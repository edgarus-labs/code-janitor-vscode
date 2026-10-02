# Changelog

All notable changes to this extension are documented here.

## [0.1.0] - Unreleased

First release of the Visual Studio Code port.

### Added (Visual Studio parity)

- **Testbed.** `npm run test:testbed` runs every cleanup option against deliberately bad C# from the public
  [code-janitor-testbed](https://github.com/edgarus-labs/code-janitor-testbed) repository (one class per option) and builds and runs the
  cleaned solution with the real compiler. It found the fixes listed under **Fixed (found on real code)**.
- **CI.** The tests that build C# with the .NET SDK run in one job per category (`test/compilerTests.json`), each on its own runner
  with the .NET 10 SDK (`10.0.x`); Build and Test runs the rest. The Code Style compiler tests build each rule group as its own project.

- **Changed:** `.codejanitor` is discovered per file, walking up from the cleaned file's folder (nearest file wins as a whole), in cleanup on save, every cleanup command, the editor diagnostics, the preview and `code-janitor check`; before, only the first workspace folder's root was read.
- **Changed:** precedence is `.editorconfig` (where it enforces) > `.codejanitor` > VS Code settings, as in the Visual Studio extension; a key in `.codejanitor` now wins over an explicit VS Code setting.
- **Changed (as in Visual Studio):** `:none` option suffix stops a rule, severity suffix on plain options, CA1852 not enabled by category/global severity, IDE2000/IDE2002 inverted blank-line keys, `csharp_style_expression_bodied_lambdas = when_on_single_line`, null-check keys, `file_header_template` independent of IDE0073 and `unset`, using-order keys, Roslyn default values for severity-only enforcement (see README).
- **Fixed:** the `insertBlankLineBeforeReturnAndThrow` key written by **Export .codejanitor** is now read back (`.codejanitor` parser accepted only the long key).
- **Added:** Code Style rules (`codeJanitor.cleanup.codeStyleRules`, `.codejanitor` `codeStyle`), grouped in the settings panel; override notes that disable the controls `.editorconfig` decides; export/import of the rules.
- Using directive placement is proven against an index of the project's declarations instead of the old name-prefix heuristic: namespace-relative directives (`using Services;` in `Company.App`) are written fully qualified, `csharp_using_directive_placement = inside_namespace` moves file-level directives into the namespace (`global::`-qualifying what would bind differently), and every file where the move is not provably safe is left unchanged with the reason in the output.
- File-scoped namespaces are only written for projects known to use C# 10+; `convertToFileScopedNamespace` keeps using directives inside the namespace and reports why a namespace was not converted.
- Added multi-file cleanup preview commands (selected files, open files, changed files, workspace) with per-file inclusion, per-rule selection, native diff and stale-text protection; optional options dialog for Cleanup Selected Files (`codeJanitor.cleanup.showOptionsDialog`).
- Added navigation commands: Switch to Related File, Toggle Read-Only (Session), Close All Read-Only Editors, Find in Explorer, Collapse Explorer, Collapse Selected in Explorer.
- Added Reorganize (`codeJanitor.reorganizeActiveFile`, `codeJanitor.reorganizeSelectedFiles`): members ordered by the `codeJanitor.reorganize.*` settings (the `Reorganizing_*` settings of the Visual Studio extension with the same defaults), with generated or removed regions, `#if` blocks moving with their member, initializers that depend on declaration order kept in order, an option to run it at the start of cleanup, and a question about files with preprocessor conditionals.
- Added Insert Region Around Selection and Remove Region (under the cursor or in the selection).
- Sort Lines now behaves like the Visual Studio command: empty lines are dropped, the order is culture-aware, every line ends with a line break, and a last selected line that the selection only reaches the start of is left out.
- Fixed the parser: explicit interface implementations of indexers (`int I.this[int i]`) and of events with accessors (`event Action I.E { add {} remove {} }`) are now single members instead of incomplete declarations.
- Added a Razor and Blazor formatter (`codeJanitor.formatRazor`, `codeJanitor.cleanup.formatRazorComponents`, `codeJanitor.razor.indentSize`, `codeJanitor.razor.indentStyle`): whitespace-only layout of `@code`/`@functions` and control blocks in `.razor` and `.cshtml` files.
- Added the real-compiler test helper (`test/helpers/dotnetBuild.ts`) and oracle projects for Code Style, Usings, Reorganize and Razor; `npm run verify:compile` covers them. The shared transformation corpus gained the two lambda null-check fixtures of the Visual Studio repository (the block-lambda conversion is a documented divergence: no semantic model).

### Added

- **Severities from the project, as the compiler reads them**: `.globalconfig` files and
  `<GlobalAnalyzerConfigFiles>` (resolved by `global_level`, below the `.editorconfig`), `NoWarn`,
  `WarningsAsErrors`/`TreatWarningsAsErrors`/`CodeAnalysisTreatWarningsAsErrors`, and the SDK rule
  sets of `AnalysisLevel`/`AnalysisMode` (including compound levels and per-category properties),
  read from the `.csproj` and `Directory.Build.props`/`.targets`. The CA rules' implicit default
  severity is shown by the diagnostics but never triggers a rewrite.
- **More code-quality rules**: CA1836, CA1841, CA1854, CA1858, CA1861, CA1862, CA1864, CA1868,
  CA1869, CA2016 and CA2263 fix the cases the syntax proves safe and report the rest; CA1305,
  CA1307 and CA1310 are reported only.
- **Diagnostics and quick fixes for `.editorconfig` rules**: open C# files show, in the editor
  and the Problems panel, each place an enforced rule would change and each violation cleanup
  cannot fix, with the `.editorconfig` severity and a link to the rule. Quick fixes fix one
  occurrence (when it can be fixed on its own), every occurrence of the rule in the file, or run
  the cleanup. Analysis waits for a pause in typing, drops results for text that changed since, and
  skips files over `codeJanitor.diagnostics.maxFileSizeKB`; `codeJanitor.diagnostics.enabled`
  turns it off.
- **Check mode for CI** (`npm run check -- <paths>`): cleanup as a dry run without VS Code, printing
  `file:line: rule (severity): message` and exiting with 1 when a file would change or has an
  enforced violation cleanup cannot fix.
- **Only changed lines** (`codeJanitor.cleanup.onlyChangedLines`, off by default): cleanup on save
  and Cleanup Changed Files keep only the changes on lines changed since the last commit; rules
  whose change spans unchanged lines are skipped and reported, and no renames or type splits are
  made.
- **Marketplace icon** (`assets/icon.png`, 128x128) and a rewritten, user-facing `README.md`: what
  the extension does, the problem it solves, and how to use it, instead of internal architecture
  notes (those moved to `PLAN.md`, the porting/dev history document).
- **C# cleanup engine**, reimplemented natively in TypeScript. All 27 converters of the original
  Roslyn engine: BOM removal, trailing whitespace, tabs to spaces, blank-line normalization and
  padding, region handling, `#endregion` naming, file headers, comment formatting, explicit access
  modifiers, `var` when apparent, readonly fields, sealed classes, file-scoped namespaces, using
  organization, `nameof`, `out var`, pattern-matching null checks, string interpolation, collection
  expressions, CA1869 `JsonSerializerOptions`, single-statement lambdas, single-line method and
  accessor formatting.
- **Commands**: cleanup of the active file, selected files, open files, files changed in Git and
  the whole workspace; toggle cleanup on save; fix namespace; remove regions; format comments;
  remove XML documentation; join lines; sort lines; split a file's top-level types into their own
  files.
- **AI features**: XML documentation generation, explain, code review, clean/refactor and unit test
  generation - through GitHub Copilot (Language Model API) or a custom OpenAI/Claude-compatible
  endpoint.
- **Cleanup on save**, off by default.
- **Cleanup scope rules**: `codeJanitor.cleanup.exclude` and `codeJanitor.cleanup.include`,
  case-insensitive regular expressions matched against the full file path, with exclusions taking
  precedence. They apply to every entry point, including cleanup on save.
- **`codeJanitor.cleanup.removeRegions`** (default `true`, matching the source extension): region
  removal used to be unconditional and is now a setting like every other rule.
- Settings are grouped into categories that follow the source extension's options pages (General,
  Cleaning: File Types / Usings and Namespaces / Insert / Remove / Update / Modern C# / File
  Header, Formatting, AI: Provider / XML Documentation / Unit Tests).
