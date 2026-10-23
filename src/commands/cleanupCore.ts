import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeLanguage, FILE_TYPE_LANGUAGES, commentPrefix, detectLanguage, fileTypeKey, languageExtensions } from '../cleanup/languages/codeLanguage';
import { CommentTextFormatter, runLanguageCleanup, runLayoutCleanup } from '../cleanup/layoutCleanup';
import { readHeadVersion } from '../cleanup/gitBaseline';
import { changedLineRanges } from '../engine/changedLines';
import { isCancellation } from '../engine/client';
import { CleanupResult, CommandParams, DocumentText, LineRange } from '../engine/protocol';
import { documentParams, engine, reportEngineUnavailable } from '../engine/vscodeEngine';
import { toEngineSettings } from '../engine/settings';
import { getAiChatCompletion } from '../ai/aiService';
import { documentDuringCleanup, formatXmlDocCleanupSummary } from '../ai/xmlDocDuringCleanup';
import { logDiagnostic, logError, logInfo } from '../logging';
import { readCleanupSettingsForUri } from './settings';
import { formatRazor } from '../razor/razorFormatter';
import { isRazorCleanupEnabled, isRazorFile, readRazorOptions } from '../razor/razorSettings';

export interface CollectedFile {
  uri: vscode.Uri;
  content: string;
  isOpen: boolean;
}

/**
 * What cleanup or a command made of one file: its new text, and the other files it changed (renames,
 * namespace fixes) or created (type splits), which are written with it in one edit.
 */
export interface FileOutcome {
  readonly text: string;
  readonly otherFiles: readonly DocumentText[];
  readonly newFiles: readonly DocumentText[];
  /** Enforced `.editorconfig` violations it could not fix. */
  readonly unresolved: number;
  /** Steps that failed: the file is written with what the other steps did, but counts as failed. */
  readonly failures?: number;
}

interface BatchOutcome {
  changed: number;
  failed: number;
  created: number;
  unresolved: number;
  /** Set when the token was cancelled before every file was done. */
  cancelled?: true;
}

/** What a batch command did; `cancelled` is set when the user cancelled it before every file was done. */
export interface BatchResult {
  changed: number;
  failed: number;
  cancelled?: true;
}

/**
 * Cleans or transforms the given files one after the other - each read when its turn comes (the live
 * editor buffer of an open file, so unsaved changes are cleaned too, and so a file another file's result
 * changed is read as changed) - and applies each result before the next file is read. The files whose
 * result was applied are added to `applied`. A cancelled `token` stops the batch before the next file; a
 * request cancelled in flight is neither counted as failed nor reported.
 */
async function runBatch(
  targets: readonly vscode.Uri[],
  transform: (file: CollectedFile, token?: vscode.CancellationToken) => Promise<FileOutcome>,
  label: string,
  emptyMessage: string,
  applied: CollectedFile[] = [],
  token?: vscode.CancellationToken
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { changed: 0, failed: 0, created: 0, unresolved: 0 };
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(emptyMessage);

    return outcome;
  }

  logDiagnostic(`${label}: starting on ${targets.length} file(s).`);
  for (const uri of targets) {
    if (token?.isCancellationRequested) {
      outcome.cancelled = true;
      break;
    }

    let file: CollectedFile | undefined;
    try {
      file = await collectFile(uri);
    } catch (err) {
      outcome.failed++;
      logError(`${label}: reading ${uri.fsPath}`, err);
      continue;
    }

    if (!file) {
      continue;
    }

    try {
      const openVersions = openDocumentVersions();
      const result = await transform(file, token);
      outcome.unresolved += result.unresolved;
      await applyFileOutcome(file, result, openVersions);
      applied.push(file);
      outcome.changed += result.text !== file.content ? 1 : 0;
      outcome.created += result.newFiles.length;
      outcome.failed += result.failures ? 1 : 0;
    } catch (err) {
      if (token?.isCancellationRequested) {
        outcome.cancelled = true;
        if (isCancellation(err)) {
          break;
        }
      }

      outcome.failed++;
      if (!reportEngineUnavailable(err)) {
        logError(`${label} of ${file.uri.fsPath}`, err);
        void vscode.window.showWarningMessage(`Code Janitor: ${file.uri.fsPath} - ${(err as Error).message}`);
      }

      if (outcome.cancelled) {
        break;
      }
    }
  }

  logDiagnostic(
    `${label}: ${outcome.cancelled ? 'cancelled' : 'finished'} - ${outcome.changed} changed, ${outcome.failed} failed` +
      (outcome.created > 0 ? `, ${outcome.created} file(s) created by splitting types.` : '.')
  );

  return outcome;
}

