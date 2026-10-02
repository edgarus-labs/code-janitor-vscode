import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPaths } from '../src/cli/check';

const EDITORCONFIG = ['root = true', '', '[*.cs]', 'csharp_prefer_braces = true:warning', 'dotnet_naming_rule.public_fields.symbols = public_fields', 'dotnet_naming_rule.public_fields.style = pascal', 'dotnet_naming_rule.public_fields.severity = error', 'dotnet_naming_symbols.public_fields.applicable_kinds = field', 'dotnet_naming_symbols.public_fields.applicable_accessibilities = public', 'dotnet_naming_style.pascal.capitalization = pascal_case', ''].join('\n');

const CLEAN = 'namespace Demo;\n\ninternal class Clean\n{\n    public int Total;\n}\n';

describe('checkPaths (code-janitor check)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-check-'));
    fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'src', 'obj'));
    fs.writeFileSync(path.join(root, 'src', 'Clean.cs'), CLEAN);
    fs.writeFileSync(path.join(root, 'src', 'obj', 'Generated.cs'), 'internal class Generated { void M(bool b) { if (b) M(b); } }\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when no file would change and no enforced rule is violated', async () => {
    const report = await checkPaths([path.join(root, 'src')], root);

    expect(report.lines).toEqual(['Code Janitor check: 1 file(s) checked, all clean.']);
    expect(report.exitCode).toBe(0);
  });

  it('fails and lists file:line: rule for each change cleanup would make and each violation it cannot fix', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'Dirty.cs'),
      'namespace Demo;\n\ninternal class Dirty\n{\n    public int total;\n\n    public void Add(int value)\n    {\n        if (value > 0)\n            total += value;\n    }\n}\n'
    );

    const report = await checkPaths([path.join(root, 'src')], root);

    expect(report.lines).toEqual([
      'src/Dirty.cs:9: IDE0011 (warning): Code Janitor would change this to: {',
      "src/Dirty.cs:5: IDE1006 (error): field 'total' should be named 'Total'; not renamed because it is not private and may be referenced from other files.",
      'Code Janitor check: 2 file(s) checked, 1 would change, 1 violation(s) cleanup cannot fix.',
    ]);
    expect(report.exitCode).toBe(1);
  });

  it('applies the nearest .codejanitor of each file, walking up from its folder', async () => {
    const source = 'namespace Demo;\n\ninternal class Holder\n{\n}\n\n#region Helpers\n#endregion\n';
    fs.mkdirSync(path.join(root, 'kept', 'deeper'), { recursive: true });
    fs.mkdirSync(path.join(root, 'removed'));
    fs.writeFileSync(path.join(root, 'kept', '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    fs.writeFileSync(path.join(root, 'kept', 'deeper', 'Holder.cs'), source);
    fs.writeFileSync(path.join(root, 'removed', 'Holder.cs'), source);

    const kept = await checkPaths([path.join(root, 'kept')], root);
    const removed = await checkPaths([path.join(root, 'removed')], root);

    expect(kept.lines.join('\n')).not.toContain('Remove region directives');
    expect(removed.lines.join('\n')).toContain('removed/Holder.cs:7: Remove region directives');
  });

  it('reports a change that only inserts blank lines as an insertion, named once', async () => {
    fs.writeFileSync(path.join(root, 'src', 'Padded.cs'), 'namespace Demo\n{\n#if DEBUG\n    internal class Padded\n    {\n    }\n#endif\n}\n');

    const report = await checkPaths([path.join(root, 'src', 'Padded.cs')], root);

    expect(report.lines).toEqual([
      'src/Padded.cs:3: Insert blank line padding: Code Janitor would insert 1 blank line(s)',
      'src/Padded.cs:6: Insert blank line padding: Code Janitor would insert 1 blank line(s)',
      'Code Janitor check: 1 file(s) checked, 1 would change, 0 violation(s) cleanup cannot fix.',
    ]);
  });

  it('lists the notes of Code Janitor settings without failing on them', async () => {
    fs.writeFileSync(path.join(root, 'src', '.codejanitor'), JSON.stringify({ cleanup: { convertToFileScopedNamespace: true, moveUsingsOutsideNamespace: true } }));
    fs.writeFileSync(path.join(root, 'src', 'Scoped.cs'), 'namespace Demo\n{\n    using System;\n\n    internal class Scoped\n    {\n    }\n}\n');

    const report = await checkPaths([path.join(root, 'src', 'Scoped.cs')], root);

    expect(report.lines).toEqual([
      'src/Scoped.cs: note: Using directives were not moved outside the namespace because the file is not part of a C# project. They were left in place.',
      'src/Scoped.cs: note: Line 1: namespace not converted to a file-scoped one: its project could not be determined, so its C# language version is unknown.',
      'Code Janitor check: 1 file(s) checked, all clean.',
    ]);
    expect(report.exitCode).toBe(0);
  });

  it('fails on an enforced .editorconfig rule cleanup cannot apply, naming the option once', async () => {
    fs.appendFileSync(path.join(root, '.editorconfig'), 'csharp_style_namespace_declarations = file_scoped:warning\n');
    fs.writeFileSync(path.join(root, 'src', 'Legacy.csproj'), '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <LangVersion>7.3</LangVersion>\n  </PropertyGroup>\n</Project>\n');
    fs.writeFileSync(path.join(root, 'src', 'Legacy.cs'), 'namespace Demo\n{\n    internal class Legacy\n    {\n    }\n}\n');

    const report = await checkPaths([path.join(root, 'src', 'Legacy.cs')], root);

    expect(report.lines).toEqual([
      'src/Legacy.cs:1: csharp_style_namespace_declarations: not applied, its project uses C# 7.3 and file-scoped namespaces need C# 10.',
      'Code Janitor check: 1 file(s) checked, 0 would change, 1 violation(s) cleanup cannot fix.',
    ]);
    expect(report.exitCode).toBe(1);
  });
});
