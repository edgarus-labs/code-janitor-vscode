# CodeJanitor for VS Code - Work Plan

Source repo being ported: `CodeMaid`/`CodeJanitor` Visual Studio extension
(`C:\Dev\codemaid`, solution `CodeJanitor.sln`). This document tracks the porting plan, what is
already implemented, and what is still pending.

## Goal

Port the parts of the CodeJanitor Visual Studio extension that make sense in VS Code:

- **1:1, byte-for-byte** for anything with zero Visual Studio / EnvDTE dependency (the pure
  Roslyn `ISourceTransformation` cleanup converters).
- **Re-implemented natively** for anything that is VS Code-specific by nature (commands,
  settings, save hooks, AI provider detection).
- **Explicitly out of scope**: Visual Studio 2026-only integration, EnvDTE/Solution Explorer/
  ProjectItem, third-party VS tool integrations (ReSharper/JustCode/XAML Styler), and the
  Digging/Spade tool window (code structure tree, McCabe complexity, navigation) - per explicit
  user decision, **only code cleanup matters** for this port.

Name and description are kept identical to the source extension, per explicit user instruction.

## Architecture

**Hard requirement (user decision):** the shipped extension must be pure TypeScript/JavaScript.
No .NET, no C#, no WebAssembly, no native binaries and no third-party runtime dependencies - it
has to run unchanged on Windows, Linux and macOS, on both x86-64 and arm64. The first iteration
shelled out to a .NET 8 engine and the second used a WebAssembly grammar; both have been replaced
by a native TypeScript implementation.

```
codejanitor-vscode/
  src/
    cleanup/
      types.ts                  Transformation contract + cleanup settings
      pipeline.ts               Ordered transformation runner
      csharpScanner.ts          C# lexer: code vs. comment vs. literal spans
      editorconfig.ts           Native .editorconfig reader
      parser.ts                 Parser facade + tree walking and text-edit helpers
      syntax/lexer.ts           C# tokenizer (tokens + comment/preprocessor trivia)
      syntax/node.ts            Syntax node and tree model
      syntax/parser.ts          Recursive-descent C# parser
      transformations/          The ported converters
    ai/                         AI provider clients (Copilot LM API + custom OpenAI/Claude endpoint)
    commands/                   VS Code commands (cleanup, AI, format-on-save)
    extension.ts                Activation entry point
  test/                         vitest suites, ported from the C# test suite
```

### Why a hand-written parser

Roslyn has no JavaScript equivalent and no maintained pure-JS C# parser exists
(`@fluffy-spoon/csharp-parser` was abandoned in 2020). The port therefore carries its own C#
lexer and recursive-descent parser: it is plain TypeScript, so there is nothing to download at
install time, nothing to initialize at activation and nothing platform-specific to ship.

The parser only needs to be as precise as the converters require, so it is deliberately tolerant:
anything it cannot classify is preserved verbatim rather than treated as an error, which is the
right behaviour for files that are being edited. Transformations that only touch layout
(whitespace, blank lines, tabs, BOM, regions) do not use the parser at all; they use the lexical
scanner, which distinguishes layout whitespace from whitespace that belongs to a literal or a
comment (the role `SyntaxKind.WhitespaceTrivia` played in Roslyn).

Transformations are expressed as text edits over the original source rather than as tree
rewrites, because there is no code printer - editing spans preserves the surrounding formatting
exactly.

## Phases

### Phase 0 - Scaffold — DONE

- `package.json` (name/description/license copied from the source extension), `tsconfig.json`,
  `esbuild.js`, `.gitignore`, `.vscodeignore`, `README.md`, `LICENSE.txt` (LGPL-3.0, same as
  source).

### Phase 1 - Cleanup engine (.NET) — DONE

- Copied verbatim (not retyped) all 34 pure `ISourceTransformation` converters + interfaces +
  `SourceTransformationPipeline` from `CodeJanitorShared/Logic/Transformations` into
  `engine/CodeJanitor.Engine/Logic/Transformations/`. Also copied `EditorConfigHelper` +
  `EditorConfigCSharpOptions` verbatim.