/** A file outcome with nothing but a new text. */
function textOutcome(text: string): FileOutcome {
  return { text, otherFiles: [], newFiles: [], unresolved: 0 };
}

/**
 * The outcome of an engine result for `file`, with the result's messages and the violations it could not
 * fix logged to the output channel, and its failures and warnings shown to the user.
 */
export function engineOutcome(file: vscode.Uri, result: CleanupResult, label: string): FileOutcome {
  for (const issue of result.issues) {
    logInfo(`${label}: ${file.fsPath}: ${issue}`);
  }

  for (const failure of result.failures) {
    logError(`${label} of ${file.fsPath}`, failure);
    void vscode.window.showWarningMessage(`Code Janitor: ${file.fsPath} - ${failure}`);
  }

  for (const warning of result.warnings) {
    logInfo(`${label}: ${file.fsPath}: ${warning}`);
    void vscode.window.showWarningMessage(`Code Janitor: ${warning}`);
  }

  for (const diagnostic of result.unresolved) {
    logInfo(`${file.fsPath}:${diagnostic.line}: ${diagnostic.id} (${diagnostic.severity}): ${diagnostic.message} - not fixed: ${diagnostic.reason}`);
  }

  return {
    text: result.text,
    otherFiles: result.otherFiles,
    newFiles: result.newFiles,
    unresolved: result.unresolved.length,
    failures: result.failures.length,
  };
}

/**
 * Cleans up `uris`: a file outside the workspace folders only partially, and as
 * `codeJanitor.cleanup.performPartialCleanupOnExternal` says. Then, for the files it cleaned, AI XML documentation
 * (`codeJanitor.ai.xmlDoc.runDuringCleanup`, not when only changed lines are cleaned), then for the open ones the
 * external tools (see {@link runExternalTools}).
 */
export async function runCleanupOnUris(
  context: vscode.ExtensionContext,
  uris: vscode.Uri[],
  options: {
    renameAcrossWorkspace?: boolean;
    /** Cleanup Changed Files: with `codeJanitor.cleanup.onlyChangedLines`, only the lines changed since HEAD are cleaned. */
    honorOnlyChangedLines?: boolean;
    /** Cancelling stops the cleanup before the next file, and skips the steps after the files. */
    token?: vscode.CancellationToken;
  } = {}
): Promise<BatchResult & { unresolved: number; created: number }> {
  const targets = uris.filter((uri) => {
    const target = isCleanupTarget(uri);
    if (!target) {
      logDiagnostic(`Cleanup: ${uri.fsPath} skipped: not a file type or path cleanup acts on.`);
    }

    return target;
  });
  const external = targets.filter(isOutsideWorkspaceFolders);
  const externalCleanup = external.length > 0 ? await externalFileCleanup(external[0], true) : undefined;
  if (externalCleanup?.skipBecause) {
    for (const uri of external) {
      logDiagnostic(`Cleanup: ${uri.fsPath} skipped: ${externalCleanup.skipBecause}.`);
    }
  }

  const partial = new Set(externalCleanup?.skipBecause === undefined ? external : []);
  const included = externalCleanup?.skipBecause ? targets.filter((uri) => !external.includes(uri)) : targets;
  // Only the lines changed since HEAD: other file types are left as they are.
  const onlyChangedLines = (uri: vscode.Uri): boolean => options.honorOnlyChangedLines === true && readCleanupSettingsForUri(uri).onlyChangedLines;
  const applied: CollectedFile[] = [];
  const { changed, failed, unresolved, created, cancelled } = await runBatch(
    included,
    async (file, token) => {
      if (isCSharp(file.uri)) {
        return cleanupCSharp(file, {
          renameAcrossWorkspace: options.renameAcrossWorkspace === true,
          honorOnlyChangedLines: options.honorOnlyChangedLines === true,
          partial: partial.has(file.uri),
          token,
        });
      }

      return textOutcome(onlyChangedLines(file.uri) ? file.content : await cleanupOtherLanguage(file));
    },
    'Cleanup',
    'Code Janitor: no files to clean up.',
    applied,
    options.token
  );

  if (unresolved > 0) {
    logInfo(`Cleanup: ${unresolved} .editorconfig rule violation(s) were not fixed (listed above).`);
  }

  if (cancelled) {
    return { changed, failed, unresolved, created, cancelled };
  }

  const cleaned = applied.filter((file) => isCSharp(file.uri)).map((file) => file.uri);
  if (cleaned.length > 0 && vscode.workspace.getConfiguration('codeJanitor').get<boolean>('ai.xmlDoc.runDuringCleanup', false)) {
    const documented = cleaned.filter((uri) => {
      const whole = !onlyChangedLines(uri);
      if (!whole) {
        logDiagnostic(
          `Cleanup: no AI XML documentation for ${uri.fsPath}, only the lines changed since the last commit are cleaned (codeJanitor.cleanup.onlyChangedLines).`
        );
      }

      return whole;
    });
    if (documented.length > 0) {
      const summary = await documentDuringCleanup(documented, {
        read: async (uri) => (await collectFiles([uri]))[0],
        write: writeFileContent,
        complete: (systemPrompt, prompt, maxTokens) => getAiChatCompletion(context, systemPrompt, prompt, maxTokens),
      });
      logInfo(formatXmlDocCleanupSummary(summary));
    }
  }

  await runExternalTools(applied.filter((file) => file.isOpen));

  return { changed, failed, unresolved, created };
}

