import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorConfigIssue, runCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';
import { clearUsingIndexCache } from '../src/cleanup/usings/workspaceIndex';
import { writeProject } from './helpers/dotnetBuild';

/**
 * The settings of the using directive placement and the namespace style, end to end through `runCleanup`
 * on real files: `moveUsingsOutsideNamespace` and `convertToFileScopedNamespace`, and what
 * `csharp_using_directive_placement` and `csharp_style_namespace_declarations` decide in their place.
 */

function csproj(languageVersion?: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
${languageVersion ? `    <LangVersion>${languageVersion}</LangVersion>\n` : ''}  </PropertyGroup>
</Project>
`;
}

/** Every step off but those in `overrides`. */
function settings(overrides: Partial<CleanupSettings>): CleanupSettings {
  const result = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'boolean') {
      result[key] = false;
    }
  }

  return { ...(result as unknown as CleanupSettings), ...overrides };
}

const LIBRARY: Record<string, string> = {
  'Services.cs': 'namespace Company.App.Services { public class Svc { } }\n',
  'Models.cs': 'namespace Company.App.Models { public class Foo { } }\n',
  'Shared.cs': 'namespace Company.Shared { public class Util { } }\n',
  'GlobalServices.cs': 'namespace Services { public class Other { } }\n',
};

let folder: string;

function project(files: Record<string, string> = {}, options: { editorconfig?: string; languageVersion?: string } = {}): void {
  folder = writeProject({ ...LIBRARY, ...files }, csproj(options.languageVersion));
  if (options.editorconfig !== undefined) {
    fs.writeFileSync(path.join(folder, '.editorconfig'), `root = true\n\n[*.cs]\n${options.editorconfig}\n`);
  }
}

/** Cleans `source`: `issues` are the `.editorconfig` violations left unfixed, `notes` what a Code Janitor setting left undone. */
function clean(
  source: string,
  overrides: Partial<CleanupSettings>,
  options: { editorconfig?: string; languageVersion?: string; file?: string } = {}
): { output: string; issues: string[]; notes: string[] } {
  const filePath = path.join(folder, options.file ?? 'Sample.cs');
  fs.writeFileSync(filePath, source);
  const issues: string[] = [];
  const notes: string[] = [];
  const output = runCleanup(source, filePath, settings(overrides), undefined, (issue: EditorConfigIssue) => {
    if (issue.kind === 'unresolved') {
      issues.push(issue.detail);
    } else if (issue.kind === 'note') {
      notes.push(issue.detail);
    }
  });

  return { output, issues, notes };
}

beforeEach(() => clearUsingIndexCache());
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

const NAMESPACE_WITH_RELATIVE_USING = 'namespace Company.App\n{\n    using Services;\n\n    internal class C\n    {\n        private Svc s;\n    }\n}\n';

describe('moveUsingsOutsideNamespace (no .editorconfig decision)', () => {
  it('moves the directives out and qualifies the namespace-relative one', () => {
    project();

    expect(clean(NAMESPACE_WITH_RELATIVE_USING, { moveUsingsOutsideNamespace: true })).toEqual({
      output: 'using Company.App.Services;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Svc s;\n    }\n}\n',
      issues: [],
      notes: [],
    });
  });

  it('leaves the directives where they are when the setting is off', () => {
    project();

    expect(clean(NAMESPACE_WITH_RELATIVE_USING, { moveUsingsOutsideNamespace: false })).toEqual({ output: NAMESPACE_WITH_RELATIVE_USING, issues: [], notes: [] });
  });

  it('reports why directives were left in place', () => {
    project({ 'Foo.cs': 'namespace Company { public class Foo { } }\n' });
    const source = 'namespace Company.App\n{\n    using Models;\n\n    internal class C\n    {\n        private Foo f;\n    }\n}\n';
    const { output, issues, notes } = clean(source, { moveUsingsOutsideNamespace: true });

    expect(output).toBe(source);
    expect(issues).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(/^Using directives were not moved outside the namespace because moving 'using Models;' would change what 'Foo' refers to.*They were left in place\.$/)]);
  });

  it('skips and reports a file that is not part of a C# project', () => {
    project();
    const outside = fs.mkdtempSync(path.join(path.dirname(folder), 'cj-outside-'));
    try {
      const source = 'namespace N\n{\n    using System;\n\n    internal class C\n    {\n        private Action a;\n    }\n}\n';
      const filePath = path.join(outside, 'Lonely.cs');
      const issues: string[] = [];
      const output = runCleanup(source, filePath, settings({ moveUsingsOutsideNamespace: true }), undefined, (issue) => {
        issues.push(issue.detail);
      });

      expect(output).toBe(source);
      expect(issues).toEqual([expect.stringMatching(/because the file is not part of a C# project/)]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stays silent for a file without directives to move', () => {
    project();
    const source = 'using System;\n\nnamespace N\n{\n    internal class C\n    {\n        private Action a;\n    }\n}\n';

    expect(clean(source, { moveUsingsOutsideNamespace: true })).toEqual({ output: source, issues: [], notes: [] });
  });
});

describe('what surrounds the directives', () => {
  it('keeps a byte order mark in front of the moved directives', () => {
    project();

    expect(clean(`\uFEFF${NAMESPACE_WITH_RELATIVE_USING}`, { moveUsingsOutsideNamespace: true }).output).toBe(
      '\uFEFFusing Company.App.Services;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Svc s;\n    }\n}\n'
    );
  });

  it('removes the regions around the usings first, so that they do not stand in the way', () => {
    project();
    const source = '#region Usings\nusing System;\n#endregion\n\nnamespace Company.App\n{\n    using Services;\n\n    internal class C\n    {\n        private Svc s;\n        private Action a;\n    }\n}\n';

    expect(clean(source, { moveUsingsOutsideNamespace: true, removeRegions: true })).toEqual({
      output: 'using System;\nusing Company.App.Services;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Svc s;\n        private Action a;\n    }\n}\n',
      issues: [],
      notes: [],
    });
    expect(clean(source, { moveUsingsOutsideNamespace: true, removeRegions: false })).toMatchObject({ issues: [], notes: [expect.stringMatching(/interleaved with preprocessor directives/)] });
  });

  it('keeps the line endings of a CRLF file', () => {
    project();

    expect(clean(NAMESPACE_WITH_RELATIVE_USING.replace(/\n/g, '\r\n'), { moveUsingsOutsideNamespace: true }).output).toBe(
      'using Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    internal class C\r\n    {\r\n        private Svc s;\r\n    }\r\n}\r\n'
    );
  });

  it('indents directives written into the namespace with the tab style of the file', () => {
    project({}, { editorconfig: 'csharp_using_directive_placement = inside_namespace:warning\nindent_style = tab' });
    const source = 'using System;\n\nnamespace Company.App\n{\n}\n';

    expect(clean(source, { moveUsingsOutsideNamespace: true }).output).toBe('namespace Company.App\n{\n\tusing System;\n}\n');
  });
});

describe('csharp_using_directive_placement', () => {
  it('moves directives inside the namespace for inside_namespace, whatever the setting says', () => {
    project({}, { editorconfig: 'csharp_using_directive_placement = inside_namespace:warning' });
    const source = 'using System;\nusing Company.App.Services;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Svc s;\n        private Action a;\n    }\n}\n';

    expect(clean(source, { moveUsingsOutsideNamespace: true })).toEqual({
      output:
        'namespace Company.App\n{\n    using System;\n    using Company.App.Services;\n\n    internal class C\n    {\n        private Svc s;\n        private Action a;\n    }\n}\n',
      issues: [],
      notes: [],
    });
  });

  it('moves directives outside for outside_namespace even when the setting is off', () => {
    project({}, { editorconfig: 'csharp_using_directive_placement = outside_namespace:warning' });

    expect(clean(NAMESPACE_WITH_RELATIVE_USING, { moveUsingsOutsideNamespace: false }).output).toBe(
      'using Company.App.Services;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Svc s;\n    }\n}\n'
    );
  });

  it('ignores a value that is not enforced and lets the setting decide', () => {
    project({}, { editorconfig: 'csharp_using_directive_placement = inside_namespace:silent' });

    expect(clean(NAMESPACE_WITH_RELATIVE_USING, { moveUsingsOutsideNamespace: true }).output).toBe(
      'using Company.App.Services;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Svc s;\n    }\n}\n'
    );
    expect(clean(NAMESPACE_WITH_RELATIVE_USING, { moveUsingsOutsideNamespace: false }).output).toBe(NAMESPACE_WITH_RELATIVE_USING);
  });

  it('treats a severity given through dotnet_diagnostic as enforcing', () => {
    project({}, { editorconfig: 'csharp_using_directive_placement = inside_namespace:silent\ndotnet_diagnostic.IDE0065.severity = warning' });
    const source = 'using System;\n\nnamespace Company.App\n{\n    internal class C\n    {\n        private Action a;\n    }\n}\n';

    expect(clean(source, { moveUsingsOutsideNamespace: false }).output).toBe(
      'namespace Company.App\n{\n    using System;\n\n    internal class C\n    {\n        private Action a;\n    }\n}\n'
    );
  });

  it('names the diagnostic and the line when it leaves directives in place', () => {
    project({ 'Foo.cs': 'namespace Company { public class Foo { } }\n' }, { editorconfig: 'csharp_using_directive_placement = outside_namespace:warning' });
    const source = 'namespace Company.App\n{\n    using Models;\n\n    internal class C\n    {\n        private Foo f;\n    }\n}\n';
    const { output, issues, notes } = clean(source, { moveUsingsOutsideNamespace: false });

    expect(output).toBe(source);
    expect(notes).toEqual([]);
    expect(issues).toEqual([expect.stringMatching(/^IDE0065 \(csharp_using_directive_placement\) line 3: using directives were not moved outside the namespace because .*'Foo'/)]);
  });

  it('leaves files without a single namespace alone when moving inwards', () => {
    project({}, { editorconfig: 'csharp_using_directive_placement = inside_namespace:warning' });
    const source = 'using System;\n\ninternal class C\n{\n    private Action a;\n}\n';

    expect(clean(source, { moveUsingsOutsideNamespace: true })).toEqual({ output: source, issues: [], notes: [] });
  });
});

describe('convertToFileScopedNamespace', () => {
  const block = 'namespace Company.App\n{\n    internal class C\n    {\n    }\n}\n';
  const fileScoped = 'namespace Company.App;\n\ninternal class C\n{\n}\n';

  it('converts when the project uses C# 10 or newer', () => {
    project();

    expect(clean(block, { convertToFileScopedNamespace: true })).toEqual({ output: fileScoped, issues: [], notes: [] });
  });

  it.each(['10', 'latest', '12.0'])('converts with LangVersion %s', (languageVersion) => {
    project({}, { languageVersion });

    expect(clean(block, { convertToFileScopedNamespace: true }).output).toBe(fileScoped);
  });

  it('stays block-scoped and reports for an older language version', () => {
    project({}, { languageVersion: '9.0' });
    const { output, issues, notes } = clean(block, { convertToFileScopedNamespace: true });

    expect(output).toBe(block);
    expect(issues).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(/C# 9 and file-scoped namespaces need C# 10/)]);
  });

  it('stays block-scoped and reports when the language version is unknown', () => {
    folder = writeProject(LIBRARY, csproj('$(SomeUnknownProperty)'));
    const { output, issues, notes } = clean(block, { convertToFileScopedNamespace: true });

    expect(output).toBe(block);
    expect(issues).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(/language version of its project is unknown/)]);
  });

  it.each([
    ['net48', /C# 7\.3 and file-scoped namespaces need C# 10/],
    ['net48;net10.0', /C# 7\.3 and file-scoped namespaces need C# 10/],
  ])('keeps the namespace block-scoped when a target framework (%s) has an older default language version', (frameworks, reason) => {
    folder = writeProject(LIBRARY, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>${frameworks}</TargetFrameworks></PropertyGroup></Project>`);
    const { output, issues, notes } = clean(block, { convertToFileScopedNamespace: true });

    expect(output).toBe(block);
    expect(issues).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(reason)]);
  });

  it('converts when every target framework has a default of C# 10 or newer', () => {
    folder = writeProject(LIBRARY, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net6.0;net10.0</TargetFrameworks></PropertyGroup></Project>');

    expect(clean(block, { convertToFileScopedNamespace: true }).output).toBe(fileScoped);
  });

  it('keeps the using directives inside the namespace', () => {
    project();
    const source = 'namespace Company.App\n{\n    using Services;\n\n    internal class C\n    {\n        private Svc s;\n    }\n}\n';

    expect(clean(source, { convertToFileScopedNamespace: true }).output).toBe('namespace Company.App;\n\nusing Services;\n\ninternal class C\n{\n    private Svc s;\n}\n');
  });

  it('moves the directives out first when both settings are on', () => {
    project();

    expect(clean(NAMESPACE_WITH_RELATIVE_USING, { moveUsingsOutsideNamespace: true, convertToFileScopedNamespace: true }).output).toBe(
      'using Company.App.Services;\n\nnamespace Company.App;\n\ninternal class C\n{\n    private Svc s;\n}\n'
    );
  });

  it('does not convert files with several namespaces, nested namespaces or types around the namespace', () => {
    project();
    for (const source of [
      'namespace A\n{\n    internal class C\n    {\n    }\n}\n\nnamespace B\n{\n    internal class D\n    {\n    }\n}\n',
      'namespace A\n{\n    namespace B\n    {\n        internal class C\n        {\n        }\n    }\n}\n',
      'internal class Top\n{\n}\n\nnamespace A\n{\n    internal class C\n    {\n    }\n}\n',
    ]) {
      expect(clean(source, { convertToFileScopedNamespace: true })).toEqual({ output: source, issues: [], notes: [] });
    }
  });

  it('reports a conditional block that straddles the braces', () => {
    project();
    const source = '#if NET6_0_OR_GREATER\nnamespace A\n{\n    internal class C\n    {\n    }\n}\n#else\nnamespace A\n{\n    internal class D\n    {\n    }\n}\n#endif\n';

    expect(clean(source, { convertToFileScopedNamespace: true })).toEqual({ output: source, issues: [], notes: [] });
  });

  it('reports an #if that opens inside the namespace and closes after it', () => {
    project();
    const source = 'namespace A\n{\n    internal class C\n    {\n    }\n#if X\n}\n#endif\n';
    const { output, issues, notes } = clean(source, { convertToFileScopedNamespace: true });

    expect(output).toBe(source);
    expect(issues).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(/namespace not converted/)]);
  });
});

