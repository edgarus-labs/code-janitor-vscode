using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>
/// What the initializers of one member declaration need from the declaration order. Field and property initializers
/// run in declaration order (static ones in the static constructor, instance ones in every constructor), so moving a
/// member with an initializer can change what another initializer sees.
/// </summary>
public sealed record InitInfo(
    bool StaticInit,
    bool InstanceInit,
    bool StaticOpaque,
    bool InstanceOpaque,
    bool InstanceReadsState,
    ImmutableHashSet<string> Declares,
    ImmutableHashSet<string> Refs)
{
    /// <summary>A member without initializers.</summary>
    public static readonly InitInfo None = new(false, false, false, false, false, ImmutableHashSet<string>.Empty, ImmutableHashSet<string>.Empty);

    public bool IsNone => Declares.IsEmpty;

    public static InitInfo Merge(IEnumerable<InitInfo> infos)
    {
        var present = infos.Where(info => !info.IsNone).ToList();
        if (present.Count == 0)
        {
            return None;
        }

        return new InitInfo(
            present.Any(info => info.StaticInit),
            present.Any(info => info.InstanceInit),
            present.Any(info => info.StaticOpaque),
            present.Any(info => info.InstanceOpaque),
            present.Any(info => info.InstanceReadsState),
            present.SelectMany(info => info.Declares).ToImmutableHashSet(),
            present.SelectMany(info => info.Refs).ToImmutableHashSet());
    }

    /// <summary>
    /// Whether two members with initializers must keep their relative order: one reads what the other initializes,
    /// or one runs code that may observe the state the other initializes.
    /// </summary>
    public static bool MustKeepOrder(InitInfo first, InitInfo second)
    {
        if ((first.StaticOpaque && second.StaticInit) || (second.StaticOpaque && first.StaticInit))
        {
            return true;
        }

        var firstObserves = first.InstanceOpaque || first.InstanceReadsState;
        var secondObserves = second.InstanceOpaque || second.InstanceReadsState;
        if ((first.InstanceOpaque && secondObserves) || (second.InstanceOpaque && firstObserves))
        {
            return true;
        }

        return second.Refs.Overlaps(first.Declares) || first.Refs.Overlaps(second.Declares);
    }
}

/// <summary>
/// Derives <see cref="InitInfo"/> from the semantic model: an initializer is opaque when it may run code of the
/// program (a method, constructor, accessor, operator or conversion declared in source, a delegate, a static
/// constructor of another type of the program) or has side effects; it reads the members of its own type it
/// references, and reads state when it reads a primary constructor parameter or calls or reads a static member of a
/// library (which may read process-wide state the program changes). Without a semantic model (code in an inactive
/// <c>#if</c> branch) every initializer that is not a literal, lambda or default counts as opaque.
/// </summary>
internal sealed class InitializerAnalyzer
{
    private static readonly ImmutableHashSet<string> PureConstructedTypes = ImmutableHashSet.Create(
        "Object", "List", "Dictionary", "HashSet", "SortedDictionary", "SortedSet", "SortedList", "Queue", "Stack", "LinkedList",
        "StringBuilder", "ConcurrentDictionary", "ConcurrentQueue", "ConcurrentStack", "ConcurrentBag", "Lazy", "ThreadLocal",
        "SemaphoreSlim", "ManualResetEvent", "ManualResetEventSlim", "AutoResetEvent", "ReaderWriterLockSlim", "Mutex", "Lock",
        "Regex", "Version", "TimeSpan", "DateTime", "DateTimeOffset", "Uri", "Guid", "Random", "Stopwatch", "CultureInfo",
        "KeyValuePair", "Tuple", "ValueTuple", "BitArray", "String", "StringComparer", "ArrayList", "Hashtable",
        "Exception", "ArgumentException", "InvalidOperationException", "NotSupportedException", "NotImplementedException",
        "Func", "Action", "EventHandler", "Predicate", "Comparison");