/** A file outside every workspace folder; with no folder open, no file is. */
export function isOutsideWorkspaceFolders(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && (vscode.workspace.workspaceFolders ?? []).length > 0 && vscode.workspace.getWorkspaceFolder(uri) === undefined;
}

const PARTIAL_CLEANUP_SETTING = 'cleanup.performPartialCleanupOnExternal';

/**
 * Whether files outside the workspace folders are cleaned (partially), as `performPartialCleanupOnExternal` says:
 * `always` cleans, `never` skips, `ask` asks with a modal (Visual Studio's `PromptUserAboutCleaningExternalFiles`)
 * whose Always and Never answers are remembered in the user settings. `ask` without `allowPrompt` (on save, which
 * must not wait for the user) cleans. `skipBecause` says why the files are skipped.
 */
export async function externalFileCleanup(example: vscode.Uri, allowPrompt: boolean): Promise<{ skipBecause?: string }> {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const preference = config.get<'ask' | 'always' | 'never'>(PARTIAL_CLEANUP_SETTING, 'ask');
  if (preference === 'always' || (preference === 'ask' && !allowPrompt)) {
    return {};
  }

  if (preference === 'never') {
    return { skipBecause: `it is not in a workspace folder (codeJanitor.${PARTIAL_CLEANUP_SETTING} is never)` };
  }

  const answer = await vscode.window.showWarningMessage(
    `Code Janitor: ${example.fsPath} is not in a workspace folder, so some cleanup actions are unavailable (using directives, renames in other files, type splits).\n\nDo you want to perform a partial cleanup?`,
    { modal: true },
    'Yes',
    'No',
    'Always',
    'Never'
  );
  if (answer === 'Always' || answer === 'Never') {
    await config.update(PARTIAL_CLEANUP_SETTING, answer === 'Always' ? 'always' : 'never', vscode.ConfigurationTarget.Global);
  }

  return answer === 'Yes' || answer === 'Always' ? {} : { skipBecause: 'it is not in a workspace folder and the partial cleanup was declined' };
}

/**
 * After the cleanup of open documents: VS Code's Format Document (`codeJanitor.cleanup.runFormatDocument`), then
 * each command of `codeJanitor.thirdParty.otherCleaningCommands` with the document as the active editor; the
 * editor active before is shown again at the end. A failing formatter or command is logged and the others run.
 * Never on save: a formatter or a command running inside a save participant would hold up the save (or save again).
 */
async function runExternalTools(files: readonly CollectedFile[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const format = config.get<boolean>('cleanup.runFormatDocument', false);
  const commands = config.get<string[]>('thirdParty.otherCleaningCommands', []).filter((id) => id.trim().length > 0);
  if (files.length === 0 || (!format && commands.length === 0)) {
    return;
  }

  const previous = vscode.window.activeTextEditor;
  for (const file of files) {
    const document = vscode.workspace.textDocuments.find((candidate) => !candidate.isClosed && candidate.uri.toString() === file.uri.toString());
    if (!document) {
      continue;
    }

    if (format) {
      await formatDocument(document).catch((err: unknown) => logError(`Format Document on ${document.uri.fsPath}`, err));
    }

    if (commands.length === 0) {
      continue;
    }

    try {
      await vscode.window.showTextDocument(document);
    } catch (err) {
      logError(`Other cleaning commands on ${document.uri.fsPath}`, err);
      continue;
    }

    for (const id of commands) {
      try {
        await vscode.commands.executeCommand(id);
      } catch (err) {
        logError(`Other cleaning command ${id} on ${document.uri.fsPath}`, err);
      }
    }
  }

  if (commands.length > 0 && previous && !previous.document.isClosed) {
    await vscode.window.showTextDocument(previous.document, previous.viewColumn);
  }
}

/** Applies the edits of the formatter VS Code has for the document's language, with the editor's indentation. */
async function formatDocument(document: vscode.TextDocument): Promise<void> {
  const editor = vscode.workspace.getConfiguration('editor', document);
  const options: vscode.FormattingOptions = { tabSize: editor.get<number>('tabSize', 4), insertSpaces: editor.get<boolean>('insertSpaces', true) };
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatDocumentProvider', document.uri, options);
  if (!edits || edits.length === 0) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const textEdit of edits) {
    edit.replace(document.uri, textEdit.range, textEdit.newText);
  }

  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('VS Code did not apply the formatting edits');
  }
}

