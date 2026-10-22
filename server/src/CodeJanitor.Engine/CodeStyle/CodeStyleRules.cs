namespace CodeJanitor.Engine.CodeStyle;

/// <summary>
/// The Roslyn code-style options Code Janitor applies when <c>.editorconfig</c> does not enforce them (the
/// <c>codeStyleRules</c> setting and the <c>.codejanitor</c> <c>codeStyle</c> section), in the order of the settings panel.
/// Naming rules (<c>dotnet_naming_*</c>) are configured in <c>.editorconfig</c> only.
/// </summary>
public static class CodeStyleRules
{
    private const string Modifiers = "Modifiers";
    private const string Blocks = "Blocks";
    private const string ExpressionBodies = "Expression-bodied members";
    private const string PatternMatching = "Pattern matching";
    private const string NullChecking = "Null checking";
    private const string ModernExpressions = "Modern expressions";
    private const string Qualification = "'this.' qualification";
    private const string PredefinedTypes = "Language keywords vs. framework type names";
    private const string Parentheses = "Parentheses";

    private static readonly string[] Boolean = ["true", "false"];
    private static readonly string[] ExpressionBody = ["true", "false", "when_on_single_line"];
    private static readonly string[] ParenthesesValues = ["always_for_clarity", "never_if_unnecessary"];

    private static readonly HashSet<string> KnownModifiers = new(StringComparer.Ordinal)
    {
        "public", "private", "protected", "internal", "file", "static", "extern", "new", "virtual", "abstract",
        "sealed", "override", "readonly", "unsafe", "required", "volatile", "async", "partial", "const", "fixed", "ref",
    };