- Added compatibility shims required for the copied files to compile standalone (NOT present in
  the source repo): `Properties/Settings.cs` (a `Settings.Default` singleton shim with the same
  field names/defaults as the real `Settings.settings`), `UI/Enumerations/HeaderPosition.cs` /
  `HeaderUpdateMode.cs`, `Logic/Transformations/DelegateSourceTransformation.cs`,
  `Logic/Cleaning/FileHeaderAndBlankLineTransforms.cs` (ported the file-header and 6 blank-line
  regex methods that lived as private statics on `CodeCleanupManager.cs` in the source repo).
- `Program.cs`: CLI entry point. Reads one JSON request from stdin (`{ settings, files }`),
  applies settings overrides via reflection, rebuilds the exact same conditional transformation
  pipeline and order as `CodeCleanupManager.ApplyHeadlessCSharpTransformations` in the source
  repo, returns `{ results: [{ path, output, changed, error }] }` on stdout.
- Added a **new**, VS-Code-only setting `Cleaning_OrganizeUsings` (not in the source repo) so
  using-directive sorting can be forced independent of `.editorconfig`.
- Verified: `dotnet build` 0 errors/warnings; manual smoke test via a hand-built JSON request
  produced correct combined output (trailing whitespace removed, blank-line padding, explicit
  access modifiers, `var`-when-apparent all applied in one pass).
- Packaging: `npm run build:engine` = `dotnet publish ... -o engine-dist`; the extension resolves
  `engine-dist/CodeJanitor.Engine.dll` in production, falling back to the local `bin/Debug` /
  `bin/Release` build for local dev (F5).
- **Engine test project** (`engine/CodeJanitor.Engine.Tests`): copied 27 test files 1:1 from the
  source repo's `CodeJanitor.UnitTests` (all `Transformations/*Tests.cs` + the `Cleaning/*Tests.cs`
  files that test converters we ported). **272/272 tests pass**, unchanged, confirming the port is
  behaviorally correct.

### Phase 2 - VS Code core commands & settings — DONE

- Commands: `codeJanitor.cleanupActiveFile`, `cleanupSelectedFiles` (explorer context menu,
  folder-aware), `cleanupWorkspace`, `generateXmlDoc`, `testAiConnection`, `setAiApiKey`.
- Settings: `codeJanitor.cleanup.*` (mirrors the engine's `Cleaning_*` flags; two settings -
  `insertExplicitAccessModifiers` and `insertBlankLinePadding` - are deliberately simplified to a
  single VS Code toggle each, fanning out to 9 / ~29 underlying per-kind engine flags),
  `codeJanitor.engine.dotnetPath`, `codeJanitor.ai.*`.
- `src/engine/client.ts` spawns `dotnet <engine.dll>` once per cleanup action (batches all target
  files into a single process invocation, not one process per file).
- `src/commands/cleanupCore.ts`: reads live editor buffers for open documents (cleans unsaved
  edits too), reads disk for closed files; applies results via `WorkspaceEdit` or
  `vscode.workspace.fs.writeFile`.
- `src/commands/formatOnSave.ts`: optional cleanup-on-save via `onWillSaveTextDocument` +
  `waitUntil`, gated by `codeJanitor.cleanup.onSave` (default `false`), never blocks save on
  engine failure.

### Phase 3 - AI-assisted XML documentation — DONE

- **Deliberate design deviation** from the source repo: `GitHubCopilotDetector.cs` scrapes
  Windows Credential Manager and VS-specific log files (Windows-only, VS-only). The VS Code port
  uses the idiomatic, cross-platform equivalent instead: `vscode.lm.selectChatModels({ vendor:
  'copilot' })` (Language Model API), requiring the GitHub Copilot Chat extension installed and
  signed in.
- `src/ai/customClient.ts`: ported `OpenAiCompatibleClient.cs` to TypeScript/`fetch` - endpoint
  normalization, local-endpoint detection (for the `num_ctx` hint), retry on transient status
  codes, response extraction supporting OpenAI, legacy `text`, **and Anthropic Messages API**
  shapes (added Anthropic support beyond the source repo, per explicit user request for
  Claude-compatible endpoints).