/**
 * The cleanup of a file that is not C#: the Razor formatter for a Razor file while Razor cleanup is on, else the
 * steps of its language family, with the comments of a Visual Basic file formatted by the engine.
 */
export async function cleanupOtherLanguage(file: CollectedFile): Promise<string> {
  if (isRazorFile(file.uri) && isRazorCleanupEnabled()) {
    return cleanupRazor(file.content, file.uri);
  }

  return runLanguageCleanup(file.content, file.uri.fsPath, readCleanupSettingsForUri(file.uri), {
    languageId: languageIdOf(file.uri),
    formatComments: engineCommentFormatter(file.uri),
  });
}

/**
 * How a C# file is cleaned: whether renames may change other files, whether only changed lines are cleaned, and
 * whether it is a cleanup on save or a partial cleanup (a file outside the workspace folders), which never change
 * other files.
 */
export interface CSharpCleanupOptions {
  /** Batch commands only (never on save, never partial): renames of non-private symbols across the workspace. */
  readonly renameAcrossWorkspace: boolean;
  /** Sends the lines changed since HEAD, which the engine cleans alone with `onlyChangedLines`. */
  readonly honorOnlyChangedLines: boolean;
  readonly onSave?: boolean;
  readonly partial?: boolean;
  readonly excludedRules?: readonly string[];
  readonly token?: vscode.CancellationToken;
}

/** Cleans one C# file through the engine. */
export async function cleanupCSharp(file: CollectedFile, options: CSharpCleanupOptions): Promise<FileOutcome> {
  return engineOutcome(file.uri, await cleanupCSharpResult(file, options), 'Cleanup');
}

/**
 * The engine's cleanup result for one C# file. On save, the settings also carry
 * `codeJanitor.cleanup.skipOrganizeUsingsDuringCleanupOnSave`, which the engine reads only on save.
 */
export async function cleanupCSharpResult(file: CollectedFile, options: CSharpCleanupOptions): Promise<CleanupResult> {
  const renames = options.renameAcrossWorkspace && !options.onSave && !options.partial;
  const params = documentParams(file.uri, file.content, renames ? {} : { renamePublicSymbolsAcrossWorkspace: false });
  const changedLines = options.honorOnlyChangedLines && readCleanupSettingsForUri(file.uri).onlyChangedLines ? await changedLinesOf(file) : undefined;
  const skipUsingsOnSave = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.skipOrganizeUsingsDuringCleanupOnSave', false);

  return engine().cleanup(
    {
      ...params,
      ...(options.excludedRules && options.excludedRules.length > 0 ? { excludedRules: options.excludedRules } : {}),
      ...(changedLines !== undefined ? { changedLines } : {}),
      ...(options.onSave ? { onSave: true, settings: { ...params.settings, skipOrganizeUsingsDuringCleanupOnSave: skipUsingsOnSave } } : {}),
      ...(options.partial ? { partial: true } : {}),
    },
    options.token
  );
}

/**
 * The lines of `file` changed since its last commit (`null`: a new file, every line). Throws when Git cannot
 * tell, as nothing then says which lines to clean while `onlyChangedLines` is on.
 */
async function changedLinesOf(file: CollectedFile): Promise<readonly LineRange[] | null> {
  const baseline =
    file.uri.scheme === 'file'
      ? await readHeadVersion(file.uri.fsPath).catch((err: unknown) => ({ kind: 'unavailable' as const, reason: String(err) }))
      : { kind: 'unavailable' as const, reason: 'the document is not a file' };
  if (baseline.kind === 'unavailable') {
    throw new Error(`only the lines changed since the last commit are cleaned (codeJanitor.cleanup.onlyChangedLines) and ${baseline.reason}`);
  }

  return changedLineRanges(baseline.kind === 'tracked' ? baseline.text : undefined, file.content);
}

