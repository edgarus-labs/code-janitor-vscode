import * as vscode from 'vscode';
import { runCleanup, runLayoutCleanup } from '../cleanup/runCleanup';
import { readCleanupSettings } from './settings';

interface CollectedFile {
  uri: vscode.Uri;
  content: string;
  isOpen: boolean;
}

interface CleanupResult {
  uri: vscode.Uri;
  output: string;
  changed: boolean;
  isOpen: boolean;
  error?: string;
}

/**
 * Reads the given file URIs (preferring the live editor buffer when a file is already open, so
 * unsaved changes are cleaned too), runs the cleanup pipeline in-process, and applies each changed
 * result back - through a WorkspaceEdit for open documents, or a direct file write otherwise.
 */
export async function runCleanupOnUris(
  _context: vscode.ExtensionContext,
  uris: vscode.Uri[]
): Promise<{ changed: number; failed: number }> {
  const targets = uris.filter(isSupportedFile);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('CodeJanitor: no files to clean up.');

    return { changed: 0, failed: 0 };
  }

  const collected = await collectFiles(targets);
  const settings = readCleanupSettings();

  const results: CleanupResult[] = collected.map((file) => {
    try {
      const output = isCSharp(file.uri)
        ? runCleanup(file.content, file.uri.fsPath, settings)
        : runLayoutCleanup(file.content, file.uri.fsPath, settings);

      return { uri: file.uri, output, changed: output !== file.content, isOpen: file.isOpen };
    } catch (err) {
      return { uri: file.uri, output: file.content, changed: false, isOpen: file.isOpen, error: (err as Error).message };
    }
  });

  return applyResults(results);
}

export function isCSharp(uri: vscode.Uri): boolean {
  return uri.fsPath.toLowerCase().endsWith('.cs');
}

/** Other languages are only cleaned when the user opts in, and then only with the layout rules. */
export function isSupportedFile(uri: vscode.Uri): boolean {
  if (isCSharp(uri)) {
    return true;
  }

  return vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.includeOtherFileTypes', false);
}

async function collectFiles(uris: vscode.Uri[]): Promise<CollectedFile[]> {
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

async function applyResults(results: readonly CleanupResult[]): Promise<{ changed: number; failed: number }> {
  const edit = new vscode.WorkspaceEdit();
  let changed = 0;
  let failed = 0;

  for (const result of results) {
    if (result.error) {
      failed++;
      void vscode.window.showWarningMessage(`CodeJanitor: ${result.uri.fsPath} - ${result.error}`);
      continue;
    }

    if (!result.changed) {
      continue;
    }

    changed++;

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

  return { changed, failed };
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
