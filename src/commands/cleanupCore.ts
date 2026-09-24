import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadEditorConfigProperties } from '../cleanup/editorconfig';
import { EditorConfigIssueLog, ReportedConfigurations, editorConfigSignature } from '../cleanup/editorConfigIssueLog';
import { planOneTypePerFile, readOneTypePerFileRules } from '../cleanup/oneTypePerFile';
import { EditorConfigIssue, EditorConfigIssueListener, runCleanup, runLayoutCleanup } from '../cleanup/runCleanup';
import { discoverDisqualifiedTypeNames } from '../cleanup/transformations/sealedClass';
import { fixNamespace } from '../cleanup/transformations/namespaceAndNameOf';
import { removeXmlDocumentationConverter } from '../cleanup/transformations/removeXmlDocumentation';
import { commentFormatConverter, regionDirectiveRemover } from '../cleanup/transformations/text';
import { createTopLevelTypeSplitPlan } from '../cleanup/topLevelTypeSplit';
import { suggestNamespace } from './editorCommands';
import { logError, logInfo } from '../logging';
import { readCleanupSettings } from './settings';
import { changedLinesSince, runCleanupOnChangedLines } from '../cleanup/changedLines';
import { Baseline, readHeadVersion } from '../cleanup/gitBaseline';
import { CleanupSettings } from '../cleanup/types';
import { renameSymbolsAcrossWorkspace } from './workspaceRename';

export interface CollectedFile {
  uri: vscode.Uri;
  content: string;
  isOpen: boolean;
}

/** A new file of a split: its path and content. */
interface NewFile {
  readonly uri: vscode.Uri;
  readonly content: string;
}

/**
 * A cleaned file with the files its one-type-per-file split creates: written together or not at
 * all, as a type must never end up in two files (or in none).
 */
interface CleanupGroup {
  readonly file: CollectedFile;
  readonly output: string;
  readonly newFiles: readonly NewFile[];
  readonly error?: string;
}

/** A file a pre-cleanup step reshaped before cleanup: its new content and the files it split off. */
interface PreCleanupResult {
  readonly content: string;
  readonly createdFiles: readonly CollectedFile[];
}

type PreCleanup = (file: CollectedFile) => Promise<PreCleanupResult | undefined>;

interface BatchOutcome {
  changed: number;
  failed: number;
  created: number;
}

/**
 * Reads the given file URIs (preferring the live editor buffer when a file is already open, so
 * unsaved changes are cleaned too), runs the given transform in-process, and applies each changed
 * result back - through a WorkspaceEdit for open documents, or a direct file write otherwise.
 */
async function runBatch(
  targets: vscode.Uri[],
  transform: (content: string, uri: vscode.Uri, disqualifiedTypeNames: ReadonlySet<string>) => string,
  label: string,
  emptyMessage: string,
  discoverSealingSafety = false,
  preCleanup?: PreCleanup
): Promise<BatchOutcome> {
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(emptyMessage);

    return { changed: 0, failed: 0, created: 0 };
  }

  logInfo(`${label}: starting on ${targets.length} file(s).`);

  const collected = await collectFiles(targets);
  // Each file is transformed from `input` (the pre-cleanup's content); `file.content` is what is on
  // disk or in the editor now.
  const work: { file: CollectedFile; input: string; newFiles: readonly CollectedFile[]; failed?: string }[] = [];
  for (const file of collected) {
    try {
      const pre = await preCleanup?.(file);
      work.push({ file, input: pre?.content ?? file.content, newFiles: pre?.createdFiles ?? [] });
    } catch (err) {
      logError(`${label} of ${file.uri.fsPath}`, err);
      work.push({ file, input: file.content, newFiles: [], failed: (err as Error).message });
    }
  }

  const disqualifiedTypeNames = discoverSealingSafety
    ? await discoverBatchDisqualifiedTypeNames(work.flatMap(({ file, input, newFiles }) => [{ ...file, content: input }, ...newFiles]))
    : new Set<string>();

  // A split and its new files are transformed together: when one fails, none is written.
  const groups: CleanupGroup[] = work.map(({ file, input, newFiles, failed }) => {
    if (failed) {
      return { file, output: file.content, newFiles: [], error: failed };
    }

    try {
      return {
        file,
        output: transform(input, file.uri, disqualifiedTypeNames),
        newFiles: newFiles.map((newFile) => ({ uri: newFile.uri, content: transform(newFile.content, newFile.uri, disqualifiedTypeNames) })),
      };
    } catch (err) {
      logError(`${label} of ${file.uri.fsPath}`, err);

      return { file, output: file.content, newFiles: [], error: (err as Error).message };
    }
  });

  const outcome = await applyResults(groups, label);
  logInfo(
    `${label}: finished - ${outcome.changed} changed, ${outcome.failed} failed` +
      (outcome.created > 0 ? `, ${outcome.created} file(s) created by splitting types.` : '.')
  );

  return outcome;
}