/** Runs an engine command on one C# file. */
export async function runEngineCommand(
  file: CollectedFile,
  command: CommandParams['command'],
  label: string,
  args?: CommandParams['arguments'],
  token?: vscode.CancellationToken
): Promise<FileOutcome> {
  const result = await engine().command({ ...documentParams(file.uri, file.content), command, ...(args ? { arguments: args } : {}) }, token);

  return engineOutcome(file.uri, result, label);
}

/** Runs an engine command on every C# file of `uris`. */
async function runCommandOnUris(
  uris: readonly vscode.Uri[],
  command: CommandParams['command'],
  label: string,
  emptyMessage: string,
  token?: vscode.CancellationToken
): Promise<BatchResult> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));
  const { changed, failed, created, cancelled } = await runBatch(
    targets,
    (file, fileToken) => runEngineCommand(file, command, label, undefined, fileToken),
    label,
    emptyMessage,
    [],
    token
  );

  return { changed: changed + created, failed, ...(cancelled ? { cancelled } : {}) };
}

/** Removes XML documentation comments from every given C# file - never uses AI. */
export function runRemoveXmlDocOnUris(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<BatchResult> {
  return runCommandOnUris(uris, 'removeXmlDocumentation', 'Remove XML Documentation', 'Code Janitor: no C# files to remove XML documentation from.', token);
}

/** Removes `#region`/`#endregion` directives from every given C# file, regardless of cleanup settings. */
export function runRemoveRegionsOnUris(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<BatchResult> {
  return runCommandOnUris(uris, 'removeRegions', 'Remove Regions', 'Code Janitor: no C# files to remove regions from.', token);
}

/**
 * Formats the comments of every given file whose comments Code Janitor formats (see {@link canFormatComments}),
 * regardless of cleanup settings.
 */
export async function runFormatCommentsOnUris(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<BatchResult> {
  const targets = uris.filter((uri) => canFormatComments(uri) && isPathCleanable(uri));
  const { changed, failed, created, cancelled } = await runBatch(
    targets,
    formatCommentsOf,
    'Format Comments',
    'Code Janitor: no files to format comments in.',
    [],
    token
  );

  return { changed: changed + created, failed, ...(cancelled ? { cancelled } : {}) };
}

/** C# files, and the files of the languages with a known single-line comment prefix (Visual Basic, C-family, PowerShell, R). */
export function canFormatComments(uri: vscode.Uri): boolean {
  return isCSharp(uri) || commentPrefix(languageOf(uri)) !== undefined;
}

/** Formats the comments of one file: a C# file through the engine command, another through `formatCommentText`. */
export async function formatCommentsOf(file: CollectedFile, token?: vscode.CancellationToken): Promise<FileOutcome> {
  if (isCSharp(file.uri)) {
    return runEngineCommand(file, 'formatComments', 'Format Comments', undefined, token);
  }

  const prefix = commentPrefix(languageOf(file.uri));
  if (prefix === undefined) {
    throw new Error(`Code Janitor does not format the comments of ${path.basename(file.uri.fsPath)}: its language has no known comment prefix.`);
  }

  return textOutcome(await engineCommentFormatter(file.uri, token)(file.content, prefix));
}

/** The engine's comment formatter for the text of `uri`, with the cleanup settings of that file. */
function engineCommentFormatter(uri: vscode.Uri, token?: vscode.CancellationToken): CommentTextFormatter {
  return async (text, prefix) =>
    (await engine().formatCommentText({ text, commentPrefix: prefix, settings: toEngineSettings(readCleanupSettingsForUri(uri)) }, token)).text;
}

/** Gives each file the namespace the engine expects from its project and folder - a batch run can't prompt per file. */
export function runFixNamespaceOnUris(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<BatchResult> {
  return runCommandOnUris(uris, 'fixNamespace', 'Fix Namespace', 'Code Janitor: no C# files to fix the namespace of.', token);
}

/**
 * Splits every given C# file that declares more than one eligible top-level type into one file per type.
 * This explicit command splits whatever the `.editorconfig` says; cleanup splits only when the
 * `.editorconfig` enforces one type per file. A file and its new files are written in one edit.
 */
export function runSplitTopLevelTypesOnUris(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<BatchResult> {
  return runCommandOnUris(uris, 'splitTopLevelTypes', 'Split Top-Level Types', 'Code Janitor: no C# files to split.', token);
}

/**
 * Writes a file's outcome. A new text alone goes through {@link writeFileContent}. With other files
 * changed or created, one `WorkspaceEdit` creates the new files and edits every file, so one undo reverts
 * it all and the disk never holds a type twice; the files that were not open are then saved (the new
 * files of an open file stay unsaved with it). Throws, changing nothing, when a new file already exists
 * (VS Code keeps the part of an edit it applied before a creation that fails), when the file changed since
 * its outcome was computed, or when another open file the outcome changes was edited since `openVersions`
 * was taken (see {@link openDocumentVersions}); throws when VS Code does not apply the edit.
 */
export async function applyFileOutcome(file: CollectedFile, outcome: FileOutcome, openVersions: ReadonlyMap<string, number>): Promise<void> {
  if (outcome.otherFiles.length === 0 && outcome.newFiles.length === 0) {
    if (outcome.text !== file.content) {
      await writeFileContent(file, outcome.text);
    }

    return;
  }

  const existing = await firstExistingFile(outcome.newFiles);
  if (existing !== undefined) {
    throw new Error(`${path.basename(existing)} already exists; no file was changed and no new file was created`);
  }

  const openBefore = new Set(vscode.workspace.textDocuments.filter((document) => !document.isClosed).map((document) => document.uri.toString()));
  const closedTarget = file.isOpen ? undefined : await vscode.workspace.openTextDocument(file.uri);
  const others: { readonly uri: vscode.Uri; readonly text: string; readonly document: vscode.TextDocument }[] = [];
  for (const other of outcome.otherFiles) {
    const uri = vscode.Uri.file(other.path);
    others.push({ uri, text: other.text, document: await vscode.workspace.openTextDocument(uri) });
  }

  // VS Code loads a closed file with mixed line endings with the dominant one throughout.
  if (closedTarget && closedTarget.getText() !== asDocumentText(editorText(file.content))) {
    throw new Error('the file changed during cleanup; no file was changed');
  }

  const target = closedTarget ?? unchangedDocument(file, '; no file was changed');
  for (const { uri, document } of others) {
    const version = openVersions.get(document.uri.toString());
    if (version === undefined ? document.isDirty : document.version !== version) {
      throw new Error(`${path.basename(uri.fsPath)} was edited during cleanup; no file was changed`);
    }
  }

  const edit = new vscode.WorkspaceEdit();
  const saved: vscode.Uri[] = [];
  for (const newFile of outcome.newFiles) {
    const uri = vscode.Uri.file(newFile.path);
    // Without options, creating a file that exists fails: a split never overwrites a file.
    edit.createFile(uri);
    edit.insert(uri, new vscode.Position(0, 0), editorText(newFile.text));
    if (!file.isOpen) {
      saved.push(uri);
    }
  }

  edit.replace(file.uri, wholeDocument(target), editorText(outcome.text));
  for (const { uri, text, document } of others) {
    edit.replace(uri, wholeDocument(document), editorText(text));
  }

  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('VS Code did not apply the edit; no file was changed and no new file was created');
  }

  saved.push(...[file.uri, ...others.map((other) => other.uri)].filter((uri) => !openBefore.has(uri.toString())));
  for (const uri of saved) {
    await vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.save();
  }
}

/**
 * The version of every open document, by uri, taken before an outcome is computed: {@link applyFileOutcome}
 * then refuses to overwrite an open file edited since.
 */
export function openDocumentVersions(): ReadonlyMap<string, number> {
  return new Map(vscode.workspace.textDocuments.filter((document) => !document.isClosed).map((document) => [document.uri.toString(), document.version]));
}

/** The path of the first of `files` that already exists; a failure other than a missing file is thrown. */
export async function firstExistingFile(files: readonly DocumentText[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(file.path));

      return file.path;
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        throw err;
      }
    }
  }

  return undefined;
}

/**
 * `text` as VS Code's document of the file holds it: with mixed line endings, the dominant one
 * throughout (as `PieceTreeTextBufferFactory` normalizes the end of lines when it loads a file).
 */
export function asDocumentText(text: string): string {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const cr = text.match(/\r(?!\n)/g)?.length ?? 0;
  const lf = text.match(/(?<!\r)\n/g)?.length ?? 0;
  const eol = cr + crlf > (cr + lf + crlf) / 2 ? '\r\n' : '\n';
  const mixed = eol === '\r\n' ? cr + lf > 0 : cr + crlf > 0;

  return mixed ? text.replace(/\r\n|\r|\n/g, eol) : text;
}

/** The text an editor document holds for `text`: VS Code keeps a byte order mark as the encoding, never in the text. */
function editorText(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function wholeDocument(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
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

/** The VS Code language of the open document of `uri`, if it is open. */
function languageIdOf(uri: vscode.Uri): string | undefined {
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString())?.languageId;
}

/** The language of a file: by its extension, else by the language mode of its open document. */
function languageOf(uri: vscode.Uri): CodeLanguage {
  return detectLanguage(uri.fsPath, languageIdOf(uri));
}

/**
 * Whether files of `language` are cleaned: `codeJanitor.cleanup.includeOtherFileTypes` is the master switch and
 * `codeJanitor.cleanup.fileTypes.<key>` selects the language (`everythingElse` for the others).
 */
function isLanguageCleaned(language: CodeLanguage): boolean {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const key = fileTypeKey(language);

  return config.get<boolean>('cleanup.includeOtherFileTypes', false) && (key === undefined || config.get<boolean>(`cleanup.fileTypes.${key}`, true));
}

/**
 * A file generated by a T4 text template (a `.tt` file with the same name next to it) while
 * `codeJanitor.cleanup.excludeT4GeneratedCode` is on: never cleaned.
 */
function isT4GeneratedFile(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file' || !vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.excludeT4GeneratedCode', true)) {
    return false;
  }

  const file = path.parse(uri.fsPath);

  return file.ext.toLowerCase() !== '.tt' && fs.existsSync(path.join(file.dir, `${file.name}.tt`));
}