    private static readonly ImmutableHashSet<string> PureStaticTypes = ImmutableHashSet.Create(
        "Math", "MathF", "Array", "Enum", "TimeSpan", "DateTime", "DateTimeOffset", "Guid", "Path", "Regex", "String", "Convert",
        "BitConverter", "Encoding", "Enumerable", "ImmutableArray", "ImmutableList", "ImmutableDictionary", "ImmutableHashSet",
        "Environment", "Type", "Uri", "Version", "Char", "Int32", "Int64", "Double", "Decimal", "Boolean", "Byte", "UInt32", "UInt64",
        "Comparer", "EqualityComparer", "StringComparer", "CultureInfo", "NumberFormatInfo", "ArrayPool", "Buffer", "BigInteger");

    private readonly SemanticModel? _model;
    private readonly INamedTypeSymbol? _type;
    private readonly bool _unreliable;

    public InitializerAnalyzer(SemanticModel? model, INamedTypeSymbol? type)
    {
        _model = model;
        _type = type;
        _unreliable = type is not null && HasUnresolvedBase(type);
    }

    /// <summary>The initializer facts of a field, event field or property declaration.</summary>
    public InitInfo Analyze(MemberDeclarationSyntax declaration, bool isStatic, bool withSemantics = true)
    {
        var initializers = InitializersOf(declaration).ToList();
        if (initializers.Count == 0)
        {
            return InitInfo.None;
        }

        var scan = new Scan();
        var declares = ImmutableHashSet.CreateBuilder<string>();
        foreach (var (name, clause) in initializers)
        {
            declares.Add(name);
            if (withSemantics && _model is not null && _type is not null && _model.GetOperation(clause) is { } operation)
            {
                Visit(operation is ISymbolInitializerOperation initializer ? initializer.Value : operation, scan);
            }
            else
            {
                ScanWithoutSemantics(clause.Value, scan);
            }
        }

        var refs = scan.Refs.Except(declares);

        return new InitInfo(
            isStatic,
            !isStatic,
            isStatic && scan.Opaque,
            !isStatic && scan.Opaque,
            !isStatic && scan.ReadsState,
            declares.ToImmutable(),
            refs.ToImmutableHashSet());
    }

    private static IEnumerable<(string Name, EqualsValueClauseSyntax Clause)> InitializersOf(MemberDeclarationSyntax declaration)
    {
        switch (declaration)
        {
            case BaseFieldDeclarationSyntax field:
                foreach (var variable in field.Declaration.Variables)
                {
                    if (variable.Initializer is { } initializer)
                    {
                        yield return (variable.Identifier.ValueText, initializer);
                    }
                }

                break;

            case PropertyDeclarationSyntax { Initializer: { } initializer } property:
                yield return (property.Identifier.ValueText, initializer);
                break;
        }
    }

