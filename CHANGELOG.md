# Changelog

All notable changes to this extension are documented here.

## [0.1.0] - Unreleased

First release of the Visual Studio Code port.

### Added

- **C# cleanup engine**, reimplemented natively in TypeScript. All 27 converters of the original
  Roslyn engine: BOM removal, trailing whitespace, tabs to spaces, blank-line normalization and
  padding, region handling, `#endregion` naming, file headers, comment formatting, explicit access
  modifiers, `var` when apparent, readonly fields, sealed classes, file-scoped namespaces, using
  organization, `nameof`, `out var`, pattern-matching null checks, string interpolation, collection
  expressions, CA1869 `JsonSerializerOptions`, single-statement lambdas, single-line method and
  accessor formatting.
- **Commands**: cleanup of the active file, selected files, open files, files changed in Git and
  the whole workspace; toggle cleanup on save; fix namespace; remove regions; format comments;
  remove XML documentation; join lines; sort lines.
- **AI features**: XML documentation generation, explain, code review, clean/refactor and unit test
  generation - through GitHub Copilot (Language Model API) or a custom OpenAI/Claude-compatible
  endpoint.
- **Cleanup on save**, off by default.
- **`.editorconfig` support** for indentation, trailing whitespace, final newline and using order.
- Optional layout-only cleanup for files that are not C#.

### Notes

- The extension is pure TypeScript/JavaScript. C# parsing uses tree-sitter compiled to
  WebAssembly, so the same artifact runs on Windows, Linux and macOS, on x86-64 and arm64, with no
  .NET runtime and no native binaries.
