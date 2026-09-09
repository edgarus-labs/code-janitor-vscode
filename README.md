# Code Janitor

**Stop reviewing whitespace. Start reviewing logic.**

Code Janitor cleans up and simplifies your C# code with a single command: trailing whitespace,
blank-line clutter, unsorted `using` directives, missing access modifiers, leftover `#region`
blocks, and outdated syntax that could be `var`, a pattern match, or a collection expression
instead. It also generates XML documentation comments for you, using GitHub Copilot or your own
AI endpoint.

## The problem it solves

Every C# codebase accumulates the same small mess over time: inconsistent whitespace, usings in
the wrong order, methods missing an explicit access modifier, null checks written the old way,
undocumented public members. None of it is hard to fix, but doing it by hand is tedious and it
rarely happens consistently across a team. Code Janitor fixes all of it in one pass, works fully
offline (no .NET, no network, no external services required for cleanup), and never touches
anything you haven't asked it to.

## Installation

Grab the latest `.vsix` from the [GitHub Releases page](https://github.com/edgarus-labs/code-janitor-vscode/releases),
then either:

- double-click the downloaded file with VS Code installed, or
- run `code --install-extension code-janitor-<version>.vsix`, or
- in VS Code, open the Extensions view, click the `...` menu, and choose **Install from VSIX...**.

## How to use it

- Right-click a C# file (or select several, or a whole folder) and choose **Code Janitor:
  Cleanup Selected Files** - or open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run
  any **Code Janitor** command.
- **Code Janitor: Cleanup Active File** cleans the file you're currently editing.
- **Code Janitor: Cleanup Workspace** cleans every C# file in the project; **Cleanup Open Files**
  and **Cleanup Changed Files (Git)** clean a smaller, more targeted set.
- Turn on **Code Janitor: Toggle Cleanup on Save** to clean every file automatically as you save it.
- Right-click a file, folder or multi-selection in the Explorer for a **Code Janitor** submenu with
  batch actions, coverage report analysis, and coverage-gap test generation.
- Right-click inside a C# file for a submenu with the rest of the commands: generating or removing
  XML documentation, fixing a namespace, removing regions, formatting comments, splitting a file's
  top-level types into their own files, and the AI-powered actions (explain, review, refactor,
  generate tests, analyze coverage reports, generate tests from coverage gaps).
- **Code Janitor: Split Top-Level Types** splits a C# file that declares more than one class,
  interface, record, enum or delegate into one file per type, keeping the type matching the
  current file name (or the first one) in place. It's an explicit, manual command - like the
  other file-creating actions, it never runs as part of cleanup-on-save or workspace cleanup.

Everything is configurable: open **Code Janitor: Open Settings** for a single page with every
option, or use the regular VS Code Settings editor - Code Janitor's settings are grouped there the
same way the original Visual Studio extension organized them.

For a team-wide cleanup policy, add a `.codejanitor` JSON file to the repository root. Its
`cleanup` properties use the same names as the Code Janitor settings, for example:

```json
{
  "cleanup": {
    "removeRegions": false,
    "organizeUsings": true,
    "convertToFileScopedNamespace": true,
    "insertBlankLinePadding": true
  }
}
```

The repository file is loaded automatically. Explicit VS Code settings take precedence over it,
so each developer can still adjust the policy locally. Invalid JSON, unknown properties and values
with the wrong type are ignored.

You can create or synchronize this file without editing JSON by opening **Code Janitor: Open
Settings** and using **Export .codejanitor** or **Import .codejanitor**. Export writes the current
cleanup configuration to the repository root; import copies the repository values into VS Code's
workspace settings so they can be reviewed or adjusted in the settings panel.

## AI features (optional)

Generating XML documentation, explaining code, reviewing it, refactoring it, generating unit
tests, analyzing coverage reports, and generating tests from coverage gaps all use AI, through GitHub Copilot (if you have the Copilot Chat extension) or a custom
OpenAI/Claude-compatible endpoint you configure yourself. Every plain cleanup command works with no
AI, no account and no network access at all.

Generating XML documentation can also run across a selection or the whole workspace at once
(**Generate XML Documentation (AI, Selected Files / Workspace)**). Files are scanned first, for
free, so if any AI request would actually be sent you get a single confirmation stating exactly how
many, across how many files, before anything happens. **Clean and Refactor (Cleanup + AI)** cleans
the active file and then offers the AI refactor for it - the refactor step still shows its usual
diff preview and asks before applying anything.

**Analyze Coverage Report (AI)** looks for common .NET coverage outputs (`coverage.cobertura.xml`,
`coverage.opencover.xml`, `lcov.info`, `*.coveragexml`, `*.coverage.xml`) and opens a focused
markdown report with the highest-risk gaps and the tests to add first.

**Generate Tests From Coverage Gaps (AI)** uses the same coverage reports, lets you pick a source
file referenced by the report, and opens a generated C# test class focused on the uncovered code.

## License

LGPL-3.0, same as the source Visual Studio extension - see [LICENSE.txt](LICENSE.txt).

