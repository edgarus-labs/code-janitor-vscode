// Compile oracle: checks that cleanup never turns compiling C# into code the compiler rejects.
// For each project: copy it to a temporary folder with the generated .editorconfig (every rule
// cleanup applies set to warning), build it, run cleanup over its .cs files (one type per file
// included), build again and fail on every new compiler error (CSxxxx, RZxxxx), and on a build that
// fails after cleanup without one. When there are new errors, the rule responsible is found by
// running cleanup again with one rule at a time.
//
// Development-time only: the extension never runs .NET. Needs the .NET SDK on PATH.
//
// Usage: npm run verify:compile -- [<folder>[=<project file relative to the folder>] ...]
//   ORACLE_KEEP=1 keeps the cleaned copy for inspection.
//   Without arguments, checks every project of test/oracle. The folder is copied whole (for its
//   Directory.Build.props); cleanup only touches the .cs files under the project's directory.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEditorConfigProperties } from '../src/cleanup/editorconfig';
import { planOneTypePerFile, readOneTypePerFileRules } from '../src/cleanup/oneTypePerFile';
import { runCleanup } from '../src/cleanup/runCleanup';
import { discoverDisqualifiedTypeNames } from '../src/cleanup/transformations/sealedClass';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';
import { editorConfigCatalog } from '../src/cleanup/editorConfigRegistry';
import { CODE_STYLE_RULES } from '../src/cleanup/codeStyleRules';
import { BuildResult, CompilerError, cleanupBuildErrors, compilerErrors, editorConfigVariant, settingsVariant } from './compileOracle';
import { renderEditorConfig } from './editorConfigTemplate';
import { planWorkspaceRenames } from '../src/cleanup/naming/workspaceRenamer';
import { discoverProjects } from '../src/cleanup/naming/workspaceScope';

const SKIPPED_FOLDERS = new Set(['bin', 'obj', '.git', '.vs', 'node_modules']);
const BUILD_ARGUMENTS = [
  '-nologo',
  '-v:q',
  '-clp:NoSummary',
  // Only compiler errors matter: analyzers would report the rules themselves.
  '-p:RunAnalyzers=false',
  '-p:EnforceCodeStyleInBuild=false',
  '-p:TreatWarningsAsErrors=false',
  '-p:WarningsAsErrors=',
];

interface Target {
  readonly folder: string;
  readonly project: string;
}

interface CleanupOutcome {
  /** Files cleanup changed or created, relative to the copy. */
  readonly changed: string[];
  readonly unresolved: number;
}

function csharpFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name) ? [] : csharpFiles(full);
    }

    return entry.name.endsWith('.cs') ? [full] : [];
  });
}

function removeNestedEditorConfigs(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) {
      removeNestedEditorConfigs(full);
    } else if (entry.name === '.editorconfig') {
      fs.rmSync(full);
    }
  }
}

function build(copy: string, project: string, restore: boolean): BuildResult {
  const args = ['build', path.join(copy, project), ...BUILD_ARGUMENTS, ...(restore ? [] : ['--no-restore'])];
  // The .NET host sometimes dies with an internal CLR error before it compiles anything; that says nothing about the code.
  let output = '';
  let status: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync('dotnet', args, { cwd: copy, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.error) {
      throw new Error(`dotnet could not be started: ${result.error.message}`);
    }

    output = `${result.stdout}\n${result.stderr}`;
    status = result.status;
    if (!/Internal CLR error/.test(output)) {
      break;
    }
  }

  return { output, errors: compilerErrors(output, copy), ok: status === 0 };
}

