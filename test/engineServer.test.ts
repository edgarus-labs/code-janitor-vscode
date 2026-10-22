import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineClient } from '../src/engine/client';
import { toEngineSettings } from '../src/engine/settings';
import { createDefaultSettings } from '../src/cleanup/types';
import { startEngine } from '../scripts/engineServer';
import { dotnetAvailable } from './helpers/dotnetBuild';

describe.skipIf(!dotnetAvailable)('EngineClient with the real server', () => {
  let root: string;
  let engine: EngineClient;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-engine-'));
    fs.writeFileSync(
      path.join(root, 'Demo.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n'
    );
    engine = startEngine([root]);
  });

  afterAll(async () => {
    await engine?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cleans a C# file of a project and answers in the protocol shape', async () => {
    const filePath = path.join(root, 'Counter.cs');
    const text = 'namespace Demo\n{\n    class Counter   \n    {\n        #region Fields\n        int total;\n        #endregion\n    }\n}\n';
    fs.writeFileSync(filePath, text);

    const result = await engine.cleanup({ filePath, text, settings: toEngineSettings(createDefaultSettings()) });

    expect(result).toMatchObject({ otherFiles: [], newFiles: [], unresolved: expect.any(Array), issues: expect.any(Array), rules: expect.any(Array) });
    expect(result.text).not.toContain('#region');
    expect(result.text).not.toMatch(/Counter {3}\n/);
  });

  it('reports the notes of the settings the workspace overrides', async () => {
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));

    const { notes } = await engine.overrideNotes({ directory: root, settings: toEngineSettings(createDefaultSettings()) });

    expect(notes.removeRegions).toMatch(/\.codejanitor/);
  });
});