- `src/ai/aiService.ts`: single entry point dispatching on `codeJanitor.ai.provider`
  (`"copilot"` default | `"custom"`). API key stored in VS Code `SecretStorage`, never in
  `settings.json`.
- **Roslyn-based member detection** (replaced the first iteration's line/brace heuristic):
  `engine/CodeJanitor.Engine/Logic/Ai/XmlDocumentationGenerator.cs` ports the pure-Roslyn half of
  `AiXmlDocumentationLogic.cs` - `CanDocumentMember`/`CanDocumentMethod` filters, the
  MaxMethodsPerFile budget that only applies to AI candidates (methods/types) while deterministic
  members (properties, fields, indexers, events) always pass, `BuildMethodPrompt`/`BuildTypePrompt`,
  the system prompt, `DetectThrownExceptions`, `BuildXmlCommentBlock` +
  `BuildParameterDescription`/`BuildReturnDescription`/`BuildPropertySummary`/`BuildFallbackSummary`,
  and `SanitizeAiCompletion`/`NormalizeSentence`. Everything EnvDTE-, output-window- or
  HTTP-client-related was left behind.
- Engine CLI protocol extended with a `command` field (`"cleanup"` default): `"xmlDocPlan"`
  returns the ordered documentation targets (index, kind, member name, line, `requiresAi`, prompt,
  deterministic fallback summary) plus the shared system prompt; `"xmlDocApply"` takes summaries
  keyed by target index and returns the fully rendered source. New
  `Cleaning_AiXmlDocumentation*` fields on the `Settings` shim drive the filters.
- `src/commands/generateXmlDoc.ts`: documents the whole active file (as the source extension
  does). Plan -> one cancellable AI request per AI target (progress shows `kind memberName i/N`)
  -> apply. Deterministic members never cost a request; failed/empty AI responses fall back to the
  engine's deterministic summary when `codeJanitor.ai.xmlDoc.allowDeterministicFallback` is on;
  the edit is abandoned if the document changed while the AI calls were in flight (target indices
  refer to the planned parse).
- New settings: `codeJanitor.ai.xmlDoc.maxMembersPerFile`, `.maxInputCharsPerMember`,
  `.allowDeterministicFallback`, `.ignoreGeneratedCode`, `.ignoreObsolete`, `.ignoreTestMethods`,
  `.ignorePattern`.
- Tests: `engine/CodeJanitor.Engine.Tests/Ai/XmlDocumentationGeneratorTests.cs` ports the
  Roslyn-facing tests from the source repo's `AiXmlDocumentationLogicTests` (the reflection
  plumbing is dropped - the engine exposes the API directly) and adds coverage for the new
  plan/apply round trip. **289/289 engine tests pass.**

### Phase 4 - Developer tooling & CI — DONE

- `.vscode/launch.json` + `.vscode/tasks.json`: F5 Extension Development Host debugging,
  `npm: watch` background build task, `build:engine` / `test:engine` tasks.
- `esbuild.js`: added a watch-log plugin so the `$esbuild-watch` problem matcher works.
- `.github/workflows/ci.yml`: two jobs on push/PR to `develop`/`main` - `engine` (`dotnet
  restore/build/test`) and `extension` (`npm ci`, typecheck, bundle).

### Phase 5 - Native TypeScript rewrite of the cleanup engine — DONE

The .NET engine has been deleted. Every converter now lives in `src/cleanup/`, and each one is
covered by vitest tests ported from the corresponding C# test class: **317 tests passing**.

- Infrastructure: `SourceTransformation` contract, pipeline, cleanup settings + defaults,
  `.editorconfig` reader, C# lexical scanner, syntax tree model and text-edit helpers.
- Layout transformations (no parser): BOM removal, final newline, blank-line normalization,
  region removal, `#endregion` naming, trailing whitespace, tabs to spaces, comment formatting,
  file header (insert/replace, document start/after usings), and the five blank-line regex
  transforms.