- **`Code Janitor: Use GitHub Copilot Model...`** - lists the models the signed-in GitHub Copilot
  actually exposes, with their context windows, and stores the chosen one for the AI features.
- AI defaults now match the source extension: xUnit as the test framework, a 131072-token context
  window hint and a 256-token cap on XML documentation answers. The other AI actions get 2048
  tokens, replacing a hard-coded 1024.
- Picking a Copilot model that does not exist now reports the available models instead of claiming
  Copilot is unavailable.
- Clarified that `codeJanitor.ai.copilotModel` has no built-in list of models: the setting's
  description and the `Code Janitor: Use GitHub Copilot Model...` picker only ever show what the
  signed-in GitHub Copilot Chat extension reports live, sorted alphabetically for a stable picker;
  an unavailable Copilot reports an empty list and a clear warning, never a placeholder list.
- **`CodeJanitor: Open Settings`** - a settings panel showing every setting on one grouped page,
  with a User/Workspace scope switch, modified markers and a reset button. The form is generated
  from the extension manifest.
- **`.editorconfig` support** for indentation, trailing whitespace, final newline and using order,
  resolved as the EditorConfig specification defines: nested files up to `root = true`, section
  globs with `*`, `**`, `?`, `[...]`, `{a,b}` and `{n..m}` (relative to the `.editorconfig`
  directory when they contain `/`), later sections and nearer files winning, and `unset`.
