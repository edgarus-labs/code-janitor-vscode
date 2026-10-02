import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_STYLE_RULES } from '../src/cleanup/codeStyleRules';
import { loadEditorConfigProperties, resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { planOneTypePerFile, readOneTypePerFileRules } from '../src/cleanup/oneTypePerFile';
import { applyRepositoryPolicy, readRepositoryPolicy } from '../src/cleanup/repositoryOverrides';
import { diagnosticIdsOfOption, editorConfigCatalog } from '../src/cleanup/editorConfigRegistry';
import { runCleanup, runLayoutCleanup } from '../src/cleanup/runCleanup';
import { createTopLevelTypeSplitPlan } from '../src/cleanup/topLevelTypeSplit';
import { insertRegionAroundLines, removeRegionsInLines } from '../src/reorganize/regionEdits';
import { sortLineRange } from '../src/reorganize/sortLines';
import { fixNamespace } from '../src/cleanup/transformations/namespaceAndNameOf';
import { removeXmlDocumentationConverter } from '../src/cleanup/transformations/removeXmlDocumentation';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';
import { createDefaultReorganizeSettings } from '../src/reorganize/settings';
import { RazorFormatOptions } from '../src/razor/razorOptions';
import { formatRazor } from '../src/razor/razorFormatter';
import { dotnetAvailable } from './helpers/dotnetBuild';
import { Check, failure } from './helpers/testbedChecks';

/**
 * The Code Janitor testbed (https://github.com/edgarus-labs/code-janitor-testbed): a solution of
 * deliberately bad C#, one class per cleanup option, and `scenarios.json` saying what each cleanup
 * must do to it. Every scenario runs here on its own file with only its own option on; then the
 * whole solution is built and run before and after the cleanup, so a rewrite that breaks the build
 * or changes what the code prints fails the test.
 *
 * The testbed is found through `CODE_JANITOR_TESTBED` (CI clones it), else in a sibling folder.
 */
type EntryPoint = 'cleanup' | 'layout' | 'razor' | 'removeXmlDoc' | 'fixNamespace' | 'splitTypes' | 'oneTypePerFile' | 'sortLines' | 'insertRegion' | 'removeRegion';

interface ScenarioEntry {
  readonly id: string;
  readonly category: string;
  readonly file: string;
  readonly entry: EntryPoint;
  readonly settings: Record<string, unknown>;
  readonly codeStyle: Record<string, string>;
  readonly editorconfig: boolean;
  readonly alwaysOn?: boolean;
  readonly knownDefect?: string;
  readonly everything?: boolean;
  readonly trap?: boolean;
  readonly reportOnly: boolean;
  readonly razor?: Partial<RazorFormatOptions>;
  readonly expectedNamespace?: string;
  readonly createdFiles?: string[];
  readonly lines?: [number, number];
  readonly policy?: boolean;
  readonly fileDir?: string;
  readonly userSettings?: Record<string, unknown>;
  readonly userCodeStyle?: Record<string, string>;
  readonly checks: Check[];
}

/** Options with no effect on the text of one file: they need git history or a whole workspace. */
const NOT_A_TEXT_TRANSFORMATION: Readonly<Record<string, string>> = {
  onlyChangedLines: 'limits any cleanup to the lines changed since the last commit (needs git history)',
  renamePublicSymbolsAcrossWorkspace: 'renames public symbols across the projects of a workspace (batch commands only)',
};

/**
 * `.editorconfig` keys and diagnostics the engine supports that no scenario can exercise, with the reason.
 * Everything else the registry lists must have a scenario.
 */
const EXEMPT_KEYS: Readonly<Record<string, string>> = {};
const EXEMPT_DIAGNOSTICS: Readonly<Record<string, string>> = {};

/** The `.editorconfig` a scenario ships next to its file, or an empty text. */
function scenarioEditorConfig(root: string, scenario: ScenarioEntry): string {
  const file = path.join(root, path.dirname(scenario.file), '.editorconfig');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** The same rules with every severity turned off: whatever they asked for must no longer happen. */
function silenced(editorconfig: string): string {
  return editorconfig.replace(/:(?:warning|error|suggestion)\b/g, ':silent').replace(/(\.severity\s*=\s*)(?:warning|error|suggestion)\b/g, '$1none');
}

function findTestbed(): string | undefined {
  const candidates = [process.env.CODE_JANITOR_TESTBED, path.resolve(__dirname, '..', '.testbed'), path.resolve(__dirname, '..', '..', 'code-janitor-testbed')];

  return candidates.find((candidate): candidate is string => Boolean(candidate) && fs.existsSync(path.join(candidate as string, 'scenarios.json')));
}

const testbed = findTestbed();
const suite = testbed ? describe : describe.skip;

// CI sets this: a missing testbed must fail the build instead of skipping the test.
if (!testbed && process.env.CODE_JANITOR_REQUIRE_TESTBED === '1') {
  describe('the Code Janitor testbed', () => {
    it('is present', () => {
      throw new Error('The testbed was not found: clone edgarus-labs/code-janitor-testbed into .testbed or set CODE_JANITOR_TESTBED.');
    });
  });
}

function allOff(): CleanupSettings {
  const settings = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      settings[key] = false;
    }
  }

  settings.fileHeaderCSharp = '';

  return settings as unknown as CleanupSettings;
}

