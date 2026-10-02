import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Groups of related file endings, separated by `||`, the endings of a group by spaces - the format
 * of the Visual Studio extension's setting. Switch File goes from a file to the same name with
 * another ending of its group. Besides the Visual Studio groups: C headers, Razor components with
 * their CSS, designer files and the files of a TypeScript component.
 */
export const DEFAULT_RELATED_FILE_EXTENSIONS =
  '.cpp .h||.c .h||.xaml .xaml.cs||.xml .xsd||.ascx .ascx.cs||.aspx .aspx.cs||.master .master.cs||.cshtml .cshtml.cs||.razor .razor.cs .razor.css||.cs .designer.cs||.ts .html .css';

/** The groups of an expression: lower case, groups of fewer than two endings are ignored. */
export function parseRelatedFileExtensions(expression: string): string[][] {
  return expression
    .split('||')
    .map((group) =>
      group
        .split(' ')
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension.length > 0)
    )
    .filter((group) => group.length >= 2);
}

/**
 * The candidate paths of the files related to `filePath`, most likely first. For each ending of a
 * group the path ends with (ignoring case), the other endings of that group replace it: first the
 * endings listed after it, then those listed before it, as in the Visual Studio extension.
 */
export function relatedFileCandidates(filePath: string, groups: readonly (readonly string[])[]): string[] {
  const candidates: string[] = [];
  const lowerPath = filePath.toLowerCase();
  for (const group of groups) {
    for (const extension of group) {
      if (!lowerPath.endsWith(extension)) {
        continue;
      }

      const stem = filePath.slice(0, filePath.length - extension.length);
      const matching = group.indexOf(extension);
      const after = group.filter((other, index) => other !== extension && index > matching);
      const before = group.filter((other, index) => other !== extension && index < matching);
      candidates.push(...[...after, ...before].map((other) => stem + other));
    }
  }

  return candidates;
}

/** The first candidate that exists, with the file name's case as it is on disk; `undefined` when none does. */
export async function findRelatedFile(filePath: string, groups: readonly (readonly string[])[]): Promise<string | undefined> {
  const candidates = relatedFileCandidates(filePath, groups);
  if (candidates.length === 0) {
    return undefined;
  }

  const directory = path.dirname(filePath);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
  } catch {
    return undefined;
  }

  const names = new Map(entries.filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => [name.toLowerCase(), name]));
  for (const candidate of candidates) {
    const name = names.get(path.basename(candidate).toLowerCase());
    if (name !== undefined && name.toLowerCase() !== path.basename(filePath).toLowerCase()) {
      return path.join(directory, name);
    }
  }

  return undefined;
}

/**
 * Switch File: opens the file related to `uri` (the right-clicked tab, from the editor tab menu) or,
 * without one, to the active editor's file (code-behind, designer, header, template, style).
 */
export async function switchFile(uri?: vscode.Uri): Promise<void> {
  const source = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!source || source.scheme !== 'file') {
    void vscode.window.showInformationMessage('Code Janitor: no active file to switch from.');

    return;
  }

  const expression = vscode.workspace.getConfiguration('codeJanitor').get<string>('switching.relatedFileExtensions', DEFAULT_RELATED_FILE_EXTENSIONS);
  const target = await findRelatedFile(source.fsPath, parseRelatedFileExtensions(expression));
  if (target === undefined) {
    void vscode.window.showInformationMessage(`Code Janitor: no related file found for ${path.basename(source.fsPath)}.`);

    return;
  }

  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
}
