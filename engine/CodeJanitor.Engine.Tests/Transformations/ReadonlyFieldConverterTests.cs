using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="ReadonlyFieldConverter" />.
/// Policy (ADR-0007): add readonly only when provably safe without a full solution-wide
/// semantic analysis. Scope: private, non-partial, non-const fields whose only writes occur
/// in the declaring class's own constructor (instance fields) or static constructor / field
/// initializer (static fields), including ref/out use within that constructor (legal per the
/// C# spec). Any write elsewhere (regular methods, accessors, local functions, nested
/// lambdas, compound assignment) disqualifies the field. Public/internal/protected fields are
/// always left unchanged since external assignment cannot be ruled out syntactically.
/// </summary>

[TestClass]
public sealed class ReadonlyFieldConverterTests
{
    private IFieldMutabilityConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new ReadonlyFieldConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldAssignedOnlyInConstructor_BecomesReadonly()
    {
        var input = "class C { private int _x; public C() { _x = 1; } }";
        var expected = "class C { private readonly int _x; public C() { _x = 1; } }";

        Assert.AreEqual(expected, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldWithInitializerOnlyNeverWrittenElsewhere_BecomesReadonly()
    {
        var input = "class C { private int _x = 5; void M() { var y = _x; } }";
        var expected = "class C { private readonly int _x = 5; void M() { var y = _x; } }";

        Assert.AreEqual(expected, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldAssignedInRegularMethod_StaysMutable()
    {
        var input = "class C { private int _x; void M() { _x = 1; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldPassedAsRefArgumentInConstructor_StaysMutable()
    {
        var input = "class C { private int _x; public C() { Helper(ref _x); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldPassedAsOutArgumentInConstructor_StaysMutable()
    {
        var input = "class C { private int _x; public C() { Helper(out _x); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldMemberPassedAsRefArgumentInMethod_StaysMutable()
    {
        var input = "class C { private Point _pt; void M() { Helper(ref _pt.X); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldMemberPassedAsOutArgumentInMethod_StaysMutable()
    {
        var input = "class C { private Point _pt; void M() { int.TryParse(\"1\", out _pt.X); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldMemberPassedAsRefArgumentInConstructor_StaysMutable()
    {
        var input = "class C { private Point _pt; public C() { Helper(ref _pt.X); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldMemberPassedAsOutArgumentInConstructor_StaysMutable()
    {
        var input = "class C { private Point _pt; public C() { Helper(out _pt.X); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void DeepObjectFieldMemberPassedAsRefArgument_StaysMutable()
    {
        var input = "class C { private Nested _n; void M() { Helper(ref this._n.Deep.Value); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldMemberAssignedInMethod_StaysMutable()
    {
        var input = "class C { private Point _pt; void M() { _pt.X = 10; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldMemberIncrementedInMethod_StaysMutable()
    {
        var input = "class C { private Point _pt; void M() { _pt.X++; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ObjectFieldElementPassedAsRef_StaysMutable()
    {
        var input = "class C { private int[] _arr; void M() { Helper(ref _arr[0]); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldPassedAsRefArgumentInMethod_StaysMutable()
    {
        var input = "class C { private int _x; void M() { Helper(ref _x); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldPassedAsRefArgumentThroughAnotherInstance_StaysMutable()
    {
        var input = "class C { private int _x; void M(C other) { Helper(ref other._x); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void StaticFieldPassedAsRefArgumentThroughTypeName_StaysMutable()
    {
        var input = "class C { private static int _x; static void M() { Helper(ref C._x); } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldAssignedThroughAnotherInstance_StaysMutable()
    {
        var input = "class C { private int _x; void M(C other) { other._x = 1; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldReturnedByRefProperty_StaysMutable()
    {
        var input = "class C { private int _x; public ref int X => ref _x; }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldReturnedByRefMethod_StaysMutable()
    {
        var input = "class C { private int _x; public ref int M() { return ref _x; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldWithCompoundAssignmentInMethod_StaysMutable()
    {
        var input = "class C { private int _x; void M() { _x += 1; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldAlreadyReadonly_Unchanged()
    {
        var input = "class C { private readonly int _x; public C() { _x = 1; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConstField_Unchanged()
    {
        var input = "class C { private const int _x = 1; }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void StaticFieldAssignedInStaticConstructor_BecomesReadonly()
    {
        var input = "class C { private static int _x; static C() { _x = 1; } }";
        var expected = "class C { private static readonly int _x; static C() { _x = 1; } }";

        Assert.AreEqual(expected, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FieldAssignedInsideLambdaInsideConstructor_StaysMutable()
    {
        // '_a' is assigned directly in the constructor, so it is safely readonly. '_x' is only
        // ever written from inside the lambda body, which could run after construction, so it
        // must stay mutable.
        var input = "class C { private System.Action _a; private int _x; public C() { _a = () => { _x = 1; }; } }";
        var expected = "class C { private readonly System.Action _a; private int _x; public C() { _a = () => { _x = 1; }; } }";

        Assert.AreEqual(expected, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PartialClass_FieldsUnchanged()
    {
        var input = "partial class C { private int _x; public C() { _x = 1; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PublicField_StaysMutable()
    {
        var input = "class C { public int X; public C() { X = 1; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MultiVariableFieldDeclaration_Unchanged()
    {
        var input = "class C { private int _x, _y; public C() { _x = 1; _y = 2; } }";

        Assert.AreEqual(input, _converter.AddReadonlyWhenSafe(input));
    }
}
