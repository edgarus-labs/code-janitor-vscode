import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineCommand } from '../engine/protocol';
import { reportEngineUnavailable } from '../engine/vscodeEngine';
import { logError } from '../logging';
import { CollectedFile, FileOutcome, applyFileOutcome, canFormatComments, formatCommentsOf, openDocumentVersions, runEngineCommand } from './cleanupCore';
import { sortLinesInEditor } from './editorText';

/**
 * The standalone editor actions of the original extension: fix namespace, remove regions, format
 * comments, remove XML documentation, join lines and sort lines.
 */
export function registerEditorCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.fixNamespace', fixNamespaceCommand),
    vscode.commands.registerCommand('codeJanitor.removeRegions', () => runOnActiveDocument('removeRegions', 'Remove Regions')),
    vscode.commands.registerCommand('codeJanitor.formatComments', formatCommentsCommand),
    vscode.commands.registerCommand('codeJanitor.removeXmlDoc', () => runOnActiveDocument('removeXmlDocumentation', 'Remove XML Documentation')),
    vscode.commands.registerCommand('codeJanitor.joinLines', joinLinesCommand),
    vscode.commands.registerCommand('codeJanitor.sortLines', sortLinesCommand)
  );
}

async function fixNamespaceCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file to fix its namespace.');

    return;
  }

  const expected = await vscode.window.showInputBox({
    title: 'Code Janitor: Fix Namespace',
    prompt: 'Namespace the file should declare',
    value: suggestNamespace(editor.document.uri),
    ignoreFocusOut: true,
  });

  if (!expected) {
    return;
  }

  await runOnEditor(editor, 'Fix Namespace', (file) => runEngineCommand(file, 'fixNamespace', 'Fix Namespace', { namespace: expected }));
}

/**
 * Suggests a namespace for the input box: the workspace folder's name followed by the folders between it and the
 * document, each as an identifier. The project file and its root namespace are not consulted, so the suggestion
 * can differ from what the batch Fix Namespace commands, which the engine resolves per project, give the file.
 */
export function suggestNamespace(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return '';
  }

  const relative = path.relative(workspaceFolder.uri.fsPath, path.dirname(uri.fsPath));
  const segments = [workspaceFolder.name, ...relative.split(path.sep)]
    .filter((segment) => segment && segment !== '.')
    .map(toNamespaceSegment)
    .filter(Boolean);

  return segments.join('.');
}

function toNamespaceSegment(segment: string): string {
  const sanitized = segment.replace(/[^A-Za-z0-9_]/g, '');

  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

async function joinLinesCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const range = selectionOrNextLine(editor);
  const joined = editor.document.getText(range).replace(/[ \t]*\r?\n[ \t]*/g, ' ');

  await editor.edit((builder) => builder.replace(range, joined));
}

async function sortLinesCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  await sortLinesInEditor(editor);
}

function selectionOrNextLine(editor: vscode.TextEditor): vscode.Range {
  const selection = editor.selection;
  if (!selection.isEmpty) {
    return new vscode.Range(selection.start, selection.end);
  }

  const nextLine = Math.min(selection.active.line + 1, editor.document.lineCount - 1);

  return new vscode.Range(new vscode.Position(selection.active.line, 0), editor.document.lineAt(nextLine).range.end);
}

async function runOnActiveDocument(command: EngineCommand, label: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a csharp file first.');

    return;
  }

  await runOnEditor(editor, label, (file) => runEngineCommand(file, command, label));
}

/** Formats the comments of the active document: C#, or a language whose comment prefix is known. */
async function formatCommentsCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !canFormatComments(editor.document.uri)) {
    void vscode.window.showInformationMessage('Code Janitor: open a C#, Visual Basic, C-family, PowerShell or R file first.');

    return;
  }

  await runOnEditor(editor, 'Format Comments', formatCommentsOf);
}

/** Runs `transform` on the editor's document and applies its outcome (other files included) as one edit. */
async function runOnEditor(editor: vscode.TextEditor, label: string, transform: (file: CollectedFile) => Promise<FileOutcome>): Promise<void> {
  const file = { uri: editor.document.uri, content: editor.document.getText(), isOpen: true };
  const openVersions = openDocumentVersions();
  try {
    const outcome = await transform(file);
    if (outcome.text === file.content && outcome.otherFiles.length === 0 && outcome.newFiles.length === 0) {
      void vscode.window.showInformationMessage('Code Janitor: nothing to change.');

      return;
    }

    await applyFileOutcome(file, outcome, openVersions);
  } catch (err) {
    if (!reportEngineUnavailable(err)) {
      logError(`${label} of ${file.uri.fsPath}`, err);
      void vscode.window.showErrorMessage(`Code Janitor: ${(err as Error).message}`);
    }
  }
}
