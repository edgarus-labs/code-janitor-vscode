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
- With `codeJanitor.cleanup.onlyChangedLines` (off by default), cleanup on save and **Cleanup
  Changed Files (Git)** only touch the lines changed since the last commit (`HEAD`; every line of
  a file Git does not know yet), so legacy files can be cleaned as they are edited. Changes on
  other lines are left out; a rule whose change covers both changed and unchanged lines (such as
  moving a whole namespace block to a file-scoped namespace) is skipped and reported in the output
  channel, and the changes left out are only dropped when the rule gives the same result once the
  rest is done (so no half-made change is kept). Names are not changed (naming violations on
  changed lines are reported), types are not moved to their own files, and other file types are
  left as they are. A file outside a Git repository is not cleaned and is reported.
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

The repository file is found from the cleaned file's folder upwards and the nearest `.codejanitor` (or `.code-janitor.json`) wins as a whole, so nested folders and multi-root workspaces can carry their own policy. A key it lists wins over the user's VS Code setting for files below it (`.editorconfig` wins over both where it enforces the option); a key it does not list follows the setting. Invalid JSON, unknown keys and values of the wrong type are ignored.

A `.codejanitor` written for the Visual Studio extension works here too, with two differences:

- **`.editorconfig` switches:** `applyEditorConfigFormatting`, `applyEditorConfigNaming` and
  `applyEditorConfigCodeStyle` have no effect, because in VS Code the `.editorconfig` rules always
  apply.
- **Third-party analyzers:** `applyAnalyzerCodeFixes` has no effect, because fixes from
  third-party analyzers are never applied here.

Each of these keys is listed in the **Code Janitor** output channel as ignored, once per session. The other way round, `renamePublicSymbolsAcrossWorkspace` and `onlyChangedLines` exist only in VS
Code, and the Visual Studio extension ignores them.

You can create or synchronize this file without editing JSON by opening **Code Janitor: Open
Settings** and using **Export .codejanitor** or **Import .codejanitor**. Export writes the cleanup
settings set in VS Code (in any scope) to the repository root, plus the values the overwritten file
already listed; a setting left at its default is not written, so it keeps following each user's
setting. Import copies the repository values into VS Code's workspace settings. While the file lists
a key, the settings panel shows it as *Overridden by .codejanitor* and disables its control.

### Diagnostics and quick fixes

While a C# file is open, Code Janitor shows its `.editorconfig` violations in the editor and the
Problems panel (source "Code Janitor"), a moment after you stop typing:

- each place an enforced rule would change, and each violation cleanup cannot fix, with the rule's
  `.editorconfig` severity (`error`, `warning`; `suggestion` shows as information) and its id
  linking to the rule's documentation;
- quick fixes: **Fix IDE0011** fixes that occurrence only (offered when the occurrence can be
  fixed on its own: the code must parse as before, and fixing the rest of the file afterwards must
  give the same result as fixing the whole file; a naming violation is fixed by renaming that one
  symbol), **Fix all IDE0011 in file** applies only that rule to the file, and **Run Code Janitor
  cleanup** runs the whole cleanup.

`codeJanitor.diagnostics.enabled` (on by default) turns them off; files larger than
`codeJanitor.diagnostics.maxFileSizeKB` (256) are not analyzed. The Code Janitor settings'
own steps (outside `.editorconfig`) are not shown as diagnostics.

### Check mode for CI

`npm run check -- [--root <repository root>] <file or folder>...`, from a clone of this
repository, runs the cleanup as a dry run over the C# files of the given paths (`bin` and `obj`
excluded) with each file's `.editorconfig` and the nearest `.codejanitor` of each file (default root: the
current folder). It needs neither VS Code nor the .NET SDK, prints one line per finding,
`file:line: rule (severity): message`, and exits with 1 when cleanup would change a file or an
enforced `.editorconfig` rule is violated in a way cleanup cannot fix (2 on a usage error).
Workspace-wide renames are not checked. For example, in GitHub Actions (with a read-only token, no
credentials left in `.git/config`, and Code Janitor pinned to a release tag or commit, so that a push to
its repository never changes what your CI runs):

```yaml
jobs:
  code-janitor:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/checkout@v4
        with:
          repository: <owner>/code-janitor-vscode
          ref: <release tag or commit SHA>
          path: .code-janitor
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
        working-directory: .code-janitor
      - run: npm run check --prefix .code-janitor -- --root "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE/src"
```

## .editorconfig rules (C#)

`.editorconfig` is the source of truth for C# code: whenever an `.editorconfig` applies to a file
(any `.editorconfig` from the file's folder up to the one with `root = true`, with nested files and
section globs), cleanup rewrites the code to follow its naming rules, code-style preferences and
formatting options. There is no setting to turn this on; without an `.editorconfig` (or a
`.globalconfig`, or an `AnalysisMode` that enables rules - see below) cleanup behaves as configured
by the Code Janitor settings alone. The `.editorconfig` rules run after
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
| Sort usings | `dotnet_sort_system_directives_first`, `dotnet_separate_import_directive_groups` | Whenever the option is set, usings are sorted in Roslyn's order (name by name, ignoring case first, `System` first only for `true`), even with the setting off; groups get a blank line between them (`true`) or none (`false`). |
| Remove end-of-line whitespace | `trim_trailing_whitespace` | Trailing whitespace is removed only for `true`. |
| Remove byte order mark | `charset` | `utf-8` removes it, `utf-8-bom` keeps it. |
| (final newline, always added) | `insert_final_newline` | Added for `true`, removed for `false`. |
| Convert to collection expressions | `dotnet_style_prefer_collection_expression` = `false`/`never` | No conversion. |
| Simplify single-statement lambdas | `csharp_style_expression_bodied_lambdas` other than `true` | No conversion. |

The other settings (regions, blank lines and padding, sealing, `nameof`, string interpolation,
pattern-matching null checks, accessor and single-line method layout, comment formatting) have no
`.editorconfig` counterpart and always apply as configured. The CA1869 setting (`new
JsonSerializerOptions()` arguments become `default(JsonSerializerOptions)`, or `null` when passed as
`options:`) also applies as configured; the CA1869 rule below caches configured options in a field.

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
  `dotnet_analyzer_diagnostic.severity`, or by the project (see below). `silent`, `none` and rules
  without a severity are left alone.
- **Safety.** There is no compiler or semantic model involved, so code is rewritten only where the
  result is certain from the syntax. Violations that cannot be fixed safely are left unchanged and
  listed in the **Code Janitor** output channel; batch cleanup counts them in its summary and
  finishes with a warning. String literals and comment text are never changed.

#### Where severities come from

Severities are read from the same sources as the C# compiler and the .NET SDK use
([configuration files](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/configuration-files),
[MSBuild properties](https://learn.microsoft.com/dotnet/core/project-sdk/msbuild-props#code-analysis-properties)),
from the nearest `.csproj` and the `Directory.Build.props`/`Directory.Build.targets` above it.
Only unconditional properties and items are read: anything with a `Condition` needs MSBuild to
evaluate and is ignored. In order of precedence:

1. `NoWarn` turns a rule off whatever the files say.
2. `dotnet_diagnostic.<ID>.severity` from `.editorconfig`, else from the global AnalyzerConfig files:
   `.globalconfig` in the folders above every compile item of the project, the file and the project (unless
   `DiscoverGlobalAnalyzerConfigFiles` is `false`) and `<GlobalAnalyzerConfigFiles>` items. Between
   global files the higher `global_level` wins (`.globalconfig` defaults to 100, other files to 0);
   two at the same level that disagree cancel each other, as in the compiler. Any other key of a
   global file applies too, below the `.editorconfig`.
3. The SDK's rule set for `AnalysisLevel` and `AnalysisMode` (`None`, `Default`, `Minimum`,
   `Recommended`, `All`; also compound levels such as `8-recommended`, and per category
   `AnalysisLevel<Category>`/`AnalysisMode<Category>`), copied from .NET SDK 10.0.112 for the rules
   cleanup implements. The code-style (IDE) rule set applies only when `AnalysisLevelStyle` or
   `AnalysisModeStyle` differ from the general ones, as in the SDK. Rule-specific, so it outranks
   the bulk severities.
4. `dotnet_analyzer_diagnostic.category-<Category>.severity`, then `dotnet_analyzer_diagnostic.severity`.
5. The option's own severity (`option = value:severity`, a naming rule's `severity`).