- Syntax transformations (parser-based): var-when-apparent, null-check pattern matching,
  return/throw blank-line padding, namespace fixer, `nameof(...)` conversion, `out var` inlining,
  sealed classes, single-statement lambdas, CA1869 `JsonSerializerOptions`, `string.Format` to
  interpolation, collection expressions, using sorting, moving usings out of namespaces,
  file-scoped namespaces, readonly fields, single-line method spreading, explicit access
  modifiers, blank-line padding, accessor formatting.
- XML documentation: member planning, prompt building, deterministic summaries and comment
  rendering, all in `src/cleanup/xmlDocumentation.ts`.
- `src/cleanup/runCleanup.ts` rebuilds the exact converter order and conditional gating of the
  source extension's headless cleanup path; `src/commands/settings.ts` maps the VS Code settings
  onto it.
- The commands, cleanup-on-save and the XML doc command call the pipeline in-process - no child
  process, no IPC. The parser is initialized once on activation.
- `esbuild.js` bundles the extension into a single `dist/extension.js` with no side-car assets; CI
  runs the suite on Ubuntu, Windows and macOS.

Three deliberate deviations from the original, all for cross-platform correctness:

1. Line endings always come from the file being cleaned; the original hard-coded CRLF in the
   `#endregion`, file-header and method/accessor spreading paths.
2. `readonly` / `sealed` / access modifiers are inserted directly in front of the token they
   qualify instead of reproducing Roslyn's trivia juggling for declarations without modifiers.
3. Interpolated strings are treated as opaque by the lexical scanner, so layout rules never
   rewrite anything inside a literal.

### Phase 6 - Closing the feature gaps — DONE

- Wired the previously dead `fixNamespace` converter to a `CodeJanitor: Fix Namespace` command that
  suggests the namespace from the workspace folder structure.
- Added the missing cleanup entry points: `Cleanup Open Files`, `Cleanup Changed Files (Git)` (via
  the built-in Git extension API) and `Toggle Cleanup on Save`.
- Added the standalone editor actions of the original: remove regions, format comments, remove XML
  documentation, join lines, sort lines.
- Added the remaining AI actions with the prompts ported verbatim: explain, code review,
  clean/refactor (with an apply step) and unit test generation (`codeJanitor.ai.tests.*` settings).
- Added the XML documentation diff preview (`codeJanitor.ai.xmlDoc.previewChanges`).
- Added opt-in layout-only cleanup for files that are not C#
  (`codeJanitor.cleanup.includeOtherFileTypes`), covering BOM, tabs, trailing whitespace, blank
  lines and the final newline.
- Added an editor context submenu grouping the documentation, code and AI actions, plus a
  `CHANGELOG.md`.

**340 tests passing.**

### Phase 7 - Removing the last external runtime dependency — DONE

`web-tree-sitter` and the `tree-sitter-c_sharp.wasm` grammar were the only third-party pieces left
at runtime. They have been replaced by a hand-written C# front end in `src/cleanup/syntax/`:

- `lexer.ts` - tokenizer covering identifiers and contextual keywords, predefined types, all string
  forms (regular, verbatim, interpolated, raw), char and numeric literals, operators, comments and
  preprocessor directives. `>` is never merged with a following `>` so nested generics can close.
- `node.ts` - the node and tree model: fields, named/anonymous children, byte offsets, lazily
  computed row/column positions, sibling navigation and `descendantsOfType`.
- `parser.ts` - recursive-descent parser for declarations, statements, types and expressions, with
  the lookahead needed to tell generics from comparisons, casts from parenthesized expressions,
  lambdas from tuples and local declarations from expression statements. Comments and preprocessor
  directives are re-attached afterwards to the deepest node that spans them, so a documentation
  comment stays a sibling of the member it documents.

The parser is tolerant by design: unrecognized input is preserved verbatim instead of failing, and
every token appears in the tree exactly once, which is what makes node offsets usable as edit
ranges. No transformation needed changing beyond its import line. `initCSharpParser` and
`isParserReady` are gone - parsing is synchronous, so activation no longer awaits anything and
`dist/` is a single `extension.js` with no side-car assets.

### Phase 8 - Command-layer tests — DONE

`test/helpers/vscodeMock.ts` is an in-memory implementation of the `vscode` API surface the
commands use, aliased in `vitest.config.ts`. It runs the real command handlers in the existing
vitest process, so no VS Code instance is downloaded and no test dependency is added.

