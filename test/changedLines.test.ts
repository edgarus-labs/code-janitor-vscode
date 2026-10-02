import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedLinesSince, runCleanupOnChangedLines } from '../src/cleanup/changedLines';
import { readHeadVersion } from '../src/cleanup/gitBaseline';
import { EditorConfigIssue } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';

const BASE = [
  'namespace Demo',
  '{',
  '    internal class Counter',
  '    {',
  '        private int total;',
  '',
  '        public void Add(int value)',
  '        {',
  '            if (value > 0)',
  '                total += value;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-changed-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('changedLinesSince', () => {
  it('lists the lines added or modified since the base, not the ones around a deletion', () => {
    const current = BASE.replace('        private int total;\n', '        private int total;\n        private int count;\n').replace(
      '            if (value > 0)\n',
      ''
    );

    expect([...changedLinesSince(BASE, current)]).toEqual([5]);
    expect([...changedLinesSince(BASE.replace(/\n/g, '\r\n'), current)]).toEqual([5]);
    expect(changedLinesSince(undefined, 'a\nb\n').size).toBe(3);
  });
});

describe('runCleanupOnChangedLines', () => {
  const run = (editorConfig: string[], current: string) => {
    fs.writeFileSync(path.join(root, '.editorconfig'), ['root = true', '', '[*.cs]', ...editorConfig, ''].join('\n'));
    // The project tells that file-scoped namespaces compile.
    fs.writeFileSync(path.join(root, 'Counter.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
    const issues: EditorConfigIssue[] = [];
    const outcome = runCleanupOnChangedLines(current, path.join(root, 'Counter.cs'), createDefaultSettings(), changedLinesSince(BASE, current), undefined, (issue) =>
      issues.push(issue)
    );

    return { ...outcome, issues: issues.filter((issue) => issue.kind === 'unresolved').map((issue) => issue.detail) };
  };

  const withNewMethod = BASE.replace(
    '        }\n    }\n}',
    '        }\n\n        public void Remove(int value)\n        {\n            if (value > 0)\n                total -= value;\n        }\n    }\n}'
  );

  it('fixes the changed lines and leaves the violations on unchanged lines', () => {
    const { output, skippedSettings } = run(['csharp_prefer_braces = true:warning'], withNewMethod);

    expect(output).toContain('            if (value > 0)\n                total += value;\n        }\n\n');
    expect(output).toContain('            if (value > 0)\n            {\n                total -= value;\n            }\n');
    expect(skippedSettings).toEqual([]);
  });

  it('skips and reports a rule whose change spans lines not changed since the last commit', () => {
    const { output, issues } = run(['csharp_style_namespace_declarations = file_scoped:warning', 'csharp_prefer_braces = true:warning'], withNewMethod);

    expect(output).toContain('namespace Demo\n{\n');
    expect(output).toContain('            if (value > 0)\n            {\n                total -= value;\n            }\n');
    expect(issues).toEqual([
      'IDE0161: not applied, its changes span lines not changed since the last commit (codeJanitor.cleanup.onlyChangedLines).',
    ]);
  });

  it('does not rename, and reports only the naming violations declared on changed lines', () => {
    const current = BASE.replace('        private int total;\n', '        private int total;\n        private int count;\n');
    const { output, issues } = run(
      [
        'dotnet_naming_rule.private_fields.symbols = private_fields',
        'dotnet_naming_rule.private_fields.style = underscore',
        'dotnet_naming_rule.private_fields.severity = warning',
        'dotnet_naming_symbols.private_fields.applicable_kinds = field',
        'dotnet_naming_symbols.private_fields.applicable_accessibilities = private',
        'dotnet_naming_style.underscore.capitalization = camel_case',
        'dotnet_naming_style.underscore.required_prefix = _',
      ],
      current
    );

    expect(output).toBe(current);
    expect(issues).toEqual([
      "IDE1006 (naming rule 'private_fields', warning) line 6: field 'count' should be named '_count'; not renamed because renames are not made when only changed lines are cleaned.",
    ]);
  });
});

describe('readHeadVersion', () => {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });

  it('reads the committed text of a tracked file, and tells new files and files outside Git apart', async () => {
    const outside = await readHeadVersion(path.join(root, 'Counter.cs'));
    git('init', '-q');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'Counter.cs'), BASE);
    const beforeFirstCommit = await readHeadVersion(path.join(root, 'src', 'Counter.cs'));
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    fs.writeFileSync(path.join(root, 'src', 'Counter.cs'), `${BASE}// edited\n`);
    fs.writeFileSync(path.join(root, 'src', 'New.cs'), 'class New { }\n');

    expect(outside.kind).toBe('unavailable');
    expect(beforeFirstCommit).toEqual({ kind: 'new' });
    expect(await readHeadVersion(path.join(root, 'src', 'Counter.cs'))).toEqual({ kind: 'tracked', text: BASE });
    expect(await readHeadVersion(path.join(root, 'src', 'New.cs'))).toEqual({ kind: 'new' });
  });

  it('reads a tracked file deleted from disk, and reports a file of a missing folder as unavailable instead of throwing', async () => {
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'Counter.cs'), BASE);
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    fs.rmSync(path.join(root, 'Counter.cs'));

    expect(await readHeadVersion(path.join(root, 'Counter.cs'))).toEqual({ kind: 'tracked', text: BASE });
    expect((await readHeadVersion(path.join(root, 'gone', 'Other.cs'))).kind).toBe('unavailable');
  });
});