/** Runs cleanup like the batch command: one type per file first, then the pipeline on every file. */
function cleanUp(copy: string, projectDir: string, settings: CleanupSettings): CleanupOutcome {
  const files = csharpFiles(projectDir);
  const work: { file: string; input: string; original?: string }[] = [];
  // Like the batch command, files one file of the batch creates are reserved for the others.
  const planned = new Set<string>();
  let unresolved = 0;
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const rules = readOneTypePerFileRules(loadEditorConfigProperties(file));
    const reserved = new Set(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.cs')));
    [...planned].filter((created) => path.dirname(created) === path.dirname(file)).forEach((created) => reserved.add(path.basename(created)));
    const outcome = rules ? planOneTypePerFile(original, file, rules, reserved) : undefined;
    unresolved += outcome?.issues.length ?? 0;
    outcome?.plan.newFiles.forEach((created) => planned.add(created.filePath));
    if (outcome?.plan.hasChanges) {
      work.push({ file, input: outcome.plan.updatedSource, original });
      work.push(...outcome.plan.newFiles.map((created) => ({ file: created.filePath, input: created.content })));
    } else {
      work.push({ file, input: original, original });
    }
  }

  const disqualified = discoverDisqualifiedTypeNames(work.map((item) => item.input));
  const changed: string[] = [];
  for (const item of work) {
    const output = runCleanup(item.input, item.file, settings, disqualified, (issue) => {
      if (issue.kind === 'unresolved') {
        unresolved++;
      }
    });
    if (output !== item.original) {
      fs.writeFileSync(item.file, output, 'utf8');
      changed.push(path.relative(copy, item.file));
    }
  }

  // Like Cleanup Workspace with renamePublicSymbolsAcrossWorkspace, confirming the renames.
  if (settings.renamePublicSymbolsAcrossWorkspace) {
    const plan = planWorkspaceRenames({
      projects: discoverProjects([copy]),
      targets: csharpFiles(projectDir),
      read: (file) => {
        const bytes = fs.readFileSync(file);
        try {
          return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), utf8: true };
        } catch {
          return { text: new TextDecoder('utf-8').decode(bytes), utf8: false };
        }
      },
    });
    unresolved += plan.issues.length;
    for (const [file, content] of plan.contents) {
      fs.writeFileSync(file, content, 'utf8');
      if (!changed.includes(path.relative(copy, file))) {
        changed.push(path.relative(copy, file));
      }
    }
  }

  return { changed, unresolved };
}

/** Puts the copied tree back as it was before cleanup: original contents, created files removed. */
function restore(projectDir: string, originals: ReadonlyMap<string, string>): void {
  for (const file of csharpFiles(projectDir)) {
    const original = originals.get(file);
    if (original === undefined) {
      fs.rmSync(file);
    } else if (fs.readFileSync(file, 'utf8') !== original) {
      fs.writeFileSync(file, original, 'utf8');
    }
  }
}

function describe(errors: readonly CompilerError[], limit = 5): string {
  return errors
    .slice(0, limit)
    .map((error) => `      ${error.file}(${error.line}): ${error.code} ${error.message}`)
    .join('\n');
}

/** The rules cleanup applies, each checked on its own: diagnostics of the registry, then each setting. */
function candidates(settings: CleanupSettings): { label: string; editorConfig: string | undefined; setting: keyof CleanupSettings | undefined }[] {
  const diagnostics = [...editorConfigCatalog().diagnostics].sort();
  const booleanSettings = (Object.keys(settings) as (keyof CleanupSettings)[]).filter((key) => settings[key] === true);

  return [
    // IDE1006 also renames across the workspace, as with the setting on.
    ...diagnostics.map((id) => ({
      label: id,
      editorConfig: id,
      setting: id === 'IDE1006' ? ('renamePublicSymbolsAcrossWorkspace' as const) : undefined,
    })),
    ...booleanSettings.map((key) => ({ label: `setting ${key}`, editorConfig: undefined, setting: key })),
  ];
}

function checkTarget(target: Target, editorConfig: string): number {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-compile-oracle-'));
  try {
    fs.cpSync(target.folder, copy, { recursive: true, filter: (source) => !SKIPPED_FOLDERS.has(path.basename(source)) });
    removeNestedEditorConfigs(copy);
    const editorConfigPath = path.join(copy, '.editorconfig');
    fs.writeFileSync(editorConfigPath, editorConfig, 'utf8');
    const projectDir = path.dirname(path.join(copy, target.project));
    const originals = new Map(csharpFiles(projectDir).map((file) => [file, fs.readFileSync(file, 'utf8')]));

    console.log(`\n=== ${target.folder} (${target.project}, ${originals.size} C# files)`);
    const baseline = build(copy, target.project, true);
    if (!baseline.ok && baseline.errors.length === 0) {
      console.log(`  NOT BUILDABLE before cleanup (no compiler errors, the build itself failed):\n${baseline.output.trim().split('\n').slice(-8).join('\n')}`);

      return 1;
    }

    console.log(`  before cleanup: ${baseline.errors.length} compiler error(s)`);
    const settings = { ...createDefaultSettings(), renamePublicSymbolsAcrossWorkspace: true };
    const outcome = cleanUp(copy, projectDir, settings);
    const after = build(copy, target.project, false);
    const added = cleanupBuildErrors(baseline, after);
    console.log(`  cleanup changed ${outcome.changed.length} file(s), ${outcome.unresolved} violation(s) left unresolved`);
    console.log(`  after cleanup: ${after.errors.length} compiler error(s), ${added.length} new`);
    if (added.length === 0) {
      return 0;
    }

    console.log(describe(added, 20));
    console.log('  finding the rules responsible (one rule at a time):');
    let blamed = 0;
    for (const candidate of candidates(settings)) {
      restore(projectDir, originals);
      fs.writeFileSync(editorConfigPath, editorConfigVariant(editorConfig, candidate.editorConfig), 'utf8');
      const run = cleanUp(copy, projectDir, settingsVariant(settings, candidate.setting));
      if (run.changed.length === 0) {
        continue;
      }

      const errors = cleanupBuildErrors(baseline, build(copy, target.project, false));
      if (errors.length > 0) {
        blamed++;
        console.log(`    ${candidate.label}: ${errors.length} new error(s)\n${describe(errors)}`);
      }
    }

    if (blamed === 0) {
      console.log('    no single rule breaks the build: the errors come from rules combined.');
    }

    return added.length;
  } finally {
    keepOrRemove(copy);
  }
}