export async function runCleanupOnUris(
  _context: vscode.ExtensionContext,
  uris: vscode.Uri[],
  options: {
    renameAcrossWorkspace?: boolean;
    /** Cleanup Changed Files: with `codeJanitor.cleanup.onlyChangedLines`, only the lines changed since HEAD are cleaned. */
    honorOnlyChangedLines?: boolean;
  } = {}
): Promise<{ changed: number; failed: number; unresolved: number; created: number }> {
  const targets = uris.filter(isSupportedFile);
  const settings = readCleanupSettings(targets[0] ? vscode.workspace.getWorkspaceFolder(targets[0])?.uri.fsPath : undefined);
  // A single file (Cleanup Active File) does not repeat the unsupported settings of its
  // `.editorconfig` once they were reported in the session; a batch lists them again.
  const issues = createEditorConfigIssueLog(targets.length === 1);
  const report = issues.report;
  // Files the split plans to create in this batch, so no two files of the batch create the same one.
  const plannedFiles = new Set<string>();
  // Batch commands only (never on save): renames other files may depend on, after a preview.
  const renameAcrossWorkspace = options.renameAcrossWorkspace === true && settings.renamePublicSymbolsAcrossWorkspace;
  // The violations only the workspace-wide rename can fix wait for it: it reports those it leaves.
  const deferred: EditorConfigIssue[] = [];
  const accounted = new Map<string, Set<string>>();
  const batchReport: EditorConfigIssueListener = (issue) => {
    if (renameAcrossWorkspace && issue.symbol) {
      deferred.push(issue);
    } else {
      report(issue);
    }
  };

  // Only the lines changed since HEAD: no type split, and other file types are left as they are.
  const onlyChangedLines = options.honorOnlyChangedLines === true && settings.onlyChangedLines;
  const baselines = new Map<string, Baseline>();

  let outcome: BatchOutcome = { changed: 0, failed: 0, created: 0 };
  let unresolved = 0;
  try {
    // A file whose last commit cannot be read fails alone (see cleanupChangedLines); the batch goes on.
    for (const uri of onlyChangedLines ? targets.filter(isCSharp) : []) {
      baselines.set(uri.fsPath, await readHeadVersion(uri.fsPath).catch((err: unknown): Baseline => ({ kind: 'unavailable', reason: String(err) })));
    }

    outcome = await runBatch(
      targets,
      (content, uri, disqualifiedTypeNames) =>
        !isCSharp(uri)
          ? onlyChangedLines
            ? content
            : runLayoutCleanup(content, uri.fsPath, settings)
          : onlyChangedLines
            ? cleanupChangedLines(
                content,
                uri.fsPath,
                settings,
                baselines.get(uri.fsPath) ?? { kind: 'unavailable', reason: 'its last commit was not read' },
                disqualifiedTypeNames,
                batchReport
              )
            : runCleanup(content, uri.fsPath, settings, disqualifiedTypeNames, batchReport),
      'Cleanup',
      'Code Janitor: no files to clean up.',
      true,
      onlyChangedLines ? undefined : (file) => splitTypesForEditorConfig(file, report, plannedFiles)
    );

    if (renameAcrossWorkspace) {
      try {
        await renameSymbolsAcrossWorkspace(targets, report, accounted);
      } catch (err) {
        outcome = { ...outcome, failed: outcome.failed + 1 };
        logError('Cleanup: workspace-wide rename', err);
        void vscode.window.showWarningMessage(`Code Janitor: workspace-wide rename - ${(err as Error).message}`);
      }
    }
  } finally {
    // Those the workspace-wide rename neither renamed nor reported (it failed, or skipped the file).
    deferred.filter((issue) => !(issue.symbol && accounted.get(issue.filePath)?.has(issue.symbol))).forEach(report);
    const finished = issues.finish();
    unresolved = finished.unresolved;
    if (unresolved > 0) {
      logInfo(`Cleanup: ${unresolved} .editorconfig rule violation(s) were not fixed.`);
    }

    if (finished.unsupported > 0) {
      logInfo(`Cleanup: ${finished.unsupported} .editorconfig setting(s) are not supported and were not applied (listed above with the number of files).`);
    }
  }

  return { ...outcome, unresolved };
}

