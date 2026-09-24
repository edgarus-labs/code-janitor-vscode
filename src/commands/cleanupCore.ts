import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadEditorConfigProperties } from '../cleanup/editorconfig';
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

export interface CollectedFile {
  uri: vscode.Uri;
  content: string;
  isOpen: boolean;
}

interface CleanupResult {
  uri: vscode.Uri;
  output: string;
  changed: boolean;
  isOpen: boolean;
  /** A file the one-type-per-file split created: always written, counted as created. */
  created?: boolean;
  error?: string;
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
  // Each entry is transformed from `input`; `original` is what is on disk or in the editor now.
  const work: { file: CollectedFile; input: string; created: boolean; failed?: string }[] = [];
  for (const file of collected) {
    try {
      const pre = await preCleanup?.(file);
      work.push({ file, input: pre?.content ?? file.content, created: false });
      for (const createdFile of pre?.createdFiles ?? []) {
        work.push({ file: createdFile, input: createdFile.content, created: true });
      }
    } catch (err) {
      logError(`${label} of ${file.uri.fsPath}`, err);
      work.push({ file, input: file.content, created: false, failed: (err as Error).message });
    }
  }

  const disqualifiedTypeNames = discoverSealingSafety
    ? await discoverBatchDisqualifiedTypeNames(work.map(({ file, input }) => ({ ...file, content: input })))
    : new Set<string>();

  const results: CleanupResult[] = work.map(({ file, input, created, failed }) => {
    if (failed) {
      return { uri: file.uri, output: file.content, changed: false, isOpen: file.isOpen, error: failed };
    }

    try {
      const output = transform(input, file.uri, disqualifiedTypeNames);

      return { uri: file.uri, output, changed: created || output !== file.content, isOpen: file.isOpen, created };
    } catch (err) {
      logError(`${label} of ${file.uri.fsPath}`, err);

      return { uri: file.uri, output: file.content, changed: false, isOpen: file.isOpen, error: (err as Error).message };
    }
  });

  const outcome = await applyResults(results);
  logInfo(
    `${label}: finished - ${outcome.changed} changed, ${outcome.failed} failed` +
      (outcome.created > 0 ? `, ${outcome.created} file(s) created by splitting types.` : '.')
  );

  return outcome;
}

export async function runCleanupOnUris(
  _context: vscode.ExtensionContext,
  uris: vscode.Uri[]
): Promise<{ changed: number; failed: number; unresolved: number; created: number }> {
  const targets = uris.filter(isSupportedFile);
  const settings = readCleanupSettings(targets[0] ? vscode.workspace.getWorkspaceFolder(targets[0])?.uri.fsPath : undefined);
  let unresolved = 0;
  let unsupported = 0;
  const report = (issue: EditorConfigIssue): void => {
    if (issue.kind === 'unresolved') {
      unresolved++;
    } else {
      unsupported++;
    }

    logEditorConfigIssue(issue);
  };

  const outcome = await runBatch(
    targets,
    (content, uri, disqualifiedTypeNames) =>
      isCSharp(uri)
        ? runCleanup(content, uri.fsPath, settings, disqualifiedTypeNames, report)
        : runLayoutCleanup(content, uri.fsPath, settings),
    'Cleanup',
    'Code Janitor: no files to clean up.',
    true,
    (file) => splitTypesForEditorConfig(file, report)
  );

  if (unresolved > 0) {
    logInfo(`Cleanup: ${unresolved} .editorconfig rule violation(s) were not fixed.`);
  }

  if (unsupported > 0) {
    logInfo(`Cleanup: ${unsupported} .editorconfig setting(s) are not supported and were not applied.`);
  }

  return { ...outcome, unresolved };
}

/**
 * The one-type-per-file pre-cleanup step (`SA1402`/`MA0048`/`SA1649` enforced in `.editorconfig`):
 * the file's content without the types moved out, and the new files holding them, which are
 * cleaned and written like the file itself. Violations it cannot fix go to `onIssue`. `undefined`
 * when the file is not C# or nothing is split.
 */