Covered: settings fan-out, file collection (open buffer versus disk), `WorkspaceEdit` application,
folder expansion, the Git extension integration, cleanup on save, the editor actions, namespace
suggestion, the AI actions and the XML documentation command including its preview, fallback and
"document changed while requests were in flight" guards. Two activation tests assert that the
commands declared in `package.json` and the handlers registered at activation are exactly the same
set.

**409 tests passing.**

### Phase 9 - Settings control and presentation — DONE

- `codeJanitor.cleanup.removeRegions` (default `true`, the same default as the source extension's
  `Cleaning_RemoveRegions`): region removal was hard-wired into the pipeline and is now a setting
  like every other rule.
- `contributes.configuration` is an array of titled, ordered sections, so the native Settings editor
  renders CodeJanitor as a category tree rather than one flat list of 55 entries.
- `CodeJanitor: Open Settings` opens a webview panel with every setting on one grouped page, a
  User/Workspace scope switch, per-setting "modified" markers and a reset button. The form is
  generated from `context.extension.packageJSON`, so a new setting appears without touching the
  panel. Values reach the webview through `postMessage` and are written with `textContent`/`value`,
  never interpolated into the HTML, and the page runs under a nonce-based CSP.
- Two manifest-consistency tests guard the wiring: every setting the code reads must be declared,
  and every declared setting must appear exactly once across the sections.

**431 tests passing.**

### Phase 10 - Correctness fix: pattern matching inside expression trees — DONE

`codeJanitor.cleanup.convertToPatternMatchingNullChecks` (on by default) used to rewrite every
`== null`/`!= null` unconditionally, including inside a lambda that gets compiled to
`Expression<TDelegate>` - e.g. `dbSet.Where(x => x.Foo != null)` against an EF Core `IQueryable<T>`.
C# forbids pattern matching inside an expression tree (CS8122), so that rewrite broke the build.
The source extension's own converter has the same gap (it is a plain Roslyn syntax rewrite with no
expression-tree check), so this is a deliberate improvement over the source, not a port of it.

Without a type checker we cannot prove a LINQ receiver is `IQueryable<T>` rather than
`IEnumerable<T>`, so the fix is conservative by design: a null check is left alone whenever it sits
inside a lambda that is (a) assigned to, or cast to, an `Expression<...>`-typed target, or (b) passed
as an argument to one of the standard LINQ query operators (`Where`, `Select`, `OrderBy`, `Any`,
`FirstOrDefault`, ...), regardless of receiver type. The cost of a missed simplification on a plain
`List<T>.Where(...)` is negligible; the cost of a broken build is not.

### Phase 11 - Real end-to-end tests — DONE

The vitest suite runs the command layer against `test/helpers/vscodeMock.ts`, a hand-written stand-in
for the `vscode` module - it cannot catch bugs in real activation, real command registration, or the
real Settings schema. `test/e2e/extension.test.ts` closes that gap: it runs inside an actual,
isolated VS Code instance that `@vscode/test-cli` / `@vscode/test-electron` download and manage (its
own user-data-dir and extensions-dir, loading *only* this extension via
`--extensionDevelopmentPath`), driven purely through the real `vscode` API - no pixel-based UI
clicking, no AutoHotKey: those are Windows-only, external to the repo, and not reproducible in CI on
Linux/macOS.

It already earned its keep on the first run: it caught a real bug where `CodeJanitor: Cleanup Active
File` silently did nothing on a brand-new, unsaved C# file, because the file-type check only looked
at the `.cs` extension (an untitled document has none) and ignored the document's actual language
mode. Fixed in `isCSharp` (`src/commands/cleanupCore.ts`) by also accepting an open document whose
`languageId` is `csharp`.

- `tsconfig.e2e.json` compiles `test/e2e/**/*.ts` to CommonJS under `out/e2e/`; `.vscode-test.mjs`
  points `@vscode/test-cli` at the compiled output and at the `test/e2e/fixtures/workspace` folder.
  `npm run test:e2e` builds the extension, compiles the tests, then runs them.