/**
 * Cleanup of the lines of a C# file changed since its last commit (`baseline`): every line of a new
 * file; throws when the baseline is unavailable, as nothing tells which lines changed.
 */
export function cleanupChangedLines(
  content: string,
  filePath: string,
  settings: CleanupSettings,
  baseline: Baseline,
  disqualifiedTypeNames: ReadonlySet<string>,
  report: EditorConfigIssueListener
): string {
  if (baseline.kind === 'unavailable') {
    throw new Error(`only the lines changed since the last commit are cleaned (codeJanitor.cleanup.onlyChangedLines) and ${baseline.reason}`);
  }

  const changed = changedLinesSince(baseline.kind === 'tracked' ? baseline.text : undefined, content);
  const { output, skippedSettings } = runCleanupOnChangedLines(content, filePath, settings, changed, disqualifiedTypeNames, report);
  for (const setting of skippedSettings) {
    logInfo(`Cleanup of changed lines: '${setting}' was not applied to ${filePath}, its changes span lines not changed since the last commit.`);
  }

  return output;
}

/**
 * The one-type-per-file pre-cleanup step (`SA1402`/`MA0048`/`SA1649` enforced in `.editorconfig`):
 * the file's content without the types moved out, and the new files holding them, which are
 * cleaned and written with the file itself, all or nothing. Violations it cannot fix go to `onIssue`. `undefined`
 * when the file is not C# or nothing is split. `plannedFiles` holds the paths of the files other
 * files of the same batch will create: they are reserved like existing files, and the files this
 * split creates are added.
 */
async function splitTypesForEditorConfig(
  file: CollectedFile,
  onIssue: EditorConfigIssueListener,
  plannedFiles: Set<string> = new Set()
): Promise<PreCleanupResult | undefined> {
  if (!isCSharp(file.uri)) {
    return undefined;
  }

  const rules = readOneTypePerFileRules(loadEditorConfigProperties(file.uri.fsPath));
  if (!rules) {
    return undefined;
  }

  const outcome = planOneTypePerFile(file.content, file.uri.fsPath, rules, await reservedFileNames(file.uri, plannedFiles));
  for (const message of outcome.issues) {
    onIssue({ kind: 'unresolved', filePath: file.uri.fsPath, detail: message });
  }

  if (!outcome.plan.hasChanges) {
    return undefined;
  }

  logInfo(`One type per file (.editorconfig): ${file.uri.fsPath} split into ${outcome.plan.newFiles.length} new file(s).`);
  outcome.plan.newFiles.forEach((planned) => plannedFiles.add(planned.filePath));

  return {
    content: outcome.plan.updatedSource,
    createdFiles: outcome.plan.newFiles.map((planned) => ({
      uri: vscode.Uri.file(planned.filePath),
      content: planned.content,
      isOpen: false,
    })),
  };
}

/**
 * Cleanup on save reports the types one type per file would move instead of moving them: VS Code
 * can drop the edits of a save (a slow or failing save participant), which would leave the types
 * both in the saved file and in the new files.
 */
export async function reportOneTypePerFileOnSave(file: CollectedFile, onIssue: EditorConfigIssueListener): Promise<void> {
  if (!isCSharp(file.uri)) {
    return;
  }

  const rules = readOneTypePerFileRules(loadEditorConfigProperties(file.uri.fsPath));
  if (!rules) {
    return;
  }

  const outcome = planOneTypePerFile(file.content, file.uri.fsPath, rules, await reservedFileNames(file.uri, new Set()), false);
  for (const message of outcome.issues) {
    onIssue({ kind: 'unresolved', filePath: file.uri.fsPath, detail: message });
  }
}

/** Unsupported settings reported in this session, by resolved `.editorconfig`. */
const sessionConfigurations: ReportedConfigurations = {
  seen: new Set<string>(),
  signatureOf: (filePath) => editorConfigSignature(loadEditorConfigProperties(filePath)),
};