export async function splitTypesForEditorConfig(
  file: CollectedFile,
  onIssue: EditorConfigIssueListener
): Promise<PreCleanupResult | undefined> {
  if (!isCSharp(file.uri)) {
    return undefined;
  }

  const rules = readOneTypePerFileRules(loadEditorConfigProperties(file.uri.fsPath));
  if (!rules) {
    return undefined;
  }

  const outcome = planOneTypePerFile(file.content, file.uri.fsPath, rules, await siblingCSharpFileNames(file.uri));
  for (const message of outcome.issues) {
    onIssue({ kind: 'unresolved', message: `${file.uri.fsPath}: ${message}` });
  }

  if (!outcome.plan.hasChanges) {
    return undefined;
  }

  logInfo(`One type per file (.editorconfig): ${file.uri.fsPath} split into ${outcome.plan.newFiles.length} new file(s).`);

  return {
    content: outcome.plan.updatedSource,
    createdFiles: outcome.plan.newFiles.map((planned) => ({
      uri: vscode.Uri.file(planned.filePath),
      content: planned.content,
      isOpen: false,
    })),
  };
}

/** Logs a `.editorconfig` rule violation cleanup could not fix safely, or a setting it does not support. */
export function logEditorConfigIssue(issue: EditorConfigIssue): void {
  logInfo(`${issue.kind === 'unresolved' ? '.editorconfig rule not fixed' : '.editorconfig setting not supported'}: ${issue.message}`);
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
 * explicit command splits whatever the `.editorconfig` says; ordinary cleanup (including on save)
 * only splits when the `.editorconfig` enforces one type per file ({@link splitTypesForEditorConfig}).
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

  for (const file of collected) {
    try {
      const reserved = await siblingCSharpFileNames(file.uri);
      const plan = createTopLevelTypeSplitPlan(file.content, file.uri.fsPath, reserved);

      if (!plan.hasChanges) {
        continue;
      }

      for (const newFile of plan.newFiles) {
        const cleaned = runCleanup(newFile.content, newFile.filePath, settings, disqualifiedTypeNames, logEditorConfigIssue);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(newFile.filePath), Buffer.from(cleaned, 'utf8'));
        createdFiles++;
      }

      await writeFileContent(
        file,
        runCleanup(plan.updatedSource, file.uri.fsPath, settings, disqualifiedTypeNames, logEditorConfigIssue)
      );
      changedOriginals++;
    } catch (err) {
      failed++;
      logError(`Split Top-Level Types of ${file.uri.fsPath}`, err);
      void vscode.window.showWarningMessage(`Code Janitor: ${file.uri.fsPath} - ${(err as Error).message}`);
    }
  }

  logInfo(
    `Split Top-Level Types: finished - ${changedOriginals} file(s) updated, ${createdFiles} file(s) created, ${failed} failed.`
  );

  return { changed: changedOriginals + createdFiles, failed };
}

/** Existing `.cs` file names in the same directory, used to avoid overwriting a file when planning new names. */
async function siblingCSharpFileNames(uri: vscode.Uri): Promise<Set<string>> {
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

async function applyResults(results: readonly CleanupResult[]): Promise<BatchOutcome> {
  const edit = new vscode.WorkspaceEdit();
  let changed = 0;
  let failed = 0;
  let created = 0;

  for (const result of results) {
    if (result.error) {
      failed++;
      void vscode.window.showWarningMessage(`Code Janitor: ${result.uri.fsPath} - ${result.error}`);
      continue;
    }

    if (!result.changed) {
      continue;
    }

    if (result.created) {
      created++;
    } else {
      changed++;
    }

    if (result.isOpen) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === result.uri.toString());
      if (doc) {
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(result.uri, fullRange, result.output);
      }
    } else {
      await vscode.workspace.fs.writeFile(result.uri, Buffer.from(result.output, 'utf8'));
    }
  }

  if (edit.size > 0) {
    await vscode.workspace.applyEdit(edit);
  }

  return { changed, failed, created };
}

/** Writes one file's new content back - a `WorkspaceEdit` for an open document, a disk write otherwise. */
export async function writeFileContent(file: CollectedFile, output: string): Promise<void> {
  if (file.isOpen) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(file.uri, fullRange, output);
      await vscode.workspace.applyEdit(edit);
    }

    return;
  }

  await vscode.workspace.fs.writeFile(file.uri, Buffer.from(output, 'utf8'));
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