- **`.editorconfig` as the source of truth for C#**: whenever an `.editorconfig` applies to a
  file, cleanup applies its rules - no setting needed. Where a Code Janitor setting governs the same
  thing (using placement, namespace style, `var`, readonly fields, `out` variable inlining, access
  modifiers, file header, using order, trailing whitespace, byte order mark, final newline,
  collection expressions, lambda bodies), the `.editorconfig` wins when it sets the option and
  enforces it; the settings keep applying to everything else. Settings the `.editorconfig` contains
  that cleanup does not implement are listed once per file in the Code Janitor output channel.
- **`.editorconfig` code style and formatting for C#**: cleanup rewrites code to follow the
  `.editorconfig` rules - namespace declarations, accessibility modifiers, `var`, braces, `this.`
  qualification, using placement, file header template, readonly fields, inlined `out` variables,
  simple `using` statements, indentation style, line endings, final newline, trailing whitespace,
  charset, brace and keyword new lines, spacing and using order; also target-typed `new()`
  (IDE0090), `default` literals (IDE0034), index and range operators (IDE0056, IDE0057), `throw`
  expressions (IDE0016), `is null` over `is object` (IDE0150), tuple swaps (IDE0180), local
  functions over lambdas (IDE0039), tuple deconstruction (IDE0042), UTF-8 string literals (IDE0230),
  `System.Threading.Lock` on .NET 9+ (IDE0330), implicitly typed lambdas (IDE0350), unbound generic
  types in `nameof` (IDE0340), parentheses for clarity (IDE0047, IDE0048), predefined type
  keywords (IDE0049), compound assignment (IDE0054, IDE0074), simplified booleans (IDE0075), `??`
  and `?.` (IDE0029 - IDE0031), `?.Invoke` for delegates (IDE1005), `is null` over
  `ReferenceEquals` (IDE0041), `not` and combined patterns (IDE0083, IDE0078), inferred tuple and
  anonymous member names (IDE0037), conditional assignment/return (IDE0045, IDE0046), object and
  collection initializers (IDE0017, IDE0028), auto properties (IDE0032), expression-bodied members
  (IDE0021 - IDE0027, IDE0061), `readonly` structs (IDE0250), `static` local functions (IDE0062)
  and modifier order (IDE0036), switch expressions (IDE0066), pattern matching over `as`/casts
  (IDE0019, IDE0020), explicit tuple names (IDE0033), expression-bodied lambdas (IDE0053),
  simplified interpolation (IDE0071), extended property patterns (IDE0170), method groups (IDE0200)
  and `readonly` struct members (IDE0251), with primary constructors (IDE0290), namespaces that do not match
  their folder (IDE0130) and unused parameters (IDE0060) reported only. Code-style rules apply only when
  their severity is `suggestion`, `warning` or `error`; C# formatting options only while `IDE0055`
  is; the core EditorConfig properties and the using order options whenever they are set. They run after the other cleanup steps, change code only when the result is certain from the
  syntax, and list the violations they could not fix in the Code Janitor output channel and the
  cleanup summary. See the README for the supported options.