    /// <summary>Every rule, in the order of the settings panel.</summary>
    public static IReadOnlyList<CodeStyleRule> All { get; } =
    [
        new(Modifiers, "csharp_preferred_modifier_order", "Order modifiers", ["IDE0036"], [],
            "public,private,protected,internal,file,static,extern,new,virtual,abstract,sealed,override,readonly,unsafe,required,volatile,async",
            IsModifierOrder),
        new(Modifiers, "csharp_prefer_static_local_function", "Make local functions static", ["IDE0062"], Boolean, "true"),
        new(Modifiers, "csharp_prefer_static_anonymous_function", "Make anonymous functions static", ["IDE0320"], Boolean, "true"),
        new(Modifiers, "csharp_style_prefer_readonly_struct", "Make structs readonly", ["IDE0250"], Boolean, "true"),
        new(Modifiers, "csharp_style_prefer_readonly_struct_member", "Make struct members readonly", ["IDE0251"], Boolean, "true"),

        new(Blocks, "csharp_prefer_braces", "Use braces", ["IDE0011"], ["true", "false", "when_multiline"], "true"),
        new(Blocks, "csharp_prefer_simple_using_statement", "Use simple 'using' statements", ["IDE0063"], Boolean, "true"),
        new(Blocks, "csharp_style_prefer_method_group_conversion", "Convert lambdas to method groups", ["IDE0200"], Boolean, "true"),

        new(ExpressionBodies, "csharp_style_expression_bodied_methods", "Methods", ["IDE0022"], ExpressionBody, "false"),
        new(ExpressionBodies, "csharp_style_expression_bodied_constructors", "Constructors", ["IDE0021"], ExpressionBody, "false"),
        new(ExpressionBodies, "csharp_style_expression_bodied_operators", "Operators", ["IDE0023", "IDE0024"], ExpressionBody, "false"),
        new(ExpressionBodies, "csharp_style_expression_bodied_properties", "Properties", ["IDE0025"], ExpressionBody, "true"),
        new(ExpressionBodies, "csharp_style_expression_bodied_indexers", "Indexers", ["IDE0026"], ExpressionBody, "true"),
        new(ExpressionBodies, "csharp_style_expression_bodied_accessors", "Accessors", ["IDE0027"], ExpressionBody, "true"),
        new(ExpressionBodies, "csharp_style_expression_bodied_local_functions", "Local functions", ["IDE0061"], ExpressionBody, "false"),

        new(PatternMatching, "csharp_style_pattern_matching_over_is_with_cast_check", "Pattern matching over 'is' with cast", ["IDE0020", "IDE0038"], Boolean, "true"),
        new(PatternMatching, "csharp_style_pattern_matching_over_as_with_null_check", "Pattern matching over 'as' with null check", ["IDE0019", "IDE0260"], Boolean, "true"),
        new(PatternMatching, "csharp_style_prefer_pattern_matching", "Combine patterns", ["IDE0078"], Boolean, "true"),
        new(PatternMatching, "csharp_style_prefer_not_pattern", "Use 'not' pattern", ["IDE0083"], Boolean, "true"),
        new(PatternMatching, "csharp_style_prefer_extended_property_pattern", "Use extended property patterns", ["IDE0170"], Boolean, "true"),
        new(PatternMatching, "csharp_style_prefer_switch_expression", "Use switch expressions", ["IDE0066"], Boolean, "true"),

        new(NullChecking, "dotnet_style_coalesce_expression", "Use '??'", ["IDE0029", "IDE0030", "IDE0270"], Boolean, "true"),
        new(NullChecking, "dotnet_style_null_propagation", "Use '?.'", ["IDE0031"], Boolean, "true"),
        new(NullChecking, "csharp_style_throw_expression", "Use throw expressions", ["IDE0016"], Boolean, "true"),
        new(NullChecking, "csharp_style_conditional_delegate_call", "Invoke delegates with '?.'", ["IDE1005"], Boolean, "true"),

        new(ModernExpressions, "csharp_style_prefer_primary_constructors", "Use primary constructors", ["IDE0290"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_implicit_object_creation_when_type_is_apparent", "Use target-typed 'new()'", ["IDE0090"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_prefer_index_operator", "Use index operator '^'", ["IDE0056"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_prefer_range_operator", "Use range operator '..'", ["IDE0057"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_prefer_utf8_string_literals", "Use UTF-8 string literals", ["IDE0230"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_prefer_tuple_swap", "Swap values with tuples", ["IDE0180"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_deconstructed_variable_declaration", "Deconstruct variable declarations", ["IDE0042"], Boolean, "true"),
        new(ModernExpressions, "csharp_style_unused_value_assignment_preference", "Unused value assignments", ["IDE0059"], ["discard_variable", "unused_local_variable"], "discard_variable"),
        new(ModernExpressions, "csharp_prefer_simple_default_expression", "Use 'default' literal", ["IDE0034"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_prefer_auto_properties", "Use auto-properties", ["IDE0032"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_prefer_compound_assignment", "Use compound assignment", ["IDE0054", "IDE0074"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_prefer_simplified_boolean_expressions", "Simplify boolean expressions", ["IDE0075"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_prefer_simplified_interpolation", "Simplify interpolation", ["IDE0071"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_object_initializer", "Use object initializers", ["IDE0017"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_collection_initializer", "Use collection initializers", ["IDE0028"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_explicit_tuple_names", "Use explicit tuple names", ["IDE0033"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_prefer_inferred_tuple_names", "Use inferred tuple element names", ["IDE0037"], Boolean, "true"),
        new(ModernExpressions, "dotnet_style_prefer_inferred_anonymous_type_member_names", "Use inferred anonymous type member names", ["IDE0037"], Boolean, "true"),

        new(Qualification, "dotnet_style_qualification_for_field", "Fields", ["IDE0003", "IDE0009"], Boolean, "false"),
        new(Qualification, "dotnet_style_qualification_for_property", "Properties", ["IDE0003", "IDE0009"], Boolean, "false"),
        new(Qualification, "dotnet_style_qualification_for_method", "Methods", ["IDE0003", "IDE0009"], Boolean, "false"),
        new(Qualification, "dotnet_style_qualification_for_event", "Events", ["IDE0003", "IDE0009"], Boolean, "false"),

        new(PredefinedTypes, "dotnet_style_predefined_type_for_locals_parameters_members", "Locals, parameters and members", ["IDE0049"], Boolean, "true"),
        new(PredefinedTypes, "dotnet_style_predefined_type_for_member_access", "Member access expressions", ["IDE0049"], Boolean, "true"),

        new(Parentheses, "dotnet_style_parentheses_in_arithmetic_binary_operators", "Arithmetic operators", ["IDE0047", "IDE0048"], ParenthesesValues, "always_for_clarity"),
        new(Parentheses, "dotnet_style_parentheses_in_relational_binary_operators", "Relational operators", ["IDE0047", "IDE0048"], ParenthesesValues, "always_for_clarity"),
        new(Parentheses, "dotnet_style_parentheses_in_other_binary_operators", "Other binary operators", ["IDE0047", "IDE0048"], ParenthesesValues, "always_for_clarity"),
        new(Parentheses, "dotnet_style_parentheses_in_other_operators", "Other operators", ["IDE0047", "IDE0048"], ParenthesesValues, "never_if_unnecessary"),
    ];

    private static readonly Dictionary<string, CodeStyleRule> ByKey = All.ToDictionary(rule => rule.Key, StringComparer.Ordinal);

    /// <summary>The rule of an <c>.editorconfig</c> option, or null when it is not a Code Style rule.</summary>
    public static CodeStyleRule? Find(string key) => ByKey.TryGetValue(key, out var rule) ? rule : null;

    private static bool IsModifierOrder(string value)
    {
        var modifiers = value.Split(',').Select(modifier => modifier.Trim()).ToList();

        return modifiers.All(KnownModifiers.Contains) && modifiers.Distinct(StringComparer.Ordinal).Count() == modifiers.Count;
    }
}
