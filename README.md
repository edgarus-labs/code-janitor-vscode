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
rarely happens consistently across a team. Code Janitor applies configurable cleanup rules to the scope you select. C# cleanup
runs locally on Roslyn, the .NET compiler platform, with Roslyn's own analyzers and code fixes and without an AI service.
Review the resulting diff and build your project, especially when enabling syntax modernization rules.

## Requirements

- Visual Studio Code 1.90 or later on Windows, macOS or Linux.
- For C# cleanup: the .NET 10 SDK or later (`dotnet` on the `PATH`, or its path in `codeJanitor.dotnetPath`).
  Without it, C# cleanup is unavailable and says so once; other file types and Razor are still cleaned.
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

A `.codejanitor` written for the Visual Studio extension works here too, with one difference: the
`.editorconfig` switches `applyEditorConfigFormatting`, `applyEditorConfigNaming`,
`applyEditorConfigCodeStyle` and `applyAnalyzerCodeFixes` have no effect, because in VS Code the
`.editorconfig` rules and the fixes of every enforced analyzer always apply. Each of these keys is
listed in the **Code Janitor** output channel as ignored, once per session. The other way round,
`renamePublicSymbolsAcrossWorkspace` and `onlyChangedLines` exist only in VS Code, and the Visual
Studio extension ignores them.

You can create or synchronize this file without editing JSON by opening **Code Janitor: Open
Settings** and using **Export .codejanitor** or **Import .codejanitor**. Export writes the cleanup
settings set in VS Code (in any scope) to the repository root, plus the values the overwritten file
already listed; a setting left at its default is not written, so it keeps following each user's
setting. Import copies the repository values into VS Code's workspace settings. While the file lists
a key, the settings panel shows it as *Overridden by .codejanitor* and disables its control.

### Diagnostics and quick fixes

While a C# file is open, Code Janitor shows its enforced diagnostics in the editor and the
Problems panel (source "Code Janitor"), a moment after you stop typing:

- each diagnostic of an enforced rule (code style, formatting, naming and the analyzers of the
  project) with its severity (`error`, `warning`; `suggestion` shows as information) and its id
  linking to the rule's documentation;
- quick fixes: **Fix IDE0011** fixes that occurrence with Roslyn's code fix (offered when the fix
  passes the compiler-error check), **Fix all IDE0011 in file** applies only that rule to the file,
  and **Run Code Janitor cleanup** runs the whole cleanup.

`codeJanitor.diagnostics.enabled` (on by default) turns them off; files larger than
`codeJanitor.diagnostics.maxFileSizeKB` (256) are not analyzed. The Code Janitor settings'
own steps (outside `.editorconfig`) are not shown as diagnostics.

### Check mode for CI

`npm run check -- [--root <repository root>] <file or folder>...`, from a clone of this
repository, runs the cleanup as a dry run over the C# files of the given paths (`bin`, `obj`, `node_modules`, `.git` and
`.vs` folders excluded) with each file's `.editorconfig` and the nearest `.codejanitor` of each file (default root: the
current folder). It needs the .NET 10 SDK or later but not VS Code, prints one line per finding,
`file:line: rule (severity): message`, and exits with 1 when cleanup would change a file or an
enforced `.editorconfig` rule is violated in a way cleanup cannot fix, and with 2 on a usage error or when the check is
incomplete (a cleanup step or analyzer crashed, or a project failed to load).
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
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
        working-directory: .code-janitor
      - run: npm run check --prefix .code-janitor -- --root "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE/src"
