import * as path from 'node:path';
import * as vscode from 'vscode';
import { EditorConfigIssueListener } from '../cleanup/runCleanup';
import { planWorkspaceRenames } from '../cleanup/naming/workspaceRenamer';
import { discoverProjects } from '../cleanup/naming/workspaceScope';
import { logInfo } from '../logging';

/**
 * The workspace-wide rename of Cleanup Selected Files and Cleanup Workspace
 * (`codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace`): plans the renames of the non-private
 * symbols the target files declare, shows them in a modal dialog, and applies them as one
 * WorkspaceEdit (one undo step). Violations it cannot rename go to `report`. `accounted` receives,
 * by file, the symbols whose violations it renamed or reported, including when it then throws.
 */
export async function renameSymbolsAcrossWorkspace(
  targets: readonly vscode.Uri[],
  report: EditorConfigIssueListener,
  accounted: Map<string, Set<string>>
): Promise<void> {
  const account = (filePath: string, symbol: string) => {
    const symbols = accounted.get(filePath) ?? new Set<string>();
    symbols.add(symbol);
    accounted.set(filePath, symbols);
  };
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const files = targets.filter((uri) => uri.scheme === 'file' && uri.fsPath.toLowerCase().endsWith('.cs')).map((uri) => uri.fsPath);
  if (roots.length === 0 || files.length === 0) {
    return;
  }

  // Every C# file of the workspace's projects and every target, as the editor has it: the open
  // document, else the file on disk without its byte order mark (VS Code keeps the BOM as the encoding,
  // never in the text, so an edit must not contain it).
  const open = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.fsPath, document]));
  const projects = discoverProjects(roots);
  const texts = new Map<string, string>();
  for (const filePath of new Set([...projects.flatMap((project) => project.csharpFiles), ...files])) {
    const document = open.get(filePath);
    texts.set(
      filePath,
      document ? document.getText() : Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString('utf8').replace(/^\uFEFF/, '')
    );
  }

  const read = (filePath: string): string => {
    const text = texts.get(filePath);
    if (text === undefined) {
      throw new Error(`${filePath} is neither a cleaned file nor a file of a project of the workspace.`);
    }

    return text;
  };
  const plan = planWorkspaceRenames({ projects, targets: files, read });
  for (const issue of plan.issues) {
    report({ kind: 'unresolved', filePath: issue.filePath, detail: issue.detail });
    account(issue.filePath, issue.symbol);
  }

  if (plan.renames.length === 0) {
    return;
  }

  const lines = plan.renames.map(
    (rename) =>
      `${rename.oldName} → ${rename.newName} (${rename.kind} in ${path.basename(rename.declaredIn)} line ${rename.line}, ${rename.files.length} file(s))`
  );
  const choice = await vscode.window.showWarningMessage(
    `Code Janitor: rename ${plan.renames.length} symbol(s) in ${plan.contents.size} file(s) of the workspace to follow the .editorconfig naming rules?`,
    { modal: true, detail: lines.join('\n') },
    'Rename'
  );
  const reportNotRenamed = (outcome: string) => {
    for (const rename of plan.renames) {
      report({
        kind: 'unresolved',
        filePath: rename.declaredIn,
        detail: `IDE1006 line ${rename.line}: ${rename.kind} '${rename.oldName}' should be named '${rename.newName}'; ${outcome}.`,
      });
      account(rename.declaredIn, rename.oldName);
    }
  };
  if (choice !== 'Rename') {
    reportNotRenamed('the workspace-wide rename was cancelled');

    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const [filePath, content] of plan.contents) {
    edit.replace(vscode.Uri.file(filePath), wholeText(read(filePath)), content);
  }

  if (!(await vscode.workspace.applyEdit(edit))) {
    reportNotRenamed('VS Code did not apply the workspace-wide rename');
    throw new Error('VS Code did not apply the workspace-wide rename; no file was changed.');
  }

  for (const rename of plan.renames) {
    rename.files.forEach((filePath) => account(filePath, rename.oldName));
  }

  // Files that were closed are opened by the edit: save them, like the rest of batch cleanup.
  for (const filePath of plan.contents.keys()) {
    if (!open.has(filePath)) {
      await vscode.workspace.textDocuments.find((document) => document.uri.fsPath === filePath)?.save();
    }
  }

  logInfo(`Workspace-wide rename (.editorconfig naming rules): ${plan.renames.length} symbol(s) renamed in ${plan.contents.size} file(s): ${lines.join('; ')}.`);
}

function wholeText(text: string): vscode.Range {
  const lines = text.split('\n');

  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lines.length - 1, lines[lines.length - 1].length));
}