/**
 * C# files, and the files of the other languages `codeJanitor.cleanup.includeOtherFileTypes` and
 * `codeJanitor.cleanup.fileTypes.*` turn on; never a file a T4 template generates.
 */
export function isSupportedFile(uri: vscode.Uri): boolean {
  if (!isPathCleanable(uri) || isT4GeneratedFile(uri)) {
    return false;
  }

  return isCSharp(uri) || isLanguageCleaned(languageOf(uri));
}

/**
 * Files cleanup acts on: the supported files, plus Razor components and views while
 * `codeJanitor.cleanup.formatRazorComponents` is on (which formats them even when other file types
 * are not cleaned).
 */
export function isCleanupTarget(uri: vscode.Uri): boolean {
  return isSupportedFile(uri) || (isRazorFile(uri) && isRazorCleanupEnabled() && isPathCleanable(uri) && !isT4GeneratedFile(uri));
}

/** The glob of the files a folder or the workspace cleanup acts on. */
export function cleanupFileGlob(): string {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  if (!config.get<boolean>('cleanup.includeOtherFileTypes', false)) {
    return isRazorCleanupEnabled() ? '**/*.{cs,razor,cshtml}' : '**/*.cs';
  }

  if (config.get<boolean>('cleanup.fileTypes.everythingElse', true)) {
    return '**/*';
  }

  const languages: CodeLanguage[] = ['csharp', ...FILE_TYPE_LANGUAGES.filter((language) => config.get<boolean>(`cleanup.fileTypes.${language}`, true))];
  if (isRazorCleanupEnabled() || languages.includes('html')) {
    languages.push('razor');
  }

  return `**/*.{${languages.flatMap(languageExtensions).join(',')}}`;
}