```

## The C# engine (Roslyn)

C# files are cleaned by Roslyn, the .NET compiler platform, in a .NET process the extension
starts on the first C# request (`dist/server`, Roslyn 5.9). It loads your projects with MSBuild,
the way the C# extension does: the solution (`.sln`/`.slnx`) that lists the file's project,
otherwise that project together with every project of the workspace folder that references it. A
file in no project is cleaned in a stand-alone project with the .NET runtime's assemblies and its
`.editorconfig`, and that is said once in the output channel. Unsaved editor text is used instead
of the file on disk, and the projects are reloaded when a `.csproj`, `.props`, `.targets`,
`.editorconfig`, `.globalconfig` or `.codejanitor` changes.

A cleanup runs in this order: Reorganize (when `codeJanitor.reorganize.runAtStartOfCleanup` is
on), the steps that need the semantic model (sealing classes, pattern-matching null checks), Code
Janitor's own steps (blank lines and padding, regions, file header, `nameof`, string
interpolation, `JsonSerializerOptions` reuse, accessor and single-line method layout, comment
formatting), the Roslyn analyzers and code fixes, and finally the layout of the whole text
(trailing whitespace, line endings, final newline). Files with an `<auto-generated` marker are
skipped.

### Roslyn analyzers and code fixes

- **What is fixed.** Every diagnostic the file's configuration enforces at `suggestion`,
  `warning` or `error`: the IDE rules of `.editorconfig` (code style, formatting IDE0055, naming
  IDE1006), the .NET analyzers (CA rules) and the analyzers the project references, NuGet analyzer
  packages included, with their own code fixes. Severities are resolved by Roslyn itself from
  `.editorconfig`, `.globalconfig`, the project's `AnalysisLevel`/`AnalysisMode`, `NoWarn` and the
  other MSBuild properties, exactly as the compiler sees them. `silent` and `none` are left alone,
  and compiler diagnostics are never "fixed".
- **How.** For each diagnostic the first code action of the first provider that offers one is used,
  with Fix All when the provider supports it, otherwise one diagnostic at a time (at most 50 passes).
  The Code Janitor settings that correspond to a Roslyn rule apply that rule with Code Janitor's
  value when `.editorconfig` does not decide it (table below).
- **Safety.** A fix is rejected when it adds a compiler error in any project or target framework
  that compiles the file, or when it does anything other than change document text. Rejected fixes,
  diagnostics without a fix and fixes that do not converge are left unchanged and listed in the
  **Code Janitor** output channel; batch cleanup counts them in its summary.
- **Naming.** A naming violation is fixed with Roslyn's rename, which also updates references,
  XML documentation and overloads. Without `codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace`
  only symbols whose rename stays in the file are renamed (locals, parameters of private and local
  methods, private members of a type declared only in this file); types and other members are
  reported. With it, the batch commands rename them in every loaded project. Cleanup on save and
  `onlyChangedLines` never rename into other files.

### Settings precedence

Each setting is resolved per file: `.editorconfig` (where it enforces the rule), then the nearest
`.codejanitor`, then your VS Code settings. A key is enforced when one of its diagnostics resolves
to `suggestion` or higher (`dotnet_diagnostic.<id>.severity`, then the category, then the global
severity, then the key's own `:severity` suffix; a key without a suffix counts as enforcing, and
`:none` turns the rule off whatever else is set). A key that is not enforced, or has an unknown
value, leaves the decision to `.codejanitor` and then to the setting.

| Code Janitor setting | `.editorconfig` key | Value Code Janitor applies when `.editorconfig` does not decide |
| --- | --- | --- |
| Convert to file-scoped namespace | `csharp_style_namespace_declarations` (IDE0160/IDE0161) | `file_scoped` (`block_scoped` converts back) |
| Move usings outside namespace | `csharp_using_directive_placement` (IDE0065) | `outside_namespace` |
| Organize usings | `dotnet_sort_system_directives_first`, `dotnet_separate_import_directive_groups`, IDE0005 | sort, and remove the unused ones (except `usingStatementsToReinsertWhenRemoved`) |
| Convert to `var` when apparent | `csharp_style_var_when_type_is_apparent` (IDE0007/IDE0008) | `true`; built-in and non-apparent types keep their type |
| Inline `out` variable declarations | `csharp_style_inlined_variable_declaration` (IDE0018) | `true` |
| Convert to collection expressions | `dotnet_style_prefer_collection_expression` (IDE0300-IDE0306) | `true` (types must match exactly) |
| Simplify single-statement lambdas | `csharp_style_expression_bodied_lambdas` (IDE0053) | `true` |
| Insert explicit access modifiers | `dotnet_style_require_accessibility_modifiers` (IDE0040) | `for_non_interface_members` |
| Make fields readonly | `dotnet_style_readonly_field` (IDE0044) | `true` |
| Remove multiple consecutive blank lines | `dotnet_style_allow_multiple_blank_lines_experimental` (IDE2000) | `false` |
| Remove blank lines after `{` / before `}` | `csharp_style_allow_blank_lines_between_consecutive_braces_experimental` (IDE2002) | as set |
| Convert to pattern-matching null checks | `csharp_style_prefer_null_check_over_type_check`, `dotnet_style_prefer_is_null_check_over_reference_equality_method` | on (an enforced `false` turns it off) |
| Seal classes | `dotnet_diagnostic.CA1852.severity` | on, only where nothing in the loaded projects derives from, converts or constrains the class, and no project involved has inactive `#if` code |
| `nameof` / `JsonSerializerOptions` reuse | `dotnet_diagnostic.CA1507.severity` / `dotnet_diagnostic.CA1869.severity` | on (CA1869 caches options built from constants in a `private static readonly` field) |
| File header | `file_header_template` (`unset` = no header) | `fileHeaderCSharp` |
| Remove end-of-line whitespace, final newline, BOM, indentation, line endings | `trim_trailing_whitespace`, `insert_final_newline`, `charset`, `indent_style`/`indent_size`/`tab_width`, `end_of_line` | as set |

