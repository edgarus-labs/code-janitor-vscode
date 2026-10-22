# Code Janitor for VS Code — Development Guide

For installation and user-facing features, see [README.md](README.md). Release changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## Scope and origin

This extension ports cleanup functionality from
[Code Janitor for Visual Studio](https://github.com/edgarus-labs/code-janitor-vs), derived from
[CodeMaid](https://github.com/codecadwallader/codemaid). C# is cleaned by Roslyn in a .NET server
next to VS Code; the extension itself is TypeScript and handles the files that are not C#, Razor
and the VS Code integration.

## Architecture

### The C# engine server (`server/`, .NET 10, Roslyn 5.9)

- `CodeJanitor.Server.slnx`, `Directory.Build.props` (net10.0, the target of Roslyn 5.9's MSBuild workspace; `RollForward=LatestMajor`, so
  the server runs on the newest installed runtime, which is never older than the SDK whose MSBuild it loads; warnings as errors) and
  `server/.editorconfig` (`root = true`, so a repository-level `.editorconfig` does not change how the server builds).
- `src/CodeJanitor.Engine/Contracts/EngineContracts.cs`: the contract of the engine:
  `IEffectiveSettings` (the settings of one file, keyed by the camelCase fields of `CleanupSettings` in
  `src/cleanup/types.ts`), `ICleanupStep` (stage and order), `IDocumentCommand`, `IDocumentQuery`,
  `ICleanupEngine` and the result records. Steps, commands and queries are discovered by reflection:
  every non-abstract implementation with a public parameterless constructor runs.
- `CleanupEngine.cs`: the orchestrator (stages Reorganize, Semantic, Text, Diagnostics, Final; change
  counts per rule; excluded rules; changed lines; `onSave`/`partial` gating; generated files skipped;
  a failing step is reported and undone).
- `Settings/`: per-file precedence `.editorconfig` > `.codejanitor` > user settings
  (`EffectiveSettings`, `RepositoryPolicy`, `EditorConfigOptions`, `OverrideNotes`).
- `Diagnostics/`: the Roslyn diagnostic cleanup ported from the Visual Studio extension
  (`DiagnosticCleanupEngine`, `CodeFixProviderCatalog`, compiler-error check over every project and
  target framework, `RoslynRulesStep`, `OrganizeUsingsStep`, `NamingRenameScope`, `HostAnalyzers`: the
  IDE analyzers and fixes of `Microsoft.CodeAnalysis(.CSharp).Features`).
- `CodeStyle/`: the Code Style rules catalog (keys shared with `src/cleanup/codeStyleRules.ts`).
- `Steps/`: Code Janitor's own steps, ported from `Logic/Transformations` of the Visual Studio
  extension; `Comments/`: the comment formatter (`Model/Comments`).
- `Reorganize/`: Reorganize on the Roslyn syntax tree and semantic model.
- `Commands/`: `reorganize`, `splitTopLevelTypes`, `fixNamespace`, `removeXmlDocumentation`,
  `removeRegions`, `formatComments`, `moveMember`, `deleteMember`; `Queries/`: `memberAtPosition`,
  `xmlDocTargets`, `structure` (Spade), `branches` (target coverage), `memberLines`, `reorganizeReport`.
- `src/CodeJanitor.Server/`: JSON-RPC over stdio (StreamJsonRpc, `Content-Length` framing, camelCase;
  `Protocol.cs`, `RpcServer.cs`), `WorkspaceHost` (one `MSBuildWorkspace` per workspace folder: the
  solution listing the file's project, else that project and the projects of the folder referencing it;
  a fallback project for loose files; unsaved text overlaid per request; `fileChanged` reloads),
  `ResultMapper` (solution diff to texts, line endings and BOM), `CheckCommand` (`check` CLI) and
  `AnalyzerDependencyUnification` (the SDK's analyzers reference newer `System.Composition` and Roslyn
  assemblies than the server ships; they are answered with the server's copies).
- `tests/CodeJanitor.Engine.Tests/`: xunit, one folder per area; `Testbed/TestbedScenarios.cs` runs the
  testbed scenarios through `CleanupEngine`. The Visual Studio extension's MSTest tests are ported here.

### The extension (`src/`)

- `src/engine/`: the client of the server (`client.ts`: lazy start, restart with backoff, cancellation;
  `serverProcess.ts`: finding `dotnet` 8+ via `codeJanitor.dotnetPath` or the `PATH`; `protocol.ts`: the
  DTOs; `vscodeEngine.ts`: activation, file watcher, request parameters; `changedLines.ts`: the git diff
  for `onlyChangedLines`; `xmlDoc.ts`: prompts and insertion from `xmlDocTargets`).
- `src/commands/`: commands, settings, cleanup on save, preview, diagnostics and quick fixes
  (`analyze`/`fixRule`), Razor and navigation. `cleanupCore.ts` routes C# files to the server and the
  other files to `src/cleanup/layoutCleanup.ts`.
- `src/cleanup/`: `types.ts` (the settings shape sent to the server), `layoutCleanup.ts` and
  `languages/` (the cleanup of files that are not C#: language detection, per-family steps, file
  headers, markup rules), `editorconfig.ts` (layout keys for those files), `repositoryOverrides.ts`
  (`.codejanitor` for the settings panel and export/import), `codeStyleRules.ts` (the Code Style
  catalog behind `package.json` and the settings panel).
- `src/razor/`: the Razor/Blazor formatter; `src/razor/csharp/` is the only C# parser left in
  TypeScript, used to lay out the C# of Razor blocks.
- `src/spade/`: the Spade view over the `structure` query; `src/ai/`: AI clients, actions, target
  coverage (`coverage/`) and XML documentation during cleanup; `src/text/`: Insert Region and Sort Lines.
- `test/`: Vitest with a VS Code API mock (`test/helpers/vscodeMock.ts`) and a fake engine
  (`helpers/fakeEngine.ts`, `fakeEngineServer.ts`); `test/e2e/` runs inside a real VS Code host.
- `shared/tests/transformations/`: behaviour fixtures shared with the Visual Studio extension.

Protocol, contract and engine changes go together: a new protocol method needs `Protocol.cs`,
`RpcServer.cs`, `src/engine/protocol.ts` and `client.ts`. `npm run build` publishes the server to
`dist/server` (`npm run build:server`), and the tests that start it publish it when the sources are
newer (`scripts/engineServer.ts`; `CODE_JANITOR_SERVER_DLL` points them at another build).

## Local development

Clone this repository and create a topic branch from `develop`. You need Node.js 22 or later and npm compatible
with the repository's dependencies and CI workflow, and the .NET 10 SDK or later for the server.

```sh
npm ci
npm run compile
npm test
dotnet test server/CodeJanitor.Server.slnx
npm run build
npm run verify:bundle
npm run test:e2e
```

- `compile` checks TypeScript without emitting files.
- `lint` runs ESLint (`eslint.config.mjs`); `format` writes and `format:check` verifies Prettier (`.prettierrc.json`) for the
  TypeScript and JavaScript files and `dotnet format whitespace` (`server/.editorconfig`) for the server's C#.
  `npm ci` installs a Git pre-commit hook (Husky, `.husky/pre-commit`) that runs `.lintstagedrc.mjs` on the staged files:
  Prettier and ESLint for TypeScript and JavaScript, `dotnet format whitespace` for C# under `server/`.
- `test` runs the Vitest suite. `CODE_JANITOR_TEST_CATEGORY` narrows it: `unit` skips the tests that need
  the .NET SDK, a category of `test/compilerTests.json` (`preview`, `razor`, `engine`, `testbed`) runs only
  its files. CI runs `unit` in Build and Test and each category in its own job, with
  `CODE_JANITOR_REQUIRE_DOTNET=1` so a missing SDK fails instead of skipping. A new test file that uses
  `dotnetAvailable` or starts the server must be added to a category; `test/compilerTestCategories.test.ts`
  fails otherwise.
- `dotnet test server/CodeJanitor.Server.slnx` runs the server's xunit tests; the testbed tests among
  them need `.testbed` (or `CODE_JANITOR_TESTBED`) and fail with the command that downloads it when it is missing.
- `build` publishes the server to `dist/server` and bundles the extension to `dist/extension.js`.
- `verify:bundle` runs the bundled client against the published server.
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
cleanup option, named after the option, plus `scenarios.json` saying what each cleanup must do. It covers what the engine does
and is checked for completeness:

- every Code Style rule, every cleanup setting that changes text and every Reorganize option needs a scenario; a missing one fails
  the test, and the exemptions are listed in `test/testbed.test.ts` with the reason (`onlyChangedLines` and the workspace rename
  need git history or a whole workspace);
- each rule also runs through a real `.editorconfig`, with its value turned off, with its severity turned off, and, for the rules that
  rewrite both ways, with the opposite value;
- traps: code a rewrite must not touch (a field written in an interpolation, a lambda that captures, `string.Format` with side effects,
  expression trees, string literals, `#if` blocks), run with every option on at once;
- using placement and namespace style, the `.codejanitor` policy and its precedence, several `.editorconfig` files, layout cleanup of
  other file types, Razor, the line commands (sort lines, insert and remove region) and the file commands (XML documentation, namespace,
  split types, one type per file, move and delete a member).

`npm run test:testbed` (`test/testbed.test.ts`) runs every scenario alone, requires cleaning the result again to change nothing
(except wrapping lines in a region, which is an action), and builds and runs the whole solution before and after the cleanups, each
alone and then every option at once: a rewrite that does not compile or changes what a scenario prints fails the test. A scenario the
engine gets wrong carries a `knownDefect` marker: its checks must fail, and the test tells you when it starts to pass.

To check one cleanup, name it in `CODE_JANITOR_TESTBED_SCENARIOS`: scenario ids or option names, separated by commas or spaces
(`CODE_JANITOR_TESTBED_SCENARIOS=CsharpPreferBraces npm run test:testbed`, or `removeRegions,csharp_prefer_braces` for every scenario
of those options). Only those scenarios are cleaned and checked, and only their cleanups are applied before the solution is built and
run; the coverage checks still read the whole `scenarios.json`. A name no scenario has fails the run.

CI first runs the Lint and format job (`npm run lint`, `npm run format:check`); every other job needs it, so unclean code fails the
build before anything else runs. Those jobs clone the testbed's `develop` branch (the testbed is not versioned separately from
this repository) into `.testbed` and the testbed job sets `CODE_JANITOR_REQUIRE_TESTBED=1`, so a missing testbed fails the
build; locally set `CODE_JANITOR_TESTBED` or keep a sibling `code-janitor-testbed` folder, otherwise the Vitest suite is skipped with a message that says how to download the testbed (`git clone https://github.com/edgarus-labs/code-janitor-testbed .testbed`). Add a
scenario there whenever an option is added or a rewrite that broke the build is fixed. Not covered, because they are not text
transformations of one file: AI actions, the preview, diagnostics and quick fixes, `check` mode, `Join Lines` (its logic is in the
editor command) and the navigation commands.

`npm run generate:editorconfig -- [path]` writes an `.editorconfig` (default `./.editorconfig`)
with every C# code-style, formatting and naming option Microsoft documents at its documented
default, every documented style rule at `warning` and a fixed list of CA rules
(`ENFORCED_DIAGNOSTIC_IDS`). The option data and its documentation links are in
`scripts/editorConfigTemplate.ts`.

`npm run verify:compile -- [<folder>[=<project file>] ...]` is the compile oracle. For each project
(by default the corpus under `test/oracle`, C# written to be tricky for the rules) it builds a
copy with the generated `.editorconfig`, runs the cleanup through the server (one type per file
included), builds again and fails on every new compiler error. For new errors it runs cleanup once
per rule (each enforced diagnostic, each boolean setting) and lists the rules that break the build.
Add a case to `test/oracle` for every construct a rule mishandled.

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