/**
 * The `.editorconfig` issue log of one cleanup run (see {@link EditorConfigIssueLog}); `perSession`
 * for runs on a single file, which skip unsupported settings already reported in the session.
 */
export function createEditorConfigIssueLog(perSession: boolean): EditorConfigIssueLog {
  return new EditorConfigIssueLog(logInfo, perSession ? sessionConfigurations : undefined);
}

/** Removes XML documentation comments from every given C# file - never uses AI. */
export async function runRemoveXmlDocOnUris(uris: vscode.Uri[]): Promise<{ changed: number; failed: number }> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));

  return runBatch(
    targets,
    (content) => removeXmlDocumentationConverter.apply(content),
    'Remove XML Documentation',
    'Code Janitor: no C# files to remove XML documentation from.'
  );
}

/** Removes `#region`/`#endregion` directives from every given C# file, regardless of cleanup settings. */
export async function runRemoveRegionsOnUris(uris: vscode.Uri[]): Promise<{ changed: number; failed: number }> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));

  return runBatch(
    targets,
    (content) => regionDirectiveRemover.apply(content),
    'Remove Regions',
    'Code Janitor: no C# files to remove regions from.'
  );
}

/** Normalizes comment formatting in every given C# file, regardless of cleanup settings. */
export async function runFormatCommentsOnUris(uris: vscode.Uri[]): Promise<{ changed: number; failed: number }> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));

  return runBatch(
    targets,
    (content) => commentFormatConverter.apply(content),
    'Format Comments',
    'Code Janitor: no C# files to format comments in.'
  );
}

/** Auto-computes each file's expected namespace from its folder path - a batch run can't prompt per file. */
export async function runFixNamespaceOnUris(uris: vscode.Uri[]): Promise<{ changed: number; failed: number }> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));

  return runBatch(
    targets,
    (content, uri) => {
      const expected = suggestNamespace(uri);

      return expected ? fixNamespace(content, expected) : content;
    },
    'Fix Namespace',
    'Code Janitor: no C# files to fix the namespace of.'
  );
}

/**
 * Splits every given C# file that declares more than one eligible top-level type into one file
 * per type, applying the cleanup pipeline to both the updated original and each created file. This
 * explicit command splits whatever the `.editorconfig` says; the cleanup commands only split when
 * the `.editorconfig` enforces one type per file ({@link splitTypesForEditorConfig}), and cleanup on
 * save never splits ({@link reportOneTypePerFileOnSave}). A file and its new files are written
 * together or not at all.
 */
export async function runSplitTopLevelTypesOnUris(uris: vscode.Uri[]): Promise<{ changed: number; failed: number }> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));

  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Code Janitor: no C# files to split.');

    return { changed: 0, failed: 0 };
  }

  logInfo(`Split Top-Level Types: starting on ${targets.length} file(s).`);

  const collected = await collectFiles(targets);
  const settings = readCleanupSettings(vscode.workspace.getWorkspaceFolder(targets[0])?.uri.fsPath);
  const disqualifiedTypeNames = await discoverBatchDisqualifiedTypeNames(collected);

  let changedOriginals = 0;
  let createdFiles = 0;
  let failed = 0;
  const issues = createEditorConfigIssueLog(collected.length === 1);

  for (const file of collected) {
    try {
      const reserved = await siblingCSharpFileNames(file.uri);
      const plan = createTopLevelTypeSplitPlan(file.content, file.uri.fsPath, reserved);

      if (!plan.hasChanges) {
        continue;
      }

      const newFiles = plan.newFiles.map((newFile) => ({
        uri: vscode.Uri.file(newFile.filePath),
        content: runCleanup(newFile.content, newFile.filePath, settings, disqualifiedTypeNames, issues.report),
      }));
      await writeFileGroup(file, runCleanup(plan.updatedSource, file.uri.fsPath, settings, disqualifiedTypeNames, issues.report), newFiles);
      createdFiles += newFiles.length;
      changedOriginals++;
    } catch (err) {
      failed++;
      logError(`Split Top-Level Types of ${file.uri.fsPath}`, err);
      void vscode.window.showWarningMessage(`Code Janitor: ${file.uri.fsPath} - ${(err as Error).message}`);
    }
  }

  issues.finish();
  logInfo(
    `Split Top-Level Types: finished - ${changedOriginals} file(s) updated, ${createdFiles} file(s) created, ${failed} failed.`
  );

  return { changed: changedOriginals + createdFiles, failed };
}