Code Janitor's other steps (regions, padding, accessors, single-line methods, string
interpolation, comment formatting) have no `.editorconfig` counterpart and always follow the
settings.

### Comment formatting

`codeJanitor.cleanup.formatComments` (and the **Format Comments** command, whatever the setting
says) formats comments as the Visual Studio extension does: consecutive `//` lines are reflowed
into paragraphs wrapped at `codeJanitor.formatting.commentWrapColumn` (100), lists and blank comment
lines are kept, and XML documentation is laid out by the `codeJanitor.formatting.commentXml*`
options (split `<summary>`, align `<param>`, tag case and spacing, value indent). Lines starting
with one of `codeJanitor.formatting.commentIgnoreLinesStartingWith` are left alone.

### One type per file

Roslyn has no rule for this, so cleanup follows the analyzer rules a repository enforces with an
explicit `dotnet_diagnostic.<ID>.severity` of `suggestion`, `warning` or `error`:

| Rule | Cleanup |
| --- | --- |
| `SA1402` (StyleCop) | Moves every class but one to its own file. |
| `MA0048` (Meziantou) | Moves every type not named like the file to its own file. |
| `SA1649` (StyleCop) | Reports a first type not named like the file. |

The type named like the file stays (else the first movable one), each other type gets a file named
after it (`Box{T}.cs` for generics) in the same folder, and the file and its new files are written
in one edit. Files are never overwritten: when a target file exists, or the type is partial, the
violation is reported. Cleanup on save, a partial cleanup of a file outside the workspace and
`onlyChangedLines` only report the types they would move.

### Code Style rules

In `.codejanitor`, `codeStyle` sets the Code Style rules (keys are `.editorconfig` option names): a string value (matched ignoring case, so `"True"` works; JSON booleans and invalid values are ignored) enables the rule with that value, `null` disables it, and a rule it does not list follows the `codeJanitor.cleanup.codeStyleRules` setting. **Export .codejanitor** writes only the enabled rules (an empty `codeStyle` when none is enabled; add `null` entries by hand to pin a rule off); **Import .codejanitor** applies the file's rules over the Workspace value of the setting, writing `null` for a rule the file turns off that your User settings enable.

VS Code merges `codeJanitor.cleanup.codeStyleRules` across the User and Workspace settings, so a rule enabled in the User settings is turned off for one workspace with `null` in its Workspace value (`{ "csharp_prefer_braces": null }`); the settings panel writes it when you clear such a rule in Workspace scope.

`codeJanitor.cleanup.codeStyleRules` lists the Roslyn code-style options Code Janitor can apply when the repository's `.editorconfig` does not enforce them: modifiers, blocks, expression-bodied members, pattern matching, null checking, modern expressions, `this.` qualification, language keywords vs. framework type names, and parentheses. Each has an on/off switch and its value; all are off by default. Naming rules are configured in `.editorconfig` only.

- **Precedence.** A rule `.editorconfig` enforces keeps its `.editorconfig` value: the panel shows *Overridden by .editorconfig: <key> in <path>* and disables the rule. Otherwise the `.codejanitor` `codeStyle` entry decides, and otherwise the setting.
- **How it applies.** The enabled rules are added to the file's analyzer configuration in memory as `suggestion` and fixed by Roslyn's code fixes with the safety rules above. Nothing is written to `.editorconfig`.
- **Rules sharing a diagnostic.** Options that report the same diagnostic (every `dotnet_style_qualification_for_*` option reports IDE0003/IDE0009) apply one at a time: enabling one does not apply the others unless `.editorconfig` enforces them.

### Override notes in the settings panel

Under each cleanup option the open workspace's `.editorconfig` decides, a note *Overridden by .editorconfig: <key> in <path>* is shown and the control is disabled; a setting the workspace's `.codejanitor` lists (and `.editorconfig` does not decide) shows *Overridden by .codejanitor: <key> in <path>* the same way. The notes come from the C# engine and are evaluated for a C# file in the first workspace folder.