    private static void ScanWithoutSemantics(ExpressionSyntax value, Scan scan)
    {
        if (value is LiteralExpressionSyntax or AnonymousFunctionExpressionSyntax or DefaultExpressionSyntax)
        {
            return;
        }

        scan.Opaque = true;
        foreach (var identifier in value.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
        {
            scan.Refs.Add(identifier.Identifier.ValueText);
        }
    }

    private void Visit(IOperation? operation, Scan scan)
    {
        if (operation is null)
        {
            return;
        }

        switch (operation)
        {
            case IAnonymousFunctionOperation:
            case ILiteralOperation:
            case ITypeOfOperation:
            case ISizeOfOperation:
            case IDefaultValueOperation:
            case INameOfOperation:
            case IMethodReferenceOperation { Instance: null }:
                return;

            case IDelegateCreationOperation creation:
                if (creation.Target is IMethodReferenceOperation { Instance: { } instance })
                {
                    Visit(instance, scan);
                }

                return;

            case IFieldReferenceOperation field:
                Visit(field.Instance, scan);
                ReadField(field.Field, scan);
                return;

            case IPropertyReferenceOperation property:
                VisitChildren(property, scan);
                ReadProperty(property, scan);
                return;

            case IEventReferenceOperation @event:
                Visit(@event.Instance, scan);
                if (IsOwnType(@event.Event.ContainingType))
                {
                    scan.ReadsState = true;
                }
                else
                {
                    scan.Opaque = true;
                }

                return;

            case IInvocationOperation invocation:
                VisitChildren(invocation, scan);
                if (!IsPureCall(invocation))
                {
                    scan.Opaque = true;
                }
                else if (invocation.Instance is null)
                {
                    scan.ReadsState = true;
                }

                return;

            case IParameterReferenceOperation:
                scan.ReadsState = true;
                return;

            case IObjectCreationOperation creation:
                if (!IsPureCreation(creation))
                {
                    scan.Opaque = true;
                }

                VisitChildren(creation, scan);
                return;

            case IMemberInitializerOperation:
            case IObjectOrCollectionInitializerOperation:
                VisitChildren(operation, scan);
                return;

            case ISimpleAssignmentOperation assignment when IsInitializerTarget(assignment.Target):
                if (assignment.Target is IPropertyReferenceOperation { Property: var setter } && (IsProgramCode(setter) || IsForeign(setter)))
                {
                    scan.Opaque = true;
                }

                if (assignment.Target is IPropertyReferenceOperation indexer)
                {
                    foreach (var argument in indexer.Arguments)
                    {
                        Visit(argument, scan);
                    }
                }

                Visit(assignment.Value, scan);
                return;

            case IBinaryOperation binary:
                if (RunsProgramCode(binary.OperatorMethod) || IsStringConcatenationOfProgramValue(binary) || IsUnresolved(binary.LeftOperand) || IsUnresolved(binary.RightOperand))
                {
                    scan.Opaque = true;
                }

                VisitChildren(binary, scan);
                return;

            case IUnaryOperation unary:
                if (RunsProgramCode(unary.OperatorMethod) || IsUnresolved(unary.Operand))
                {
                    scan.Opaque = true;
                }

                VisitChildren(unary, scan);
                return;

            case IConversionOperation conversion:
                if (RunsProgramCode(conversion.OperatorMethod) || IsUnresolvedConversion(conversion))
                {
                    scan.Opaque = true;
                }

                Visit(conversion.Operand, scan);
                return;

            case IInterpolationOperation interpolation:
                if (IsProgramDependent(interpolation.Expression.Type))
                {
                    scan.Opaque = true;
                }

                VisitChildren(interpolation, scan);
                return;

            case IRecursivePatternOperation pattern:
                if (pattern.DeconstructSymbol is { } deconstruct && (IsProgramCode(deconstruct) || IsForeign(deconstruct)))
                {
                    scan.Opaque = true;
                }

                VisitChildren(pattern, scan);
                return;

            case IListPatternOperation list:
                if (RunsProgramCode(list.LengthSymbol) || RunsProgramCode(list.IndexerSymbol))
                {
                    scan.Opaque = true;
                }

                VisitChildren(list, scan);
                return;

            case ICollectionExpressionOperation collection:
                if (RunsProgramCode(collection.ConstructMethod))
                {
                    scan.Opaque = true;
                }

                VisitChildren(collection, scan);
                return;

            case IRangeOperation range:
                if (RunsProgramCode(range.Method))
                {
                    scan.Opaque = true;
                }

                VisitChildren(range, scan);
                return;

            case IWithOperation with:
                if (RunsProgramCode(with.CloneMethod) || IsProgramDependent(with.Operand.Type))
                {
                    scan.Opaque = true;
                }

                VisitChildren(with, scan);
                return;

            case IArrayCreationOperation:
            case IArrayInitializerOperation:
            case IArrayElementReferenceOperation:
            case ITupleOperation:
            case IConditionalOperation:
            case ICoalesceOperation:
            case IConditionalAccessOperation:
            case IConditionalAccessInstanceOperation:
            case IInstanceReferenceOperation:
            case ILocalReferenceOperation:
            case IIsTypeOperation:
            case IIsPatternOperation:
            case ISwitchExpressionOperation:
            case ISwitchExpressionArmOperation:
            case IPatternOperation:
            case IPropertySubpatternOperation:
            case IThrowOperation:
            case IInterpolatedStringOperation:
            case IInterpolatedStringTextOperation:
            case IAnonymousObjectCreationOperation:
            case IArgumentOperation:
            case IDiscardOperation:
            case IDeclarationExpressionOperation:
            case ISpreadOperation:
            case IParenthesizedOperation:
                VisitChildren(operation, scan);
                return;

            default:
                scan.Opaque = true;
                return;
        }
    }

    private void VisitChildren(IOperation operation, Scan scan)
    {
        foreach (var child in operation.ChildOperations)
        {
            Visit(child, scan);
        }
    }

    private void ReadField(IFieldSymbol field, Scan scan)
    {
        if (IsOwnType(field.ContainingType))
        {
            if (!field.IsConst)
            {
                scan.ReadsState = true;
                scan.Refs.Add(field.AssociatedSymbol?.Name ?? field.Name);
            }

            return;
        }

        if (IsForeign(field) || (field.IsStatic && !field.IsConst && IsProgramCode(field.ContainingType)))
        {
            // Reading a static field of another type of the program runs its static constructor, which may read this type's statics.
            scan.Opaque = true;
        }
        else if (field.IsStatic && !field.IsConst && !field.IsReadOnly)
        {
            scan.ReadsState = true;
        }
    }

    private void ReadProperty(IPropertyReferenceOperation reference, Scan scan)
    {
        var property = reference.Property;
        if (IsOwnType(property.ContainingType))
        {
            if (IsAutoProperty(property))
            {
                scan.ReadsState = true;
                scan.Refs.Add(property.Name);
            }
            else
            {
                scan.Opaque = true;
            }

            return;
        }

        if (IsProgramCode(property) || IsForeign(property) || (reference.Instance is { } instance && IsProgramDependent(instance.Type)))
        {
            scan.Opaque = true;
        }
        else if (property.IsStatic)
        {
            scan.ReadsState = true;
        }
    }

    private bool IsPureCall(IInvocationOperation invocation)
    {
        var method = invocation.TargetMethod;
        if (IsProgramCode(method) || IsForeign(method) || method.MethodKind == MethodKind.DelegateInvoke)
        {
            return false;
        }

        if (method.TypeArguments.Any(IsProgramDependent) || invocation.Arguments.Any(argument => PassesCode(argument.Value) || IsProgramDependent(argument.Value.Type)))
        {
            return false;
        }

        if (invocation.Instance is { } instance)
        {
            // An instance call on the object an initializer creates (a collection initializer's Add), or on an immutable value.
            return instance is IInstanceReferenceOperation { ReferenceKind: InstanceReferenceKind.ImplicitReceiver }
                || instance.Type is { SpecialType: not SpecialType.None and not SpecialType.System_Object } or { TypeKind: TypeKind.Enum };
        }

        var container = method.ContainingType;

        return container.SpecialType != SpecialType.None || PureStaticTypes.Contains(container.Name) && IsSystemNamespace(container);
    }

    private bool IsPureCreation(IObjectCreationOperation creation)
    {
        if (creation.Constructor is not { } constructor || IsProgramCode(constructor) || IsForeign(constructor))
        {
            return false;
        }

        var type = constructor.ContainingType;
        if (!(type.SpecialType == SpecialType.System_Object || PureConstructedTypes.Contains(type.Name) && IsSystemNamespace(type) || type.TypeKind == TypeKind.Delegate))
        {
            return false;
        }

        // Lambdas are stored (Lazy, delegates), not run; a value of a type of the program may have its Equals, GetHashCode or ToString called.
        return creation.Arguments.All(argument => argument.Value is IAnonymousFunctionOperation or IDelegateCreationOperation || !IsProgramDependent(argument.Value.Type));
    }

    private static bool PassesCode(IOperation value)
    {
        var unwrapped = value is IConversionOperation conversion ? conversion.Operand : value;

        return unwrapped is IAnonymousFunctionOperation or IDelegateCreationOperation or IMethodReferenceOperation;
    }

    private bool IsStringConcatenationOfProgramValue(IBinaryOperation binary) =>
        binary.OperatorKind == BinaryOperatorKind.Add
        && binary.Type?.SpecialType == SpecialType.System_String
        && new[] { binary.LeftOperand, binary.RightOperand }.Any(operand => IsProgramDependent(Unconverted(operand).Type) && Unconverted(operand) is not ILiteralOperation);

    /// <summary>An operand of a type that does not resolve: the operator may be a user-defined one.</summary>
    private static bool IsUnresolved(IOperation operand) => Unconverted(operand).Type is { TypeKind: TypeKind.Error };

    private static IOperation Unconverted(IOperation operation) =>
        operation is IConversionOperation { IsImplicit: true } conversion ? conversion.Operand : operation;

    /// <summary>A conversion to or from a type that does not resolve may be a user-defined one.</summary>
    private static bool IsUnresolvedConversion(IConversionOperation conversion)
    {
        if (conversion.Operand is ILiteralOperation { ConstantValue: { HasValue: true, Value: null } } or IDefaultValueOperation or IAnonymousFunctionOperation or IDelegateCreationOperation)
        {
            return false;
        }

        return conversion.Type is null or { TypeKind: TypeKind.Error } || conversion.Operand.Type is { TypeKind: TypeKind.Error };
    }

    private bool RunsProgramCode(ISymbol? symbol) => symbol is not null && (IsProgramCode(symbol) || IsForeign(symbol));

    private bool IsOwnType(INamedTypeSymbol? type) => type is not null && SymbolEqualityComparer.Default.Equals(type, _type);

    /// <summary>A symbol of another type while the bases of this type do not resolve: an unseen base member may shadow it.</summary>
    private bool IsForeign(ISymbol symbol) => _unreliable && !IsOwnType(symbol.ContainingType);

    private static bool IsProgramCode(ISymbol symbol) =>
        symbol.Locations.Any(location => location.IsInSource) || symbol.OriginalDefinition.Locations.Any(location => location.IsInSource);

    private static bool IsSystemNamespace(INamedTypeSymbol type)
    {
        var name = type.ContainingNamespace?.ToDisplayString() ?? string.Empty;

        return name == "System" || name.StartsWith("System.", StringComparison.Ordinal);
    }

    /// <summary>
    /// Whether a value of the type may be (or contain) an object whose code is the program's: a type declared in
    /// source, an unresolved type, a type parameter, <c>object</c>, <c>dynamic</c>, an interface, a delegate or an
    /// unsealed library class (a subclass of the program may override its virtual members).
    /// </summary>
    private static bool IsProgramDependent(ITypeSymbol? type)
    {
        switch (type)
        {
            case null:
                return false;
            case IArrayTypeSymbol array:
                return IsProgramDependent(array.ElementType);
            case IPointerTypeSymbol:
                return false;
            case INamedTypeSymbol named:
                if (named.TypeKind is TypeKind.Error or TypeKind.Interface or TypeKind.Delegate or TypeKind.Dynamic || IsProgramCode(named))
                {
                    return true;
                }

                if (named.TypeKind == TypeKind.Enum || named.SpecialType == SpecialType.System_String)
                {
                    return false;
                }

                if (named.SpecialType == SpecialType.System_Object || (named.TypeKind == TypeKind.Class && !named.IsSealed && !named.IsStatic))
                {
                    return true;
                }

                return named.TypeArguments.Any(IsProgramDependent);
            default:
                return true;
        }
    }

    private bool IsAutoProperty(IPropertySymbol property)
    {
        foreach (var reference in property.DeclaringSyntaxReferences)
        {
            if (reference.GetSyntax() is PropertyDeclarationSyntax declaration)
            {
                return !MemberDescriber.IsComputedProperty(declaration);
            }
        }

        return false;
    }

    private static bool IsInitializerTarget(IOperation target) =>
        target is IMemberReferenceOperation { Instance: IInstanceReferenceOperation { ReferenceKind: InstanceReferenceKind.ImplicitReceiver } };

    private static bool HasUnresolvedBase(INamedTypeSymbol type)
    {
        for (var current = type; current is not null; current = current.ContainingType)
        {
            if (current.BaseType is { TypeKind: TypeKind.Error } || current.Interfaces.Any(@interface => @interface.TypeKind == TypeKind.Error))
            {
                return true;
            }
        }

        return false;
    }

    private sealed class Scan
    {
        public HashSet<string> Refs { get; } = new(StringComparer.Ordinal);

        public bool Opaque { get; set; }

        public bool ReadsState { get; set; }
    }
}