/**
 * The `.cs` file names a split of `uri` must not use: the files of its directory, and the files of
 * that directory `plannedFiles` (other files of the same batch) will create.
 */
async function reservedFileNames(uri: vscode.Uri, plannedFiles: ReadonlySet<string>): Promise<Set<string>> {
  const reserved = await siblingCSharpFileNames(uri);
  for (const planned of plannedFiles) {
    if (path.dirname(planned) === path.dirname(uri.fsPath)) {
      reserved.add(path.basename(planned));
    }
  }

  return reserved;
}

/** Existing `.cs` file names in the same directory, used to avoid overwriting a file when planning new names. */
export async function siblingCSharpFileNames(uri: vscode.Uri): Promise<Set<string>> {
  const directory = vscode.Uri.file(path.dirname(uri.fsPath));

  try {
    const entries = await vscode.workspace.fs.readDirectory(directory);

    return new Set(entries.filter(([name]) => name.toLowerCase().endsWith('.cs')).map(([name]) => name));
  } catch {
    return new Set();
  }
}

/**
 * Cross-file safety net for sealing a single file: reads every other same-directory `.cs` file
 * not already in `alreadyCovered` (best effort - an unreadable or unparsable sibling is skipped,
 * matching {@link collectFiles}'s tolerance) and unions the type names they and `ownContent`
 * disqualify from sealing, so a file cleaned on its own still knows about a subclass or generic
 * constraint declared right next to it.
 */
export async function discoverDisqualifiedTypeNamesForFile(
  uri: vscode.Uri,
  ownContent: string,
  alreadyCovered: ReadonlySet<string> = new Set()
): Promise<Set<string>> {
  const directory = vscode.Uri.file(path.dirname(uri.fsPath));

  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    // No sibling directory to read (e.g. an untitled document) - fall back to just ownContent.
  }

  const siblingSources: string[] = [];
  for (const [name, type] of entries) {
    if ((type & vscode.FileType.File) === 0 || !name.toLowerCase().endsWith('.cs')) {
      continue;
    }

    const siblingUri = vscode.Uri.file(path.join(directory.fsPath, name));
    if (siblingUri.toString() === uri.toString() || alreadyCovered.has(siblingUri.toString())) {
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(siblingUri);
      siblingSources.push(Buffer.from(bytes).toString('utf8'));
    } catch {
      // Unreadable sibling (e.g. deleted concurrently) - skip it.
    }
  }

  return discoverDisqualifiedTypeNames([ownContent, ...siblingSources]);
}

/**
 * Unions {@link discoverDisqualifiedTypeNamesForFile} across an entire batch, so cleaning several
 * files together also sees a subclass or generic constraint that lives in one batch file but
 * targets a type declared in another.
 */
async function discoverBatchDisqualifiedTypeNames(collected: readonly CollectedFile[]): Promise<Set<string>> {
  const batchUris = new Set(collected.map((file) => file.uri.toString()));
  const perFile = await Promise.all(
    collected.map((file) => discoverDisqualifiedTypeNamesForFile(file.uri, file.content, batchUris))
  );

  const names = new Set<string>();
  for (const fileNames of perFile) {
    for (const name of fileNames) {
      names.add(name);
    }
  }

  return names;
}

/**
 * A file counts as C# either by extension or, for a document that is already open, by its
 * language mode - so a brand-new, unsaved C# file (`untitled:Untitled-1`, no `.cs` extension yet)
 * is still cleaned rather than silently skipped.
 */
export function isCSharp(uri: vscode.Uri): boolean {
  if (uri.fsPath.toLowerCase().endsWith('.cs')) {
    return true;
  }

  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());

  return open?.languageId === 'csharp';
}

/** Other languages are only cleaned when the user opts in, and then only with the layout rules. */
export function isSupportedFile(uri: vscode.Uri): boolean {
  if (!isPathCleanable(uri)) {
    return false;
  }

  if (isCSharp(uri)) {
    return true;
  }

  return vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.includeOtherFileTypes', false);
}

