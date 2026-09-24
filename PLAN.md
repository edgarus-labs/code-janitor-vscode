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
- `src/ai/`: GitHub Copilot and custom endpoint clients.
- `src/commands/`: commands, settings integration and cleanup-on-save.
- `src/extension.ts`: extension activation.
- `test/`: unit and command tests; `test/e2e/` runs inside a real VS Code host.
- `shared/tests/transformations/`: shared behavior fixtures for the VS and VS Code implementations.

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
commands as `EditorConfigIssue`s: `unresolved` violations (counted in the cleanup summary) and
`unsupported` settings (logged only).

- `oneTypePerFile.ts`: `SA1402`/`MA0048`/`SA1649` (explicit `dotnet_diagnostic` severity only).
  Not a pipeline step: it creates files, so `commands/cleanupCore.ts` (`splitTypesForEditorConfig`)
  runs it before the pipeline in batch cleanup and cleanup on save, using `topLevelTypeSplit.ts`
  with `movableKinds` and `refuseFileNameCollisions`, and cleans the created files like the rest.
- `transformations/editorConfigNaming.ts`: IDE1006. `naming/namingRules.ts` parses and orders
  the rules (Roslyn `EditorConfigNamingStyleParser`), `naming/namingStyle.ts` checks names and
  derives the fixed name (Roslyn `NamingStyle`), `naming/sourceModel.ts` collects declarations,
  scopes and every identifier occurrence with its role, and `naming/renamer.ts` plans a rename
  that is refused unless every occurrence in the symbol's scope is understood. Violations are
  fixed in passes over the re-parsed text until none can be fixed; the rest are reported.
- `transformations/editorConfigCodeStyle.ts`: code-style rules in a fixed order, reusing the
  existing converters (file-scoped namespaces, explicit access modifiers, readonly fields, `out`
  variable inlining, using placement). Rule modules: `editorConfigQualification.ts` (`this.`),
  `editorConfigVarPreference.ts` (`var`), `editorConfigBraces.ts` (braces),
  `editorConfigExpressionPreferences.ts` (target-typed `new`, `default`, index/range, `is null`,
  `nameof`, UTF-8 literals, implicit lambdas), `editorConfigStatementPreferences.ts` (`throw`
  expressions, tuple swap, local functions, deconstruction) and `editorConfigTypePreferences.ts`
  (`System.Threading.Lock`, primary constructors). `projectInfo.ts` reads the target frameworks of
  the nearest `.csproj` for rules that depend on them.
- `transformations/editorConfigFormatting.ts`: core EditorConfig properties and using order, and the
  C# formatting options gated on IDE0055.
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