function everythingOn(): CleanupSettings {
  const settings = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      settings[key] = !(key in NOT_A_TEXT_TRANSFORMATION);
    }
  }

  settings.codeStyleRules = Object.fromEntries(CODE_STYLE_RULES.map((rule) => [rule.key, rule.defaultValue]));

  return settings as unknown as CleanupSettings;
}

function settingsOf(scenario: ScenarioEntry): CleanupSettings {
  if (scenario.everything) {
    const everything = everythingOn() as unknown as Record<string, unknown>;
    if (scenario.settings.reorganize) {
      const defaults = createDefaultReorganizeSettings();
      everything.reorganize = { ...defaults, ...(scenario.settings.reorganize as object), memberTypes: defaults.memberTypes };
    }

    return everything as unknown as CleanupSettings;
  }

  const settings = allOff() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries({ ...scenario.userSettings, ...scenario.settings })) {
    if (!(key in settings)) {
      throw new Error(`${scenario.id}: unknown setting ${key}`);
    }

    if (key === 'reorganize') {
      const defaults = createDefaultReorganizeSettings();
      const override = value as Partial<typeof defaults>;
      settings.reorganize = { ...defaults, ...override, memberTypes: { ...defaults.memberTypes, ...(override.memberTypes ?? {}) } };
    } else {
      settings[key] = value;
    }
  }

  const rules: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...scenario.userCodeStyle, ...scenario.codeStyle })) {
    const rule = CODE_STYLE_RULES.find((candidate) => candidate.key === key);
    if (!rule) {
      throw new Error(`${scenario.id}: unknown Code Style rule ${key}`);
    }

    rules[key] = value || rule.defaultValue;
  }

  settings.codeStyleRules = rules;

  return settings as unknown as CleanupSettings;
}

/** What one engine entry point makes of a scenario file: the new text, the files it creates and what it reports. */
interface Produced {
  readonly output: string;
  readonly created: Map<string, string>;
  readonly issues: string[];
}