- **Newer `.editorconfig` code-style rules for C#**: collection expressions (IDE0300 - IDE0306),
  `static` anonymous functions (IDE0320), `field`-backed simple accessors (IDE0360), `?? throw`
  null checks (IDE0270), `is` over `as` compared with null (IDE0260), `nameof` in attributes
  (IDE0280), discarded return values and overwritten initializers (IDE0058, IDE0059), the
  experimental blank-line options (IDE2000 - IDE2006), and the rules without an option IDE0001,
  IDE0002, IDE0035, IDE0064, IDE0080, IDE0082, IDE0100, IDE0110, IDE0120, IDE0121, IDE0240 and
  IDE0380. Reported only: IDE0050, IDE0070, IDE0072, IDE0076, IDE0077, IDE0079, IDE0210/IDE0211,
  IDE0220, IDE0241 and IDE0390/IDE0391. Each is gated by its severity and by the project's C#
  version (from `<LangVersion>`/`Directory.Build.props`/target framework) and `<Nullable>`.
- **Using order from `.editorconfig`**: when `dotnet_sort_system_directives_first` is set, cleanup
  always sorts usings (`System` first only for `true`), whatever the "Sort usings" setting says;
  `dotnet_separate_import_directive_groups` adds (`true`) or removes (`false`) the blank lines
  between using groups.
- **Code-quality rules from `.editorconfig`**: while `dotnet_diagnostic.<ID>.severity` (or the
  `Performance`/`Usage`/`Maintainability`/`Style` category or global bulk severity) enforces them,
  cleanup marks members that use no instance data `static` (CA1822, honoring `api_surface`), seals
  internal types nothing in the project derives from (CA1852, honoring `InternalsVisibleTo` and
  `ignore_internalsvisibleto`), removes default-value initializers (CA1805) and unused private
  members (IDE0051), and uses `Array.Empty<T>()` (CA1825), `Any()`/`AnyAsync()` (CA1827, CA1828),
  `Length`/`Count` (CA1829, CA1860), `nameof` (CA1507), char overloads (CA1834, CA1847, CA1865),
  `Contains` (CA2249), no identity casts (IDE0004) and no duplicate or own-namespace usings
  (IDE0005). CA1822 and CA1852 read the project's other C# files to prove the change is safe;
  unread private members (IDE0052), CA1866/CA1867 and every violation that cannot be proven safe are
  listed in the Code Janitor output channel and the cleanup summary.
- **`.editorconfig` naming rules for C#**: cleanup renames symbols that violate the
  `dotnet_naming_rule`/`dotnet_naming_symbols`/`dotnet_naming_style` rules whose severity is
  `suggestion`, `warning` or `error`, choosing the same name as the Visual Studio naming fix and
  following Roslyn's rule ordering. It runs before the other `.editorconfig` categories and renames
  only what the file fully contains: private members, locals, local functions, lambda parameters,
  parameters of private methods and constructors (with their named arguments and XML
  documentation) and type parameters. Public symbols, members of partial types and names whose
  references cannot be resolved from the syntax are listed in the Code Janitor output channel and
  the cleanup summary instead.
- **Workspace-wide rename for `.editorconfig` naming rules** (`codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace`,
  off by default): Cleanup Selected Files and Cleanup Workspace rename the types and non-private
  members that break the naming rules in every file of their project and of the projects
  referencing it, after listing the renames in a dialog, as one undoable edit. Renames that cannot
  be proven safe from the syntax - names used as text (strings, XAML, Razor, JSON), NuGet package
  APIs, `InternalsVisibleTo`, virtual members, bases declared outside the workspace - are reported.