/** A Razor file in a cleanup: the Razor formatter, then the layout rules when HTML files are cleaned (Razor counts as HTML). */
function cleanupRazor(content: string, uri: vscode.Uri): string {
  const formatted = formatRazor(content, readRazorOptions());

  return isLanguageCleaned('razor') ? runLayoutCleanup(formatted, uri.fsPath, readCleanupSettingsForUri(uri)) : formatted;
}

/** Formats the Razor files among `uris` with the Razor formatter only, whatever the cleanup settings say. */
export async function runFormatRazorOnUris(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<BatchResult> {
  const targets = uris.filter((uri) => isRazorFile(uri) && isPathCleanable(uri));

  return runBatch(
    targets,
    async (file) => textOutcome(formatRazor(file.content, readRazorOptions())),
    'Format Razor',
    'Code Janitor: no Razor files to format.',
    [],
    token
  );
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

/** The invalid expressions already reported, so each is reported once. */
const reportedInvalidPatterns = new Set<string>();

function matchesAny(patterns: readonly string[] | undefined, value: string): boolean {
  return (patterns ?? []).some((pattern) => {
    try {
      return pattern.trim().length > 0 && new RegExp(pattern, 'i').test(value);
    } catch (err) {
      // An invalid expression must never fail the cleanup; it matches nothing and is reported once.
      if (!reportedInvalidPatterns.has(pattern)) {
        reportedInvalidPatterns.add(pattern);
        logError(`Path filter ${pattern}`, err);
        void vscode.window.showWarningMessage(`Code Janitor: the path filter "${pattern}" is not a valid regular expression, so it matches no file.`);
      }

      return false;
    }
  });
}

/** A closed file that is not text Code Janitor can rewrite byte for byte: binary, or in another encoding than UTF-8. */
class NotTextError extends Error {}

/** The text of a closed file, its byte order mark kept; throws {@link NotTextError} for NUL bytes or invalid UTF-8. */
async function readClosedText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.includes(0)) {
    throw new NotTextError('it contains NUL bytes, so it is not text');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new NotTextError('it is not valid UTF-8');
  }
}