function produce(root: string, scenario: ScenarioEntry, text: string, collect: boolean): Produced {
  const file = path.join(root, scenario.file);
  const issues: string[] = [];
  const created = new Map<string, string>();
  switch (scenario.entry) {
    case 'razor':
      return { output: formatRazor(text, scenario.razor ?? {}), created, issues };
    case 'layout':
      return { output: runLayoutCleanup(text, file, settingsOf(scenario)), created, issues };
    case 'removeXmlDoc':
      return { output: removeXmlDocumentationConverter.apply(text), created, issues };
    case 'fixNamespace':
      return { output: fixNamespace(text, scenario.expectedNamespace ?? ''), created, issues };
    case 'splitTypes': {
      const plan = createTopLevelTypeSplitPlan(text, file);
      for (const planned of plan.newFiles) {
        created.set(path.basename(planned.filePath), planned.content);
      }

      return { output: plan.updatedSource, created, issues };
    }

    case 'sortLines':
      return { output: sortLineRange(text, scenario.lines![0], scenario.lines![1]), created, issues };
    case 'insertRegion':
      return { output: insertRegionAroundLines(text, scenario.lines![0], scenario.lines![1], createDefaultSettings()).text, created, issues };
    case 'removeRegion':
      return { output: removeRegionsInLines(text, scenario.lines![0], scenario.lines![1]), created, issues };
    case 'oneTypePerFile': {
      const rules = readOneTypePerFileRules(loadEditorConfigProperties(file));
      if (!rules) {
        return { output: text, created, issues };
      }

      const reserved = new Set(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.cs')));
      const outcome = planOneTypePerFile(text, file, rules, reserved);
      for (const planned of outcome.plan.newFiles) {
        created.set(path.basename(planned.filePath), planned.content);
      }

      return { output: outcome.plan.hasChanges ? outcome.plan.updatedSource : text, created, issues: [...outcome.issues] };
    }

    default: {
      const user = settingsOf(scenario);
      const settings = scenario.policy ? applyRepositoryPolicy(user, readRepositoryPolicy(path.dirname(file))) : user;

      return { output: runCleanup(text, file, settings, undefined, (issue) => collect && issues.push(`${issue.kind}: ${issue.detail}`)), created, issues };
    }
  }
}

interface Outcome extends Produced {
  readonly scenario: ScenarioEntry;
  readonly input: string;
  readonly again: string;
}

function clean(root: string, scenario: ScenarioEntry, input: string): Outcome {
  const first = produce(root, scenario, input, true);

  return { ...first, scenario, input, again: produce(root, scenario, first.output, false).output };
}

function copyTestbed(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-testbed-'));
  fs.cpSync(source, target, { recursive: true, filter: (from) => !/[\\/](bin|obj|\.git|node_modules)([\\/]|$)/.test(from) });

  return target;
}

interface BuildRun {
  readonly errors: string[];
  readonly lines: Map<string, string>;
}

function buildAndRun(root: string): BuildRun {
  // The .NET host sometimes dies with an internal CLR error before it compiles anything; that says nothing about the code.
  let output = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const build = spawnSync('dotnet', ['build', path.join(root, 'CodeJanitor.Testbed.slnx'), '-nologo', '-v:q', '-clp:NoSummary', '-nodeReuse:false'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 900_000 });
    output = `${build.stdout}\n${build.stderr}`;
    if (!/Internal CLR error/.test(output)) {
      break;
    }
  }

  const errors = [...new Set(output.split('\n').filter((line) => /: error [A-Z]+\d+/.test(line)).map((line) => line.replace(root, '').replace(/\s+\[[^\]]+\]$/, '')))];
  const lines = new Map<string, string>();
  if (errors.length === 0) {
    const run = spawnSync('dotnet', [path.join(root, 'src', 'Scenarios', 'bin', 'Debug', 'net10.0', 'Scenarios.dll')], { encoding: 'utf8', timeout: 120_000 });
    for (const line of run.stdout.split('\n').filter(Boolean)) {
      const at = line.indexOf('=');
      lines.set(line.slice(0, at), line.slice(at + 1));
    }
  }

  return { errors, lines };
}

function write(root: string, scenario: ScenarioEntry, produced: Produced): void {
  fs.writeFileSync(path.join(root, scenario.file), produced.output);
  for (const [name, content] of produced.created) {
    fs.writeFileSync(path.join(root, path.dirname(scenario.file), name), content);
  }
}

function differences(before: BuildRun, after: BuildRun): string[] {
  return [...before.lines].filter(([name, value]) => after.lines.get(name) !== value).map(([name, value]) => `${name}: ${value} -> ${after.lines.get(name)}`);
}

