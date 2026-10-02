import * as path from 'node:path';
import * as vscode from 'vscode';
import { EditorConfigIssueListener } from '../cleanup/runCleanup';
import { planWorkspaceRenames, SourceText, workspaceRenameInputs } from '../cleanup/naming/workspaceRenamer';
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

  // The C# files the plan may need (not the other projects of the workspace), as the editor has them:
  // the open document, else the file on disk decoded as UTF-8 (VS Code keeps a byte order mark as the
  // encoding, never in the text, and the decoder drops it). A file that is not UTF-8 is decoded lossily
  // for the analysis and marked so: the rename never rewrites it.
  const open = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.fsPath, document]));
  const projects = discoverProjects(roots);
  const texts = new Map<string, SourceText>();
  for (const filePath of workspaceRenameInputs(projects, files)) {
    const document = open.get(filePath);
    if (document) {
      texts.set(filePath, { text: document.getText(), utf8: true });
      continue;
    }

    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    try {
      texts.set(filePath, { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), utf8: true });
    } catch {
      texts.set(filePath, { text: new TextDecoder('utf-8').decode(bytes), utf8: false });
    }
  }

  const read = (filePath: string): SourceText => {
    const source = texts.get(filePath);
    if (source === undefined) {
      throw new Error(`${filePath} is neither a cleaned file nor a file the workspace-wide rename reads.`);
    }

    return source;
  };
  const plan = planWorkspaceRenames({ projects, targets: files, read });
  for (const issue of plan.issues) {
    report({ kind: 'unresolved', filePath: issue.filePath, detail: issue.detail });
    account(issue.filePath, issue.symbol);
  }

  if (plan.renames.length === 0) {
    return;
  }

  const lines = plan.renames.map((rename) => {
    const [first] = rename.declarations;

    return `${rename.oldName} → ${rename.newName} (${rename.kind} in ${path.basename(first.filePath)} line ${first.line}, ${rename.files.length} file(s))`;
  });
  const choice = await vscode.window.showWarningMessage(
    `Code Janitor: rename ${plan.renames.length} symbol(s) in ${plan.contents.size} file(s) of the workspace to follow the .editorconfig naming rules?`,
    { modal: true, detail: lines.join('\n') },
    'Rename'
  );
  const reportNotRenamed = (outcome: string) => {
    for (const rename of plan.renames) {
      for (const declaration of rename.declarations) {
        report({
          kind: 'unresolved',
          filePath: declaration.filePath,
          detail: `IDE1006 line ${declaration.line}: ${rename.kind} '${rename.oldName}' should be named '${rename.newName}'; ${outcome}.`,
        });
        account(declaration.filePath, rename.oldName);
      }
    }
  };
  if (choice !== 'Rename') {
    reportNotRenamed('the workspace-wide rename was cancelled');

    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const [filePath, content] of plan.contents) {
    edit.replace(vscode.Uri.file(filePath), wholeText(read(filePath).text), content);
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