- **One type per file from `.editorconfig`**: when `SA1402` (StyleCop) or `MA0048` (Meziantou) is
  enforced with `dotnet_diagnostic.<ID>.severity`, the cleanup commands first move the extra
  top-level types of a file to their own files, named after each type, and clean them too; the
  summary counts the created files. A file and its new files are written all or nothing (new files
  already written are removed when a later write fails, or when VS Code rejects the edit of the
  open file). Cleanup on save reports these types instead of moving them, since VS Code can drop the
  edits of a save. `SA1649` and `MA0048` file-name mismatches, types
  that cannot be moved safely (partial types, structs, files with preprocessor directives or
  several namespaces) and existing target files are reported instead; files are never renamed or
  overwritten.
- **Full C# formatting from `.editorconfig`**: while `IDE0055` is enforced, cleanup applies every
  `csharp_space_*` option, the `csharp_indent_*` options, `csharp_preserve_single_line_blocks` and
  `csharp_preserve_single_line_statements`, the object-initializer, anonymous-type and query-clause
  new-line options, and re-indents code to `indent_size`, matching Roslyn's formatter. It works token
  by token, never touches strings, comments or preprocessor directives, and leaves the spacing and
  relative indentation of lines the parser cannot fully read as they are (the latter logged to the
  output channel).
- Optional layout-only cleanup for files that are not C#.
- **Explorer context menu**: a `Code Janitor` submenu holding every batch action for a file, a
  folder (recursively) or a multi-selection - `Cleanup Selected Files`, generating and removing XML
  documentation, fixing namespaces, removing regions and formatting comments - instead of a single
  unlabeled item next to unrelated menu entries.
- **`Fix Namespace (Selected Files)`**, **`Remove Regions (Selected Files)`** and
  **`Format Comments (Selected Files)`**: batch variants of the existing single-file editor
  commands. Fix Namespace computes each file's expected namespace from its folder path
  automatically, the same way the input box is pre-filled for a single file, since a batch run
  across many files can't prompt for one; the other two are deterministic and settings-independent,
  same as their single-file counterparts.
- **`Remove XML Documentation (Selected Files)`** and **`Remove XML Documentation (Workspace)`**:
  batch variants of the existing single-file command, for a file, a folder (recursively) or a
  multi-selection in the Explorer, and for the whole workspace. Deterministic, no AI involved.
- **`Generate XML Documentation (AI, Selected Files)`** and **`... (AI, Workspace)`**: batch
  variants of AI XML documentation generation. Files are planned first (a cheap, deterministic,
  AI-free pass); if any AI request would actually be sent, a modal confirmation states exactly how
  many requests across how many files before a single one is fired, since firing AI requests across
  a whole project unattended is a materially different risk than doing it for one open file.
- **`Clean and Refactor (Cleanup + AI)`**: runs the deterministic cleanup pipeline on the active
  file, then the existing `Clean and Refactor (AI)` action on it - which still shows its own diff
  preview and asks before applying anything, exactly as it does standalone. No workspace-wide
  variant: unlike documentation (which only adds comments), an AI refactor changes logic-adjacent
  code, so applying it unattended across many files was judged too risky to ship without a
  finer-grained review step per change; see `PLAN.md` for the reasoning.

- **Preview Cleanup** can now leave out single changes. **Choose Rules...** lists each step and
  each `.editorconfig` rule that changes the file, with its number of changes
  (`IDE0090 (3 changes)`). Unchecked ones are left out of the diff and of what gets applied.