/** `ORACLE_KEEP=1` keeps the cleaned copy for inspection. */
function keepOrRemove(copy: string): void {
  if (process.env.ORACLE_KEEP) {
    console.log(`  kept the cleaned copy: ${copy}`);
  } else {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * The Code Style rules opt-in layer: the same project cleaned with no `.editorconfig` rule and every rule of
 * the layer enabled with the value it proposes (as the `codeJanitor.cleanup.codeStyleRules` setting or
 * `.codejanitor` would), so the rules `.editorconfig` would enforce in the pass above are applied by the layer.
 */
function checkCodeStyleLayer(target: Target): number {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-compile-oracle-'));
  try {
    fs.cpSync(target.folder, copy, { recursive: true, filter: (source) => !SKIPPED_FOLDERS.has(path.basename(source)) });
    removeNestedEditorConfigs(copy);
    fs.writeFileSync(path.join(copy, '.editorconfig'), 'root = true\n\n[*.cs]\n', 'utf8');
    const projectDir = path.dirname(path.join(copy, target.project));

    console.log(`\n=== ${target.folder} (${target.project}): Code Style rules opt-in layer`);
    const baseline = build(copy, target.project, true);
    if (!baseline.ok && baseline.errors.length === 0) {
      console.log('  NOT BUILDABLE before cleanup (no compiler errors, the build itself failed)');

      return 1;
    }

    const settings = { ...createDefaultSettings(), codeStyleRules: Object.fromEntries(CODE_STYLE_RULES.map((rule) => [rule.key, rule.defaultValue])) };
    const outcome = cleanUp(copy, projectDir, settings);
    const after = build(copy, target.project, false);
    const added = cleanupBuildErrors(baseline, after);
    console.log(`  cleanup changed ${outcome.changed.length} file(s), ${outcome.unresolved} violation(s) left unresolved`);
    console.log(`  after cleanup: ${after.errors.length} compiler error(s), ${added.length} new`);
    if (added.length > 0) {
      console.log(describe(added, 20));
    }

    return added.length;
  } finally {
    keepOrRemove(copy);
  }
}

function targets(args: readonly string[]): Target[] {
  if (args.length > 0) {
    return args.map((arg) => {
      const [folder, project] = arg.split('=');
      const found = project ?? fs.readdirSync(folder).find((name) => name.endsWith('.csproj'));
      if (!found) {
        throw new Error(`${folder}: no project file; pass <folder>=<project file>.`);
      }

      return { folder: path.resolve(folder), project: found };
    });
  }

  const oracle = path.join(__dirname, '..', 'test', 'oracle');

  return fs
    .readdirSync(oracle, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => targets([path.join(oracle, entry.name)])[0]);
}

const editorConfig = renderEditorConfig();
let failures = 0;
for (const target of targets(process.argv.slice(2))) {
  failures += checkTarget(target, editorConfig);
  failures += checkCodeStyleLayer(target);
}

console.log(failures === 0 ? '\nCompile oracle: no new compiler errors.' : `\nCompile oracle: ${failures} new compiler error(s) or failed build(s).`);
process.exitCode = failures === 0 ? 0 : 1;