A resulting `warning` is an `error` under `WarningsAsErrors` or `TreatWarningsAsErrors` (minus
`WarningsNotAsErrors`; `CodeAnalysisTreatWarningsAsErrors = false` exempts the CA rules), and
`CodeAnalysisTreatWarningsAsErrors = true` makes the rule set's warnings errors.

The CA rules also have a default severity (most are `suggestion`) in every project where the .NET
analyzers run (.NET 5+ SDK projects, `EnableNETAnalyzers`, or the NetAnalyzers package). The
diagnostics view shows it, but cleanup never rewrites code on an implicit default: a rule must be
enabled explicitly by one of the sources above. An `AnalysisMode` of `Minimum`, `Recommended` or
`All` (general, per category or for the style rules) applies the rules it enables even in a project
without an `.editorconfig`. `EnforceCodeStyleInBuild` only decides whether
`dotnet build` runs the code-style rules; the editor applies them either way, so cleanup does not
read it.

Supported code-style options:

| Option | Diagnostic | Behavior |
| --- | --- | --- |
| `csharp_style_namespace_declarations` | IDE0160, IDE0161 | Converts the file's only namespace to file-scoped or block-scoped. |
| `dotnet_style_require_accessibility_modifiers` | IDE0040 | `always`/`for_non_interface_members` add the default modifier, `omit_if_default` removes it. Partial types and (for `always`) interface members are reported. |
| `csharp_style_var_for_built_in_types`, `csharp_style_var_when_type_is_apparent`, `csharp_style_var_elsewhere` | IDE0007, IDE0008 | Local declarations only. The type must follow from the initializer (literal, `new T()`, `(T)x`, `x as T`, `default(T)`, `new T[n]`). Other declarations are reported: for `false`, the `var` locals whose type is not known without a compiler get one line per file, with their line numbers. |
| `csharp_prefer_braces` | IDE0011 | `true` and `when_multiline` add braces; `false` never removes them. |
| `dotnet_style_qualification_for_field`, `_property`, `_method`, `_event` | IDE0003, IDE0009 | Adds or removes `this.` for members declared in the same type in the file, unless a local, parameter or type parameter of the same name exists in the member. `this.` on other members is reported. |
| `csharp_using_directive_placement` | IDE0065 | `outside_namespace` / `inside_namespace` move the using directives, only when the declarations of the project prove that every name binds as before (see the limitations table); otherwise they are reported. |
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
| `dotnet_style_predefined_type_for_locals_parameters_members`, `_for_member_access` | IDE0049 | `Int32`/`System.String` become `int`/`string` in type positions and member access (`string.Empty`); bare names only with `using System;`, in a file of a project whose files could all be read, when neither the file nor the project declares a type or a global using alias of that name. `false` is not supported. |
| `dotnet_style_prefer_compound_assignment` | IDE0054, IDE0074 | `x = x + y` becomes `x += y` (`x = x ?? y` becomes `x ??= y`) for a side-effect-free `x`. |
| `dotnet_style_prefer_simplified_boolean_expressions` | IDE0075 | `c ? true : false` becomes `c`, `c ? false : true` becomes `!c`, and `c ? true : y` / `c ? y : false` become `c \|\| y` / `c && y` when both sides are provably `bool`. |
| `dotnet_style_coalesce_expression` | IDE0029, IDE0030, IDE0270 | `x != null ? x : y` becomes `x ?? y` when `x` is declared as `string`, `object`, an array or an interface or base-less class of the file without `operator ==`; `x.HasValue ? x.Value : y` becomes `x ?? y` for nullable built-in value types. IDE0270: `T x = e; if (x == null) throw ...;` becomes `T x = e ?? throw ...;` under the same type condition for `T`. |
| `dotnet_style_null_propagation` | IDE0031 | `x != null ? x.Y : null` becomes `x?.Y` under the same type condition (any type for `x is not null`). |
| `csharp_style_conditional_delegate_call` | IDE1005 | `if (h != null) h(args);` becomes `h?.Invoke(args);`. |
| `dotnet_style_prefer_is_null_check_over_reference_equality_method` | IDE0041 | `ReferenceEquals(x, null)` becomes `x is null` (`!` gives `x is not null`) unless the file declares its own `ReferenceEquals`. |
| `csharp_style_prefer_not_pattern` | IDE0083 | `!(x is T)` becomes `x is not T` for type and constant patterns without a designation. |
| `csharp_style_prefer_pattern_matching` | IDE0078 | `x == 1 \|\| x == 2` becomes `x is 1 or 2`, `x >= 0 && x <= 9` becomes `x is >= 0 and <= 9`, for a value declared as `int`, `long`, `float`, `double`, `decimal`, `char`, `string` or `bool` compared with literals of its type. |
| `dotnet_style_prefer_inferred_tuple_names`, `dotnet_style_prefer_inferred_anonymous_type_member_names` | IDE0037 | `(x: x, y)` becomes `(x, y)` and `new { X = p.X }` becomes `new { p.X }` when C# infers the same, unique name. |
| `dotnet_style_prefer_conditional_expression_over_assignment`, `_over_return` | IDE0045, IDE0046 | `if (c) x = a; else x = b;` becomes `x = c ? a : b;` (a preceding `T x;` takes the initializer, unless a comment or directive sits in between), `if (c) return a; [else] return b;` becomes `return c ? a : b;`, when the type is `bool`, `int`, `long`, `decimal` or `string` (for other types the conditional could change a value's type) and the result fits on one line. Before C# 9 a conditional that needs a target type (`c ? 1 : null`, mixed numeric literals) is left unchanged. |
| `dotnet_style_object_initializer`, `dotnet_style_collection_initializer` | IDE0017, IDE0028 | Member assignments (`c.A = 1;`) and `Add` calls on `List`, `HashSet`, `SortedSet`, `Collection`, `ObservableCollection`, `Dictionary`, `SortedDictionary`, `SortedList` right after `var c = new T(...);` move into an initializer, as long as they do not use `c`. |
| `dotnet_style_prefer_auto_properties` | IDE0032 | A property that only returns (and sets) a private field used nowhere else becomes an auto property, with the field initializer; a field used elsewhere is reported. |
| `csharp_style_expression_bodied_methods`, `_constructors`, `_operators`, `_properties`, `_indexers`, `_accessors`, `_local_functions` | IDE0021 – IDE0027, IDE0061 | `true` turns a body holding a single `return`, expression or `throw` statement into `=> ...;`, `false` does the reverse, `when_on_single_line` only for one-line expressions (lambdas: see IDE0053). |
| `csharp_style_prefer_readonly_struct` | IDE0250 | Adds `readonly` to non-partial structs with only `readonly` instance fields, no settable auto property or field-like event, no write to a primary-constructor parameter, that never assign `this` outside a constructor. |
| `csharp_prefer_static_local_function` | IDE0062 | Adds `static` to local functions that use no `this`, instance member, local or parameter of the enclosing code (types with a base class are skipped: inherited members are unknown). |
| `csharp_preferred_modifier_order` | IDE0036 | Reorders modifiers to the listed order (`partial` stays last); declarations with a modifier outside the list are left alone. |
| `csharp_style_prefer_switch_expression` | IDE0066 | A `switch` whose sections only `return` (or `throw`), or only assign one variable and `break`, becomes a switch expression (`case 1: case 2:` gives `1 or 2`); without `default`, a `return` right after the switch becomes the `_` arm. Only for the target types of IDE0045 and enums declared in the file. |
| `csharp_style_pattern_matching_over_as_with_null_check` | IDE0019, IDE0260 | `var s = o as T; if (s != null ...)` becomes `if (o is T s ...)` when `s` is used only inside the `if` and never assigned, and `T` cannot define its own `!=` (a class of the BCL or of the file without `operator ==`; `s is not null` always qualifies). IDE0260: `(o as T) != null` becomes `o is T` and `(o as T) == null` becomes `o is not T` for a class `T` of the BCL or the file; `(o as T)?.Member` is reported. |
| `csharp_style_pattern_matching_over_is_with_cast_check` | IDE0020 | `if (o is T) { var t = (T)o; ... }` becomes `if (o is T t) { ... }` when `t` is never assigned and the name `t` is not used outside the `if` body (the pattern variable would capture it). |
| `dotnet_style_explicit_tuple_names` | IDE0033 | `t.Item1` becomes `t.count` when `t` is declared in the file with a named tuple type. |
| `dotnet_style_prefer_simplified_interpolation` | IDE0071 | `{x.ToString()}` becomes `{x}` and `{x.ToString("N2")}` becomes `{x:N2}` in `$"..."` strings that are provably `string` (a `var`/`string` initializer, a `string` return, a `+` operand), when `x` is declared as a built-in value type or an enum; other receivers are reported. |
| `csharp_style_prefer_extended_property_pattern` | IDE0170 | `{ A: { B: p } }` becomes `{ A.B: p }` in `is` patterns. |
| `csharp_style_prefer_method_group_conversion` | IDE0200 | `x => M(x)` becomes `M` when `M` is the file's only method of that name and its parameter and return types match the written `Func`/`Action` type (or the lambda's parameter types, for a `void` method); other forwarding lambdas are reported. |
| `csharp_style_expression_bodied_lambdas` | IDE0053 | `x => { return e; }` becomes `x => e`; lambdas whose conversion could change the delegate type they bind to are reported. |
| `csharp_style_prefer_readonly_struct_member` | IDE0251 | Adds `readonly` to struct methods and get-only properties that assign nothing but their locals, pass nothing by reference, take no `ref` to the instance, and call only `static`/`readonly` members of the struct or methods of reference-type fields; `ref`-returning members are skipped. |
| `dotnet_style_namespace_match_folder` | IDE0130 | Reported only: a namespace other than the project's `RootNamespace` (or project file name) plus the file's folders. |
| `dotnet_code_quality_unused_parameters` | IDE0060 | Reported only: parameters a method, constructor or local function never uses (overrides, virtual, abstract, partial, event handlers, methods that only throw, and public methods of types with a base list are skipped). |
| `dotnet_style_prefer_collection_expression` | IDE0300 - IDE0306 | `true`, `when_types_exactly_match` and `when_types_loosely_match` turn `new T[] { ... }`, `new[] { ... }`, `{ ... }` array initializers, `new List<T> { ... }` (and other BCL collections), `Array.Empty<T>()`, `ImmutableArray.Create(...)`/`ImmutableList.Create(...)` (.NET 8 or later) and `xs.ToList()`/`ToArray()` into `[...]`, `[]` or `[.. xs]`, only where the target's written type is the created type (not `var`, not arguments). `CreateBuilder` sequences (IDE0304) and receivers that may be null are reported. Needs C# 12. |
| `csharp_prefer_static_anonymous_function` | IDE0320 | Adds `static` to lambdas and anonymous methods that capture nothing: no `this`/`base`, local, parameter or instance member (in partial types and types with a base class, only names declared in the function itself; a base list of interfaces declared in the file, the project or the .NET library does not count). Needs C# 9. |
| `csharp_style_prefer_simple_property_accessors` | IDE0360 | `get { return field; }`/`get => field;` become `get;` and `set { field = value; }`/`set => field = value;` become `set;` (C# 14), unless the type declares a member named `field`. |
| `csharp_style_unused_value_expression_statement_preference` | IDE0058 | `discard_variable`: a statement calling a method of the calling type (declared once; not in partial types, types with a base class or interfaces with base interfaces) whose value is not used becomes `_ = M();`. `unused_local_variable` is reported: the variable would need a name. |
| `csharp_style_unused_value_assignment_preference` | IDE0059 | `T x = <literal>;` directly followed by an assignment to `x` that does not read it loses its initializer; other initializers, which may have side effects, are reported. |
| `csharp_style_prefer_top_level_statements` | IDE0210, IDE0211 | Reported only: `true` lists a `Main` that top-level statements could replace, `false` lists top-level statements. |
| `dotnet_style_prefer_foreach_explicit_cast_in_source` | IDE0220 | Reported only: `foreach (T x in items)` over elements declared `object`, where the compiler inserts a cast. |
| `dotnet_prefer_system_hash_code` | IDE0070 | Reported only: `GetHashCode` overrides that combine values by hand where `HashCode.Combine` would do. |
| `dotnet_style_allow_multiple_blank_lines_experimental` | IDE2000 | `false`: two or more blank lines in a row become one. |
| `csharp_style_allow_embedded_statements_on_same_line_experimental` | IDE2001 | `false`: a statement written on the line of its `if (...)`, `else`, `while (...)`, `for (...)`, `foreach (...)`, `using (...)` or `lock (...)` moves to its own line (one-line statements only; `else if` stays together). |
| `csharp_style_allow_blank_lines_between_consecutive_braces_experimental` | IDE2002 | `false`: blank lines between two closing braces go. |
| `dotnet_style_allow_statement_immediately_after_block_experimental` | IDE2003 | `false`: a statement right after a block's `}` gets a blank line before it. |
| `csharp_style_allow_blank_line_after_colon_in_constructor_initializer_experimental`, `csharp_style_allow_blank_line_after_token_in_conditional_expression_experimental`, `csharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental` | IDE2004 - IDE2006 | `false`: blank lines after a line ending in the constructor initializer's `:`, a conditional's `?`/`:` or `=>` go. |

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
one) always apply, as do `dotnet_sort_system_directives_first` (sorts usings in Roslyn's order, `System` first for
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

Not supported (reported when enforced): `dotnet_style_prefer_non_hidden_explicit_cast_in_source`
(IDE0221), moves of using directives that cannot be proven safe, adding a byte order mark, renaming symbols other files
may reference, and other code-style options. Unlike the
Visual Studio extension, fixes from third-party analyzers are not applied: their
`dotnet_diagnostic.<ID>.severity` entries (e.g. Roslynator's `RCS1079`) are listed as third-party
rules that cleanup does not apply.

#### Code-style guards checked against the C# rules

Each code-style rewrite, and each Code Janitor setting that does the same kind of rewrite, was checked against two things: the rule's documented fix, and the C# rules that would make the rewritten code invalid or change what it does. Guarded cases are left unchanged, and for the `.editorconfig` rules they are listed in the output channel. `test/editorConfigAudit.test.ts` covers the guards added by this check. Style rule pages are under `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/`.

| Rule | Documentation | C# constraints guarded |
| --- | --- | --- |
| Every rule | [C# language version defaults](https://learn.microsoft.com/dotnet/csharp/language-reference/configure-language-version#c-language-version-reference), [version history](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-version-history) | The project's C# version is taken from its `<LangVersion>`, then from `Directory.Build.props`, then from its target framework's default (.NET Framework and .NET Standard 2.0 default to 7.3). A rewrite that needs newer syntax (switch expressions, `is not null`, `new()`, file-scoped namespaces, `u8`, `nameof(List<>)`, ...) is skipped and reported. Index, range and UTF-8 literal rewrites also need a target whose runtime has `System.Index`, `System.Range` and `ReadOnlySpan<byte>`. A rewrite whose result the parser reads less completely than its input is discarded. |
| IDE0160, IDE0161 | [IDE0160/IDE0161](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0160-ide0161) | Only files with a single namespace (no nested or sibling namespaces, no types or attributes outside it) are converted. File-scoped namespaces are written only for a project known to use C# 10 or newer; an unknown language version keeps the namespace block-scoped and is reported. Lines inside multi-line string literals are never re-indented. A `#if` or `#region` block that starts outside the namespace braces and ends inside them (or the reverse) is reported and the namespace is not converted. Using directives inside the namespace stay there; they move only with the using directive placement. |
| IDE0065, Move usings outside/inside namespace | [IDE0065](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0065), [using directive](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/using-directive) | Without Roslyn's semantic model the move relies on an index of the namespaces, types and extension methods declared by the project and the projects it references, plus the public surface of the .NET reference assemblies. A directive moves only when that index proves that every name of the file binds as before; it is written fully qualified (`using Company.App.Services;`) or `global::`-qualified when its meaning would otherwise change, and keeps its text when it means the same at its new place (`System...`, `global::`, `using static`, aliases of special types, `extern alias` qualified names). Packages are not indexed: a namespace of a referenced package is assumed not to reuse a name the project or the framework declares for something the file uses. The file is left unchanged, with the reason in the output, when a directive cannot be resolved, a used name or extension method would bind to another symbol (a same-named type or extension method of an enclosing namespace, another directive, a `global using`), merging the directives would make a name ambiguous, the directives are interleaved with `#if`/`#region`/`#nullable`/`#pragma`, an extern alias declared inside the namespace is used, a directive shares its line with code, or the file is not part of exactly one C# project (files compiled from outside the project folder make the index incomplete). Inwards, files without a single namespace, with types, top-level statements or `[assembly: ...]` outside it are left alone without a report. `global using` and `extern alias` directives stay at file level. |
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
| IDE0300 - IDE0306 | [IDE0300](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0300), [collection expressions](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/collection-expressions) | A collection expression takes the type of its target: for `IEnumerable<T>`, `object[]` from `new[] { "a" }`, or `var`, the created type would change or not be known. Only targets written with exactly the created type are rewritten; arguments are skipped because the chosen overload could change. `[.. xs]` throws `NullReferenceException` where `ToList()` throws `ArgumentNullException`, so receivers that may be null are reported. Needs C# 12, and .NET 8 for `ImmutableArray`. |
| IDE0320 | [IDE0320](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0320), [static anonymous functions](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/lambda-expressions#static-anonymous-functions) | A static anonymous function cannot capture locals, parameters or `this` ([CS8820](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/lambda-expression-errors)). Every name it uses must be declared inside it, be a static member of the type, or be used as a type or namespace; in types with a base class, where inherited members are unknown, only names declared inside it. Needs C# 9. |
| IDE0360 | [IDE0360](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0360), [`field` keyword](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/field) | `field` is a keyword only in C# 14 accessors; a type with a member named `field` is skipped, since there it names that member. |
| IDE0270, IDE0260 | [IDE0270](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0029-ide0030-ide0270), [IDE0260](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0078-ide0260) | `x == null` and `(o as T) != null` equal the `??`/`is` forms only when `T` cannot define its own `==`: classes of the BCL or of the file without `operator ==`. `(o as T)?.Member` needs the member's type for a property pattern and is reported. |
| IDE0001, IDE0002 | [IDE0001](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0001), [IDE0002](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0002), [name lookup](https://learn.microsoft.com/dotnet/csharp/language-reference/language-specification/basic-concepts#77-name-lookup) | A shortened name must bind to the same symbol. It must not be declared by the file or the project (a type, member, local or parameter), every imported namespace must be a .NET one, and names that exist in several .NET namespaces (`Timer`, `Path`, ...) are kept. Files outside a readable project are left alone. |
| IDE0035 | [IDE0035](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0035), [`goto`](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/jump-statements#the-goto-statement) | Code after a jump is reachable through a label, and a local function after it can be called from before it; such blocks are kept, as are blocks with comments or directives. |
| IDE0058, IDE0059 | [IDE0058](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0058), [IDE0059](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0059), [discards](https://learn.microsoft.com/dotnet/csharp/fundamentals/functional/discards) | Only calls to a method of the calling type whose return type is written there (one declaration, not `void`, `dynamic` or awaitable) get `_ =`, and not where a local of the method's name hides it; partial types and types with a base class are skipped, because overloads may be declared elsewhere. An initializer is removed only when it is a literal (no side effects) and the next statement assigns the variable without reading it. |
| IDE0080, IDE0100, IDE0110 | [IDE0080](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0080), [IDE0100](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0100), [IDE0110](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0110) | `x == true` equals `x` only for `bool` (not `bool?` or a type with its own operators). `T _` becomes a type pattern only when no value named `T` could turn it into a constant pattern. `!` is removed only where the value is never null. |
| IDE0082, IDE0280 | [IDE0082](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0082), [IDE0280](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0280), [`nameof`](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/nameof) | `nameof` gives the name as written: generic types (`List`1`), type parameters and aliases have another runtime name. Parameter names in attributes need C# 11. |
| IDE0064, IDE0380, IDE0240 | [IDE0064](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0064), [IDE0380](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0380), [IDE0240](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0240) | Assigning `this` overwrites `readonly` fields ([CS0191](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/cs0191)). `unsafe` stays wherever pointer syntax, `stackalloc`, `fixed` or `sizeof` appears. The nullable context under `#if` depends on symbols, so directives there are kept. A `<Nullable>` set under an MSBuild `Condition`, by an unresolved import or to another property is unknown: a directive that may repeat it is reported and kept. |
| IDE2000 - IDE2006 | [IDE2000](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide2000) | Only whitespace between tokens changes, never inside strings or comments; statements spanning several lines are not moved by IDE2001. |
| Insert blank line padding (setting) | - | Padding before a member goes above the comments on the lines just before it, and never adds a second blank line. |

### Code-quality rules and diagnostics without an option

These rules have no code-style option. Each applies while its diagnostic is `suggestion`, `warning`
or `error` through `dotnet_diagnostic.<ID>.severity`, the project's analysis mode, its category's
`dotnet_analyzer_diagnostic.category-<Category>.severity` (`Performance`, `Usage`, `Reliability`,
`Globalization`, `Maintainability` or `Style`) or `dotnet_analyzer_diagnostic.severity`; unset,
`silent` and `none` leave the code alone. Like the .NET analyzers they skip generated code and code
suppressed with `#pragma warning disable` or `[SuppressMessage]`. They run in the code-style stage,
before the member preferences (so `csharp_preferred_modifier_order` orders the `static`/`sealed`
they add).

| Diagnostic | Behavior |
| --- | --- |
| CA1822 | Makes methods and non-auto, get-only properties `static` when they use no instance data (no `this`/`base`, instance member, member of `object` or primary-constructor parameter) and drops `this.` from their calls in the file, repeating until nothing more changes. Follows Roslyn's exclusions (virtual, override, abstract, interface implementations, test methods, `[Obsolete]`, event handlers, members that only throw, members used as delegates) and `dotnet_code_quality.api_surface` (default: all). Reported instead: public API (a breaking change), members used through another instance or through a member access in another project file, members of partial types, uses of names that may be inherited from an unknown base type, public members that may implement an interface declared outside the project, `readonly` members, properties with setters and members with other attributes. |
| CA1852 | Seals classes and records that are not visible outside the assembly and that no type of the project derives from or uses as a generic constraint. With `InternalsVisibleTo` the rule is off unless `dotnet_code_quality.CA1852.ignore_internalsvisibleto = true`, and then only reported. Partial types, types with `virtual` or `protected` members, types the project casts to or tests with `as`, `is` or a pattern (sealing can make a conversion from an interface a compile error), files without a project and projects whose files cannot all be read are reported. |
| CA1805 | Removes field and auto-property initializers that assign the default value (`0`, `false`, `'\0'`, `null`, `default`); instance fields of structs are skipped, as in Roslyn. Reported: `0` for a type it cannot resolve (an enum?) and fields nothing else assigns (removing the initializer would raise CS0649). |
| CA1825 | `new T[0]` and `new T[] { }` become `Array.Empty<T>()` (`System.Array` without `using System` or implicit usings, or when a member, local or parameter named `Array` may be in scope); attributes are skipped. Reported: an unknown target framework, or a lambda that may be an expression tree. |
| CA1827, CA1828 | `Count()`/`LongCount()` compared with `0` or `1` becomes `Any()`; an awaited `CountAsync()`/`LongCountAsync()` becomes `AnyAsync()` in files using Entity Framework. Receivers of unknown type are reported. |
| CA1829, CA1860 | `Count()` becomes `Length`/`Count` and `Any()` becomes `Length != 0`/`Count != 0` (`== 0` for `!Any()`) on arrays, strings and the .NET collections. |
| CA1507 | A string literal naming a parameter in scope, passed as `paramName` (`ArgumentException`, `ArgumentNullException`, `ArgumentOutOfRangeException`, their `ThrowIf` helpers, any `paramName:` argument), or a property of the type passed as `propertyName` (`PropertyChangedEventArgs`, `PropertyChangingEventArgs`, `propertyName:`), becomes `nameof(...)`. |
| CA1834, CA1847 | `StringBuilder.Append("x")` becomes `Append('x')`; `string.Contains("x")` becomes `Contains('x')`. |
| CA1865, CA1866, CA1867 | `StartsWith`, `EndsWith`, `IndexOf` and `LastIndexOf` with a one-character string and an ordinal comparison (or the invariant culture and a printable ASCII character) use the char overload (CA1865). Without a comparison (CA1866) or with another one (CA1867) they are reported: the char overloads compare ordinally. |
| CA2249 | `s.IndexOf(x) >= 0`, `!= -1` and `== -1` become `s.Contains(x)`/`!s.Contains(x)` with the same comparison (`StringComparison.CurrentCulture` for a string without one, as in Roslyn's fix). |
| CA1858 | `s.IndexOf(x) == 0`/`!= 0` becomes `s.StartsWith(x)`/`!s.StartsWith(x)` for a `char` or an ordinal comparison. Culture-sensitive ones are reported: ignorable characters can make `StartsWith` true where `IndexOf` is not 0. |
| CA1862 | `s.ToUpperInvariant() == "ABC"` (an upper-case ASCII literal, either side, `==`/`!=`) becomes `string.Equals(s, "ABC", StringComparison.OrdinalIgnoreCase)`. Every other case-changing comparison is reported: no `StringComparison` compares exactly like `ToLower`/`ToUpper`, `ToLowerInvariant` or two changed strings. |
| CA1305, CA1307, CA1310 | Reported only: formatting and parsing without an `IFormatProvider` (`ToString()` of numbers and dates, `Parse`, `string.Format`), and string comparisons without a `StringComparison` (culture-sensitive ones for CA1310). Choosing a culture or comparison changes what the code does. |
| CA1836 | `Count`/`Length`/`Count()` compared with `0` or `1` becomes `IsEmpty`/`!IsEmpty` on concurrent and immutable collections, spans and memory. |
| CA1841 | `d.Keys.Contains(k)` becomes `d.ContainsKey(k)` and `d.Values.Contains(v)` becomes `d.ContainsValue(v)` on `Dictionary` and `SortedDictionary`; other dictionaries are reported (their collections may compare differently). |
| CA1854 | `if (d.ContainsKey(k)) { ... d[k] ... }` and `d.ContainsKey(k) ? d[k] : x` become `d.TryGetValue(k, out var value)` with `value` for the reads (`value1`... when the name is taken). Reported: unknown dictionary types, keys that are not a literal or a simple name, reads inside lambdas, writes to the entry, other uses of the dictionary, and calls that run between the check and a read. |
| CA1864 | `if (!d.ContainsKey(k)) { d.Add(k, v); ... }` becomes `d.TryAdd(k, v);` (or `if (d.TryAdd(k, v)) { ... }`) on `Dictionary`. Reported: a value that is not a literal or a simple name (`TryAdd` evaluates it even when the key exists) and an unknown target framework. |
| CA1868 | `if (!set.Contains(x)) set.Add(x);` becomes `set.Add(x);` and `if (c.Contains(x)) c.Remove(x);` becomes `c.Remove(x);` (`if (set.Add(x)) { ... }` when more follows) on `HashSet`, `SortedSet` and (for `Remove`) `List`. |
| CA1861 | Literal `char`/`string` arrays passed to `string.Split`, `Trim`, `TrimStart`, `TrimEnd`, `IndexOfAny` and `LastIndexOfAny` move to a `private static readonly` field named after the naming rules (`Separators`, `TrimCharacters`, `SearchCharacters`). Constant arrays passed to other methods are reported: the method may change or keep the array. |
| CA1869 | `new JsonSerializerOptions { ... }` passed to a `JsonSerializer` method, directly or through a local used once, moves to a `private static readonly` field (`JsonOptions`) when it is built from constants (literals, `JsonNamingPolicy.CamelCase`, `JsonIgnoreCondition.*`, `JsonStringEnumConverter`, ...). Options built from other values are reported. |
| CA2016 | Methods whose last parameter is their only `CancellationToken` pass it to `Task.Delay`, `File.*Async`, `Stream.ReadAsync`/`WriteAsync`/`FlushAsync`/`CopyToAsync`, `SemaphoreSlim.WaitAsync`, `HttpClient` requests and (.NET 7+) `TextReader.ReadLineAsync`/`ReadToEndAsync`. Calls in lambdas and local functions nested in the method are left alone. |
| CA2263 | `Marshal.SizeOf(typeof(T))` becomes `Marshal.SizeOf<T>()` and `(E)Enum.Parse(typeof(E), s)` becomes `Enum.Parse<E>(s)`. The other `Enum` methods taking `typeof(E)` are reported: their generic overloads return other types. |
| IDE0004 | Removes casts to the type the value already has: a literal, or a local, parameter, field or property declared with that exact type. |
| IDE0005 | Removes duplicate using directives and file-level usings of the file's own namespace or of one containing it. Other unnecessary usings need the compiler's binding and are neither removed nor reported. |
| IDE0051 | Removes private fields, properties, methods and events that no identifier in the file refers to, with their doc comments, repeating until nothing more changes. Reported: members of partial types, members with attributes, names that appear in a string literal or comment, fields of structs and `[Serializable]` types, and initializers that may have side effects. |
| IDE0052 | Reported only: private fields and properties that are assigned but never read. |
| IDE0001, IDE0002 | IDE0001: in type positions, `System.IO.FileInfo` becomes `FileInfo` when the file imports `System.IO`, imports only .NET namespaces the library index knows, `System.IO` is the only imported namespace that declares `FileInfo`, and nothing named `FileInfo` is declared in the file or the project (and the name is not one the .NET namespaces share, like `Timer`). IDE0002: inside type `C`, `C.Member` becomes `Member` for a static member of `C` that no local or parameter hides. |
| IDE0035 | Removes statements after a `return`, `throw`, `break` or `continue` in the same block, unless they hold a label, a local function, a comment or a preprocessor directive, or declare a name used elsewhere. |
| IDE0064 | In a non-`readonly` struct that assigns `this` outside a constructor, instance fields lose `readonly`. |
| IDE0080 | Removes `!` after literals, `new` expressions and `this`, and before `is`. |
| IDE0082 | `typeof(T).Name` becomes `nameof(T)` (built-in types by their CLR name, with `using System;`), except for generic types, type parameters and using aliases. |
| IDE0100 | `x == true`/`x != false` become `x` and `x == false`/`x != true` become `!x` for a value that is certainly `bool` (not `bool?`). |
| IDE0110 | `case T _:`, `x is T _` and `T _ =>` become type patterns (C# 9), unless the file declares a value named `T`. |
| IDE0120, IDE0121 | `x.Where(p).Any()` becomes `x.Any(p)` (also `Count`, `First`, `Last`, `Single` and their `OrDefault` forms); `x.Where(a => a is T).Cast<T>()` and `x.Select(a => (T)a)` after such a `Where` become `x.OfType<T>()`. |
| IDE0240, IDE0241 | Removes a `#nullable enable`/`disable`/`restore` that sets the context already in effect (starting from the project's `<Nullable>`, unknown after `#nullable ... annotations`/`warnings` or inside `#if`). When the project's `<Nullable>` is unknown, directives that may repeat it are reported. IDE0241 is reported only: `#nullable disable` in front of enums only. |
| IDE0280 | `[NotNullIfNotNull("p")]` and `[CallerArgumentExpression("p")]` naming a parameter become `nameof(p)` (C# 11). |
| IDE0380 | Removes `unsafe` from declarations whose code holds no pointer syntax (`*`, `&`, `->`, `stackalloc`, `fixed`, `sizeof`) and uses only members declared in the file without pointer types; a use of a member declared elsewhere is reported. `partial` and `extern` declarations are skipped. |
| IDE0050, IDE0072, IDE0076, IDE0077, IDE0079, IDE0390, IDE0391 | Reported only: anonymous types a tuple could replace (IDE0050); switch expressions over an enum of the file that miss members (IDE0072); global `[SuppressMessage]` with an invalid scope (IDE0076) or a legacy target (IDE0077); `#pragma warning disable` of IDE/CA rules the configuration sets to `none` or `silent`, except those in `dotnet_remove_unnecessary_suppression_exclusions` (IDE0079); `async` methods without `await` (IDE0390; IDE0391 for overrides and interface implementations). |

The rules that depend on a receiver's type need it from the file: a literal, `new T(...)`, or a
local, parameter, field or property declared with an explicit type (or with `var` and one of
those). The string rules, CA1825, CA1864, CA2016 and CA2263 need a target framework with the API
they introduce, read from the nearest `.csproj` (the analyzers are off for older frameworks); an
unknown framework is reported. CA1822 (for members visible to the whole project) and CA1852 read
every C# file of the project - the SDK's default items (outside `bin`, `obj` and nested projects)
plus `<Compile Include>` items - to prove that nothing else needs the old declaration.

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
| CA1858 | [CA1858](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1858) | Only `== 0`/`!= 0` without a start index; `StartsWith(char)` must exist for the target framework. Culture comparisons treat [ignorable characters](https://learn.microsoft.com/dotnet/standard/base-types/best-practices-strings) differently in `IndexOf` and `StartsWith`, so only ordinal ones are rewritten. |
| CA1862 | [CA1862](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1862) | `OrdinalIgnoreCase` compares characters by their invariant upper case, which is exactly `ToUpperInvariant` against a literal that it leaves unchanged; `ToLowerInvariant` differs (Kelvin sign, dotted `İ`) and culture comparisons differ further. The receiver must be a `string`. A `null` receiver now yields `false` instead of a `NullReferenceException`, as with Roslyn's fix. |
| CA1854 | [CA1854](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1854) | The value is read once, at the check: nothing that could change the dictionary (calls, assignments, `await`, other uses of it) may run before a read, reads may not be deferred (lambdas, local functions), and the entry may not be written. [Out variables](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/out-parameter-modifier) need C# 7 and are not allowed in queries; the name must be unused in the member, and not `value` in a setter. Several reads with member access are reported (a struct copy could observe its own changes). |
| CA1841, CA1864, CA1868 | [CA1841](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1841), [CA1864](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1864), [CA1868](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1868) | Only BCL collections whose methods are documented to behave like the removed pair; `ConcurrentDictionary.Keys` is a snapshot compared with the default comparer, so it is reported. The key or item is evaluated once instead of twice, so it must be a literal or a simple name; `TryAdd` must exist for the target framework. An `else` branch is left alone. |
| CA1836 | [CA1836](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1836) | Only the property the type actually has (`Count` or `Length`) and the documented comparisons with `0`/`1`; conditional access (`?.`) is skipped. |
| CA1861, CA1869 | [CA1861](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1861), [CA1869](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1869) | A shared array is safe only if the callee never changes or keeps it, so only the listed `string` methods; shared options only if they are built from constants and used once. Static field and constructor initializers run once and are skipped. Collection expressions (`[',']`) are left alone: from .NET 9 they may bind to a `ReadOnlySpan<char>` overload that allocates nothing. The field goes first in a non-partial class, struct or record (another part could declare the same name) with a name no identifier in the file uses. |
| CA2016, CA2263 | [CA2016](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca2016), [CA2263](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca2263) | Only listed BCL methods whose token or generic overload exists for the target framework; a call that may already pass a token (an argument of unknown type) is skipped. `Enum.Parse<E>` requires an enum type, so a type parameter `E` is skipped; `Enum.GetValues<E>()` returns `E[]` instead of `Array`, so it is only reported. |
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
declared with the containing type are updated; comments are not. Everything else is
reported instead of renamed, for example:

- types, namespaces and non-private members or their parameters, which other files may use;
- members of partial types, overrides, explicit interface implementations and `extern` members;
- a new name that is already used where it would change what another reference means;
- a member read through an expression whose type is not evident (`GetOther().field`);
- names used in `switch` sections, switch expressions, patterns, deconstruction or code the
  cleanup parser cannot fully structure, and variables declared inside expressions (`out var`);
- a name that also appears in a string in its scope (reflection, `CallerArgumentExpression`,
  `DebuggerDisplay`), and members with attributes or of serialized types, whose name a serializer or
  framework may read.

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
  ...) makes the name part of a data format; attribute classes are not renamed;
- for an extension method, the type it extends and that type's whole hierarchy are declared in the
  workspace (so no instance member with the new name can take over its calls); extension methods
  of `string`, `int`, other outside types or type parameters are reported.

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
Types**: the type named like the file stays even when it cannot move itself (a partial class
`Foo` in `Foo.cs` keeps its file while the other types move), else the first movable type does;
each other type gets a file named
after it (`Box{T}.cs` for generics) in the same folder, and new files are cleaned like any other
file. This happens for every cleanup command (the preview does not split), and the summary counts
the files created. A file and its new files are written together: when one of them cannot be
written, none is (the new files already written are removed) and the file counts as failed.
Cleanup on save only reports the types it would move: VS Code can drop the edits of a save, which
would leave them both in the saved file and in the new files. Files are never renamed or overwritten: when a target
file already exists, the file uses preprocessor directives, assembly attributes or several
namespaces, or a type is partial or a struct, the type stays and the violation is reported. File
names are compared up to the first dot, so `Form.Designer.cs` and `View.xaml.cs` match `Form` and
`View`.

## Code Style rules

In `.codejanitor`, `codeStyle` sets the Code Style rules (keys are `.editorconfig` option names): a string value (matched ignoring case, so `"True"` works; JSON booleans and invalid values are ignored) enables the rule with that value, `null` disables it, and a rule it does not list follows the `codeJanitor.cleanup.codeStyleRules` setting. **Export .codejanitor** writes only the enabled rules (an empty `codeStyle` when none is enabled; add `null` entries by hand to pin a rule off); **Import .codejanitor** applies the file's rules over the Workspace value of the setting, writing `null` for a rule the file turns off that your User settings enable.

VS Code merges `codeJanitor.cleanup.codeStyleRules` across the User and Workspace settings, so a rule enabled in the User settings is turned off for one workspace with `null` in its Workspace value (`{ "csharp_prefer_braces": null }`); the settings panel writes it when you clear such a rule in Workspace scope.

`codeJanitor.cleanup.codeStyleRules` lists the Roslyn code-style options Code Janitor can apply when the repository's `.editorconfig` does not enforce them: modifiers (`csharp_preferred_modifier_order`, static local and anonymous functions, `readonly` structs and struct members), blocks (`csharp_prefer_braces`, simple `using`, method group conversion), expression-bodied members, pattern matching, null checking, modern expressions (primary constructors, target-typed `new()`, index and range operators, UTF-8 literals, tuple swap, deconstruction, unused value assignments, `default` literal, auto-properties, compound assignment, simplified boolean expressions and interpolation, object and collection initializers, tuple names), `this.` qualification, language keywords vs. framework type names and parentheses - 53 rules, all off by default. An entry enables the rule with its value (`{ "csharp_prefer_braces": "when_multiline" }`); the settings panel (`Code Janitor: Open Settings`) shows them as a switch and a value per rule, grouped as in the Visual Studio Options page. Naming rules (`dotnet_naming_*`) are configured in `.editorconfig` only.

- **Precedence.** A rule `.editorconfig` enforces keeps its `.editorconfig` value: the panel shows *Overridden by .editorconfig: <key> in <path>* and disables the rule. Otherwise the `.codejanitor` `codeStyle` entry decides, and otherwise the setting.
- **How it applies.** The enabled rules are added on top of the file's `.editorconfig` in memory (each as `suggestion`, with the severity of its diagnostics raised to `suggestion`), and the `.editorconfig` rule engine applies them with the same safety rules: a rewrite whose result the parser reads worse than the input is discarded, and what cannot be fixed safely is reported as unresolved (primary constructors and unused value assignments are only reported; `dotnet_style_predefined_type_for_* = false` is not implemented and is reported). Nothing is written to `.editorconfig`.
- **Rules sharing a diagnostic.** Options that report the same diagnostic (every `dotnet_style_qualification_for_*` option reports IDE0003/IDE0009, the four parentheses options IDE0047/IDE0048) apply one at a time: enabling one does not apply the others unless `.editorconfig` enforces them.

### .editorconfig resolution, as in Visual Studio

- A severity of `none` after the option (`csharp_prefer_braces = true:none`) stops the rule whatever `dotnet_diagnostic.<id>.severity` or a category/global severity says; `silent` (and `refactoring`) never enforce. The same suffix works on the plain options (`indent_style = tab:warning`, `dotnet_sort_system_directives_first = true:none`).
- `dotnet_analyzer_diagnostic.severity` and `dotnet_analyzer_diagnostic.category-*.severity` enable CA1852 (bulk-configurable), but not CA1307 and CA1867 (disabled by default): only `dotnet_diagnostic.<id>.severity` or a rule set enables those.
- `dotnet_style_allow_multiple_blank_lines_experimental` (IDE2000) and `csharp_style_allow_blank_lines_between_consecutive_braces_experimental` (IDE2002) are inverted: `false` turns *Remove multiple consecutive blank lines* / *Remove blank lines after opening brace / before closing brace* on, `true` turns them off; a severity only (no option) leaves them off.
- `csharp_style_expression_bodied_lambdas = when_on_single_line` keeps *Simplify single-statement lambdas* on (`false` turns it off). An enforced `csharp_style_prefer_null_check_over_type_check` / `dotnet_style_prefer_is_null_check_over_reference_equality_method` = `false` turns *Convert to pattern-matching null checks* off.
- `file_header_template` defines the C# file header whatever the severity of IDE0073 (each template line is a `//` comment, `\n` separates lines, `{fileName}` is the file name); `unset` or an empty template means no header and replaces the `.codejanitor` and user header.
- `dotnet_separate_import_directive_groups = true` (or `dotnet_sort_system_directives_first = false`) turns *Organize usings* off; `dotnet_sort_system_directives_first = true` turns it on.
- A rule enforced only by severity (no option) uses Roslyn's default value for the setting it decides: inline `out` variables, read-only fields, collection expressions, explicit access modifiers, lambdas, CA1507/CA1869, block-scoped namespaces (`convertToFileScopedNamespace` off) and using placement outside the namespace; `convertToVarWhenApparent` is off.

### Override notes in the settings panel

Under each cleanup option the open workspace's `.editorconfig` decides, a note *Overridden by .editorconfig: <key> in <path>* is shown and the control is disabled; a setting the workspace's `.codejanitor` lists (and `.editorconfig` does not decide) shows *Overridden by .codejanitor: <key> in <path>* the same way. The note is evaluated for a C# file in the first workspace folder (`.editorconfig` files nested below it are not considered; a key that is not enforced or has an unrecognized value shows no note; nothing is shown or locked without a workspace). Affected settings: explicit access modifiers, var, inline out variables, collection expressions, read-only fields, file-scoped namespaces, usings outside the namespace, file header, trailing whitespace, lambdas, null checks, sealed classes, `nameof`, JSON options, the blank-line removals and the Code Style rules. The notes are read when the panel opens and whenever a setting changes.

## Cleanup preview and navigation

**Cleanup preview (multi-file).** `Preview Cleanup (Selected Files / Open Files / Changed Files / Workspace)` builds a plan with the ordinary cleanup pipeline without writing files or calling AI. A Quick Pick lists every file with an explicit status (`N changes`, `No changes`, `Skipped: not a C# file / too large / excluded / not UTF-8`, `Error: ...`); files with changes are checked. Moving through the list (or the Show Diff button) opens a native `vscode.diff` of the original and the updated text from virtual documents (no temporary files). The Choose Rules button lists the file's rules as Changed / No change / Excluded; each change of the selection is recomputed from the file's original text. Enter applies the checked files through one `WorkspaceEdit` (one undo step; when VS Code rejects it, each file is checked again and applied on its own): a file whose text (editor buffer or disk) changed since the plan is refused and reported; nothing is saved (closed files are edited as unsaved buffers). A result with more syntax problems than the original is never offered. With `onlyChangedLines`, Changed Files previews the lines changed since HEAD as one result. The preview covers the deterministic C# text pipeline only: type splits (one type per file), workspace-wide renames, AI and encoding changes are not part of it (a note says so). Settings: `codeJanitor.preview.maxFileSizeKB`, `codeJanitor.cleanup.showOptionsDialog` (Cleanup Selected Files first asks `Start Cleanup` / `Preview C# Text Changes`; default off).

**Navigation and workflow commands** (ports of the Visual Studio commands): `Switch to Related File` (`.cs`/`.designer.cs`, `.xaml`/`.xaml.cs`, `.razor`/`.razor.cs`/`.razor.css`, `.cshtml`/`.cshtml.cs`, `.aspx`/`.ascx`/`.master` with code-behind, `.h`/`.c`/`.cpp`, `.ts`/`.html`/`.css`; groups in `codeJanitor.switching.relatedFileExtensions`), `Toggle Read-Only (Session)` (built-in session read-only toggle; VS Code has no command for the file attribute), `Close All Read-Only Editors` (files marked read-only on disk or on read-only file systems, without unsaved changes; `files.readonlyInclude` patterns are not detectable through the API), `Find in Explorer` (reveals the active file), `Collapse Explorer` (built-in), `Collapse Selected in Explorer` (collapses the focused Explorer folder; VS Code cannot collapse a selection recursively).

## Reorganize

**Reorganize Active File** / **Reorganize (Selected Files)** reorder the members of every type by the configured member type order
(default: fields, constructors, destructors, delegates, events, enums, interfaces, properties, indexers, methods, structs, classes),
then access level (public, internal, protected internal, protected, private protected, private - or reversed, or access first), then
constants, static and read-only fields, then alphabetically. Comments directly above a member, its attributes, XML documentation (also when a
blank line separates it from the member), its trailing comment and the `#if` block around it move with it. Fields and properties whose
initializers depend on the order they are declared in (an initializer that reads another field or runs code, including a user-defined operator,
indexer or conversion) keep their relative order, and so do the instance fields of a struct, which are its memory layout unless it is marked
`[StructLayout(LayoutKind.Auto)]`, so the behaviour of the code does not change.
Regions can be kept, sorted across, removed, or generated per group (optionally with the access level, for methods only, and even when
empty). Settings: `codeJanitor.reorganize.*` (section "Reorganizing"). **Insert Region Around Selection** wraps the selected lines in
`#region New Region` and selects the name; **Remove Region** removes the region under the cursor (keeping the regions nested in it) or the
regions in the selection.
**Sort Lines** sorts the selected lines like the Visual Studio extension (empty lines dropped, culture-aware order).

## Razor and Blazor

**Razor and Blazor formatter.** `Code Janitor: Format Razor` (active `.razor` / `.cshtml` file, or the selected
files and folders in the explorer) and, with `codeJanitor.cleanup.formatRazorComponents` (off by default, as in the Visual Studio
extension), the regular cleanup lay out the C# of `@code` / `@functions` blocks and of the control blocks `@if`, `@else if`, `@else`,
`@for`, `@foreach`, `@while`, `@switch`, `@try`, `@catch` and `@finally` (headers normalized, braces on their own lines, statements
one per line, `else` / `catch` / `finally` on a line of their own). Markup is moved with its block but never reformatted;
Razor comments, HTML comments, `<script>`, `<style>`, `<pre>` and `<textarea>` content and `@{ }` blocks are never touched.
Only whitespace ever changes - the result is checked token by token - and anything the formatter cannot read with certainty
(C# that does not parse, unbalanced blocks, `catch ... when` filters, and blocks whose markup shares a line with a brace where a
line break would be rendered) stays as authored. Formatting twice is a no-op.
Indentation: `codeJanitor.razor.indentSize` (4) and `codeJanitor.razor.indentStyle` (`auto` follows the file).
Implemented in TypeScript with no Roslyn or .NET at runtime: `src/razor/`.

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

## Differences from the Visual Studio extension

Both extensions share the cleanup concepts, the `.codejanitor` policy file and the transformation
fixtures in `shared/tests/transformations/`. They do not share an engine: the Visual Studio
extension runs on Roslyn and its semantic model inside Visual Studio; this extension is TypeScript
with its own C# parser, with no .NET at runtime. Where Roslyn's semantic model decides, this
extension changes code only when the syntax proves the result is the same, and otherwise leaves it
unchanged and reports it in the **Code Janitor** output channel.

Legend: **Same** = equivalent behavior; **Approx.** = same goal, narrower or more conservative;
**No** = not available; **n/a** = no counterpart in that IDE.

| Area | Visual Studio | VS Code | Status |
|---|---|---|---|
| Deterministic text rules (whitespace, blank lines, padding, regions, BOM, file header, comment format, access modifiers, `var`, readonly, sealed, `nameof`, `out var`, collection expressions, lambdas, null checks, interpolation, CA1869) | Roslyn syntax and semantics | Own parser, same shared fixtures | **Same** for the syntactic cases; **Approx.** where a type must be known (e.g. block-lambda null checks are left unchanged) |
| `.editorconfig` rules and severities | Evaluated by Roslyn | Own evaluator of `.editorconfig`, `.globalconfig`, `.csproj`, `Directory.Build.*`, `AnalysisMode` | **Approx.** (static; a `Condition` or unknown import leaves a value unknown) |
| Code-style code fixes | Roslyn code fixes of Visual Studio and project analyzers | Native rewrites for the supported rules (README list); the rest are reported | **Approx.** |
| Third-party analyzer fixes (NuGet analyzers) | Yes | No | **No** |
| Compiler errors checked before applying a fix | Roslyn compiles the changed project(s) | A rewrite whose result parses worse than the input is discarded | **Approx.** |
| Code Style opt-in rules (53) and `.codejanitor` `codeStyle` | Yes | Yes, applied by the same native engine | **Same** settings, **Approx.** fixes |
| Naming rules (`dotnet_naming_*`) | Rename across the solution | Rename inside the file; types and non-private members are reported; opt-in workspace rename | **Approx.** |
| Using placement (outside / inside namespace) | Semantic model, all `#if` variants, every target framework | Index of project and referenced-project declarations plus .NET reference assemblies; skips on any `#if`/`#region`/`#nullable`/`#pragma` in the way and when the index is incomplete | **Approx.** (stricter, moves fewer files) |
| File-scoped / block-scoped namespace | Language version from the Roslyn workspace | Language version from the nearest `.csproj`; unknown version keeps block scope | **Approx.** |
| Remove and sort usings (IDE0005), Visual Studio Format Document (IDE0055) | Visual Studio services | Using order and the formatting options of `.editorconfig`; only duplicate usings and usings of the file's own namespace are removed, other unused usings need the compiler and are neither removed nor reported | **Approx.** |
| Settings precedence | `.editorconfig` > `.codejanitor` > user settings | The same | **Same** |
| `.codejanitor` discovery | Nearest file, walking up | The same | **Same** |
| `.codejanitor` keys `applyEditorConfig*`, `applyAnalyzerCodeFixes` | Opt-in keys | Ignored (logged once); `.editorconfig` always applies | **No** (intentional) |
| Override notes in settings UI | WPF options pages | Settings panel notes and locked controls | **Same** |
| Cleanup preview | Options dialog, side-by-side diff | Quick Pick, native diff, per-file rule selection, stale-text protection; no type splitting or workspace rename in the preview | **Approx.** |
| Cleanup scopes (file, selection, open, changed, workspace) | Yes | Yes | **Same** |
| Cleanup on save | Yes | Yes | **Same** |
| Reorganize members, generate/remove regions | DTE code model | Syntax tree; fields with order-dependent initializers keep their order; `#if` blocks move as one unit; `private protected` has its own rank; with access first, a member type order of 10 or more no longer outweighs one access level | **Approx.** |
| Code tree window (Spade): move above/below/into, search, name sort | Yes | No (VS Code has Outline) | **No** |
| Sort Lines, Join Lines, Insert/Remove Region | Yes | Yes | **Same** |
| Razor / Blazor formatter | `RazorFormatterLogic` | Port; whitespace only, markup layout kept, idempotent; `.cshtml` and indent options added | **Approx.** |
| Switch File, Find in Explorer, Collapse, Read-only | Solution Explorer | Equivalent commands on VS Code's Explorer and editors | **Approx.** |
| Build progress in toolbar and taskbar | Yes | No | **No** |
| Split top-level types into files | Yes | Yes (explicit command, never on save) | **Same** |
| Fix namespace | Yes | Yes | **Same** |
| XML documentation generation (AI) | Yes | Yes | **Same** |
| Explain / review / refactor / unit tests (AI) | Yes | Yes | **Same** |
| Coverage-report analysis and tests from gaps (AI) | Target-coverage loop (`AiCoverageTargetLogic`) | Coverage-report analysis and test generation | **Approx.** |
| GitHub Copilot access | Session endpoint, model discovery | VS Code language model API | **Approx.** |
| Secret storage | DPAPI | VS Code secret storage | **n/a** |
| Diagnostics and quick fixes in the editor | Roslyn / Visual Studio | Native diagnostics from the cleanup rules | **Approx.** |
| Check mode for CI | n/a | `npm run check` (no VS Code, no .NET) | VS Code only |
| Platforms | Windows, Visual Studio 2026 | Windows, macOS, Linux | n/a |

### What is verified, and how

- Unit tests (Vitest) for every rule family; the shared fixtures run against both engines. One
  fixture (`pattern-matching-null-checks-block-lambda-convert`) is an intentional divergence: Roslyn
  knows the parameter's type, this engine does not, so the code is left unchanged.
- Real-compiler tests: the cleanup output is built with `dotnet build` before and after, and
  any new `CSxxxx`/`RZxxxx` error fails the test (`test/oracle/*`, `npm run verify:compile`).
  These need the .NET SDK on the development machine only.
- Tests in a real VS Code host (`npm run test:e2e`).
- There is no line-coverage measurement in the repository, so "every line is tested" is not
  claimed. Rule modules are exercised through the cleanup pipeline and the compiler corpora rather
  than by one test file each.

## Scope and review

The C# cleanup engine uses a TypeScript parser, without Roslyn semantic analysis. Syntax
modernization rules can depend on your project's language version and usage; review changes and
run your normal build and tests. Non-C# cleanup is optional and limited to layout rules.

AI actions send the selected code or report context to the provider you configure. Use a provider
appropriate for the source code you are working with, and review generated output before use.

## Development and support

Every cleanup option is tested on deliberately bad C# in the [testbed repository](https://github.com/edgarus-labs/code-janitor-testbed)
(`npm run test:testbed`): each option must fix its own bad code, and the cleaned solution must still build and behave the same.


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