### Fixed
- Rewrites that broke the build or changed behavior, found by cleaning a large real C# solution with every setting and rule:
  - `readonly` was added to a field written inside an interpolated string (`$"{_n++}"`, `$"{(_n = 3)}"`, `out _n`).
  - `static` was added to a lambda that captures a local, a parameter or a member (CS8820/CS8821), also through names inside interpolated strings, in
    constructor initializers and inside `with` expressions (the parser now reads `with`).
  - CA1869: `new JsonSerializerOptions()` was replaced by a positional `null`, which is ambiguous between overloads (CS0121); it is now `default(JsonSerializerOptions)`
    (positionally) or `null` (as `options:`).
  - Blank lines inside multi-line string literals (verbatim, raw and interpolated) were collapsed by *Remove multiple consecutive blank lines* and by IDE2000.
  - `string.Format` was converted to an interpolated string even when that changes the number or the order of evaluations of its arguments, and a conditional
    argument was not parenthesized (CS8361).
  - Code review fixes, each with a test reproducing it:
    - Rewrites that no longer compiled or changed behavior: `return(x)` became `returnx`; `a - --b` became `a---b` with
      `csharp_space_around_binary_operators = none`; an expression body was put after a `//` comment on the header line; a trailing
      `throw` after an assigning `switch` was folded into its `_` arm; `?.` on a `Nullable<T>` pattern null check (CS1061); object/collection
      initializers, deconstruction, tuple swap and pattern matching that ignored uses inside interpolated strings; `static` lambdas reading
      deconstructed or `case` pattern locals; `readonly` struct members calling through nested struct fields.
    - Using directive placement skips moves that would rebind a name: a namespace directive resolved only through a moved one, an alias
      next to a same-named imported type, an alias named like a member of the target namespace (CS0576); `<Using>` items count as global usings.
    - CA1822/CA1852 read member uses inside interpolated strings and property patterns of other files, keep pattern-bound members
      (`GetEnumerator`, `Deconstruct`, ...) and interface implementations through derived types, and report instead of fixing in projects
      with Razor/XAML markup.
    - Workspace rename refuses anonymous-type, `dynamic` and unresolved-receiver members, contextual keywords as new names, and projects
      whose references or packability it cannot read; it no longer inserts a byte order mark.
    - In the effective settings, `NoWarn` wins over `.editorconfig` severities, and the `AnalysisLevel`/`AnalysisMode` rule set over the
      category and global bulk severities, as in the build; `<GlobalAnalyzerConfigFiles>`
      items resolve against the project; a `none` severity on the selected diagnostic is no longer overridden.
    - The preview, Reorganize and Insert Region use the `.codejanitor` nearest to each file; Cleanup Open/Changed Files and Workspace
      format Razor files when `formatRazorComponents` is on.
    - `check` lists Code Janitor setting notes without failing on them; changed-lines cleanup ignores a byte order mark in `HEAD`;
      `x < (y) ? a > b : c` is no longer parsed as a generic name; the Razor formatter keeps inline control blocks as written; Reorganize
      keeps static initializers that read names it cannot resolve in order.
    - Large files: applying edits, IDE0360 and IDE0002 were quadratic.
    - Casts to tuple types (`(List<(int, int)>)o`) and calls inside comparisons (`F(x < Max(a, b), y > z)`) parse correctly again;
      `string.Format` to interpolation escapes backslashes and control characters; `global::` inside interpolation holes is read
      whole; workspace rename handles extension-method calls, `this.field.member` and derived types; CA1822 keeps `Length`/`Count`
      a derived type or `Slice` needs; project-file imports and XML comments in MSBuild files are honored.

- **Project settings read as MSBuild evaluates them**: the target frameworks, C# version, root
  namespace and `<Nullable>` ignore XML comments, follow `Directory.Build.targets` and resolvable
  imports, and are unknown (never guessed) when a `Condition`, `<Choose>`, unresolved import or
  unknown property decides them. IDE0240 no longer removes `#nullable` directives needed under a
  conditional `<Nullable>`; it reports them.
- **One type per file keeps the type named like the file**: names are compared up to the first dot
  (`View.xaml.cs` keeps `View`), and a matching type that cannot move itself (a partial class) keeps
  the file while the other types move, instead of the first movable type staying.
- Cleanup Changed Files with `onlyChangedLines`: a file whose last commit cannot be read (not in a
  repository, its folder removed, Git failing) fails alone and the other files are still cleaned; a
  file that exists only in the editor counts as new instead of stopping the whole command.
- An open file whose edit VS Code rejects (or that is closed during cleanup) now counts as failed
  instead of changed, in the cleanup commands, Split Top-Level Types and batch XML documentation.
