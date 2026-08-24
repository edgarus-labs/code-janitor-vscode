# CodeJanitor for Visual Studio Code

[![Build](https://github.com/edgarus-labs/code-janitor-vscode/actions/workflows/ci.yml/badge.svg?branch=develop&label=build)](https://github.com/edgarus-labs/code-janitor-vscode/actions/workflows/ci.yml)
[![Tests](https://github.com/edgarus-labs/code-janitor-vscode/actions/workflows/ci.yml/badge.svg?branch=develop&label=tests)](https://github.com/edgarus-labs/code-janitor-vscode/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/edgarus-labs/code-janitor-vscode/branch/develop/graph/badge.svg)](https://codecov.io/gh/edgarus-labs/code-janitor-vscode)
[![License: LGPL-3.0](https://img.shields.io/badge/license-LGPL--3.0-blue.svg)](LICENSE.txt)

CodeJanitor is a cross-platform Visual Studio Code extension for cleaning, modernizing and documenting C# code. Its cleanup engine is implemented natively in TypeScript and uses WebAssembly-based C# parsing, so the packaged extension requires no .NET runtime or native binaries.

This project is a Visual Studio Code port of the original CodeJanitor Visual Studio extension. Layout-only cleanup can also be enabled for other text-based file types.

## Highlights

- 27 C# cleanup and modernization transformations.
- Cleanup for the active file, selected files, open files, Git-changed files or an entire workspace.
- Optional cleanup on save.
- Standalone editor actions for namespaces, regions, comments, XML documentation and line sorting.
- AI-assisted XML documentation, explanations, reviews, refactoring and unit-test generation.
- GitHub Copilot support through the VS Code Language Model API.
- Custom OpenAI- and Anthropic-compatible endpoints, including local services such as LM Studio and Ollama.
- Native TypeScript runtime with WebAssembly parsing on Windows, Linux and macOS.
- 340 Vitest tests and CI validation on all three supported operating systems.

## Getting started

The extension is not yet published to the Visual Studio Marketplace. To run it from source:

1. Install Node.js 20 or newer and Visual Studio Code 1.90 or newer.
2. Clone the repository and install dependencies:

```bash
git clone https://github.com/edgarus-labs/code-janitor-vscode.git
cd code-janitor-vscode
npm ci
```

3. Open the folder in Visual Studio Code and press `F5` to start an Extension Development Host.
4. Open a C# file and run a `CodeJanitor:` command from the Command Palette.

For a production bundle, run:

```bash
npm run build
```

## Commands

### Cleanup

- `CodeJanitor: Cleanup Active File`
- `CodeJanitor: Cleanup Selected Files`
- `CodeJanitor: Cleanup Open Files`
- `CodeJanitor: Cleanup Changed Files (Git)`
- `CodeJanitor: Cleanup Workspace`
- `CodeJanitor: Toggle Cleanup on Save`

### Editor actions

- Fix namespace
- Remove regions
- Format comments
- Remove XML documentation
- Join lines
- Sort lines

### AI actions

- Generate XML documentation
- Explain code
- Review code
- Clean and refactor
- Generate unit tests
- Test the configured AI connection

AI features use GitHub Copilot by default. A custom endpoint and model can be selected under `codeJanitor.ai.*`. API keys are stored in VS Code SecretStorage rather than `settings.json`.

## Configuration

All settings are available under `CodeJanitor` in the standard Visual Studio Code Settings UI. Potentially opinionated transformations such as file-scoped namespaces, collection expressions, readonly fields and sealed classes are individually configurable. Cleanup on save and cleanup of non-C# files are disabled by default.

Review changes before accepting them, especially when enabling multiple modernization rules on an existing codebase. AI refactoring uses a preview/apply flow; other AI commands do not silently modify files.

## Architecture

- `src/cleanup/` — cleanup pipeline, C# scanner, WebAssembly parser, transformations and XML documentation planning.
- `src/commands/` — Visual Studio Code commands, settings mapping, Git integration and cleanup-on-save.
- `src/ai/` — GitHub Copilot and custom endpoint clients.
- `test/` — Vitest suites covering the cleanup engine and transformations.
- `esbuild.js` — production bundle and WebAssembly asset packaging.

The parser is initialized once when the extension activates. Transformations are applied as text edits over the original source so surrounding formatting can be preserved.

See [PLAN.md](PLAN.md) for the porting history, design decisions and remaining backlog.

## Development

```bash
npm ci
npm run compile
npm test
npm run test:coverage
npm run build
npm run verify:bundle
```

Pull requests target the `develop` branch. CI runs type checking, tests, bundling and bundle verification on Ubuntu, Windows and macOS. Coverage is collected on Ubuntu and uploaded to Codecov.

## License

Licensed under LGPL-3.0-only. See [LICENSE.txt](LICENSE.txt).