suite('the Code Janitor testbed', () => {
  // Vitest also runs the body of a skipped suite to collect it: without a testbed there is nothing to read.
  const root = testbed ?? '';
  const scenarios = testbed ? (JSON.parse(fs.readFileSync(path.join(root, 'scenarios.json'), 'utf8')) as { scenarios: ScenarioEntry[] }).scenarios : [];
  const outcomes = new Map<string, Outcome>();
  const folders: string[] = [];

  beforeAll(() => {
    for (const scenario of scenarios) {
      outcomes.set(scenario.id, clean(root, scenario, fs.readFileSync(path.join(root, scenario.file), 'utf8')));
    }
  });
  afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

  describe('coverage of the options', () => {
    it('has a scenario for every Code Style rule', () => {
      const covered = new Set(scenarios.flatMap((scenario) => Object.keys(scenario.codeStyle)));

      expect(CODE_STYLE_RULES.map((rule) => rule.key).filter((key) => !covered.has(key))).toEqual([]);
    });

    it('has a scenario for every cleanup setting that changes the text of a file', () => {
      const covered = new Set(scenarios.flatMap((scenario) => Object.keys(scenario.settings)));
      const settings = createDefaultSettings() as unknown as Record<string, unknown>;
      const options = Object.keys(settings).filter((key) => typeof settings[key] === 'boolean' && !(key in NOT_A_TEXT_TRANSFORMATION));

      expect(options.filter((key) => !covered.has(key))).toEqual([]);
    });

    it('has a scenario for every Reorganize option', () => {
      const covered = new Set(scenarios.flatMap((scenario) => Object.keys((scenario.settings.reorganize ?? {}) as Record<string, unknown>)));
      const options = Object.keys(createDefaultReorganizeSettings());

      expect(options.filter((key) => !covered.has(key))).toEqual([]);
    });

    it('has a scenario for every .editorconfig key the engine supports', () => {
      const used = new Set<string>();
      for (const scenario of scenarios) {
        for (const line of scenarioEditorConfig(root, scenario).split(/\r?\n/)) {
          const key = /^\s*([\w.*-]+)\s*=/.exec(line)?.[1];
          if (key) {
            used.add(key);
          }
        }
      }

      expect(editorConfigCatalog().settings.filter((key) => !used.has(key) && !(key in EXEMPT_KEYS))).toEqual([]);
    });

    it('has a scenario for every diagnostic the engine honors', () => {
      const covered = new Set<string>();
      for (const scenario of scenarios) {
        const text = scenarioEditorConfig(root, scenario);
        const props = resolveEditorConfigProperties([{ directory: '/r', text: `root = true\n[*.cs]\n${text}` }], '/r/a.cs');
        for (const line of text.split(/\r?\n/)) {
          const explicit = /^\s*dotnet_diagnostic\.(\w+)\.severity/.exec(line)?.[1];
          if (explicit) {
            covered.add(explicit);
          }

          const key = /^\s*([\w*.-]+)\s*=/.exec(line)?.[1];
          if (key && /^dotnet_naming_rule\./.test(key)) {
            covered.add('IDE1006');
          }

          if (key) {
            diagnosticIdsOfOption(props, key).split(/[/,]/).forEach((id) => covered.add(id.trim()));
          }
        }
      }

      expect([...editorConfigCatalog().diagnostics].filter((id) => !covered.has(id) && !(id in EXEMPT_DIAGNOSTICS)).sort()).toEqual([]);
    });

    it('names every scenario class after its option', () => {
      const names = (key: string): string => key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
      for (const scenario of scenarios.filter((candidate) => candidate.category === 'CodeStyle')) {
        expect(Object.keys(scenario.codeStyle).map(names), scenario.id).toContain(scenario.id);
      }
    });
  });

  describe('each cleanup, alone, on its own bad code', () => {
    it.each(scenarios.map((scenario) => [scenario.id, scenario] as const))('%s', (_id, scenario) => {
      const outcome = outcomes.get(scenario.id) as Outcome;
      const problems = scenario.checks.map((check) => failure(check, outcome.output, outcome.issues)).filter((problem): problem is string => problem !== undefined);

      if (scenario.knownDefect) {
        expect(problems.length, `${scenario.id} now works: remove its knownDefect (${scenario.knownDefect})`).toBeGreaterThan(0);

        return;
      }

      expect(problems, `${scenario.id}: the cleaned file is:\n${outcome.output}`).toEqual([]);
      if (scenario.reportOnly) {
        expect(outcome.output, 'an option that is only reported must not change the code').toBe(outcome.input);
      } else if (!scenario.trap) {
        expect(outcome.output, 'the bad code must change').not.toBe(outcome.input);
      }

      expect([...outcome.created.keys()].sort(), 'the files the command creates').toEqual([...(scenario.createdFiles ?? [])].sort());
      // Wrapping lines in a region is an action, not a normalization: doing it twice nests another region.
      if (scenario.entry !== 'insertRegion') {
        expect(outcome.again, 'cleaning the result again must change nothing').toBe(outcome.output);
      }
    });
  });

  describe('with its option turned off', () => {
    it.each(scenarios.filter((scenario) => scenario.entry === 'cleanup' && !scenario.everything && !scenario.editorconfig && !scenario.alwaysOn && !scenario.policy).map((scenario) => [scenario.id, scenario] as const))('%s leaves its code alone', (_id, scenario) => {
      const input = fs.readFileSync(path.join(root, scenario.file), 'utf8');
      const off: ScenarioEntry = { ...scenario, settings: {}, codeStyle: {} };

      expect(runCleanup(input, path.join(root, scenario.file), settingsOf(off), undefined, () => undefined)).toBe(input);
    });
  });

  describe('with every severity turned off', () => {
    it.each(scenarios.filter((scenario) => scenario.editorconfig && !scenario.alwaysOn && !scenario.reportOnly && scenario.entry === 'cleanup' && !scenario.policy && !scenario.fileDir).map((scenario) => [scenario.id, scenario] as const))('%s leaves its code alone', (_id, scenario) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-silent-'));
      folders.push(dir);
      fs.writeFileSync(path.join(dir, '.editorconfig'), `root = true\n\n[*.cs]\n${silenced(scenarioEditorConfig(root, scenario))}\n`);
      fs.writeFileSync(path.join(dir, 'Scenarios.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
      const file = path.join(dir, path.basename(scenario.file));
      const input = fs.readFileSync(path.join(root, scenario.file), 'utf8');
      fs.writeFileSync(file, input);

      expect(runCleanup(input, file, allOff(), undefined, () => undefined)).toBe(input);
    });
  });

  describe.skipIf(!dotnetAvailable)('against the compiler', () => {
    it('builds and prints the same values after every cleanup', () => {
      const copy = copyTestbed(root);
      folders.push(copy);
      const before = buildAndRun(copy);
      expect(before.errors, 'the unfixed testbed must build').toEqual([]);
      expect(before.lines.size).toBeGreaterThan(0);

      for (const { scenario, ...produced } of outcomes.values()) {
        write(copy, scenario, produced);
      }

      const after = buildAndRun(copy);
      expect(after.errors, 'a cleanup produced code that does not compile').toEqual([]);
      expect(differences(before, after), 'a cleanup changed what the code does').toEqual([]);
    }, 900_000);

    it('builds and prints the same values with every option on at once', () => {
      const copy = copyTestbed(root);
      folders.push(copy);
      const before = buildAndRun(copy);
      const everything = createDefaultSettings() as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(everything)) {
        if (typeof value === 'boolean') {
          everything[key] = !(key in NOT_A_TEXT_TRANSFORMATION);
        }
      }

      everything.codeStyleRules = Object.fromEntries(CODE_STYLE_RULES.map((rule) => [rule.key, rule.defaultValue]));
      everything.reorganize = { ...createDefaultReorganizeSettings(), runAtStartOfCleanup: true };
      for (const scenario of scenarios.filter((candidate) => candidate.entry === 'cleanup')) {
        const file = path.join(copy, scenario.file);
        fs.writeFileSync(file, runCleanup(fs.readFileSync(file, 'utf8'), file, everything as unknown as CleanupSettings));
      }

      const after = buildAndRun(copy);
      expect(after.errors, 'a cleanup produced code that does not compile').toEqual([]);
      expect(differences(before, after), 'a cleanup changed what the code does').toEqual([]);
    }, 900_000);
  });
});
