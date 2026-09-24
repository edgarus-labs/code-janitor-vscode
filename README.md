# Code Janitor for VS Code

**Stop reviewing whitespace. Start reviewing logic.**

Code Janitor cleans up and simplifies your C# code with a single command: trailing whitespace,
blank-line clutter, unsorted `using` directives, missing access modifiers, leftover `#region`
blocks, and outdated syntax that could be `var`, a pattern match, or a collection expression
instead. It also generates XML documentation comments for you, using GitHub Copilot or your own
AI endpoint.

## The problem it solves

Every C# codebase accumulates the same small mess over time: inconsistent whitespace, usings in
the wrong order, methods missing an explicit access modifier, null checks written the old way,
undocumented public members. None of it is hard to fix, but doing it by hand is tedious and it
rarely happens consistently across a team. Code Janitor applies configurable cleanup rules to the scope you select. Deterministic cleanup
runs locally without .NET or an AI service. Review the resulting diff and build your project,
especially when enabling syntax modernization rules.

## Requirements

- Visual Studio Code 1.90 or later on Windows, macOS or Linux.
- No .NET runtime is required by the extension's cleanup engine.
- AI actions require an available provider; access and usage costs depend on that provider.

## Installation

Grab the latest `.vsix` from the [GitHub Releases page](https://github.com/edgarus-labs/code-janitor-vscode/releases),
then either:

- run `code --install-extension code-janitor-<version>.vsix`, or
- in VS Code, open the Extensions view, click the `...` menu, and choose **Install from VSIX...**.

## How to use it

- Right-click a C# file (or select several, or a whole folder) and choose **Code Janitor:
  Cleanup Selected Files** - or open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run
  any **Code Janitor** command.
- **Code Janitor: Cleanup Active File** cleans the file you're currently editing. **Preview Cleanup
  (Active File)** shows the changes as a diff first. Its **Choose Rules...** button lists every
  step and every `.editorconfig` rule that would change the file, with its number of changes
  (e.g. `IDE0090 (3 changes)`), so you can leave some out before applying.
- **Code Janitor: Cleanup Workspace** cleans every C# file in the project; **Cleanup Open Files**
  and **Cleanup Changed Files (Git)** clean a smaller, more targeted set.
- Turn on **Code Janitor: Toggle Cleanup on Save** to run cleanup automatically when saving supported files.
- Right-click a file, folder or multi-selection in the Explorer for a **Code Janitor** submenu with
  batch actions, coverage report analysis, and coverage-gap test generation.
- Right-click inside a C# file for a submenu with the rest of the commands: generating or removing
  XML documentation, fixing a namespace, removing regions, formatting comments, splitting a file's
  top-level types into their own files, and the AI-powered actions (explain, review, refactor,
  generate tests, analyze coverage reports, generate tests from coverage gaps).
- **Code Janitor: Split Top-Level Types** splits a C# file that declares more than one class,
  interface, record, enum or delegate into one file per type, keeping the type matching the
  current file name (or the first one) in place. It's an explicit, manual command - like the
  other file-creating actions, it never runs as part of cleanup-on-save or workspace cleanup.

Everything is configurable: open **Code Janitor: Open Settings** for a single page with every
option, or use the regular VS Code Settings editor - Code Janitor's settings are grouped there the
same way the original Visual Studio extension organized them.

For a team-wide cleanup policy, add a `.codejanitor` JSON file to the repository root. Its
`cleanup` properties use the same names as the Code Janitor settings, for example:

```json
{
  "cleanup": {
    "removeRegions": false,
    "organizeUsings": true,
    "convertToFileScopedNamespace": true,
    "insertBlankLinePadding": true
  }
}
```

The repository file is loaded automatically. Explicit VS Code settings take precedence over it,
so each developer can still adjust the policy locally. Invalid JSON, unknown properties and values
with the wrong type are ignored.

You can create or synchronize this file without editing JSON by opening **Code Janitor: Open
Settings** and using **Export .codejanitor** or **Import .codejanitor**. Export writes the current
cleanup configuration to the repository root; import copies the repository values into VS Code's
workspace settings so they can be reviewed or adjusted in the settings panel.

## .editorconfig rules (C#)

`.editorconfig` is the source of truth for C# code: whenever an `.editorconfig` applies to a file
(any `.editorconfig` from the file's folder up to the one with `root = true`, with nested files and
section globs), cleanup rewrites the code to follow its naming rules, code-style preferences and
formatting options. There is no setting to turn this on; without an `.editorconfig` cleanup
behaves as configured by the Code Janitor settings alone. The `.editorconfig` rules run after
every other cleanup step (naming first, formatting last), for every cleanup command and for
cleanup on save.

When a Code Janitor setting and an `.editorconfig` setting govern the same thing, the
`.editorconfig` wins as long as it sets the option with a supported value and, where a severity
applies, the rule is enforced. Code Janitor settings keep applying to everything the
`.editorconfig` does not decide:

| Code Janitor setting | Overridden by | Effect when the `.editorconfig` decides |
| --- | --- | --- |
| Move usings outside namespace | `csharp_using_directive_placement` | Usings are placed as the option says (only provably safe moves). |
| Convert to file-scoped namespace | `csharp_style_namespace_declarations` | The namespace style of the option. |
| Convert to `var` when apparent | `csharp_style_var_*` | The `var` preferences decide. |
| Make fields readonly | `dotnet_style_readonly_field` | `readonly` only for `true`. |
| Inline `out` variable declarations | `csharp_style_inlined_variable_declaration`; `csharp_style_var_*` = `false` | Inlining only for `true`; with explicit types preferred, `out T x` instead of `out var x`. |
| Insert explicit access modifiers | `dotnet_style_require_accessibility_modifiers` | Modifiers are added or removed as the option says. |
| File header | `file_header_template` (with IDE0073 enforced) | The template is used. |
| Sort usings | `dotnet_sort_system_directives_first`, `dotnet_separate_import_directive_groups` | Whenever the option is set, usings are sorted (`System` first only for `true`), even with the setting off; groups get a blank line between them (`true`) or none (`false`). |
| Remove end-of-line whitespace | `trim_trailing_whitespace` | Trailing whitespace is removed only for `true`. |
| Remove byte order mark | `charset` | `utf-8` removes it, `utf-8-bom` keeps it. |
| (final newline, always added) | `insert_final_newline` | Added for `true`, removed for `false`. |
| Convert to collection expressions | `dotnet_style_prefer_collection_expression` = `false`/`never` | No conversion. |
| Simplify single-statement lambdas | `csharp_style_expression_bodied_lambdas` other than `true` | No conversion. |

The other settings (regions, blank lines and padding, sealing, `nameof`, string interpolation,
pattern-matching null checks, CA1869, accessor and single-line method layout, comment formatting)
have no `.editorconfig` counterpart and always apply as configured.

Settings in the `.editorconfig` that cleanup does not implement are never ignored silently: each
one that would take effect (an enforced rule, or an EditorConfig property without a severity) is
listed in the **Code Janitor** output channel as not supported. Each cleanup run lists it once,
with the number of files it affects. Cleaning a single file, cleanup on save and the preview skip
the settings of an `.editorconfig` whose settings were already listed in the session. Rules at `silent` or
`none` require nothing and are not listed, nor are Visual Basic options. Rule violations cleanup
could not fix are still listed per file and place.

- **Severity.** A code-style rule is applied only when its diagnostic is `suggestion`, `warning` or
  `error` - set with `option = value:severity`, a naming rule's `severity`,
  `dotnet_diagnostic.<ID>.severity`, `dotnet_analyzer_diagnostic.category-Style.severity` or
  `dotnet_analyzer_diagnostic.severity`. `silent`, `none` and rules without a severity are left alone.
- **Safety.** There is no compiler or semantic model involved, so code is rewritten only where the
  result is certain from the syntax. Violations that cannot be fixed safely are left unchanged and
  listed in the **Code Janitor** output channel; batch cleanup counts them in its summary and
  finishes with a warning. String literals and comment text are never changed.

Supported code-style options:

| Option | Diagnostic | Behavior |
| --- | --- | --- |
| `csharp_style_namespace_declarations` | IDE0160, IDE0161 | Converts the file's only namespace to file-scoped or block-scoped. |
| `dotnet_style_require_accessibility_modifiers` | IDE0040 | `always`/`for_non_interface_members` add the default modifier, `omit_if_default` removes it. Partial types and (for `always`) interface members are reported. |
| `csharp_style_var_for_built_in_types`, `csharp_style_var_when_type_is_apparent`, `csharp_style_var_elsewhere` | IDE0007, IDE0008 | Local declarations only. The type must follow from the initializer (literal, `new T()`, `(T)x`, `x as T`, `default(T)`, `new T[n]`). Other declarations are reported: for `false`, the `var` locals whose type is not known without a compiler get one line per file, with their line numbers. |
| `csharp_prefer_braces` | IDE0011 | `true` and `when_multiline` add braces; `false` never removes them. |
| `dotnet_style_qualification_for_field`, `_property`, `_method`, `_event` | IDE0003, IDE0009 | Adds or removes `this.` for members declared in the same type in the file, unless a local, parameter or type parameter of the same name exists in the member. `this.` on other members is reported. |
| `csharp_using_directive_placement` | IDE0065 | `outside_namespace` moves usings whose name starts with `global::`, `System`, `Microsoft` or the namespace's first segment; other usings, and `inside_namespace`, are reported. |
| `csharp_style_inlined_variable_declaration` | IDE0018 | Inlines `T x;` into the following `out x` as `out T x` when the variable keeps its scope. |
| `file_header_template` | IDE0073 | Inserts or replaces the leading `//` header; `{fileName}` is supported. |
| `dotnet_style_readonly_field` | IDE0044 | Adds `readonly` to private fields assigned only in constructors. |
| `csharp_prefer_simple_using_statement` | IDE0063 | Converts a `using (...) { }` that ends its block. |
| `csharp_style_implicit_object_creation_when_type_is_apparent` | IDE0090 | `new T(...)` becomes `new(...)` in variable, field, property and parameter declarations whose declared type is `T`. |
| `csharp_prefer_simple_default_expression` | IDE0034 | `default(T)` becomes `default` where `T` is the declared type of the variable or parameter, or the return type of the (non-async) method returning it. |
| `csharp_style_prefer_index_operator` | IDE0056 | `x[x.Length - n]`/`x[x.Count - n]` becomes `x[^n]` when `x` is declared as an array, `string`, `List<T>`, `IList<T>`, `IReadOnlyList<T>`, `Span<T>` or `ReadOnlySpan<T>`; other receivers are reported. |
| `csharp_style_prefer_range_operator` | IDE0057 | `Substring`/`Slice` calls become ranges (`s[a..]`, `s[..n]`, `s[a..b]`, `s[a..^n]`) when the receiver is declared as `string`, `Span<T>`, `ReadOnlySpan<T>`, `Memory<T>` or `ReadOnlyMemory<T>` in the member or type; other `Substring` calls are reported. |
| `csharp_style_throw_expression` | IDE0016 | `if (x == null) throw e; y = x;` becomes `y = x ?? throw e;` for a local or parameter `x`. |
| `csharp_style_prefer_null_check_over_type_check` | IDE0150 | `x is object` becomes `x is not null`, `x is not object` becomes `x is null`. |
| `csharp_style_prefer_tuple_swap` | IDE0180 | `var t = a; a = b; b = t;` becomes `(a, b) = (b, a);` when `t` is used nowhere else. |
| `csharp_style_prefer_local_over_anonymous_function` | IDE0039 | A `Func<...>`/`Action<...>` local initialized with a lambda becomes a local function when the variable is only called. |
| `csharp_style_deconstructed_variable_declaration` | IDE0042 | A local of a named tuple (`var p = (x: 1, y: 2)`, `(int x, int y) p = ...`) used only through its element names is deconstructed, when the names are free in the member. |
| `csharp_style_prefer_utf8_string_literals` | IDE0230 | `new byte[] { ... }` of printable ASCII becomes `"..."u8.ToArray()` (`"..."u8` for a `ReadOnlySpan<byte>`), except in attributes. |
| `csharp_prefer_system_threading_lock` | IDE0330 | A private readonly `object` field used only in `lock` statements becomes `System.Threading.Lock`, when the nearest `.csproj` targets only .NET 9 or later; otherwise it is reported. |
| `csharp_style_prefer_implicitly_typed_lambda_expression` | IDE0350 | Removes lambda parameter types that the declared `Func`/`Action` type gives; other explicitly typed lambdas are reported. |
| `csharp_style_prefer_unbound_generic_type_in_nameof` | IDE0340 | `nameof(List<int>)` becomes `nameof(List<>)`. |
| `csharp_style_prefer_primary_constructors` | IDE0290 | Reported only: `true` lists classes and structs whose only constructor just assigns its parameters, `false` lists those declared with a primary constructor. |
| `dotnet_style_parentheses_in_arithmetic_binary_operators`, `_relational_binary_operators`, `_other_binary_operators`, `_other_operators` | IDE0047, IDE0048 | `always_for_clarity` adds parentheses around an operator of another precedence in the same group (`a + (b * c)`); `never_if_unnecessary` removes parentheses that group nothing (around primary expressions, whole initializers, returns and arguments, and inner operators that bind tighter). |
| `dotnet_style_predefined_type_for_locals_parameters_members`, `_for_member_access` | IDE0049 | `Int32`/`System.String` become `int`/`string` in type positions and member access (`string.Empty`); bare names only with `using System;` and when the file declares no symbol of that name. `false` is not supported. |
| `dotnet_style_prefer_compound_assignment` | IDE0054, IDE0074 | `x = x + y` becomes `x += y` (`x = x ?? y` becomes `x ??= y`) for a side-effect-free `x`. |
| `dotnet_style_prefer_simplified_boolean_expressions` | IDE0075 | `c ? true : false` becomes `c`, `c ? false : true` becomes `!c`, and `c ? true : y` / `c ? y : false` become `c \|\| y` / `c && y` when both sides are provably `bool`. |
| `dotnet_style_coalesce_expression` | IDE0029, IDE0030 | `x != null ? x : y` becomes `x ?? y` when `x` is declared as `string`, `object`, an array or an interface or base-less class of the file without `operator ==`; `x.HasValue ? x.Value : y` becomes `x ?? y` for nullable built-in value types. |
| `dotnet_style_null_propagation` | IDE0031 | `x != null ? x.Y : null` becomes `x?.Y` under the same type condition (any type for `x is not null`). |
| `csharp_style_conditional_delegate_call` | IDE1005 | `if (h != null) h(args);` becomes `h?.Invoke(args);`. |
| `dotnet_style_prefer_is_null_check_over_reference_equality_method` | IDE0041 | `ReferenceEquals(x, null)` becomes `x is null` (`!` gives `x is not null`) unless the file declares its own `ReferenceEquals`. |
| `csharp_style_prefer_not_pattern` | IDE0083 | `!(x is T)` becomes `x is not T` for type and constant patterns without a designation. |
| `csharp_style_prefer_pattern_matching` | IDE0078 | `x == 1 \|\| x == 2` becomes `x is 1 or 2`, `x >= 0 && x <= 9` becomes `x is >= 0 and <= 9`, for a value declared as `int`, `long`, `float`, `double`, `decimal`, `char`, `string` or `bool` compared with literals of its type. |
| `dotnet_style_prefer_inferred_tuple_names`, `dotnet_style_prefer_inferred_anonymous_type_member_names` | IDE0037 | `(x: x, y)` becomes `(x, y)` and `new { X = p.X }` becomes `new { p.X }` when C# infers the same, unique name. |
| `dotnet_style_prefer_conditional_expression_over_assignment`, `_over_return` | IDE0045, IDE0046 | `if (c) x = a; else x = b;` becomes `x = c ? a : b;` (a preceding `T x;` takes the initializer), `if (c) return a; [else] return b;` becomes `return c ? a : b;`, when the type is `bool`, `int`, `long`, `decimal` or `string` (for other types the conditional could change a value's type) and the result fits on one line. |
| `dotnet_style_object_initializer`, `dotnet_style_collection_initializer` | IDE0017, IDE0028 | Member assignments (`c.A = 1;`) and `Add` calls on `List`, `HashSet`, `SortedSet`, `Collection`, `ObservableCollection`, `Dictionary`, `SortedDictionary`, `SortedList` right after `var c = new T(...);` move into an initializer, as long as they do not use `c`. |
| `dotnet_style_prefer_auto_properties` | IDE0032 | A property that only returns (and sets) a private field used nowhere else becomes an auto property, with the field initializer; a field used elsewhere is reported. |
| `csharp_style_expression_bodied_methods`, `_constructors`, `_operators`, `_properties`, `_indexers`, `_accessors`, `_local_functions` | IDE0021 – IDE0027, IDE0061 | `true` turns a body holding a single `return`, expression or `throw` statement into `=> ...;`, `false` does the reverse, `when_on_single_line` only for one-line expressions (lambdas: see IDE0053). |
| `csharp_style_prefer_readonly_struct` | IDE0250 | Adds `readonly` to non-partial structs with only `readonly` instance fields, no settable auto property or field-like event, that never assign `this` outside a constructor. |
| `csharp_prefer_static_local_function` | IDE0062 | Adds `static` to local functions that use no `this`, instance member, local or parameter of the enclosing code (types with a base class are skipped: inherited members are unknown). |
| `csharp_preferred_modifier_order` | IDE0036 | Reorders modifiers to the listed order (`partial` stays last); declarations with a modifier outside the list are left alone. |
| `csharp_style_prefer_switch_expression` | IDE0066 | A `switch` whose sections only `return` (or `throw`), or only assign one variable and `break`, becomes a switch expression (`case 1: case 2:` gives `1 or 2`); without `default`, a `return` right after the switch becomes the `_` arm. Only for the target types of IDE0045 and enums declared in the file. |
| `csharp_style_pattern_matching_over_as_with_null_check` | IDE0019 | `var s = o as T; if (s != null ...)` becomes `if (o is T s ...)` when `s` is used only inside the `if` and never assigned. |
| `csharp_style_pattern_matching_over_is_with_cast_check` | IDE0020 | `if (o is T) { var t = (T)o; ... }` becomes `if (o is T t) { ... }` when `t` is never assigned. |
| `dotnet_style_explicit_tuple_names` | IDE0033 | `t.Item1` becomes `t.count` when `t` is declared in the file with a named tuple type. |
| `dotnet_style_prefer_simplified_interpolation` | IDE0071 | `{x.ToString()}` becomes `{x}` and `{x.ToString("N2")}` becomes `{x:N2}` in `$"..."` strings that are provably `string` (a `var`/`string` initializer, a `string` return, a `+` operand), when `x` is declared as a built-in value type or an enum; other receivers are reported. |
| `csharp_style_prefer_extended_property_pattern` | IDE0170 | `{ A: { B: p } }` becomes `{ A.B: p }` in `is` patterns. |
| `csharp_style_prefer_method_group_conversion` | IDE0200 | `x => M(x)` becomes `M` when `M` is the file's only method of that name and its parameter and return types match the written `Func`/`Action` type (or the lambda's parameter types, for a `void` method); other forwarding lambdas are reported. |
| `csharp_style_expression_bodied_lambdas` | IDE0053 | `x => { return e; }` becomes `x => e`; lambdas whose conversion could change the delegate type they bind to are reported. |
| `csharp_style_prefer_readonly_struct_member` | IDE0251 | Adds `readonly` to struct methods and get-only properties that assign nothing but their locals, pass nothing by reference, and call only `static`/`readonly` members of the struct or methods of reference-type fields. |
| `dotnet_style_namespace_match_folder` | IDE0130 | Reported only: a namespace other than the project's `RootNamespace` (or project file name) plus the file's folders. |
| `dotnet_code_quality_unused_parameters` | IDE0060 | Reported only: parameters a method, constructor or local function never uses (overrides, virtual, abstract, partial, event handlers, methods that only throw, and public methods of types with a base list are skipped). |

Rewrites of index/range access, `is` patterns, `?.`, `throw` expressions and UTF-8 literals are
never made inside a lambda that could become an expression tree. For `false`, the boolean options
change nothing (Roslyn reports nothing for them either), except the expression-bodied member
options, which then use block bodies. The rules run in passes until a pass changes nothing, since
one rewrite can let another apply (an `if`/`return` chain folds into one `return`); the
violations are reported for the final code. Every option cleanup reads is gated by its own
diagnostic, so `dotnet_diagnostic.<ID>.severity` also turns a single rule on or off; this applies
to the unsupported-settings list too.

Formatting: `indent_style` (with `tab_width`/`indent_size`), `end_of_line`, `insert_final_newline`,
`trim_trailing_whitespace` and `charset` (`utf-8` removes a byte order mark, `utf-8-bom` keeps
one) always apply, as do `dotnet_sort_system_directives_first` (sorts usings, `System` first for
`true`) and `dotnet_separate_import_directive_groups` (a blank line between groups for `true`, none
for `false`), which have no diagnostic of their own.
As in Visual Studio, the C# formatting options have no severity of their own and apply only while
`IDE0055` is `suggestion`, `warning` or `error`: `csharp_new_line_before_open_brace`,
`csharp_new_line_before_else`, `csharp_new_line_before_catch`, `csharp_new_line_before_finally`,
`csharp_new_line_before_members_in_object_initializers`,
`csharp_new_line_before_members_in_anonymous_types`,
`csharp_new_line_between_query_expression_clauses`, `csharp_preserve_single_line_blocks`,
`csharp_preserve_single_line_statements`, every `csharp_space_*` option, and `csharp_indent_*`
(`block_contents`, `braces`, `case_contents`, `case_contents_when_block`, `labels`,
`switch_labels`). While `IDE0055` is enforced, code is also re-indented to `indent_size`/`indent_style`.
The result matches Roslyn's formatter: the options that only split constructs already written
over several lines do the same here, `dotnet_style_operator_placement_when_wrapping` moves no
operator (Roslyn's formatter never does), and the contents of multi-line collection initializers
keep their layout. Formatting works token by token and never changes strings (including the code
inside interpolations), comments or preprocessor directives; lines the parser cannot fully read
keep their spacing, and their relative indentation (logged to the output channel).

Not supported (reported when enforced): `csharp_prefer_static_anonymous_function` (IDE0320),
`csharp_style_prefer_top_level_statements` (IDE0210/IDE0211), `csharp_style_unused_value_*`
(IDE0058, IDE0059), `dotnet_style_prefer_foreach_explicit_cast_in_source` (IDE0220), the
experimental blank-line options (IDE2000 - IDE2006), moving usings into a namespace, adding a byte
order mark, renaming symbols other files may reference, and other code-style options. Unlike the
Visual Studio extension, fixes from third-party analyzers are not applied: their
`dotnet_diagnostic.<ID>.severity` entries (e.g. Roslynator's `RCS1079`) are listed as third-party
rules that cleanup does not apply.

#### Code-style guards checked against the C# rules

Each code-style rewrite, and each Code Janitor setting that does the same kind of rewrite, was checked against two things: the rule's documented fix, and the C# rules that would make the rewritten code invalid or change what it does. Guarded cases are left unchanged, and for the `.editorconfig` rules they are listed in the output channel. `test/editorConfigAudit.test.ts` covers the guards added by this check. Style rule pages are under `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/`.

| Rule | Documentation | C# constraints guarded |
| --- | --- | --- |
| Every rule | [C# language version defaults](https://learn.microsoft.com/dotnet/csharp/language-reference/configure-language-version#c-language-version-reference), [version history](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-version-history) | The project's C# version is taken from its `<LangVersion>`, then from `Directory.Build.props`, then from its target framework's default (.NET Framework and .NET Standard 2.0 default to 7.3). A rewrite that needs newer syntax (switch expressions, `is not null`, `new()`, file-scoped namespaces, `u8`, `nameof(List<>)`, ...) is skipped and reported. Index, range and UTF-8 literal rewrites also need a target whose runtime has `System.Index`, `System.Range` and `ReadOnlySpan<byte>`. A rewrite whose result the parser reads less completely than its input is discarded. |
| IDE0160, IDE0161 | [IDE0160/IDE0161](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0160-ide0161) | Only files with a single namespace are converted. When converting to a block-scoped namespace, two cases are reported: multi-line string literals, which cannot be re-indented, and an `#if` opened before a file-scoped namespace that ends after it, because the closing brace would land inside the conditional group. |
| IDE0065, Move usings outside namespace | [IDE0065](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0065), [using directive](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/using-directive) | Inside a namespace, a using's name is resolved relative to that namespace first. Only `global::` names, `System`/`Microsoft` names and names starting with the namespace's first segment are moved. Files with several namespaces are left alone. |
| IDE0040, Insert explicit access modifiers | [IDE0040](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0040), [access modifiers](https://learn.microsoft.com/dotnet/csharp/programming-guide/classes-and-structs/access-modifiers) | No modifier is added to explicit interface implementations (including those of generic interfaces), static constructors or finalizers. Partial types and interface members are reported. Nothing changes in a type body the parser could not fully read, because a misread member would receive the modifier inside its type or name. |
| IDE0007, IDE0008, Convert to `var` when apparent | [IDE0007/IDE0008](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0007-ide0008), [implicitly typed locals](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/declarations#implicitly-typed-local-variables) | `var` is used only when the initializer has exactly the declared type. `null` initializers and array initializers (`int[] a = { 1 }`) are kept, since they have no type of their own. |
| IDE0003, IDE0009 | [IDE0003/IDE0009](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0003-ide0009) | `this.` is added only to instance members of the same type that no local, parameter or type parameter hides. Static members are never qualified ([CS0176](https://learn.microsoft.com/dotnet/csharp/misc/cs0176)). |
| IDE0018, Inline `out` variable declarations | [IDE0018](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0018), [`out` variables](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/out-parameter-modifier#out-parameter-modifier) | An `out` variable declared in a `while`, `for`, `foreach` or `using` header, a nested block, a lambda or a query clause is scoped to that construct. The declaration is only moved when later uses stay in scope: an `if` condition or a statement of the same block. |
| IDE0044, Make fields readonly | [IDE0044](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0044), [readonly fields](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/readonly#readonly-field-example) | Only fields assigned in constructors or initializers of their own type become readonly. A lambda in a constructor does not count as the constructor. A field whose type is not known to be a reference type, and whose members or elements are used outside the constructors, is kept: members of a `readonly` struct field run on a copy. |
| IDE0063 | [IDE0063](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0063) | Only a `using` statement that ends its block is converted, so disposal happens at the same point. |
| IDE0090 | [IDE0090](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0090), [target-typed `new`](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/new-operator#target-typed-new) | The declared type must be the created type. Nullable targets (`T?`, `Nullable<T>`) and type parameters are skipped: `new()` would create the underlying type or need a `new()` constraint. |
| IDE0056 | [IDE0056](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0056), [index support](https://learn.microsoft.com/dotnet/csharp/tutorials/ranges-indexes#type-support-for-indices-and-ranges) | `^n` needs a countable type with an `int` indexer. The receiver must be declared as an array, `string`, `List<T>`, `IList<T>`, `IReadOnlyList<T>`, `Span<T>` or `ReadOnlySpan<T>`, and must be the same variable as in `Length`/`Count`. Other receivers are reported, and code that could become an expression tree is left alone. |
| IDE0057 | [IDE0057](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0057) | `Substring` is rewritten only on receivers declared as `string`, and `Slice` only on span and memory types. Code that could become an expression tree is left alone. |
| IDE0016 | [IDE0016](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0016), [constant pattern](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/patterns#constant-pattern) | `x == null` must be a plain null check. The type of `x` must be known and unable to define its own `==`. |
| Pattern-matching null checks (setting) | [type testing](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/type-testing-and-cast#type-testing-with-pattern-matching) | `x == null` becomes `x is null` only when `x`'s type cannot overload `==`: known reference types of the BCL or of the file, and nullable value types. |
| IDE0150, IDE0041 | [IDE0150](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0150), [IDE0041](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0041) | Non-nullable value types are skipped: `x is not null` does not compile for them, and `ReferenceEquals(x, null)` only compares a boxed copy. |
| IDE0054, IDE0074 | [IDE0054/IDE0074](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0054-ide0074) | The target must have no side effects. `??=` is used only for variables: for a property, `P ??= y` skips the setter that `P = P ?? y` always calls. |
| IDE0200 | [IDE0200](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0200) | Methods with attributes are skipped, because a method group of a `[Conditional]` method does not compile ([CS1618](https://learn.microsoft.com/dotnet/csharp/misc/cs1618)). Parameter and return types must match the written delegate type. |
| IDE0032 | [IDE0032](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0032), [variable initializers](https://learn.microsoft.com/dotnet/csharp/language-reference/language-specification/classes#1556-variable-initializers) | Field initializers run in textual order. A field with an initializer is not moved past another member's initializer. The field must be used nowhere else and must not be `const`, `volatile` or attributed. |
| IDE0053, Simplify single-statement lambdas | [IDE0053](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0053), [expression lambdas](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/lambda-expressions#expression-lambdas), [anonymous methods](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/delegate-operator) | A block body cannot become an expression tree, and `{ F(); }` discards F's value. Passed as an argument, the expression body could therefore bind to another overload (`Expression<T>`, `Func<Task>`). Only lambdas that initialize a variable of a written delegate type are rewritten, and IDE0053 reports the rest. `delegate { ... }` without a parameter list becomes `() => ...` only for a delegate type without parameters. |
| IDE0066 | [IDE0066](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0066), [switch expression](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/switch-expression) | Converted only when every section returns or throws, or assigns the same variable and breaks, and the target type is known. A switch expression's natural type could otherwise differ from the target, for example `object` with numeric arms. |
| IDE0019, IDE0020 | [IDE0019](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0019), [IDE0020](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0020-ide0038), [declaration pattern](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/patterns#declaration-and-type-patterns) | A pattern variable is definitely assigned only where the pattern matched. The variable must be used only inside the `if`, never assigned, and not tested under `\|\|`. No other variable of that name may exist in the member. |
| IDE0071 | [IDE0071](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0071), [interpolated strings](https://learn.microsoft.com/dotnet/csharp/language-reference/tokens/interpolated#structure-of-an-interpolated-string) | A hole formats `null` as an empty string where `ToString()` throws, and it calls `IFormattable.ToString` rather than `ToString()`. Only receivers declared as a built-in value type or enum are simplified, and only in strings that are provably `string`. |
| IDE0047, IDE0048 | [IDE0047/IDE0048](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0047-ide0048) | Parentheses are removed only when the grouping is unchanged. Argument lists are never parentheses: `await f(x)` inside `if (...)`, `while (...)` and lambda arguments is read as a call. |
| IDE0230, IDE0330, IDE0340 | [IDE0230](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0230), [IDE0330](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0330), [IDE0340](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0340) | `u8` literals need C# 11 and are not used in attribute arguments, which must be constants. `System.Threading.Lock` needs .NET 9, and `nameof(List<>)` needs C# 14. |
| Insert blank line padding (setting) | - | Padding before a member goes above the comments on the lines just before it, and never adds a second blank line. |

### Code-quality rules and diagnostics without an option

These rules have no code-style option. Each applies while its diagnostic is `suggestion`, `warning`
or `error` through `dotnet_diagnostic.<ID>.severity`, its category's
`dotnet_analyzer_diagnostic.category-<Category>.severity` (`Performance`, `Usage`,
`Maintainability` or `Style`) or `dotnet_analyzer_diagnostic.severity`; unset, `silent` and `none`
leave the code alone. Like the .NET analyzers they skip generated code and code suppressed with
`#pragma warning disable` or `[SuppressMessage]`. They run in the code-style stage, before the
member preferences (so `csharp_preferred_modifier_order` orders the `static`/`sealed` they add).

| Diagnostic | Behavior |
| --- | --- |
| CA1822 | Makes methods and non-auto, get-only properties `static` when they use no instance data (no `this`/`base`, instance member, member of `object` or primary-constructor parameter) and drops `this.` from their calls in the file, repeating until nothing more changes. Follows Roslyn's exclusions (virtual, override, abstract, interface implementations, test methods, `[Obsolete]`, event handlers, members that only throw, members used as delegates) and `dotnet_code_quality.api_surface` (default: all). Reported instead: public API (a breaking change), members used through another instance or through a member access in another project file, members of partial types, uses of names that may be inherited from an unknown base type, public members that may implement an interface declared outside the project, `readonly` members, properties with setters and members with other attributes. |
| CA1852 | Seals classes and records that are not visible outside the assembly and that no type of the project derives from or uses as a generic constraint. With `InternalsVisibleTo` the rule is off unless `dotnet_code_quality.CA1852.ignore_internalsvisibleto = true`, and then only reported. Partial types, types with `virtual` or `protected` members, files without a project and projects whose files cannot all be read are reported. |
| CA1805 | Removes field and auto-property initializers that assign the default value (`0`, `false`, `'\0'`, `null`, `default`); instance fields of structs are skipped, as in Roslyn. Reported: `0` for a type it cannot resolve (an enum?) and fields nothing else assigns (removing the initializer would raise CS0649). |
| CA1825 | `new T[0]` and `new T[] { }` become `Array.Empty<T>()` (`System.Array` without `using System` or implicit usings); attributes are skipped. Reported: an unknown target framework, or a lambda that may be an expression tree. |
| CA1827, CA1828 | `Count()`/`LongCount()` compared with `0` or `1` becomes `Any()`; an awaited `CountAsync()`/`LongCountAsync()` becomes `AnyAsync()` in files using Entity Framework. Receivers of unknown type are reported. |
| CA1829, CA1860 | `Count()` becomes `Length`/`Count` and `Any()` becomes `Length != 0`/`Count != 0` (`== 0` for `!Any()`) on arrays, strings and the .NET collections. |
| CA1507 | A string literal naming a parameter in scope, passed as `paramName` (`ArgumentException`, `ArgumentNullException`, `ArgumentOutOfRangeException`, their `ThrowIf` helpers, any `paramName:` argument), or a property of the type passed as `propertyName` (`PropertyChangedEventArgs`, `PropertyChangingEventArgs`, `propertyName:`), becomes `nameof(...)`. |
| CA1834, CA1847 | `StringBuilder.Append("x")` becomes `Append('x')`; `string.Contains("x")` becomes `Contains('x')`. |
| CA1865, CA1866, CA1867 | `StartsWith`, `EndsWith`, `IndexOf` and `LastIndexOf` with a one-character string and an ordinal comparison (or the invariant culture and a printable ASCII character) use the char overload (CA1865). Without a comparison (CA1866) or with another one (CA1867) they are reported: the char overloads compare ordinally. |
| CA2249 | `s.IndexOf(x) >= 0`, `!= -1` and `== -1` become `s.Contains(x)`/`!s.Contains(x)` with the same comparison (`StringComparison.CurrentCulture` for a string without one, as in Roslyn's fix). |
| IDE0004 | Removes casts to the type the value already has: a literal, or a local, parameter, field or property declared with that exact type. |
| IDE0005 | Removes duplicate using directives and file-level usings of the file's own namespace or of one containing it. Other unnecessary usings need the compiler's binding and are neither removed nor reported. |
| IDE0051 | Removes private fields, properties, methods and events that no identifier in the file refers to, with their doc comments, repeating until nothing more changes. Reported: members of partial types, members with attributes, names that appear in a string literal or comment, fields of structs and `[Serializable]` types, and initializers that may have side effects. |
| IDE0052 | Reported only: private fields and properties that are assigned but never read. |

The rules that depend on a receiver's type need it from the file: a literal, `new T(...)`, or a
local, parameter, field or property declared with an explicit type (or with `var` and one of
those). The string rules and CA1825 need a target framework with the API they introduce, read from
the nearest `.csproj` (the analyzers are off for older frameworks); an unknown framework is
reported. CA1822 (for members visible to the whole project) and CA1852 read every C# file of the
project - the SDK's default items (outside `bin`, `obj` and nested projects) plus
`<Compile Include>` items - to prove that nothing else needs the old declaration.

#### Guards checked against the C# rules

Each rewrite was checked against the rule's documented fix and against the C# language rules that
would make the rewritten code invalid or change its meaning. A guard either skips the case (it is
not a violation of the rule) or reports it; `test/editorConfigQualityRules*.test.ts` and `test/sealedClass.test.ts` cover them.

| Rule | Rule documentation | C# constraints guarded |
| --- | --- | --- |
| CA1822 | [CA1822](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1822) | [`static`](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/static) members cannot use the instance ([CS0120](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/cs0120)): `this`/`base` anywhere in the body (lambdas, local functions, interpolations), instance fields, properties, methods and events, members of `object`, primary-constructor parameters and the `field` keyword. A static member cannot be called through an instance ([CS0176](https://learn.microsoft.com/dotnet/csharp/misc/cs0176)): calls through other expressions or `base.` are reported and `this.` is removed. A static member cannot be `virtual`, `abstract`, `override`, `readonly` or have a `readonly`/`init` accessor ([CS0106, CS0736](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/interface-implementation-errors), [readonly members](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/struct)). It also cannot implement an interface member, explicitly or implicitly. Other guards: other parts of partial types, members used as delegates, public API (a breaking change), and members visible to the project (all project files are scanned for member access; `InternalsVisibleTo` is reported). |
| CA1852 | [CA1852](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1852) | A [`sealed`](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/sealed) type cannot be derived from ([CS0509](https://learn.microsoft.com/dotnet/csharp/misc/cs0509)) or used as a constraint ([CS0701](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/generic-type-parameters-errors)); the whole project is scanned. A sealed type cannot declare new virtual members ([CS0549](https://learn.microsoft.com/dotnet/csharp/misc/cs0549)), and protected members raise [CS0628](https://learn.microsoft.com/dotnet/csharp/misc/cs0628). A type that contains an `abstract` member or nested type at any depth is never sealed, and neither the sealing setting nor CA1852 overrides this; while CA1852 is enforced it replaces the "Seal classes" setting. Also guarded: abstract, static and partial types, records as classes only, `ComImport`, and `InternalsVisibleTo` (off by default, reported with `ignore_internalsvisibleto`). |
| CA1805 | [CA1805](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1805) | Removing an initializer must not leave a field never assigned ([CS0649](https://learn.microsoft.com/dotnet/csharp/misc/cs0649)), so that case is reported. Nullable and boxed targets (`int? x = 0`, `object o = 0`) and `null!` are not defaults and are kept. Instance fields of structs, `const` fields and attributed fields are skipped. `0` for a type that cannot be resolved (an enum?) is reported. |
| CA1825 | [CA1825](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1825) | Attribute arguments must be constants, so they are skipped. Code in lambdas may be an [expression tree](https://learn.microsoft.com/dotnet/csharp/advanced-topics/expression-trees/) and is reported. Pointer, multi-dimensional and jagged arrays are skipped. `Array.Empty<T>()` must exist for the target framework. |
| CA1827, CA1828 | [CA1827](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1827), [CA1828](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1828) | The call must be LINQ's `Count`: the receiver is a known BCL sequence or collection, or the result of a LINQ operator on one; for CA1828 the file must use Entity Framework and declare no `CountAsync` of its own. Only the documented comparisons with `0`/`1` are rewritten. Expression trees are reported. Conditional access (`?.`) is skipped. |
| CA1829, CA1860 | [CA1829](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1829), [CA1860](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1860) | The receiver must be an array, a string or a BCL collection whose `Count`/`Length` property exists; types with their own `Any`/`IsEmpty` (immutable, concurrent) are skipped. [Operator precedence](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/) is kept by adding parentheses (`(x.Length != 0).ToString()`). Expression trees are reported. |
| CA1507 | [CA1507](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1507) | [`nameof`](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/nameof) needs the name in scope. A static local function or lambda cannot use enclosing parameters ([CS8421](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/local-function-errors)). Only the documented `paramName`/`propertyName` parameters are rewritten, and constructor overloads are told apart by argument shape (`ArgumentException(message, inner)` is not a paramName). |
| CA1834, CA1847, CA1865-CA1867 | [CA1834](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1834), [CA1847](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1847), [CA1865-CA1867](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1865-ca1867) | The receiver must be provably `StringBuilder`/`string`, and the char overload must exist for the target framework. Culture-sensitive calls (no comparison, `ignoreCase: true`, other cultures) keep their string argument because the char overloads compare ordinally. `startIndex`/`count` arguments are kept. |
| CA2249 | [CA2249](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca2249) | Only `>= 0`, `!= -1` and `== -1` (either side for equality) are rewritten. `0 >= IndexOf(...)` is not equivalent and is skipped. The comparison is kept, and `CurrentCulture` is added for `IndexOf(string)`. The argument type must be known, and `Contains(char)`/`Contains(string, StringComparison)` must exist. |
| IDE0004 | [IDE0004](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0004) | Only identity [conversions](https://learn.microsoft.com/dotnet/csharp/programming-guide/types/casting-and-type-conversions) are removed: literal type or exact declared type, including nullability. Casts followed by member access or invocation are kept, because a struct copy would become the original. A space is kept after keywords (`return(int)x`). |
| IDE0005 | [IDE0005](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0005) | Only duplicates in one scope ([CS0105](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/using-directive-errors)) and file-level usings of the enclosing namespace are removed, per [using directive](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/using-directive) lookup. Files with `#if` around usings, global attributes, or other top-level code are skipped. Aliases and `global using` are skipped. |
| IDE0051, IDE0052 | [IDE0051](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0051), [IDE0052](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0052) | Removal must not drop side effects (initializers other than constants are reported) or break reflection and serialization (attributes, names in strings or comments, fields of structs and `[Serializable]` types are reported). Explicit interface implementations, `Main`, `ShouldSerialize*`/`Reset*`, and `extern`/`partial` members are skipped, as are members of partial types or of types the parser could not fully read. |

### Naming rules

`dotnet_naming_rule`, `dotnet_naming_symbols` and `dotnet_naming_style` entries (IDE1006) are
read as Roslyn reads them: all symbol kinds (including `local_function`, `type_parameter` and
`*`), accessibilities (including `local`, `private_protected` and `protected_internal`),
`required_modifiers` (`abstract`, `async`, `const`, `readonly`, `static`), the five
capitalizations, `required_prefix`, `required_suffix` and `word_separator`. Rules are ordered by
specificity (modifiers, then accessibilities, then symbol kinds), then by name, and the first rule
matching a symbol decides, even when the name already complies with it. The new name is the one
the Visual Studio naming fix proposes (so `m_count` and `count` become `_count` under a
`_camelCase` style).

Renames are made only when every reference is in the same file and can be identified from the
syntax: private members (explicitly or by default) of non-partial types, locals, local functions,
parameters of lambdas, local functions and private methods or constructors (including named
arguments and `<param>`/`<paramref>` documentation), and type parameters. References through
`this.`, the type name, `nameof`, interpolated strings, `<see cref>` and parameters or locals
declared with the containing type are updated; strings and comments are not. Everything else is
reported instead of renamed, for example:

- types, namespaces and non-private members or their parameters, which other files may use;
- members of partial types, overrides, explicit interface implementations and `extern` members;
- a new name that is already used where it would change what another reference means;
- a member read through an expression whose type is not evident (`GetOther().field`);
- names used in `switch` sections, switch expressions, patterns, deconstruction or code the
  cleanup parser cannot fully structure, and variables declared inside expressions (`out var`).

With `codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace` (off by default; `.codejanitor` key
`renamePublicSymbolsAcrossWorkspace`), **Cleanup Selected Files** and **Cleanup Workspace** also
rename the types and non-private members the cleaned files declare, in every `.cs` file of their
project and of the projects referencing it (`<ProjectReference>`, directly or not). The renames are
listed in a dialog first and applied as one edit, undone with a single Undo; cleanup on save and
Cleanup Active File never make them. Like the in-file renames they are syntactic, so a rename is
only made when:

- every declaration of the old name in those projects is renamed with it (overloads, or the same
  member of several types getting the same new name) or is a local or parameter whose scope is
  known, and the new name is not declared or used there yet;
- the old name does not appear as text: in strings (reflection), preprocessor symbols, or XAML,
  Razor or JSON files of the projects;
- code outside the workspace cannot depend on it: public symbols of a project that builds a NuGet
  package (`IsPackable`, `GeneratePackageOnBuild`, `PackageId`) and internal symbols of an assembly
  with `InternalsVisibleTo` are reported, as are members of types whose base types are declared
  outside the workspace;
- the member is not virtual, abstract, an override, `new`, extern, partial, an interface member,
  or annotated with attributes, and no serialization attribute (`[DataContract]`, `[JsonProperty]`,
  ...) makes the name part of a data format; attribute classes are not renamed.

Top-level statements are not parsed reliably, so a name they use is not renamed. Everything
refused is reported in the Code Janitor output channel with the reason.

### One type per file

Roslyn has no rule for this, so cleanup follows the analyzer rules a repository enforces with an
explicit `dotnet_diagnostic.<ID>.severity` of `suggestion`, `warning` or `error` (a bulk severity
does not show whether the analyzer is installed):

| Rule | Cleanup |
| --- | --- |
| `SA1402` (StyleCop) | Moves every class but one to its own file; other kinds may stay, as with StyleCop's default `topLevelTypes`. |
| `MA0048` (Meziantou) | Moves every type not named like the file to its own file. |
| `SA1649` (StyleCop) | Reports a first type not named like the file. |

Before the other cleanup steps, the types are moved with the same split as **Split Top-Level
Types**: the type named like the file (or the first one) stays, each other type gets a file named
after it (`Box{T}.cs` for generics) in the same folder, and new files are cleaned like any other
file. This happens for every cleanup command and for cleanup on save (the preview does not split),
and the summary counts the files created. Files are never renamed or overwritten: when a target
file already exists, the file uses preprocessor directives, assembly attributes or several
namespaces, or a type is partial or a struct, the type stays and the violation is reported. File
names are compared up to the first dot, so `Form.Designer.cs` and `View.xaml.cs` match `Form` and
`View`.

## AI features (optional)

Generating XML documentation, explaining code, reviewing it, refactoring it, generating unit
tests, analyzing coverage reports, and generating tests from coverage gaps all use AI, through GitHub Copilot (if you have the Copilot Chat extension) or a custom
OpenAI/Claude-compatible endpoint you configure yourself. Every plain cleanup command works with no
AI, no account and no network access at all.

Generating XML documentation can also run across a selection or the whole workspace at once
(**Generate XML Documentation (AI, Selected Files / Workspace)**). Files are scanned locally first, without an AI request, so if any AI request would actually be sent you get a single confirmation stating exactly how
many, across how many files, before anything happens. **Clean and Refactor (Cleanup + AI)** cleans
the active file and then offers the AI refactor for it - the refactor step still shows its usual
diff preview and asks before applying anything.

**Analyze Coverage Report (AI)** looks for common .NET coverage outputs (`coverage.cobertura.xml`,
`coverage.opencover.xml`, `lcov.info`, `*.coveragexml`, `*.coverage.xml`) and opens a focused
markdown report with the highest-risk gaps and the tests to add first.

**Generate Tests From Coverage Gaps (AI)** uses the same coverage reports, lets you pick a source
file referenced by the report, and opens a generated C# test class focused on the uncovered code.

## Scope and review

The C# cleanup engine uses a TypeScript parser, without Roslyn semantic analysis. Syntax
modernization rules can depend on your project's language version and usage; review changes and
run your normal build and tests. Non-C# cleanup is optional and limited to layout rules.

AI actions send the selected code or report context to the provider you configure. Use a provider
appropriate for the source code you are working with, and review generated output before use.

## Development and support

See [the development guide](PLAN.md) for architecture and verification commands and
[CHANGELOG.md](CHANGELOG.md) for release history. Report reproducible problems in
[GitHub Issues](https://github.com/edgarus-labs/code-janitor-vscode/issues), including the extension
version, VS Code version, relevant settings and a minimal example without credentials or private code.

## Project origin

This extension ports cleanup functionality from
[Code Janitor for Visual Studio](https://github.com/edgarus-labs/code-janitor-vs), an independently
maintained fork of [CodeMaid](https://github.com/codecadwallader/codemaid), originally created by
[Steve Cadwallader](https://github.com/codecadwallader). It is a separate VS Code implementation
with its own feature set and is not an official CodeMaid extension.

## License

LGPL-3.0, same as the source Visual Studio extension - see [LICENSE.txt](LICENSE.txt).

