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

```
codejanitor-vscode/
  engine/
    CodeJanitor.Engine/         .NET 8 console app - the cleanup engine
    CodeJanitor.Engine.Tests/   MSTest project, ported 1:1 from the source repo's test suite
  src/
    ai/                         AI provider clients (Copilot LM API + custom OpenAI/Claude endpoint)
    commands/                   VS Code commands (cleanup, AI, format-on-save)
    engine/                     Talks to the .NET engine as a child process (JSON over stdio)
    extension.ts                Activation entry point
  engine-dist/                  Published engine output (generated, ships inside the .vsix)
  .github/workflows/ci.yml      CI: engine tests + extension typecheck/bundle
  .vscode/                      F5 debug config + build/test tasks
```

The VS Code extension never re-implements Roslyn logic in TypeScript. It spawns the `.NET`
engine as a subprocess, sends a single JSON request (settings + files) over stdin, and applies
the JSON response (per-file changed output) via `WorkspaceEdit` or direct file writes.

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

## Backlog / next steps

1. **TS-side automated tests** - none yet. Would use `@vscode/test-electron` or
   `@vscode/test-cli` to run real extension-host integration tests (requires downloading a VS
   Code test instance). Bigger effort, not started.
2. **Marketplace packaging polish** - `CHANGELOG.md`, `CONTRIBUTING.md`, an icon, and a real
   `npx vsce package` dry run. Deferred until requested.
3. **Settings UI** - currently plain `settings.json` entries only (no custom webview), which is
   intentional (native VS Code settings, unlike the source extension's custom WPF Options pages).
4. **XML doc preview / run-during-cleanup** - the source extension can preview the diff before
   applying (`Cleaning_AiXmlDocumentationPreviewChanges`) and run documentation as part of a
   cleanup pass (`Cleaning_AiXmlDocumentationRunDuringCleanup`). Neither is ported; the VS Code
   command is explicit and single-file.
5. Anything Digging/Spade/reorganizing-related remains explicitly out of scope.

## Verified build/test commands

```powershell
# Engine
cd engine\CodeJanitor.Engine.Tests
dotnet test                      # 289/289 passing

# Engine packaging
dotnet publish engine\CodeJanitor.Engine -c Release -o engine-dist --self-contained false

# Extension
npm ci
npm run compile                  # tsc --noEmit
node esbuild.js --production     # -> dist/extension.js
```

## Git

- Remote: `https://github.com/edgarus-labs/code-janitor-vscode.git`
- Main branch: `develop` (protected - PRs expected; direct pushes are currently bypassed by the
  repo owner, don't rely on this long-term)
- Local git identity for this repo: `Edgarus79` / `p.gawdzik@gmail.com`