- Cleanup on save logs its failures in the Code Janitor output channel instead of ignoring them.
- With the workspace-wide rename, a naming violation of a public symbol is reported once, with the
  reason it was not renamed across the workspace, and not at all once it is renamed.
- Removing the blank lines at the bottom of a file keeps its final newline whenever a final
  newline is ensured (always, unless `insert_final_newline = false`), instead of dropping it for
  the next step to add back. This also stops the preview from listing both steps as changes.
- The `.codejanitor` keys of the Visual Studio extension that VS Code does not honor
  (`applyEditorConfigFormatting`, `applyEditorConfigNaming`, `applyEditorConfigCodeStyle`,
  `applyAnalyzerCodeFixes`) are no longer ignored silently. Each one is logged as ignored, with the
  reason, once per session.
- Less output noise:
  - Unsupported `.editorconfig` settings are listed once per cleanup run, with the number of files
    they affect, instead of once per file. For single-file cleanup, cleanup on save and the
    preview, an `.editorconfig`'s unsupported settings are listed only once per session.
  - When explicit types are preferred (IDE0008), the `var` locals whose type is not known without
    a compiler are reported in one line per file instead of one line each.

- Pattern-matching null checks (`convertToPatternMatchingNullChecks`) no longer rewrite `== null` /
  `!= null` inside a lambda that may be compiled to an expression tree (e.g. an EF Core
  `IQueryable<T>.Where(x => x.Foo != null)`), which used to produce code that fails to compile
  (CS8122: an expression tree may not contain an `is` pattern-matching operator).
- Explicit access modifiers: types nested in an interface get `public` (their default) instead of
  `private`, and C# 11 file-local types (`file class C`) no longer get `internal` added.
- `CodeJanitor: Cleanup Active File` now cleans a brand-new, unsaved C# file: file-type detection
  used to look only at the `.cs` extension, which an untitled document does not have yet, and
  silently skipped it even though its language mode was C#.
- **Format Comments** no longer mangles `///` XML documentation comments into `// /`. The comment
  spacing normalizer matched any line starting with `//`, so a doc comment's third slash was read
  as the start of the comment text and got a space inserted in front of it; it now captures the
  whole run of slashes (`//`, `///`, `////`, ...) and only normalizes the spacing after it.
- **Import Settings from .codejanitor** no longer fails in VS Code with "... is not a registered
  configuration": it wrote each blank-line-padding and explicit-access-modifier key on its own,
  although only their group settings exist, and the repository-only padding keys (single-line
  fields, properties and comments). Grouped keys are imported through their group setting, and
  repository-only keys stay in `.codejanitor`, which the import message now says.
- Blank-line padding and the blank line before `return`/`throw` inserted blank lines at the wrong
  place - and a new one on every run - in a CRLF file whose verbatim strings contain bare LF line
  breaks: lines were counted on CRLF while the syntax tree counts them on LF.
- One type per file: two files cleaned together that both hold an extra type of the same name
  (in different namespaces) no longer write it to the same new file, where the second overwrote
  the first. The second file keeps its type and the violation is reported.
- `.editorconfig` naming rules now run after the code-style rules, so names those rules introduce
  (e.g. the local function IDE0039 makes of a lambda) follow the naming rules in the same cleanup
  instead of the next one.
- Code-style rules and the matching Code Janitor settings were audited against the C# rules (see
  "Code-style guards checked against the C# rules" in the README). Each rule is skipped and
  reported when the project's C# version or runtime lacks the syntax it needs, whether that
  version comes from `<LangVersion>`, `Directory.Build.props` or the target framework default.
  New guards against rewrites that break the build or change behavior:
  - IDE0056 needs a known countable receiver; IDE0071 only simplifies value types and enums.
  - IDE0090 skips nullable targets and type parameters; IDE0150 and IDE0041 skip non-nullable
    value types; IDE0074 skips properties; IDE0200 skips `[Conditional]` methods.
  - IDE0016 and the pattern-matching null-check setting skip types that may overload `==`.
  - IDE0032 keeps field initializer order; IDE0053 and the single-statement lambda setting only
    rewrite lambdas stored as a written delegate type.
  - IDE0044 and the readonly-field setting skip possibly mutable struct fields.
  - IDE0018 and the out-variable setting no longer move a variable out of scope.
  - IDE0160 skips a namespace wrapped in `#if`; moving usings outside a namespace (setting)
    skips usings that resolve relative to it.
  - IDE0040 and the access-modifier setting leave explicit implementations of generic interfaces
    and unreadable type bodies alone.