describe('csharp_style_namespace_declarations', () => {
  const block = 'namespace Company.App\n{\n    internal class C\n    {\n    }\n}\n';
  const fileScoped = 'namespace Company.App;\n\ninternal class C\n{\n}\n';

  it('converts a file-scoped namespace back for block_scoped, although the setting asks for file-scoped', () => {
    project({}, { editorconfig: 'csharp_style_namespace_declarations = block_scoped:warning\nindent_size = 4' });

    expect(clean(fileScoped, { convertToFileScopedNamespace: true }).output).toBe(block);
  });

  it('does not convert to file-scoped when the project is older than C# 10', () => {
    project({}, { editorconfig: 'csharp_style_namespace_declarations = file_scoped:warning', languageVersion: '9' });
    const { output, issues, notes } = clean(block, {});

    expect(output).toBe(block);
    expect(notes).toEqual([]);
    expect(issues).toEqual([expect.stringMatching(/csharp_style_namespace_declarations: not applied, its project uses C# 9/)]);
  });

  it('keeps a block-scoped namespace for block_scoped although the setting asks for file-scoped', () => {
    project({}, { editorconfig: 'csharp_style_namespace_declarations = block_scoped:warning' });

    expect(clean(block, { convertToFileScopedNamespace: true }).output).toBe(block);
  });
});