/**
 * Reads the files: the live buffer of an open one, the UTF-8 text of a closed one. A closed file that is not
 * UTF-8 text is skipped and reported, as writing it back would corrupt it.
 */
export async function collectFiles(uris: vscode.Uri[]): Promise<CollectedFile[]> {
  const collected: CollectedFile[] = [];

  for (const uri of uris) {
    try {
      const file = await collectFile(uri);
      if (file) {
        collected.push(file);
      }
    } catch (err) {
      logError(`Reading ${uri.fsPath}`, err);
    }
  }

  return collected;
}

/**
 * Reads one file like {@link collectFiles}: undefined for a closed file that is not UTF-8 text (reported),
 * and the error of a file that cannot be read.
 */
async function collectFile(uri: vscode.Uri): Promise<CollectedFile | undefined> {
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (openDoc) {
    return { uri, content: openDoc.getText(), isOpen: true };
  }

  try {
    return { uri, content: await readClosedText(uri), isOpen: false };
  } catch (err) {
    if (err instanceof NotTextError) {
      logInfo(`${uri.fsPath} skipped: ${err.message}; Code Janitor only rewrites UTF-8 text files.`);

      return undefined;
    }

    throw err;
  }
}

/**
 * Writes one file's new content back - a disk write for a closed file, otherwise a `WorkspaceEdit` replacing
 * only the part of the document that differs (so the cursor and the folding outside it stay where they
 * are). Throws when VS Code does not apply the edit, the document was closed or edited meanwhile, or a closed
 * file changed on disk since it was read.
 */
export async function writeFileContent(file: CollectedFile, output: string): Promise<void> {
  if (!file.isOpen) {
    if ((await readClosedText(file.uri).catch(() => undefined)) !== file.content) {
      throw new Error('the file changed during cleanup; it was not written');
    }

    await vscode.workspace.fs.writeFile(file.uri, Buffer.from(output, 'utf8'));

    return;
  }

  const doc = unchangedDocument(file);
  const current = doc.getText();
  const text = editorText(output);
  let start = 0;
  while (start < current.length && start < text.length && current[start] === text[start]) {
    start++;
  }

  let end = 0;
  while (end < current.length - start && end < text.length - start && current[current.length - 1 - end] === text[text.length - 1 - end]) {
    end++;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(file.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(current.length - end)), text.slice(start, text.length - end));
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('VS Code did not apply the edit');
  }
}

/**
 * The open document of `file`, still holding the text its output was computed from: the user's
 * edits made while the cleanup ran are never overwritten. Throws when it was closed or edited.
 */
function unchangedDocument(file: CollectedFile, suffix = ''): vscode.TextDocument {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
  if (!doc) {
    throw new Error(`the document was closed during cleanup${suffix}`);
  }

  if (doc.getText() !== file.content) {
    throw new Error(`the document was edited during cleanup${suffix}`);
  }

  return doc;
}

export async function expandToCleanableFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    return [uri];
  }

  return vscode.workspace.findFiles(new vscode.RelativePattern(uri, cleanupFileGlob()), '**/{bin,obj,node_modules,.git}/**');
}

/** Like {@link expandToCSharpFiles} for Razor: a folder becomes its `.razor` and `.cshtml` files. */
export async function expandToRazorFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    return [uri];
  }

  return vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.{razor,cshtml}'), '**/{bin,obj,node_modules,.git}/**');
}

/** Unlike {@link expandToCleanableFiles}, always only `.cs` - XML documentation is a C# concept. */
export async function expandToCSharpFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    return [uri];
  }

  return vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.cs'), '**/{bin,obj,node_modules,.git}/**');
}

/** Like {@link expandToCSharpFiles} for Format Comments: a folder becomes its files whose comments Code Janitor formats. */
export async function expandToCommentFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    return [uri];
  }

  const languages = (['csharp', ...FILE_TYPE_LANGUAGES] as const).filter((language) => commentPrefix(language) !== undefined);

  return vscode.workspace.findFiles(
    new vscode.RelativePattern(uri, `**/*.{${languages.flatMap(languageExtensions).join(',')}}`),
    '**/{bin,obj,node_modules,.git}/**'
  );
}