- The C# parser now reads `await f(x)` in `if`/`while` headers and in lambda arguments, tuple types
  used as type arguments (`IEnumerable<(Type A, object B)>`) and explicit implementations of
  generic interfaces (`Task IHandler<T>.Handle(...)`). Rules used to garble these into code that
  did not compile.
- Blank-line padding keeps a `//` comment attached to the member below it and no longer adds a
  second blank line after a member already followed by one.
- The editor context submenu no longer splits Generate and Remove XML Documentation across two
  groups separated by an unrelated divider. They are adjacent, in their own group - not folded into
  the AI actions group either, since removal never calls AI.

### Testing

- Added `test/e2e/`, a suite that runs inside a real, isolated VS Code instance
  (`@vscode/test-cli` / `@vscode/test-electron`) rather than the hand-written `vscode` mock the
  rest of the suite uses - real activation, real command registration, the real Settings schema.
  `npm run test:e2e`; runs in CI on Ubuntu (via `xvfb-run`), Windows and macOS.

### Testing

- Added `test/e2e/`, a suite that runs inside a real, isolated VS Code instance
  (`@vscode/test-cli` / `@vscode/test-electron`) rather than the hand-written `vscode` mock the
  rest of the suite uses - real activation, real command registration, the real Settings schema.
  `npm run test:e2e`; runs in CI on Ubuntu (via `xvfb-run`), Windows and macOS.
- Added `scripts/smoke-test.js` (`npm run smoke-test -- <path>`): runs the cleanup pipeline and the
  XML documentation planner against every `.cs` file in an arbitrary real-world repository,
  read-only, no `vscode` host needed. Catches parser/pipeline crashes that hand-written unit test
  fixtures do not reach.
- `test/e2e/editorConfig.test.ts`: in the real VS Code host, a fixture folder with its own
  `.editorconfig` checks that cleanup applies naming, code-style and formatting rules, lists the
  settings it does not apply in the Code Janitor output channel, moves extra types to their own
  files (SA1402) and applies the rules on save.
- `test/oracle/MultiProject`: a project using another project's public API, for the compile
  oracle of the workspace-wide rename; CI runs `npm run verify:compile` in a separate job with
  the .NET SDK.
- `npm run verify:compile`: a compile oracle that builds C# projects before and after cleanup with
  every rule enforced and finds the rule behind each new compiler error, over a corpus of tricky
  C# in `test/oracle` (see `PLAN.md`). Development only; needs the .NET SDK.
- `npm run generate:editorconfig`: writes an `.editorconfig` with every documented C# code-style,
  formatting and naming option at its documented default, enforcing as warnings what cleanup
  applies (see `PLAN.md`).
- Extended `test/e2e/` to a full pass over the three places a user actually interacts with the
  extension: every declared setting is read from the real Settings system and checked against its
  declared JSON type/enum, plus a real update/clear round-trip; every declared command is executed
  through the real Command Palette path with prompts auto-answered (34 real-host tests in total);
  and the editor context submenu's structure (grouping, adjacency) is checked against the manifest.

### Added (troubleshooting)

- A **"Code Janitor" output channel** and the **`Code Janitor: Show Output Channel`** command.
  Cleanup errors, AI request failures (including the ones that silently fell back to a
  deterministic summary before) and command-level exceptions are now logged there with full detail,
  instead of only a one-line toast notification.

### Notes

- The extension is pure TypeScript/JavaScript with no runtime dependencies. C# parsing uses a
  hand-written lexer and recursive-descent parser, so the same artifact runs on Windows, Linux and
  macOS, on x86-64 and arm64, with no .NET runtime, no WebAssembly and no native binaries.