- Covers: exactly one Code Janitor-like extension present, every declared command registered exactly
  once, the Settings schema exposing the declared defaults, cleanup of an open document and of a file
  on disk that was never opened, XML documentation generation falling back deterministically with no
  Copilot installed, XML documentation removal, the settings webview panel opening, and the AI
  connection test resolving instead of throwing when no provider is available.
- CI runs it on Ubuntu (under `xvfb-run`, since Electron needs a display), Windows and macOS.

**448 unit tests + 9 end-to-end tests passing.**

### Phase 12 - Troubleshooting tools and a real duplicate-install diagnosis — DONE

The user reported both "Code Janitor" and "CodeJanitor" showing in Settings, and
"Generate XML Documentation (AI)" not working while cleanup and "Remove XML Documentation" did.
Root cause, found by inspecting the real extensions folder
(`%USERPROFILE%\.vscode\extensions`): uninstalling the pre-rename `codejanitor.codejanitor-0.1.0`
extension earlier in this session marked it obsolete (`.obsolete` in that folder) but could not
delete its files, because the still-running VS Code window had it loaded - a normal Windows
file-locking situation. A `Reload Window` does not re-run the "prune obsolete extensions" step (a
full quit-and-relaunch does), so the old folder, and its old `displayName: "CodeJanitor"`, kept
loading side by side with the new one - two extensions both contributing `codeJanitor.*` commands
and settings, racing for the same command IDs. That fully explains both symptoms without any new
code defect. Deleted the stale folder directly; **a full quit-and-relaunch of VS Code (not just
Reload Window) is required once** to clear whatever the currently-running window still has loaded
from it.

To actually verify there was no separate, real pipeline bug, `scripts/smoke-test.js` was added and
run read-only against a real, unrelated 776-file C# codebase
(`C:\Dev\dfaa-auth-mgmt-app`, never written to, never committed to): 0 cleanup exceptions, 0 XML
documentation planning exceptions, 775/776 files would change under cleanup, 1425 AI documentation
targets planned. The parser and pipeline hold up on real-world code; the reported failure was the
duplicate-extension issue above.

- **`Code Janitor` output channel** (`src/logging.ts`) plus the
  **`Code Janitor: Show Output Channel`** command: cleanup start/finish counts, per-file cleanup
  exceptions with full stack, XML documentation planning counts, every AI request failure (even the
  ones that silently fall back to a deterministic summary), and AI connection test / model selection
  results are now logged there instead of only surfacing as a one-line toast.
- **`scripts/smoke-test.js`** (`npm run smoke-test -- <path>`): read-only, runs the cleanup pipeline
  and the XML documentation planner over every `.cs` file in an arbitrary repository. No `vscode`
  host needed, since `src/cleanup/**` has no dependency on it. Kept as a permanent tool for smoke
  testing against real-world codebases beyond the hand-written unit test fixtures.

**450 unit tests + 9 end-to-end tests passing.**

### Phase 13 - Full pass over Settings, Command Palette and the context menu — DONE

Requested explicitly: an automated check of (1) Settings, (2) every Command Palette entry, and
(3) the editor context menu's readability. Fixed one real issue found while reviewing (3): the
editor submenu had `Generate XML Documentation (AI)` and `Remove XML Documentation` in two
different groups, separated by a divider from four unrelated commands, instead of next to each
other as the natural pair they are. They are now adjacent in their own `1_doc` group - not folded
into the AI actions group, since removal never calls AI.

Coverage added:

- `test/commands.test.ts` gained fast, manifest-only tests (no VS Code host needed): Generate/Remove
  XML Documentation are adjacent and share a group, no AI command leaks into a non-AI group and vice
  versa, and the submenu is wired into `editor/context` with a non-empty label.
- `test/e2e/extension.test.ts` grew from 9 to 34 real-host tests: every declared setting is read
  through `vscode.workspace.getConfiguration('codeJanitor')` and checked against its declared JSON
  `type`/`enum`; a real `update`/clear round-trip; the settings webview panel reveals instead of
  duplicating on a second `Open Settings`; and **every single command declared in the manifest is
  executed through the real Command Palette path** (`vscode.commands.executeCommand`), with
  `showInputBox`/`showQuickPick`/`showInformationMessage` temporarily replaced by safe
  auto-answering stand-ins so a prompt never hangs the run waiting for a human that isn't there.

