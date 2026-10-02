import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { CompilerError, compilerErrors, newCompilerErrors } from '../scripts/compileOracle';
import { reorganizeSourceDetailed } from '../src/reorganize/reorganize';
import { MEMBER_TYPE_KEYS, ReorganizeSettings, createDefaultReorganizeSettings } from '../src/reorganize/settings';
import { dotnetAvailable, writeProject } from './helpers/dotnetBuild';
import { withoutPadding } from './helpers/padding';

/**
 * The real-compiler proof: the C# files of test/oracle/Reorganize (members in the order nobody would
 * choose: every kind of member, partial classes, nested types, explicit interface implementations,
 * #if around members, regions, attributes, structs, records, enums, delegates, events, and static and
 * instance initializers that depend on the order they are declared in) are reorganized with several
 * settings. The result must compile with no new compiler error and - Program.cs prints the value of
 * every static field and every instance field - behave exactly as before.
 */
const corpus = path.join(__dirname, 'oracle', 'Reorganize');
const project = 'Reorganize.csproj';

function readCorpus(): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(corpus).filter((name) => name.endsWith('.cs') || name === project).map((name) => [name, fs.readFileSync(path.join(corpus, name), 'utf8')]));
}

interface Built {
  errors: CompilerError[];
  ok: boolean;
  log: string;
  /** What Program.cs printed. */
  program: string;
}

function buildAndRun(files: Record<string, string>, configuration: 'Debug' | 'Release'): Built {
  const folder = writeProject(files, files[project], project);
  try {
    const build = spawnSync(
      'dotnet',
      ['build', path.join(folder, project), '-c', configuration, '-nologo', '-v:q', '-clp:NoSummary', '-p:RunAnalyzers=false', '-p:EnforceCodeStyleInBuild=false', '-p:TreatWarningsAsErrors=false', '-p:WarningsAsErrors='],
      { cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
    const log = `${build.stdout}\n${build.stderr}`;
    const ok = build.status === 0;
    const run = ok ? spawnSync('dotnet', [path.join(folder, 'bin', configuration, 'net10.0', 'Reorganize.dll')], { encoding: 'utf8' }) : undefined;

    return { errors: compilerErrors(log, folder), ok, log, program: run ? `${run.stdout}${run.stderr}` : '' };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

function describeErrors(errors: readonly CompilerError[]): string {
  return errors.map((error) => `${error.file}(${error.line}): ${error.code} ${error.message}`).join('\n');
}

interface Scenario {
  name: string;
  settings: Partial<ReorganizeSettings>;
  padding?: 'default' | 'none';
  lineEnding?: '\n' | '\r\n';
  configuration?: 'Debug' | 'Release';
}

const customOrder = createDefaultReorganizeSettings().memberTypes;
customOrder.methods = { order: 1, name: 'Methods' };
customOrder.classes = { order: 2, name: 'Types' };
customOrder.structs = { order: 2, name: 'Types' };
customOrder.fields = { order: 12, name: 'State' };

const SCENARIOS: Scenario[] = [
  { name: 'the defaults', settings: {} },
  { name: 'the defaults in a Release build', settings: {}, configuration: 'Release' },
  { name: 'the defaults without blank line padding and with CRLF line endings', settings: {}, padding: 'none', lineEnding: '\r\n' },
  { name: 'members in source order inside their group', settings: { alphabetizeMembersOfTheSameGroup: false, explicitMembersAtEnd: true } },
  { name: 'access first, private to public', settings: { primaryOrderByAccessLevel: true, reverseOrderByAccessLevel: true } },
  { name: 'a configured member type order', settings: { memberTypes: customOrder } },
  { name: 'members sorted across the existing regions', settings: { keepMembersWithinRegions: false } },
  { name: 'existing regions removed', settings: { regionsRemoveExistingRegions: true } },
  { name: 'new regions', settings: { regionsInsertNewRegions: true, regionsRemoveExistingRegions: true } },
  { name: 'new regions with the access level', settings: { regionsInsertNewRegions: true, regionsIncludeAccessLevel: true, regionsInsertKeepEvenIfEmpty: true } },
  {
    name: 'new regions with the access level of methods, sorted across regions',
    settings: { regionsInsertNewRegions: true, regionsIncludeAccessLevel: true, regionsIncludeAccessLevelForMethodsOnly: true, keepMembersWithinRegions: false },
    lineEnding: '\r\n',
  },
];

describe.skipIf(!dotnetAvailable)('reorganize: real C# files compiled with dotnet', () => {
  const baselines = new Map<string, Built>();

  beforeAll(() => {
    for (const configuration of ['Debug', 'Release'] as const) {
      baselines.set(configuration, buildAndRun(readCorpus(), configuration));
    }
  }, 300_000);

  it('starts from a corpus that compiles and runs', () => {
    for (const [configuration, baseline] of baselines) {
      expect(baseline.ok, `${configuration}: ${baseline.log}`).toBe(true);
      expect(baseline.program).toContain('Oracle.Reorganize.Settings.Quadrupled = 84');
    }
  });

  it.each(SCENARIOS)(
    'reorganizes with $name without a new compiler error and without a change of behaviour',
    (scenario) => {
      const configuration = scenario.configuration ?? 'Debug';
      const baseline = baselines.get(configuration)!;
      const settings: ReorganizeSettings = { ...createDefaultReorganizeSettings(), performWhenPreprocessorConditionals: 'yes', ...scenario.settings };
      const cleanup = scenario.padding === 'none' ? withoutPadding() : createDefaultSettings();
      const eol = scenario.lineEnding ?? '\n';

      const reorganized: Record<string, string> = {};
      const changed: string[] = [];
      for (const [name, content] of Object.entries(readCorpus())) {
        if (name === project) {
          reorganized[name] = content;
          continue;
        }

        const input = eol === '\n' ? content : content.replace(/\r?\n/g, eol);
        const first = reorganizeSourceDetailed(input, settings, cleanup);
        expect(first.skipped, `${name} must not be left alone`).toEqual([]);
        expect(reorganizeSourceDetailed(first.output, settings, cleanup).output, `${name} must not change when reorganized again`).toBe(first.output);

        reorganized[name] = first.output;
        if (first.output !== input) {
          changed.push(name);
        }
      }

      // The scenarios would prove nothing if the reorganizer left the files alone.
      expect(changed).toContain('Kitchen.cs');
      expect(changed).toContain('StaticInit.cs');

      const after = buildAndRun(reorganized, configuration);
      expect(describeErrors(newCompilerErrors(baseline.errors, after.errors)), after.log).toBe('');
      expect(after.ok, after.log).toBe(true);
      expect(after.program).toBe(baseline.program);
    },
    300_000
  );
});
