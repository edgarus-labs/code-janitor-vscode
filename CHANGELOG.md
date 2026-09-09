# Changelog

All notable changes to this extension are documented here.

## [0.1.0] - Unreleased

First release of the Visual Studio Code port.

### Added

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
- **`.editorconfig` support** for indentation, trailing whitespace, final newline and using order.
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

### Fixed

- Pattern-matching null checks (`convertToPatternMatchingNullChecks`) no longer rewrite `== null` /
  `!= null` inside a lambda that may be compiled to an expression tree (e.g. an EF Core
  `IQueryable<T>.Where(x => x.Foo != null)`), which used to produce code that fails to compile
  (CS8122: an expression tree may not contain an `is` pattern-matching operator).
- `CodeJanitor: Cleanup Active File` now cleans a brand-new, unsaved C# file: file-type detection
  used to look only at the `.cs` extension, which an untitled document does not have yet, and
  silently skipped it even though its language mode was C#.
- **Format Comments** no longer mangles `///` XML documentation comments into `// /`. The comment
  spacing normalizer matched any line starting with `//`, so a doc comment's third slash was read
  as the start of the comment text and got a space inserted in front of it; it now captures the
  whole run of slashes (`//`, `///`, `////`, ...) and only normalizes the spacing after it.
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