/**
 * Applies the configured path filters, mirroring the source extension: a file matching any
 * exclusion is never cleaned, and when inclusions are configured a file must match one of them.
 */
export function isPathCleanable(uri: vscode.Uri): boolean {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const path = uri.fsPath;

  if (matchesAny(config.get<string[]>('cleanup.exclude', []), path)) {
    return false;
  }

  const include = config.get<string[]>('cleanup.include', []);

  return include.length === 0 || matchesAny(include, path);
}

function matchesAny(patterns: readonly string[] | undefined, value: string): boolean {
  return (patterns ?? []).some((pattern) => {
    try {
      return pattern.trim().length > 0 && new RegExp(pattern, 'i').test(value);
    } catch {
      // An invalid expression must never fail the cleanup; it simply matches nothing.
      return false;
    }
  });
}

export async function collectFiles(uris: vscode.Uri[]): Promise<CollectedFile[]> {
  const collected: CollectedFile[] = [];

  for (const uri of uris) {
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (openDoc) {
      collected.push({ uri, content: openDoc.getText(), isOpen: true });
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      collected.push({ uri, content: Buffer.from(bytes).toString('utf8'), isOpen: false });
    } catch {
      // Unreadable file (e.g. deleted between enumeration and read) - skip it.
    }
  }

  return collected;
}

async function applyResults(groups: readonly CleanupGroup[], label: string): Promise<BatchOutcome> {
  let changed = 0;
  let failed = 0;
  let created = 0;

  for (const group of groups) {
    let error = group.error;
    if (!error) {
      try {
        await writeFileGroup(group.file, group.output, group.newFiles);
      } catch (err) {
        logError(`${label} of ${group.file.uri.fsPath}`, err);
        error = (err as Error).message;
      }
    }

    if (error) {
      failed++;
      void vscode.window.showWarningMessage(`Code Janitor: ${group.file.uri.fsPath} - ${error}`);
      continue;
    }

    if (group.output !== group.file.content) {
      changed++;
    }

    created += group.newFiles.length;
  }

  return { changed, failed, created };
}

/**
 * Writes a file's new content with the new files of its split, all or nothing: the new files
 * first, then the file itself; when a write fails, the new files already written are deleted, so
 * no type is left in two files. Throws the failure.
 */
async function writeFileGroup(file: CollectedFile, output: string, newFiles: readonly NewFile[]): Promise<void> {
  const written: vscode.Uri[] = [];
  try {
    for (const newFile of newFiles) {
      await vscode.workspace.fs.writeFile(newFile.uri, Buffer.from(newFile.content, 'utf8'));
      written.push(newFile.uri);
    }

    if (output !== file.content) {
      await writeFileContent(file, output);
    }
  } catch (err) {
    const leftOver: string[] = [];
    for (const uri of written) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch (deleteError) {
        logError(`Removing ${uri.fsPath} after a failed split`, deleteError);
        leftOver.push(uri.fsPath);
      }
    }

    const message = (err as Error).message;
    throw new Error(
      leftOver.length > 0
        ? `${message}; these new files repeat types of the file and could not be removed: ${leftOver.join(', ')}`
        : `${message}; the file was not changed${written.length > 0 ? ' and its new files were removed' : ''}`
    );
  }
}

/**
 * Writes one file's new content back - a `WorkspaceEdit` for an open document, a disk write
 * otherwise. Throws when VS Code does not apply the edit or the document was closed meanwhile.
 */
export async function writeFileContent(file: CollectedFile, output: string): Promise<void> {
  if (!file.isOpen) {
    await vscode.workspace.fs.writeFile(file.uri, Buffer.from(output, 'utf8'));

    return;
  }

  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
  if (!doc) {
    throw new Error('the document was closed during cleanup');
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(file.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), output);
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('VS Code did not apply the edit');
  }
}

export async function expandToCleanableFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    return [uri];
  }

  const pattern = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.includeOtherFileTypes', false)
    ? '**/*'
    : '**/*.cs';

  return vscode.workspace.findFiles(new vscode.RelativePattern(uri, pattern), '**/{bin,obj,node_modules,.git}/**');
}

/** Unlike {@link expandToCleanableFiles}, always only `.cs` - XML documentation is a C# concept. */
export async function expandToCSharpFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    return [uri];
  }

  return vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.cs'), '**/{bin,obj,node_modules,.git}/**');
}
