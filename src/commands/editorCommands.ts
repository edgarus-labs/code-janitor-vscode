import * as path from 'node:path';
import * as vscode from 'vscode';
import { removeXmlDocumentationConverter } from '../cleanup/transformations/removeXmlDocumentation';
import { commentFormatConverter, regionDirectiveRemover } from '../cleanup/transformations/text';
import { fixNamespace } from '../cleanup/transformations/namespaceAndNameOf';

/**
 * The standalone editor actions of the original extension: fix namespace, remove regions, format
 * comments, remove XML documentation, join lines and sort lines.
 */
export function registerEditorCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.fixNamespace', fixNamespaceCommand),
    vscode.commands.registerCommand('codeJanitor.removeRegions', () =>
      transformActiveDocument('csharp', (source) => regionDirectiveRemover.apply(source))
    ),
    vscode.commands.registerCommand('codeJanitor.formatComments', () =>
      transformActiveDocument('csharp', (source) => commentFormatConverter.apply(source))
    ),
    vscode.commands.registerCommand('codeJanitor.removeXmlDoc', () =>
      transformActiveDocument('csharp', (source) => removeXmlDocumentationConverter.apply(source))
    ),
    vscode.commands.registerCommand('codeJanitor.joinLines', joinLinesCommand),
    vscode.commands.registerCommand('codeJanitor.sortLines', sortLinesCommand)
  );
}

async function fixNamespaceCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('CodeJanitor: open a C# file to fix its namespace.');

    return;
  }

  const expected = await vscode.window.showInputBox({
    title: 'CodeJanitor: Fix Namespace',
    prompt: 'Namespace the file should declare',
    value: suggestNamespace(editor.document.uri),
    ignoreFocusOut: true,
  });

  if (!expected) {
    return;
  }

  await replaceDocument(editor, (source) => fixNamespace(source, expected));
}

/**
 * Derives the namespace from the folders between the nearest project file (or the workspace root)
 * and the document, which is the convention the Visual Studio extension gets from the project
 * system.
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

  const document = editor.document;
  const selection = editor.selection;
  const lastLine = selection.isEmpty ? Math.min(selection.active.line + 1, document.lineCount - 1) : selection.end.line;
  const range = new vscode.Range(
    new vscode.Position(selection.start.line, 0),
    document.lineAt(lastLine).range.end
  );

  const newline = document.getText().includes('\r\n') ? '\r\n' : '\n';
  const sorted = document
    .getText(range)
    .split(/\r\n|\r|\n/)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(newline);

  await editor.edit((builder) => builder.replace(range, sorted));
}

function selectionOrNextLine(editor: vscode.TextEditor): vscode.Range {
  const selection = editor.selection;
  if (!selection.isEmpty) {
    return new vscode.Range(selection.start, selection.end);
  }

  const nextLine = Math.min(selection.active.line + 1, editor.document.lineCount - 1);

  return new vscode.Range(
    new vscode.Position(selection.active.line, 0),
    editor.document.lineAt(nextLine).range.end
  );
}

async function transformActiveDocument(languageId: string, transform: (source: string) => string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== languageId) {
    void vscode.window.showInformationMessage(`CodeJanitor: open a ${languageId} file first.`);

    return;
  }

  await replaceDocument(editor, transform);
}

async function replaceDocument(editor: vscode.TextEditor, transform: (source: string) => string): Promise<void> {
  const content = editor.document.getText();

  let output: string;
  try {
    output = transform(content);
  } catch (err) {
    void vscode.window.showErrorMessage(`CodeJanitor: ${(err as Error).message}`);

    return;
  }

  if (output === content) {
    void vscode.window.showInformationMessage('CodeJanitor: nothing to change.');

    return;
  }

  const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(content.length));
  await editor.edit((builder) => builder.replace(fullRange, output));
}