## Other file types

With `codeJanitor.cleanup.includeOtherFileTypes`, files that are not C# get the steps of their
language family, as in the Visual Studio extension (`codeJanitor.cleanup.fileTypes.*` selects the
languages, `everythingElse` the rest):

- every language: byte order mark, trailing whitespace, blank lines at top, bottom and in a row,
  final newline, and its own file header (`codeJanitor.cleanup.fileHeader<Language>`, written with
  the language's comment syntax, below a shebang, an XML declaration or a PHP opening tag);
- C-family (C/C++, CSS, LESS, SCSS, JavaScript, TypeScript, JSON, PHP, PowerShell, R): blank lines
  after `{` and before `}`, padding before `//` comments;
- markup (HTML, XAML, XML): blank lines before closing tags, `<a >` to `<a>`, `<br/>` to `<br />`,
  never inside comments, CDATA, attribute values or `script`, `style`, `pre` and `textarea`;
- Visual Basic: `#Region` removal and padding, blank lines after attributes and between chained
  statements, padding before `Case` and `'` comments, and comment formatting.

`codeJanitor.cleanup.excludeT4GeneratedCode` (on) skips a file next to a `.tt` template of the same
name. These steps run in the extension and need no .NET.

## More cleanup options

- **Files outside the workspace folders** (`codeJanitor.cleanup.performPartialCleanupOnExternal`):
  `ask` (once per cleanup run: Yes / No / Always / Never), `always` or `never`. A partial cleanup
  leaves the using directives alone and never changes or creates other files.
- **Cleanup on save** never moves types or renames into other files, and with
  `codeJanitor.cleanup.skipOrganizeUsingsDuringCleanupOnSave` leaves the using directives alone.
- **External tools** after the cleanup of an open document (not on save):
  `codeJanitor.cleanup.runFormatDocument` runs VS Code's **Format Document**, then the command ids
  of `codeJanitor.thirdParty.otherCleaningCommands` run in order with the document active.
- **AI XML documentation during cleanup** (`codeJanitor.ai.xmlDoc.runDuringCleanup`, off; not on
  save) within `maxRequestsPerCleanup`, `maxEstimatedTokensPerCleanup`, `globalTimeoutSeconds` and
  `maxParallelFiles`.
- **Diagnostics mode** (`codeJanitor.general.diagnosticsMode`): skip reasons and informational
  messages are written to the output channel only in this mode.
- **Feature switches** (`codeJanitor.features.*`): turning one off hides its commands (and the
  Spade view) from the menus and the Command Palette.

## Spade

The **Spade** view in the Explorer (**Code Janitor: Show Spade**) shows the namespaces, types,
members and regions of the active C# file with their parameters, types, modifiers and McCabe
complexity, coloured from `codeJanitor.spade.complexityWarningThreshold` (10) and
`complexityAlertThreshold` (15). It sorts in file order, by member type (the Reorganize order) or
alphabetically, filters by name (**Search Members**), follows the cursor, goes to the selected
member (`centerOnWhole`) and folds a type or region when you collapse it
(`synchronizeOutlining`). The context menu deletes a member with its documentation and attributes,
finds its references, and inserts or removes a region; drag and drop moves a member before or after
a sibling and is refused when the move would add a compiler error.

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
fixtures in `shared/tests/transformations/`, and both clean C# with Roslyn. The Visual Studio
extension runs inside Visual Studio's own Roslyn workspace; this extension runs a Roslyn 5.9 server
next to VS Code that loads the projects with MSBuild, on Windows, macOS and Linux.

Legend: **Same** = equivalent behavior; **Approx.** = same goal, narrower or more conservative;
**No** = not available; **n/a** = no counterpart in that IDE.

| Area | Visual Studio | VS Code | Status |
|---|---|---|---|
| Code Janitor's own C# steps (whitespace, blank lines, padding, regions, BOM, file header, comment format, sealing, `nameof`, null checks, interpolation, CA1869, accessors, single-line methods) | Roslyn | The same steps, ported to the Roslyn server | **Same** |
| `.editorconfig` rules, severities and code fixes, including NuGet analyzers | Roslyn in Visual Studio | Roslyn in the server, projects loaded with MSBuild | **Same** |
| Compiler errors checked before applying a fix | Every project and target framework compiling the file | The same | **Same** |
| Code Style opt-in rules and `.codejanitor` `codeStyle` | Yes | Yes | **Same** |
| Naming rules (`dotnet_naming_*`) | Rename across the solution | Roslyn rename; non-private symbols only with `renamePublicSymbolsAcrossWorkspace`, never on save | **Approx.** |
| Other file types (VB, C-family, markup, generic): steps, headers, comment formatting | Code model and text | Text steps; VB code-element padding needs a VB code model and is not ported | **Approx.** |
| Run Visual Studio Format Document, ReSharper, XAML Styler, other cleaning commands | Yes | VS Code's Format Document and any command ids (`codeJanitor.thirdParty.otherCleaningCommands`), not on save | **Approx.** |
| Settings precedence | `.editorconfig` > `.codejanitor` > user settings | The same | **Same** |
| `.codejanitor` discovery | Nearest file, walking up | The same | **Same** |
| `.codejanitor` keys `applyEditorConfig*`, `applyAnalyzerCodeFixes` | Opt-in keys | Ignored (logged once); `.editorconfig` and every enforced analyzer fix always apply | **No** (intentional) |
| Override notes in settings UI | WPF options pages | Settings panel notes and locked controls | **Same** |
| Cleanup preview | Options dialog, side-by-side diff | Quick Pick, native diff, per-file rule selection, stale-text protection; no type splitting or workspace rename in the preview | **Approx.** |
| Cleanup scopes (file, selection, open, changed, workspace) | Yes | Yes | **Same** |
| Cleanup on save | Yes | Yes | **Same** |
| Reorganize members, generate/remove regions | DTE code model | Roslyn syntax and semantic model; fields with order-dependent initializers keep their order; `#if` blocks move as one unit | **Approx.** |
| Code tree window (Spade): sort, search, complexity, navigation, outlining, delete, references, regions, move | Yes | Spade view in the Explorer on the Roslyn engine's structure; drag and drop moves a member above or below a sibling, refused when it adds a compiler error; no "move into" another type | **Approx.** |
| Sort Lines, Join Lines, Insert/Remove Region | Yes | Yes | **Same** |
| Razor / Blazor formatter | `RazorFormatterLogic` | Port; whitespace only, markup layout kept, idempotent; `.cshtml` and indent options added | **Approx.** |
| Switch File, Find in Explorer, Collapse, Read-only | Solution Explorer | Equivalent commands on VS Code's Explorer and editors | **Approx.** |
| Build progress in toolbar and taskbar | Yes | No | **No** |
| Split top-level types into files | Yes | Yes (explicit command, never on save) | **Same** |
| Fix namespace | Yes | Yes | **Same** |
| XML documentation generation (AI) | Yes | Yes | **Same** |
| Explain / review / refactor / unit tests (AI) | Yes | Yes | **Same** |
| Coverage-report analysis and tests from gaps (AI) | Target-coverage loop (`AiCoverageTargetLogic`) | Coverage-report analysis, tests from gaps, and the target-coverage loop with the branches and coverage estimate of the Roslyn engine | **Same** for the loop |
| GitHub Copilot access | Session endpoint, model discovery | VS Code language model API | **Approx.** |
| Secret storage | DPAPI | VS Code secret storage | **n/a** |
| Diagnostics and quick fixes in the editor | Roslyn / Visual Studio | Roslyn diagnostics and code fixes through the server | **Same** |
| Check mode for CI | n/a | `npm run check` (no VS Code; .NET SDK) | VS Code only |
| Platforms | Windows, Visual Studio 2026 | Windows, macOS, Linux | n/a |

### What is verified, and how

- Unit tests: xunit for the Roslyn server (`server/tests`, including the Visual Studio extension's
  tests ported from MSTest) and Vitest for the extension; the shared fixtures run against both
  extensions.
- The [testbed](https://github.com/edgarus-labs/code-janitor-testbed) (`npm run test:testbed`): every
  cleanup option on its own deliberately bad code through the real server, then the whole solution
  built and run before and after cleanup with every option on.
- Real-compiler tests: the cleanup output is built with `dotnet build` before and after, and
  any new `CSxxxx`/`RZxxxx` error fails the test (`test/oracle/*`, `npm run verify:compile`).
- Tests in a real VS Code host (`npm run test:e2e`).
- There is no line-coverage measurement in the repository, so "every line is tested" is not
  claimed.

## Scope and review

Roslyn's code fixes and Code Janitor's steps are checked against the compiler, but they can still
change behaviour the compiler cannot see (reflection, serialization of renamed members, mocks of
sealed classes); review changes and run your normal build and tests. Non-C# cleanup is optional.

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

