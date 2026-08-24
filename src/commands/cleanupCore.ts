import * as vscode from 'vscode';
import { EngineFile, EngineFileResult, resolveEngineDll, runEngine } from '../engine/client';
import { buildEngineSettings, getDotnetPath } from '../engine/settings';

interface CollectedFile {
  uri: vscode.Uri;
  content: string;
  isOpen: boolean;
}

/**
 * Reads the given C# file URIs (preferring the live editor buffer when a file is already open,
 * so unsaved changes are cleaned too), runs the engine once for the whole batch, and applies
 * each changed result back - through a WorkspaceEdit for open documents, or a direct file write
 * for files that are not currently open in an editor.
 */
export async function runCleanupOnUris(context: vscode.ExtensionContext, uris: vscode.Uri[]): Promise<{ changed: number; failed: number }> {
  const csharpUris = uris.filter((u) => u.fsPath.toLowerCase().endsWith('.cs'));
  if (csharpUris.length === 0) {
    void vscode.window.showInformationMessage('CodeJanitor: no C# files to clean up.');

    return { changed: 0, failed: 0 };
  }

  const collected = await collectFiles(csharpUris);
  const engineDll = resolveEngineDll(context.extensionUri);
  const dotnetPath = getDotnetPath();
  const settings = buildEngineSettings();

  const files: EngineFile[] = collected.map((f) => ({ path: f.uri.fsPath, content: f.content }));

  let results: EngineFileResult[];
  try {
    results = await runEngine(dotnetPath, engineDll, { settings, files });
  } catch (err) {
    void vscode.window.showErrorMessage(`CodeJanitor: cleanup engine failed - ${(err as Error).message}`);

    return { changed: 0, failed: collected.length };
  }

  return applyResults(collected, results);
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

async function applyResults(collected: CollectedFile[], results: EngineFileResult[]): Promise<{ changed: number; failed: number }> {
  const resultsByPath = new Map(results.map((r) => [r.path, r]));
  let changed = 0;
  let failed = 0;

  const edit = new vscode.WorkspaceEdit();

  for (const file of collected) {
    const result = resultsByPath.get(file.uri.fsPath);
    if (!result) {
      continue;
    }

    if (result.error) {
      failed++;
      void vscode.window.showWarningMessage(`CodeJanitor: ${file.uri.fsPath} - ${result.error}`);
      continue;
    }

    if (!result.changed) {
      continue;
    }

    changed++;

    if (file.isOpen) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
      if (doc) {
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(file.uri, fullRange, result.output);
      }
    } else {
      await vscode.workspace.fs.writeFile(file.uri, Buffer.from(result.output, 'utf8'));
    }
  }

  if (edit.size > 0) {
    await vscode.workspace.applyEdit(edit);
  }

  return { changed, failed };
}

export async function expandToCSharpFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type === vscode.FileType.Directory) {
    return vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.cs'), '**/{bin,obj}/**');
  }

  return [uri];
}
