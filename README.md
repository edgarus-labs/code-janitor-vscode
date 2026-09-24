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
- **Code Janitor: Cleanup Active File** cleans the file you're currently editing.
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
| Sort usings | `dotnet_sort_system_directives_first` | `false` sorts alphabetically without putting `System` first. |
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
listed once per file in the **Code Janitor** output channel as not supported. Rules at `silent` or
`none` require nothing and are not listed, nor are Visual Basic options.

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
| `csharp_style_var_for_built_in_types`, `csharp_style_var_when_type_is_apparent`, `csharp_style_var_elsewhere` | IDE0007, IDE0008 | Local declarations only. The type must follow from the initializer (literal, `new T()`, `(T)x`, `x as T`, `default(T)`, `new T[n]`); other declarations are reported. |
| `csharp_prefer_braces` | IDE0011 | `true` and `when_multiline` add braces; `false` never removes them. |
| `dotnet_style_qualification_for_field`, `_property`, `_method`, `_event` | IDE0003, IDE0009 | Adds or removes `this.` for members declared in the same type in the file, unless a local, parameter or type parameter of the same name exists in the member. `this.` on other members is reported. |
| `csharp_using_directive_placement` | IDE0065 | `outside_namespace` moves usings whose name starts with `global::`, `System`, `Microsoft` or the namespace's first segment; other usings, and `inside_namespace`, are reported. |
| `csharp_style_inlined_variable_declaration` | IDE0018 | Inlines `T x;` into the following `out x` as `out T x` when the variable keeps its scope. |
| `file_header_template` | IDE0073 | Inserts or replaces the leading `//` header; `{fileName}` is supported. |
| `dotnet_style_readonly_field` | IDE0044 | Adds `readonly` to private fields assigned only in constructors. |
| `csharp_prefer_simple_using_statement` | IDE0063 | Converts a `using (...) { }` that ends its block. |
| `csharp_style_implicit_object_creation_when_type_is_apparent` | IDE0090 | `new T(...)` becomes `new(...)` in variable, field, property and parameter declarations whose declared type is `T`. |
| `csharp_prefer_simple_default_expression` | IDE0034 | `default(T)` becomes `default` where `T` is the declared type of the variable or parameter, or the return type of the (non-async) method returning it. |
| `csharp_style_prefer_index_operator` | IDE0056 | `x[x.Length - n]`/`x[x.Count - n]` becomes `x[^n]` for simple receivers. |
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

Rewrites of index/range access, `is` patterns, `throw` expressions and UTF-8 literals are never
made inside a lambda that could become an expression tree. For `false`, the options from IDE0090
to IDE0340 change nothing (Roslyn reports nothing for them either). Every option cleanup reads is gated by its own
diagnostic, so `dotnet_diagnostic.<ID>.severity` also turns a single rule on or off; this applies
to the unsupported-settings list too.

Formatting: `indent_style` (with `tab_width`/`indent_size`), `end_of_line`, `insert_final_newline`,
`trim_trailing_whitespace` and `charset` (`utf-8` removes a byte order mark, `utf-8-bom` keeps
one) always apply, as do `dotnet_sort_system_directives_first = true` (sorts usings, `System`
first) and `dotnet_separate_import_directive_groups = true`, which have no diagnostic of their own.
As in Visual Studio, the C# formatting options have no severity of their own and apply only while
`IDE0055` is `suggestion`, `warning` or `error`: `csharp_new_line_before_open_brace`,
`csharp_new_line_before_else`, `csharp_new_line_before_catch`, `csharp_new_line_before_finally`,
`csharp_space_after_cast` and `csharp_space_after_keywords_in_control_flow_statements`.

Not supported: `csharp_style_pattern_matching_over_as_with_null_check` (IDE0019),
`dotnet_style_prefer_is_null_check_over_reference_equality_method` (IDE0041),
`csharp_indent_case_contents`, `csharp_indent_switch_labels`, re-indenting code to a different
`indent_size`, moving usings into a namespace, adding a byte order mark, renaming symbols other
files may reference, and other code-style and formatting options. Unlike the Visual Studio
extension, fixes from third-party analyzers are not applied.

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