**453 unit tests + 34 end-to-end tests passing.**

### Phase 14 - Marketplace icon and a user-facing README — DONE

- `assets/icon.png` (128x128, resized from a user-provided source image) wired up via the
  top-level `icon` field in `package.json`. The `contributes.icons` SVG/`.woff` pair
  (`code-janitor` id, used for a future themable icon reference, not yet consumed by any command)
  is unrelated and untouched.
- `README.md` rewritten for the audience that actually reads it - the Marketplace/Extensions-view
  details page - instead of the internal module/file layout: what the extension does, the problem
  it solves, and how to use it. The architecture notes that used to live there are already covered
  by this document's Phases above, so nothing of substance was lost.

### Phase 15 - Explorer context menu submenu and batch XML documentation removal — DONE

User feedback while testing: the single `Cleanup Selected Files` entry in the Explorer context menu
gave no visual indication of which extension it belonged to (unlike the editor context menu, which
already groups its secondary actions under a labeled `Code Janitor` submenu). Fixed the same way:
added a `codeJanitor.explorerSubmenu`, contributed next to `Cleanup Selected Files` for a file,
folder or multi-selection.

Also requested: XML documentation removal batch commands to match `Cleanup Selected Files` /
`Cleanup Workspace`. Added `Remove XML Documentation (Selected Files)` (in the new Explorer
submenu; a folder is always expanded to its `.cs` files, regardless of
`codeJanitor.cleanup.includeOtherFileTypes` - XML documentation is a C#-only concept) and
`Remove XML Documentation (Workspace)`. Both are deterministic, no AI involved, so there is no cost
or confirmation concern in running them over an entire project. `cleanupCore.ts`'s per-file
read/transform/apply loop was generalized into a shared `runBatch` helper so `runCleanupOnUris` and
the new `runRemoveXmlDocOnUris` share the open-buffer-vs-disk-write logic instead of duplicating it.

Two further items from that same feedback - a workspace-wide **AI** XML documentation batch
("Add XMLDoc ALL") and a batch/combined **"Cleanup & Refactor"** action - needed a decision on
scope and safety before being built; the user was unreachable to clarify, so the following
decisions were made autonomously, favoring the more conservative option in each case, and are
recorded here for review:

- **Batch AI XML documentation** (`Generate XML Documentation (AI, Selected Files)` /
  `(AI, Workspace)`): implemented. Files are planned first - a deterministic, AI-free pass - so the
  exact number of files and AI requests is known before anything is sent. If that number is greater
  than zero, a modal confirmation states it and requires an explicit "Continue" before a single
  request is fired; declining leaves every file untouched. A single cancellable progress reports
  per-file position; per-target detail goes to the "Code Janitor" output channel instead of a
  second nested progress bar. `generateXmlDocForDocument` was refactored to work from a
  `vscode.TextDocument` and a `WorkspaceEdit`/disk write (via the newly-exported `collectFiles` /
  `writeFileContent` from `cleanupCore.ts`) instead of requiring a visible `TextEditor`, so the
  batch runner never has to open a tab per file; the single-file command's behavior is unchanged
  (same tests, unmodified, still pass).
- **"Cleanup & Refactor"**: implemented as `Clean and Refactor (Cleanup + AI)` - the deterministic
  cleanup pipeline on the active file, then the existing `Clean and Refactor (AI)` action on it,
  which still shows its own diff preview and requires "Apply" before touching anything. No
  workspace-wide variant was built: an AI refactor changes logic-adjacent code, not just adds
  comments, so applying model output across a whole project with no per-change review is a
  qualitatively different (and higher) risk than the documentation case above. If this is wanted
  later it needs its own review mechanism (e.g. one combined diff per file with per-file
  accept/reject, not a single all-or-nothing confirmation), not a copy of the XML-doc batch pattern.

Follow-up (same feedback round): the Explorer submenu only had the two XML-doc batch commands, and
feedback pointed out cleanup and fix namespace looked missing from it (`Cleanup Selected Files` is
actually a flat item right above the submenu, mirroring `Cleanup Active File` in the editor context
menu - easy to miss). Rather than move it, brought the submenu up to the same breadth as the
editor's: added `Fix Namespace (Selected Files)`, `Remove Regions (Selected Files)` and
`Format Comments (Selected Files)`, all deterministic batch variants of the existing single-file
editor commands. Fix Namespace can't prompt per file in a batch run, so it always uses the
auto-computed namespace from each file's folder path (the same value the single-file command
pre-fills into its input box) with no confirmation step, since it's a pure rename with no AI or
data loss involved.

