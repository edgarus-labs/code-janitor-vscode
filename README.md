# CodeJanitor

CodeJanitor is an open source Visual Studio extension to cleanup and simplify our C#, C++, F#, VB, PHP, PowerShell, R, JSON, XAML, XML, ASP, HTML, CSS, LESS, SCSS, JavaScript and TypeScript coding.

This repository is the Visual Studio Code port of the [CodeJanitor](https://github.com/) Visual Studio extension. Every cleanup rule of the original Roslyn engine was reimplemented natively in TypeScript, so the extension is pure JavaScript at runtime: no .NET, no C#, no native binaries, and the same artifact runs unchanged on Windows, Linux and macOS, on x86-64 and arm64. It also adds AI-assisted XML documentation with both GitHub Copilot (via the VS Code Language Model API) and custom OpenAI/Claude-compatible endpoints.

## Architecture

- `src/cleanup/` - the cleanup engine. `pipeline.ts` runs an ordered list of transformations, each
  of which takes C# source and returns C# source. Layout rules (BOM, blank lines, trailing
  whitespace, tabs, regions, file headers) work on text with the help of `csharpScanner.ts`, a C#
  lexer that tells layout whitespace apart from whitespace inside a literal or a comment. Rules
  that need syntax use `parser.ts`, which loads [tree-sitter](https://tree-sitter.github.io) and
  the C# grammar as WebAssembly and expresses every change as a text edit over the original
  source, so surrounding formatting is preserved exactly.
- `src/commands/` - the VS Code integration: commands (`CodeJanitor: Cleanup Active File`,
  `...Selected Files`, `...Workspace`), settings mapping, cleanup-on-save, and the AI XML
  documentation command.
- `src/ai/` - AI provider clients: GitHub Copilot through the Language Model API, or a custom
  OpenAI/Claude-compatible HTTP endpoint.
- `test/` - vitest suites covering every transformation, ported from the original test suite.

## Commands

**Cleanup** - active file, selected files (explorer), open files, files changed in Git, whole
workspace, and a toggle for cleanup on save.

**Editor actions** - fix namespace, remove regions, format comments, remove XML documentation,
join lines, sort lines.

**AI** - generate XML documentation, explain code, review code, clean and refactor, generate unit
tests. All of them run through GitHub Copilot or a custom OpenAI/Claude-compatible endpoint.

## Status

The cleanup engine, the VS Code integration and the AI features are implemented. See
[PLAN.md](PLAN.md) for the detailed porting history and the remaining backlog.

## License

LGPL-3.0, same as the source Visual Studio extension - see [LICENSE.txt](LICENSE.txt).
