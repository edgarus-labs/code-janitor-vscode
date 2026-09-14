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
- `src/ai/`: GitHub Copilot and custom endpoint clients.
- `src/commands/`: commands, settings integration and cleanup-on-save.
- `src/extension.ts`: extension activation.
- `test/`: unit and command tests; `test/e2e/` runs inside a real VS Code host.
- `shared/tests/transformations/`: shared behavior fixtures for the VS and VS Code implementations.

The parser supports the transformations implemented here; it is not a replacement for Roslyn's
compiler or semantic model. Text edits preserve surrounding source formatting. When changing a
transformation, test comments, literals, preprocessor directives and line endings as well as the
intended syntax. Document intentional differences from the Visual Studio implementation.

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
- `test` runs the Vitest suite.
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

An optional read-only smoke test can exercise cleanup and XML documentation planning on a
source directory you are authorized to inspect:

```sh
npm run smoke-test -- <source-directory>
```

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
