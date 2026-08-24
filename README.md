# CodeJanitor

CodeJanitor is an open source Visual Studio extension to cleanup and simplify our C#, C++, F#, VB, PHP, PowerShell, R, JSON, XAML, XML, ASP, HTML, CSS, LESS, SCSS, JavaScript and TypeScript coding.

This repository is the Visual Studio Code port of the [CodeJanitor](https://github.com/) Visual Studio extension. It ports the parts of the cleanup engine that have no Visual Studio / EnvDTE dependency 1:1 (same Roslyn-based converters, copied verbatim into a companion .NET engine), re-implements the VS Code-specific integration (commands, settings, format-on-save) natively, and adds AI-assisted XML documentation with both GitHub Copilot (via the VS Code Language Model API) and custom OpenAI/Claude-compatible endpoints.

## Architecture

- `engine/CodeJanitor.Engine` - a small .NET 8 console app containing the ported, pure
  `ISourceTransformation` Roslyn converters (no EnvDTE, no Visual Studio dependency; the same
  files as the VS extension's `CodeJanitorShared/Logic/Transformations`) plus the ported Roslyn
  XML documentation planner/renderer. It communicates with the extension over a single JSON
  request/response on stdin/stdout.
- `src/` - the VS Code extension (TypeScript). Talks to the engine as a child process, exposes
  commands (`CodeJanitor: Cleanup Active File`, `...Selected Files`, `...Workspace`), contributes
  settings mirroring the original `Cleaning_*` options, and drives AI-assisted XML doc
  generation: the engine plans which members need documentation and builds each prompt, the
  extension runs the AI request, and the engine renders and inserts the comment blocks.

## Status

Work in progress, implemented in phases:

1. **Phase 0** - project scaffold (this).
2. **Phase 1** - cleanup engine (.NET, ported converters + pipeline + CLI). Done for the core
   C# cleanup transform set.
3. **Phase 2** - VS Code commands, settings, format-on-save integration.
4. **Phase 3** - AI-assisted XML documentation (Copilot detection via the Language Model API,
   plus a configurable custom OpenAI/Claude-compatible endpoint), with Roslyn-based member
   selection and comment rendering ported from the source extension.

## License

LGPL-3.0, same as the source Visual Studio extension - see [LICENSE.txt](LICENSE.txt).
