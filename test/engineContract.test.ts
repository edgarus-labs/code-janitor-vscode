import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { EngineClient } from '../src/engine/client';
import { toEngineSettings } from '../src/engine/settings';
import { startEngine } from '../scripts/engineServer';
import { dotnetAvailable } from './helpers/dotnetBuild';

const SOURCE = [
  'using System;',
  '',
  'namespace Demo',
  '{',
  '    public class Counter',
  '    {',
  '        #region Fields',
  '        private int total;',
  '        #endregion',
  '',
  '        public int Add(int amount)',
  '        {',
  '            if (amount < 0)',
  '            {',
  '                throw new ArgumentOutOfRangeException(nameof(amount));',
  '            }',
  '',
  '            total += amount;',
  '            return total;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

describe.skipIf(!dotnetAvailable)('the shapes the TypeScript client reads from the real server', () => {
  let root: string;
  let engine: EngineClient;
  let filePath: string;

  const document = () => ({ filePath, text: SOURCE });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-contract-'));
    fs.writeFileSync(
      path.join(root, 'Demo.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n'
    );
    filePath = path.join(root, 'Counter.cs');
    fs.writeFileSync(filePath, SOURCE);
    engine = startEngine([root]);
  });

  afterAll(async () => {
    await engine?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('analyze: diagnostics with 0-based ranges and the fixable flag', async () => {
    const result = await engine.analyze(document());

    expect(Array.isArray(result.diagnostics)).toBe(true);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic).toMatchObject({
        id: expect.any(String),
        message: expect.any(String),
        severity: expect.any(String),
        startLine: expect.any(Number),
        startColumn: expect.any(Number),
        endLine: expect.any(Number),
        endColumn: expect.any(Number),
        fixable: expect.any(Boolean),
      });
    }
  });

  it('fixRule: a cleanup result for a rule on a line', async () => {
    const result = await engine.fixRule({ ...document(), ruleId: 'IDE0073', line: 0 });

    expect(result).toMatchObject({
      text: expect.any(String),
      otherFiles: expect.any(Array),
      newFiles: expect.any(Array),
      rules: expect.any(Array),
      unresolved: expect.any(Array),
      issues: expect.any(Array),
      failures: expect.any(Array),
      warnings: expect.any(Array),
    });
  });

  it('memberAtPosition: the innermost member around the position', async () => {
    const member = await engine.query<Record<string, unknown> | null>({ ...document(), query: 'memberAtPosition', arguments: { line: 17, character: 14 } });

    expect(member).toMatchObject({
      name: 'Add',
      kind: 'method',
      startLine: expect.any(Number),
      endLine: expect.any(Number),
      text: expect.stringContaining('total += amount'),
      signature: expect.stringContaining('Add(int amount)'),
    });
    expect(member!.startLine as number).toBeLessThanOrEqual(17);
    expect(member!.endLine as number).toBeGreaterThanOrEqual(17);
  });

  it('memberAtPosition: null outside any member', async () => {
    expect(await engine.query({ ...document(), query: 'memberAtPosition', arguments: { line: 0, character: 0 } })).toBeNull();
  });

  it('structure: items with children and regions, 0-based lines', async () => {
    const structure = await engine.query<{ items: Record<string, unknown>[]; regions: Record<string, unknown>[] }>({ ...document(), query: 'structure' });

    expect(structure.regions).toEqual([expect.objectContaining({ name: 'Fields', startLine: 6, endLine: 8, children: [] })]);
    const [namespace] = structure.items;
    expect(namespace).toMatchObject({
      kind: 'namespace',
      name: 'Demo',
      startLine: expect.any(Number),
      endLine: expect.any(Number),
      children: expect.any(Array),
    });
    const type = (namespace.children as Record<string, unknown>[])[0];
    expect(type).toMatchObject({
      kind: 'class',
      name: 'Counter',
      modifiers: expect.any(Array),
      baseTypes: expect.any(Array),
      typeParameters: expect.any(Array),
      accessors: expect.any(Array),
    });
    const method = (type.children as Record<string, unknown>[]).find((item) => item.name === 'Add');
    expect(method).toMatchObject({
      kind: 'method',
      returnType: 'int',
      parameters: [{ name: 'amount', type: 'int' }],
      complexity: expect.any(Number),
      startLine: 10,
      endLine: 19,
    });
  });

  it('memberLines: the lines a member owns', async () => {
    const lines = await engine.query({ ...document(), query: 'memberLines', arguments: { line: 10, name: 'Add' } });

    expect(lines).toEqual({ startLine: 10, endLine: 19 });
  });

  it('branches: the target, its branches and the coverage', async () => {
    const result = await engine.query<Record<string, unknown>>({ ...document(), query: 'branches', arguments: { line: 17, character: 14 } });

    expect(result).toMatchObject({
      target: { name: 'Add', kind: 'method', startLine: expect.any(Number), endLine: expect.any(Number), text: expect.any(String) },
      branches: expect.any(Array),
      coverage: null,
    });
    expect((result.branches as unknown[]).length).toBeGreaterThan(0);
  });

  it('xmlDocTargets: the undocumented members with everything the XML documentation planner reads', async () => {
    const targets = await engine.query<Record<string, unknown>[]>({
      ...document(),
      query: 'xmlDocTargets',
      arguments: {
        maxMembersPerFile: 10,
        maxInputCharsPerMember: 2500,
        ignoreGeneratedCode: true,
        ignoreObsolete: true,
        ignoreTestMethods: true,
        ignorePattern: '',
      },
    });

    const method = targets.find((target) => target.name === 'Add');
    expect(method).toMatchObject({
      kind: 'method',
      text: expect.any(String),
      insertionLine: 10,
      indent: '        ',
      signature: expect.stringContaining('public int Add(int amount)'),
      body: expect.stringContaining('total += amount'),
      parameters: [{ name: 'amount', type: 'int' }],
      typeParameters: [],
      returnType: 'int',
      containingType: { name: 'Counter', kind: 'class' },
      exceptions: ['ArgumentOutOfRangeException'],
      accessors: null,
      baseTypes: [],
    });
    expect(targets.find((target) => target.name === 'Counter')).toMatchObject({
      kind: 'class',
      members: expect.any(Array),
      modifiers: expect.arrayContaining(['public']),
    });
  });

  it('reorganizeReport: the preprocessor flag and the skipped members', async () => {
    const report = await engine.query({ ...document(), query: 'reorganizeReport' });

    expect(report).toMatchObject({ blockedByPreprocessor: false, skipped: expect.any(Array) });
  });

  it('cleanup: the result shape with the default settings', async () => {
    const result = await engine.cleanup({ ...document(), settings: toEngineSettings(createDefaultSettings()) });

    expect(result).toMatchObject({
      text: expect.any(String),
      otherFiles: [],
      newFiles: [],
      rules: expect.any(Array),
      unresolved: expect.any(Array),
      issues: expect.any(Array),
      failures: [],
      warnings: expect.any(Array),
    });
  });
});