Second follow-up: still missing from that submenu was `Cleanup Selected Files` itself - it was a
flat item right above the submenu rather than inside it, which is exactly the "unlabeled item"
complaint the submenu was built to fix in the first place. Moved it into
`codeJanitor.explorerSubmenu` as its own top group (`0_cleanup`), so every Explorer batch action
now lives in one labeled place; nothing is registered twice. The user separately asked for a
"reorganize" action alongside it, referencing member-ordering, which `PLAN.md` already lists as
explicitly out of scope for this port (see the Backlog); not built, since it would be new,
substantial functionality rather than a menu placement fix.

### Bug: Format Comments mangled `///` XML documentation comments — FIXED

Reported from real usage: running Format Comments on a file with `/// <summary>...` turned it into
`// / <summary>`. `SINGLE_LINE_COMMENT` in `transformations/text.ts` matched any line starting with
`//`, so for a `///` line the regex consumed only the first two slashes as the comment marker and
captured the third slash as if it were the start of the comment text, which then got a space
inserted in front of it. Fixed by capturing the whole leading run of slashes (`\/\/+`) instead of
exactly two, so `//`, `///` and `////` (the commented-out-code convention) are all recognized as
their own marker and only the spacing after it is normalized - none of them gain or lose slashes.

**478 unit tests + 42 end-to-end tests passing.**

## Backlog / next steps

1. **Batch AI refactor across a workspace/selection** - deliberately not built; see Phase 15 for
   the reasoning (needs a per-file review mechanism, not a single all-or-nothing confirmation).
2. **Razor / Blazor formatting** - the source extension has a safe Razor formatter and control-block
   formatting for `@if`, `@for`, `@foreach`, `@switch`, `@try` and friends. Not ported; it would be
   a separate module, independent of the C# parser.
3. **Cleanup scope rules** - `codeJanitor.cleanup.exclude` / `.include` port the source extension's
   `Cleaning_ExclusionExpression` / `Cleaning_InclusionExpression` semantics (case-insensitive
   regular expressions over the full path, exclusions winning) as VS Code string arrays instead of
   `||`-separated strings. The one-time cleanup options dialog for a selected scope is not ported.
4. **Settings coverage** - the source extension exposes roughly 191 settings; this port maps the
   subset the cleanup pipeline uses, with two deliberate fan-out toggles.
5. **AI coverage targeting** (`AiTargetCoverageCommand`) is not ported: it drives Visual Studio's
   coverage results and solution-wide test runs, which have no direct VS Code equivalent.
6. **Running XML documentation as part of a cleanup pass** is still not ported (distinct from the
   explicit batch commands added in Phase 15): a cleanup run itself never triggers unattended AI
   calls.
7. Anything Digging/Spade/reorganizing-related remains explicitly out of scope, as are code
   navigation, McCabe complexity and the Solution Explorer helpers of the source extension.

## Verified build/test commands

```powershell
npm ci
npm run compile                  # tsc --noEmit
npm test                         # vitest, 478/478 passing
npm run build                    # -> dist/extension.js (single file, no assets)
npm run verify:bundle            # bundles and runs the pipeline exactly like the extension does
npm run test:e2e                 # real VS Code host, 42/42 passing (downloads VS Code once)
```

## Git

- Remote: `https://github.com/edgarus-labs/code-janitor-vscode.git`
- Main branch: `develop` (protected - PRs expected; direct pushes are currently bypassed by the
  repo owner, don't rely on this long-term)
- Local git identity for this repo: `Edgarus79` / `p.gawdzik@gmail.com`
