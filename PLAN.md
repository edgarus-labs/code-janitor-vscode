# Code Janitor for VS Code — Development Guide

For installation and user-facing features, see [README.md](README.md). Release changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## Scope and origin

This extension ports cleanup functionality from
[Code Janitor for Visual Studio](https://github.com/edgarus-labs/code-janitor-vs), derived from
[CodeMaid](https://github.com/codecadwallader/codemaid). The VS Code implementation uses
TypeScript and JavaScript. It does not require a .NET process, WebAssembly grammar or native
parser binary at runtime.

The two extensions share cleanup concepts and transformation fixtures, but do not offer
identical IDE integration or semantic analysis. Visual Studio-specific navigation, complexity
views, member reorganization and third-party IDE integrations are outside this port's scope.

## Architecture

- `src/cleanup/`: cleanup settings, ordered transformations, lexical scanning and EditorConfig support.
- `src/cleanup/syntax/`: C# tokenizer, syntax node model and recursive-descent parser.
- `src/cleanup/transformations/`: cleanup rules expressed as source-text edits.
- `src/cleanup/naming/`: `.editorconfig` naming rules - Roslyn naming style/rule ports, the
  syntactic symbol and scope model, and the safe in-file renamer.
- `src/cleanup/analysis.ts`: cleanup in analyze mode - runs the pipeline step by step and locates
  each rule's changes (`lineDiff.ts` hunks mapped back to the original lines) and the violations
  reported, and fixes one rule or one occurrence (kept only when the rest of the rule's fix still
  gives the same file). Used by `commands/diagnostics.ts` (diagnostics, quick fixes, debounced and
  versioned per document) and `src/cli/check.ts` (check mode, `scripts/check.ts`, no VS Code; the
  `.codejanitor` reader is `cleanup/repositoryOverrides.ts` for that reason).
- `src/cleanup/changedLines.ts` and `gitBaseline.ts`: `onlyChangedLines` - the lines changed since
  `git show HEAD:<path>`, and a pipeline run that keeps each step's (or rule's) hunks on those
  lines, skipping a unit whose change spans unchanged lines or whose dropped hunks it needs.
- `src/ai/`: GitHub Copilot and custom endpoint clients.
- `src/commands/`: commands, settings integration and cleanup-on-save.
- `src/extension.ts`: extension activation.
- `test/`: unit and command tests; `test/e2e/` runs inside a real VS Code host.
- `shared/tests/transformations/`: shared behavior fixtures for the VS and VS Code implementations.

### Visual Studio parity modules

- `src/cleanup/codeStyleRules.ts`: catalog of the 53 Code Style rules (key, group, label, diagnostic ids, values, default, `csharp_preferred_modifier_order` validation), the setting format and its package.json schema.
- `src/cleanup/effectiveSettings.ts`: port of `EffectiveCleanupSettings.cs`: resolves per file which settings `.editorconfig` decides (severity resolution of the Visual Studio doc: `:none` stopper, diagnostic > category > global > suffix, CA1852 disabled by default, Roslyn default values for severity-only enforcement), merges the policy and the enabled Code Style rules over `.editorconfig` (the synthetic analyzer-config layer: rule with `suggestion`, diagnostics raised, sibling rules of a shared diagnostic silenced with `:none`; in memory only). `getCleanupPipeline` (`runCleanup.ts`) and `analysis.ts` use it; `buildPipeline` only sees the effective settings and properties.
- `src/cleanup/repositoryOverrides.ts`: `.codejanitor` reader: `findRepositoryConfigFile` (walk up), `readRepositoryPolicy`, `parseRepositoryPolicy`, `applyRepositoryPolicy` (policy over user). `commands/settings.ts`: `readCleanupSettings(startDirectory)` / `readCleanupSettingsForUri(uri)`.
- `src/cleanup/overrideNotes.ts`: the settings panel override notes (`editorConfigOverrideNotes`); `findDefiningEditorConfigPath` in `editorconfig.ts` names the file.
- `test/oracle/CodeStyle/` (one file per group); `scripts/compile-oracle.ts` also runs every oracle project with all Code Style rules enabled and no `.editorconfig` rule (the opt-in layer).
`src/cleanup/usings/` holds the using-directive placement: `layout.ts` (token-level layout of directives and namespaces), `declarations.ts` (per-file declaration summaries, the `DeclarationIndex` view and the generated `bclIndex.generated.ts` of the .NET reference assemblies, written by `scripts/bclIndex`), `workspaceIndex.ts` (project discovery, caches), `names.ts` (used names, what a directive imports), `placement.ts` (qualification, hazards, text edits, verification). `transformations/namespaceScope.ts` wires it and owns the namespace style conversions. Verified against the C# compiler by `test/usingPlacementCompile.test.ts` (corpora `test/oracle/Usings`, `test/oracle/UsingsGlobal`).
- `src/commands/cleanupPreview.ts`: the plan (`buildCleanupPreviewPlan`, `PreviewFile` with per-rule outcomes recomputed from the original text, parse-problem guard via `parseErrorCount`), the virtual-document provider (`codejanitor-preview:`) and `applyCleanupPreviewPlan` (stale check per file, one `WorkspaceEdit`, per-file retry when VS Code rejects it). `cleanupPreviewUi.ts`: QuickPick review loop (`createQuickPick`, item buttons, `vscode.diff`), progress with cancellation, closing the diff tabs. `cleanupCommands.ts` registers the four preview commands and the optional options dialog. `switchFile.ts` / `navigation.ts`: Switch File (VS `SwitchFileCommand` ordering) and the workflow commands; `registerNavigationCommands(context)` must be called from `extension.ts`.
- Tests: `test/cleanupPreview.test.ts`, `test/navigation.test.ts`, `test/cleanupPreviewCompile.test.ts` (real `dotnet build` before/after for every scope), helpers `test/helpers/previewMock.ts` (scriptable `createQuickPick`, virtual-document providers, tabs) and `previewFixtures.ts`; fixtures in `test/fixtures/preview/`.
- Known differences from Visual Studio: the options dialog has no temporary-settings page; rule list shows the `.editorconfig` rules that change the file (as in the active-file preview); no disk-level rollback; closed files become unsaved buffers.
- `src/reorganize/`: Reorganize, the port of `Logic/Reorganizing` of the Visual Studio extension on the syntax tree (no Roslyn).
  `settings.ts` (the `Reorganizing_*` settings), `comparer.ts` (`CodeItemTypeComparer`), `structure.ts` (a container's members, comments,
  `#if` blocks, regions and barriers as line-aligned entries), `memberInfo.ts` (kind, access, static/const/read-only, explicit
  interface), `initializers.ts` (which initializers must keep their order), `regions.ts` (`GenerateRegionLogic` names),
  `reorganize.ts` (sorting, region removal/insertion, emission, safety nets; `reorganizeSource`, `createReorganizeTransformation`),
  `sortLines.ts`, `regionEdits.ts` (insert/remove region commands). `src/commands/reorganizeCommands.ts` are the commands.
  A rewrite only ever permutes the lines of a body (plus region directives): a body whose lines differ, whose `#if`/`#region` nesting
  broke, or a file that parses worse afterwards is left unchanged. What is left alone is reported (`ReorganizeResult.skipped`,
  logged to the output channel). `test/oracle/Reorganize` is the real-compiler corpus (`test/reorganizeCompile.test.ts` builds it before
  and after with 11 setting combinations and compares what `Program.cs` prints: the value of every static and instance field).
- `src/razor/`: Razor/Blazor formatter (`razorScanner.ts`, `csharpLayout.ts` runs the repo's own formatting engine under fixed Roslyn-default rules, `razorFormatter.ts`, `razorOptions.ts`, `razorSettings.ts`); `commands/razorCommands.ts`. A layout is used only when the wrapped code parses cleanly and the token stream is unchanged; only whitespace changes. Verified by `test/razorOracle.test.ts` (a Razor SDK project built before and after).
- Real-compiler tests: `test/helpers/dotnetBuild.ts` (`buildFiles`, `writeProject`, `buildProject`) builds fixtures before and after; wrap such tests in `describe.skipIf(!dotnetAvailable)`. Regenerate the framework index of the using placement with `dotnet run --project scripts/bclIndex -- src/cleanup/usings/bclIndex.generated.ts <Microsoft.NETCore.App.Ref dir> <Microsoft.AspNetCore.App.Ref dir>`.

The parser supports the transformations implemented here; it is not a replacement for Roslyn's
compiler or semantic model. Text edits preserve surrounding source formatting. When changing a
transformation, test comments, literals, preprocessor directives and line endings as well as the
intended syntax. Document intentional differences from the Visual Studio implementation.

### `.editorconfig`-driven categories

`src/cleanup/editorconfig.ts` resolves the `.editorconfig` properties of a file and the effective
severity of a diagnostic. `src/cleanup/editorConfigRegistry.ts` is the single registry of the
settings cleanup applies and when each takes effect (always, while IDE0055 is enforced, or while
the option's diagnostic is enforced); it lists the file's unsupported settings and tells
`buildPipeline` which settings the `.editorconfig` decides. For those, the step of the conflicting
Code Janitor setting is skipped or adjusted (the mapping is in the README). The naming, code-style
and formatting categories run at the end of `buildPipeline` (`runCleanup.ts`), in that order,
after every other step, whenever the file has `.editorconfig` properties. Issues reach the
commands as `EditorConfigIssue`s (`{ kind, filePath, detail }`): `unresolved` violations
(counted in the cleanup summary) and `unsupported` settings. `editorConfigIssueLog.ts` logs them
for one run: violations per file, each unsupported setting once with its file count, and for
single-file runs (cleanup on save, preview, Cleanup Active File) only for `.editorconfig`
configurations not yet reported in the session. The preview (`pipeline.preview`) can leave out
steps by index and `.editorconfig` rules by diagnostic id: the code-style converter implements
`SourceTransformation.applyRules`, which reports how many places each rule changed. `lineDiff.ts`
counts those places.

- `oneTypePerFile.ts`: `SA1402`/`MA0048`/`SA1649` (explicit `dotnet_diagnostic` severity only).
  Not a pipeline step: it creates files, so `commands/cleanupCore.ts` (`splitTypesForEditorConfig`)
  runs it before the pipeline in the cleanup commands, using `topLevelTypeSplit.ts` with
  `movableKinds` and `refuseFileNameCollisions`, and cleans the created files like the rest; a file
  and its new files are written all or nothing (`writeFileGroup`). Cleanup on save only reports
  (`reportOneTypePerFileOnSave`): VS Code can drop a save's edits, so it never creates files.
- `transformations/editorConfigNaming.ts`: IDE1006. `naming/namingRules.ts` parses and orders
  the rules (Roslyn `EditorConfigNamingStyleParser`), `naming/namingStyle.ts` checks names and
  derives the fixed name (Roslyn `NamingStyle`), `naming/sourceModel.ts` collects declarations,
  scopes and every identifier occurrence with its role, and `naming/renamer.ts` plans a rename
  that is refused unless every occurrence in the symbol's scope is understood. Violations are
  fixed in passes over the re-parsed text until none can be fixed; the rest are reported.
  With `renamePublicSymbolsAcrossWorkspace`, `naming/workspaceScope.ts` reads the workspace's
  project files (files, `ProjectReference`s, packaging, `InternalsVisibleTo`) and
  `naming/workspaceRenamer.ts` plans the renames of types and non-private members across the
  declaring project and the projects referencing it; `commands/workspaceRename.ts` previews them
  and applies them as one WorkspaceEdit after batch cleanup.
- `transformations/editorConfigCodeStyle.ts`: code-style rules in a fixed order, reusing the
  existing converters (file-scoped namespaces, explicit access modifiers, readonly fields, `out`
  variable inlining, using placement). Rule modules: `editorConfigQualification.ts` (`this.`),
  `editorConfigVarPreference.ts` (`var`), `editorConfigBraces.ts` (braces),
  `editorConfigExpressionPreferences.ts` (target-typed `new`, `default`, index/range, `is null`,
  `nameof`, UTF-8 literals, implicit lambdas), `editorConfigStatementPreferences.ts` (`throw`
  expressions, tuple swap, local functions, deconstruction, conditional assignment/return,
  object and collection initializers, switch expressions, `is` patterns over `as`/casts), `editorConfigTypePreferences.ts` (`System.Threading.Lock`,
  primary constructors), `editorConfigOperatorPreferences.ts` (parentheses, predefined types,
  compound assignment, simplified booleans, `??`, `?.`, delegate calls, `is null`/`not`/combined
  patterns, inferred names, explicit tuple names, simplified interpolation, extended property
  patterns, method groups), `editorConfigPrecedence.ts` (shared precedence and null-check helpers), `editorConfigMemberPreferences.ts` (modifier order, `readonly`
  structs and struct members, `static` local functions, auto properties; namespace/folder and unused parameters
  reported) and `editorConfigExpressionBodies.ts` (expression-bodied members and lambdas),
  `editorConfigSimplificationRules.ts` (IDE0035, IDE0080, IDE0082, IDE0100, IDE0110; IDE0050,
  IDE0070, IDE0072, IDE0076, IDE0077 reported), `editorConfigCollectionExpressions.ts`
  (IDE0300 - IDE0306), `editorConfigLanguageRules.ts` (IDE0001/0002, IDE0058/0059, IDE0064,
  IDE0120/0121, IDE0240/0241, IDE0260, IDE0270, IDE0280, IDE0320, IDE0360, IDE0380; IDE0079,
  IDE0210/0211, IDE0220, IDE0390/0391 reported) and `editorConfigBlankLineRules.ts` (IDE2000 -
  IDE2006, run last). The rules run in passes until one changes nothing (at most three), and only
  the last pass reports.
  `projectInfo.ts` reads the nearest `.csproj` (root namespace, target frameworks, C# language
  version, `<Nullable>` context and whether the runtime has `System.Index`/`Range`) for rules that
  depend on it, through the static evaluator of `msbuildProperties.ts` (`Directory.Build.props`,
  the project, resolvable imports, `Directory.Build.targets`; a value a `Condition`, `<Choose>`,
  unknown import or property decides is unknown, never guessed); a rule whose rewrite needs a newer C# version or runtime is skipped and reported.
  `typeFacts.ts` holds what the file proves about a type (reference types without `operator ==`,
  non-nullable value types, plain null comparisons, variables, the written delegate type of a
  lambda), shared by the code-style rules and the legacy converters.
- `transformations/editorConfigQualityRules.ts`: the code-quality (CA) rules and the IDE rules
  without a code-style option (`SUPPORTED_DIAGNOSTICS` in the registry), run by the code-style
  stage before the member preferences, each gated on its diagnostic's severity (including the
  category bulk severity). `editorConfigQualityRulesMembers.ts` (CA1822 `static`, IDE0051/IDE0052
  unused/unread private members, repeated until stable), `editorConfigQualityRulesSealing.ts`
  (CA1852), `editorConfigQualityRulesExpressions.ts` (CA1805, CA1825, CA1827-CA1829, CA1860, CA1507,
  CA1834, CA1847, CA1865-CA1867, CA2249, IDE0004, IDE0005), `editorConfigQualityRulesSupport.ts`
  (suppressions, generated code, `dotnet_code_quality` options, visibility, target-framework API
  checks, declared-type lookup on the naming `SourceModel`) and `editorConfigQualityRulesProject.ts`
  (facts from the project's other C# files - derived types, member-access names, interfaces,
  `InternalsVisibleTo` - cached per file version; a project whose files cannot all be listed or read
  makes CA1822/CA1852 report instead of fixing). `editorConfigQualityRulesCollections.ts` (CA1836,
  CA1841, CA1854, CA1864, CA1868), `editorConfigQualityRulesStrings.ts` (CA1858, CA1862; CA1305,
  CA1307, CA1310 reported) and `editorConfigQualityRulesCalls.ts` (CA1861, CA1869 - both add
  `private static readonly` fields named by the naming rules -, CA2016, CA2263).
- Severity sources: `editorconfig.ts` `loadEditorConfigProperties` merges the `.editorconfig` entries
  over the project's global AnalyzerConfig files and attaches the project's `ProjectAnalysis`
  (`analyzerConfig.ts`: `.globalconfig`/`GlobalAnalyzerConfigFiles` resolved by `global_level`;
  `NoWarn`, `WarningsAsErrors`, `TreatWarningsAsErrors`, `CodeAnalysisTreatWarningsAsErrors`;
  `AnalysisLevel`/`AnalysisMode` and their per-category variants). `msbuildProperties.ts` reads the
  unconditional properties and items of the `.csproj` and the nearest `Directory.Build.props`/
  `.targets`. `analyzerRules.ts` holds the CA rules' category, default severity and the SDK rule sets
  (copied from .NET SDK 10.0.112 `analysislevel_*.globalconfig` and `analysislevelstyle_*`); the
  registry's `SUPPORTED_DIAGNOSTICS` takes the CA entries from it. `resolveDiagnosticSeverity`
  applies them in the compiler's order; `isDiagnosticEnforced` ignores a CA rule's implicit default
  severity, so cleanup only rewrites what is enabled explicitly.
- `transformations/editorConfigFormatting.ts`: core EditorConfig properties and using order, and the
  C# formatting options gated on IDE0055, in this order: `editorConfigWrapping.ts` (single-line
  blocks and statements, initializer and anonymous-type members), brace and keyword new lines,
  `editorConfigSpacing.ts` (every `csharp_space_*` option, one horizontal gap at a time), query
  clauses (aligned with `from` once spacing is final) and `editorConfigIndentation.ts` (re-indents
  each line from the syntax tree to `indent_size`, following the `csharp_indent_*` options).
- `transformations/editorConfigSupport.ts`: option/severity reading, indentation and line helpers,
  and parse-error detection shared by the rules.

Differences from the Visual Studio implementation, which applies Roslyn's code fixes: rules are
implemented natively on the syntax tree, a subset of options is supported (see the README), and a
rewrite happens only when it is certain from syntax. Otherwise the violation is passed to the
pipeline's reporter, which logs it to the output channel and counts it in the cleanup summary.
Members the parser only partially understood (`hasParseErrors`) are skipped, and a rule whose result
parses worse than its input is discarded. Reported line numbers refer to the text at that point of
the cleanup, after earlier steps.

The Visual Studio naming fix renames a symbol across the solution; here a symbol is renamed only
when all its references are in the file and each one is identified from the syntax (so types,
non-private members and members of partial types are always reported, never renamed).

## Local development

Clone this repository and create a topic branch from `develop`. Use Node.js and npm compatible
with the repository's dependencies and CI workflow.

```sh
npm ci
npm run compile
npm test
npm run build
npm run verify:bundle
npm run test:e2e
```

- `compile` checks TypeScript without emitting files.
- `test` runs the Vitest suite. `CODE_JANITOR_TEST_CATEGORY` narrows it: `unit` skips the tests that build C#
  with the .NET SDK, a category of `test/compilerTests.json` (`codestyle`, `usings`, ...) runs only its files.
  CI runs `unit` in Build and Test and each category in its own `compiler-tests` job, with
  `CODE_JANITOR_REQUIRE_DOTNET=1` so a missing SDK fails instead of skipping. A new test file that uses
  `dotnetAvailable` must be added to a category; `test/compilerTestCategories.test.ts` fails otherwise.
- `build` bundles the extension to `dist/extension.js`.
- `verify:bundle` exercises the bundled cleanup pipeline.
- `test:e2e` builds the extension, compiles tests and runs a real VS Code host. It downloads
  a test host and requires a graphical display (or a virtual display on headless Linux).

Use the current run and CI results for test counts; historical counts are not a release gate.

To package the extension locally:

```sh
npm run package
```

Install the resulting VSIX using **Extensions → Install from VSIX...**.

## Verification and contributions

Keep changes focused and open pull requests against `develop`. Explain the problem, resulting
behavior and verification performed. Add regression coverage when changing cleanup rules,
especially for constructs that could change compilation or runtime behavior.

Unit tests use a VS Code API mock for command behavior. Real-host tests cover activation,
command registration and settings integration. Both are needed when changing IDE integration.
Update shared transformation fixtures when changing behavior shared with the VS extension.

### The testbed

[code-janitor-testbed](https://github.com/edgarus-labs/code-janitor-testbed) is a solution of deliberately bad C#: one class per
cleanup option, named after the option, plus `scenarios.json` saying what each cleanup must do. Without Roslyn it is the measure of
whether a rewrite is right, so it covers everything the engine does and is checked for completeness:

- every Code Style rule, every cleanup setting that changes text, every Reorganize option and every key and diagnostic of the
  `.editorconfig` catalog (`editorConfigCatalog()`) needs a scenario; a missing one fails the test, and the few exemptions are listed in
  `test/testbed.test.ts` with the reason (`onlyChangedLines` and the workspace rename need git history or a whole workspace);
- each rule also runs through a real `.editorconfig`, with its value turned off, with its severity turned off, and, for the rules that
  rewrite both ways, with the opposite value;
- traps: code a rewrite must not touch (a field written in an interpolation, a lambda that captures, `string.Format` with side effects,
  expression trees, string literals, `#if` blocks), run with every option on at once;
- using placement and namespace style, the `.codejanitor` policy and its precedence, several `.editorconfig` files, layout cleanup of
  other file types, Razor, the line commands (sort lines, insert and remove region) and the file commands (XML documentation, namespace,
  split types, one type per file).

`npm run test:testbed` (`test/testbed.test.ts`) runs every scenario alone, requires cleaning the result again to change nothing
(except wrapping lines in a region, which is an action), and builds and runs the whole solution before and after the cleanups, each
alone and then every option at once: a rewrite that does not compile or changes what a scenario prints fails the test. A scenario the
engine gets wrong carries a `knownDefect` marker: its checks must fail, and the test tells you when it starts to pass.

CI clones the testbed (branch `develop`) into `.testbed` and sets `CODE_JANITOR_REQUIRE_TESTBED=1`, so a missing testbed fails the
build; locally set `CODE_JANITOR_TESTBED` or keep a sibling `code-janitor-testbed` folder, otherwise the test is skipped. Add a
scenario there whenever an option is added or a rewrite that broke the build is fixed. Not covered, because they are not text
transformations of one file: AI actions, the preview, diagnostics and quick fixes, `check` mode, `Join Lines` (its logic is in the
editor command) and the navigation commands.

An optional read-only smoke test can exercise cleanup and XML documentation planning on a
source directory you are authorized to inspect:

```sh
npm run smoke-test -- <source-directory>
```

`npm run generate:editorconfig -- [path]` writes an `.editorconfig` (default `./.editorconfig`)
with every C# code-style, formatting and naming option Microsoft documents at its documented
default. Its severities come from the `.editorconfig` registry: what cleanup applies is a
`warning`, the other documented style rules are `suggestion`s. The option data and its
documentation links are in `scripts/editorConfigTemplate.ts`; `test/editorConfigTemplate.test.ts`
checks that the file makes every supported setting take effect.

`npm run verify:compile -- [<folder>[=<project file>] ...]` is the compile oracle (needs the .NET
SDK; development only, the extension never runs .NET). For each project - by default the corpus
under `test/oracle`, C# written to be tricky for the rules - it builds a copy with the generated
`.editorconfig`, runs cleanup on it (one type per file included), builds again and fails on every
new compiler error. For new errors it runs cleanup once per rule (each diagnostic of the registry,
each boolean setting) and lists the rules that break the build. Add a case to `test/oracle` for
every construct a rule mishandled.

## AI behavior

Plain cleanup does not invoke AI. Explicit AI commands use GitHub Copilot or a configured
custom endpoint. Batch XML documentation plans requests locally and asks for confirmation
before sending them. AI refactoring provides a diff and an apply step; review generated code
and tests before use.

## Troubleshooting

Use **Code Janitor: Show Output Channel** for cleanup and AI diagnostics. Before sharing logs,
remove credentials and private source content.

If duplicate Code Janitor settings or commands appear after installing an older build, check
the installed extensions for duplicate versions. Uninstall the obsolete extension and fully
quit and restart VS Code before testing again.

## Releases

The release workflow is defined in [release.yml](.github/workflows/release.yml). Consult it for
the current tag triggers, packaging and artifact publication steps. GitHub release packages and
Marketplace publication are separate distribution paths; this guide does not imply a
Marketplace listing is available.

## License and attribution

See [LICENSE.txt](LICENSE.txt) and the [project origin](README.md#project-origin). Preserve
upstream notices and attribution when contributing.
