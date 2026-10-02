import * as path from 'node:path';
import * as vscode from 'vscode';
import { CleanupFinding, analyzeCleanup, applyRuleOnly, fixFindingOccurrence } from '../cleanup/analysis';
import { EditorConfigSeverity } from '../cleanup/editorconfig';
import { discoverDisqualifiedTypeNames } from '../cleanup/transformations/sealedClass';
import { logError, logInfo } from '../logging';
import { isPathCleanable } from './cleanupCore';
import { readCleanupSettingsForUri } from './settings';

/**
 * `.editorconfig` violations as diagnostics ("Code Janitor" in the Problems panel): what cleanup
 * would change per rule and what it cannot fix, computed a moment after a C# document opens or
 * changes, and dropped when the document changed again meanwhile. Quick fixes fix one occurrence,
 * every occurrence of the rule in the file, or run the whole cleanup.
 */

const SOURCE = 'Code Janitor';
/** Pause after the last edit before a document is analyzed again. */
export const ANALYSIS_DELAY_MS = 500;

const SEVERITIES: Readonly<Record<EditorConfigSeverity, vscode.DiagnosticSeverity | undefined>> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  suggestion: vscode.DiagnosticSeverity.Information,
  silent: undefined,
  none: undefined,
};

/** Documentation of a rule, by the prefix of its id. */
const DOCUMENTATION: Readonly<Record<string, (id: string) => string>> = {
  IDE: (id) =>
    `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/${id === 'IDE1006' ? 'naming-rules' : id.toLowerCase()}`,
  CA: (id) => `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/${id.toLowerCase()}`,
  SA: (id) => `https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/${id}.md`,
  MA: (id) => `https://github.com/meziantou/Meziantou.Analyzer/blob/main/docs/Rules/${id}.md`,
};

interface Analyzed {
  readonly version: number;
  readonly entries: readonly { readonly diagnostic: vscode.Diagnostic; readonly finding: CleanupFinding }[];
  /** Occurrence fixes already computed, by finding. */
  readonly occurrenceFixes: Map<CleanupFinding, string | undefined>;
}

export function registerCleanupDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection(SOURCE);
  const diagnostics = new CleanupDiagnostics(collection);

  // The other files of a document's folder are read once; a file created, changed or deleted is read again.
  const csharpFiles = vscode.workspace.createFileSystemWatcher('**/*.cs');
  const onDisk = (uri: vscode.Uri) => diagnostics.invalidateFile(uri);

  context.subscriptions.push(
    collection,
    diagnostics,
    csharpFiles,
    csharpFiles.onDidCreate(onDisk),
    csharpFiles.onDidChange(onDisk),
    csharpFiles.onDidDelete(onDisk),
    vscode.workspace.onDidOpenTextDocument((document) => diagnostics.schedule(document)),
    vscode.workspace.onDidChangeTextDocument((event) => diagnostics.schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.forget(document.uri)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (/(?:^|[\\/])(?:\.editorconfig|\.globalconfig|\.codejanitor)$/i.test(document.uri.fsPath)) {
        diagnostics.refreshAll();
      } else {
        // The watcher only sees the workspace folders; a file saved outside them changed on disk too.
        diagnostics.invalidateFile(document.uri);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeJanitor')) {
        diagnostics.refreshAll();
      }
    }),
    vscode.languages.registerCodeActionsProvider({ language: 'csharp' }, diagnostics, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('codeJanitor.fixRuleInFile', (uri?: vscode.Uri, ruleId?: string) => diagnostics.fixRuleInFile(uri, ruleId))
  );

  vscode.workspace.textDocuments.forEach((document) => diagnostics.schedule(document));
}

export class CleanupDiagnostics implements vscode.CodeActionProvider, vscode.Disposable {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly analyzed = new Map<string, Analyzed>();
  /** The entries of each folder read so far, by folder path. */
  private readonly folders = new Map<string, Promise<readonly [string, vscode.FileType][]>>();
  /** The type names each `.cs` file read so far disqualifies from sealing, by file path. */
  private readonly disqualifiedByFile = new Map<string, Promise<ReadonlySet<string>>>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  /** Analyzes `document` once it has not changed for {@link ANALYSIS_DELAY_MS}; clears it when it is not analyzed. */
  schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (!this.isAnalyzed(document)) {
      this.forget(document.uri);

      return;
    }

    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.analyze(document);
      }, ANALYSIS_DELAY_MS)
    );
  }

  forget(uri: vscode.Uri): void {
    this.analyzed.delete(uri.toString());
    this.collection.delete(uri);
  }

  refreshAll(): void {
    this.analyzed.clear();
    vscode.workspace.textDocuments.forEach((document) => this.schedule(document));
  }

  /** `uri` was created, changed or deleted on disk: it and its folder's entries are read again when needed. */
  invalidateFile(uri: vscode.Uri): void {
    this.disqualifiedByFile.delete(uri.fsPath);
    this.folders.delete(path.dirname(uri.fsPath));
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.folders.clear();
    this.disqualifiedByFile.clear();
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const analyzed = this.analyzed.get(document.uri.toString());
    if (!analyzed || analyzed.version !== document.version) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];
    const fixAll = new Set<string>();
    for (const diagnostic of context.diagnostics.filter((candidate) => candidate.source === SOURCE)) {
      const finding = analyzed.entries.find((entry) => sameDiagnostic(entry.diagnostic, diagnostic))?.finding;
      if (!finding?.fixable || !finding.ruleId) {
        continue;
      }

      const fixed = this.occurrenceFix(document, analyzed, finding);
      if (fixed !== undefined) {
        const action = new vscode.CodeAction(`Fix ${finding.ruleId}`, vscode.CodeActionKind.QuickFix);
        action.edit = replaceText(document, fixed);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        actions.push(action);
      }

      if (!fixAll.has(finding.ruleId)) {
        fixAll.add(finding.ruleId);
        const action = new vscode.CodeAction(`Fix all ${finding.ruleId} in file`, vscode.CodeActionKind.QuickFix);
        action.command = { title: action.title, command: 'codeJanitor.fixRuleInFile', arguments: [document.uri, finding.ruleId] };
        actions.push(action);
      }
    }

    if (context.diagnostics.some((diagnostic) => diagnostic.source === SOURCE)) {
      const action = new vscode.CodeAction('Run Code Janitor cleanup', vscode.CodeActionKind.QuickFix);
      action.command = { title: action.title, command: 'codeJanitor.cleanupActiveFile' };
      actions.push(action);
    }

    return actions;
  }

  /** "Fix all <ID> in file": applies only that rule to the open document, as one edit. */
  async fixRuleInFile(uri: vscode.Uri | undefined, ruleId: string | undefined): Promise<void> {
    if (!uri || !ruleId) {
      void vscode.window.showInformationMessage('Code Janitor: use the quick fix "Fix all <rule> in file" of a Code Janitor diagnostic.');

      return;
    }

    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    if (!document) {
      void vscode.window.showWarningMessage(`Code Janitor: ${uri.fsPath} is not open; ${ruleId} was not fixed.`);

      return;
    }

    const text = document.getText();
    const settings = readCleanupSettingsForUri(uri);
    const fixed = applyRuleOnly(text, uri.fsPath, settings, ruleId, (await this.folderFacts(uri, text)).disqualifiedTypeNames);
    if (document.getText() !== text) {
      void vscode.window.showWarningMessage(`Code Janitor: ${uri.fsPath} changed while ${ruleId} was being fixed; nothing was changed.`);

      return;
    }

    if (fixed === text) {
      void vscode.window.showInformationMessage(`Code Janitor: nothing to fix for ${ruleId}.`);

      return;
    }

    if (!(await vscode.workspace.applyEdit(replaceText(document, fixed)))) {
      void vscode.window.showWarningMessage(`Code Janitor: VS Code did not apply the fix of ${ruleId} to ${uri.fsPath}.`);

      return;
    }

    logInfo(`Fixed every ${ruleId} occurrence in ${uri.fsPath}.`);
  }

  private isAnalyzed(document: vscode.TextDocument): boolean {
    const config = vscode.workspace.getConfiguration('codeJanitor');

    return (
      document.languageId === 'csharp' &&
      document.uri.scheme === 'file' &&
      config.get<boolean>('diagnostics.enabled', true) &&
      document.getText().length <= config.get<number>('diagnostics.maxFileSizeKB', 256) * 1024 &&
      isPathCleanable(document.uri)
    );
  }

  /**
   * The type names `text` and the other `.cs` files of its folder disqualify from sealing, and the
   * `.cs` names of the folder. The folder and its files are read once, until {@link invalidateFile}.
   */
  private async folderFacts(uri: vscode.Uri, text: string): Promise<{ disqualifiedTypeNames: Set<string>; siblingFileNames: Set<string> }> {
    const directory = path.dirname(uri.fsPath);
    let entries = this.folders.get(directory);
    if (!entries) {
      entries = Promise.resolve(vscode.workspace.fs.readDirectory(vscode.Uri.file(directory))).catch(() => []);
      this.folders.set(directory, entries);
    }

    const csharp = (await entries).filter(([name]) => name.toLowerCase().endsWith('.cs'));
    const disqualifiedTypeNames = discoverDisqualifiedTypeNames([text]);
    for (const [name, type] of csharp) {
      const file = path.join(directory, name);
      if ((type & vscode.FileType.File) !== 0 && file !== uri.fsPath) {
        (await this.disqualifiedBy(file)).forEach((typeName) => disqualifiedTypeNames.add(typeName));
      }
    }

    return { disqualifiedTypeNames, siblingFileNames: new Set(csharp.map(([name]) => name)) };
  }

  /** The type names the file on disk disqualifies from sealing; none when it cannot be read. */
  private disqualifiedBy(file: string): Promise<ReadonlySet<string>> {
    let names = this.disqualifiedByFile.get(file);
    if (!names) {
      names = Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(file))).then(
        (bytes) => discoverDisqualifiedTypeNames([Buffer.from(bytes).toString('utf8')]),
        () => new Set<string>()
      );
      this.disqualifiedByFile.set(file, names);
    }

    return names;
  }

  private async analyze(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const version = document.version;
    if (this.analyzed.get(key)?.version === version) {
      return;
    }

    try {
      const text = document.getText();
      const { disqualifiedTypeNames, siblingFileNames } = await this.folderFacts(document.uri, text);
      // Superseded while reading the folder: the newer version is analyzed instead.
      if (document.isClosed || document.version !== version) {
        return;
      }

      const settings = readCleanupSettingsForUri(document.uri);
      const { findings } = analyzeCleanup(text, document.uri.fsPath, settings, { disqualifiedTypeNames, siblingFileNames });
      const lines = text.split('\n');
      const entries = findings.flatMap((finding) => {
        const diagnostic = toDiagnostic(finding, lines);

        return diagnostic ? [{ diagnostic, finding }] : [];
      });
      this.analyzed.set(key, { version, entries, occurrenceFixes: new Map() });
      this.collection.set(
        document.uri,
        entries.map((entry) => entry.diagnostic)
      );
    } catch (err) {
      logError(`Code Janitor diagnostics of ${document.uri.fsPath}`, err);
      this.forget(document.uri);
    }
  }

  private occurrenceFix(document: vscode.TextDocument, analyzed: Analyzed, finding: CleanupFinding): string | undefined {
    if (!analyzed.occurrenceFixes.has(finding)) {
      const settings = readCleanupSettingsForUri(document.uri);
      analyzed.occurrenceFixes.set(finding, fixFindingOccurrence(document.getText(), document.uri.fsPath, settings, finding));
    }

    return analyzed.occurrenceFixes.get(finding);
  }
}

function toDiagnostic(finding: CleanupFinding, lines: readonly string[]): vscode.Diagnostic | undefined {
  const severity = finding.severity ? SEVERITIES[finding.severity] : vscode.DiagnosticSeverity.Information;
  if (!finding.ruleId || finding.fileLevel || severity === undefined) {
    return undefined;
  }

  const range = new vscode.Range(
    new vscode.Position(finding.startLine, finding.startCharacter ?? 0),
    new vscode.Position(finding.endLine, finding.endCharacter ?? (lines[finding.endLine] ?? '').replace(/\r$/, '').length)
  );
  const diagnostic = new vscode.Diagnostic(range, finding.fixable ? finding.message : `${finding.message} (not fixed by Code Janitor)`, severity);
  diagnostic.source = SOURCE;
  const documentation = DOCUMENTATION[/^[A-Z]+/.exec(finding.ruleId)?.[0] ?? '']?.(finding.ruleId.split('/')[0]);
  diagnostic.code = documentation ? { value: finding.ruleId, target: vscode.Uri.parse(documentation) } : finding.ruleId;

  return diagnostic;
}

/** The diagnostics VS Code passes back to code actions are copies: they are matched by rule, place and message. */
function sameDiagnostic(a: vscode.Diagnostic, b: vscode.Diagnostic): boolean {
  const code = (diagnostic: vscode.Diagnostic) => (typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code);

  return (
    code(a) === code(b) &&
    a.message === b.message &&
    a.range.start.line === b.range.start.line &&
    a.range.start.character === b.range.start.character &&
    a.range.end.line === b.range.end.line
  );
}

/** One edit replacing the part of the document that differs from `text`. */
function replaceText(document: vscode.TextDocument, text: string): vscode.WorkspaceEdit {
  const current = document.getText();
  let start = 0;
  while (start < current.length && start < text.length && current[start] === text[start]) {
    start++;
  }

  let end = 0;
  while (end < current.length - start && end < text.length - start && current[current.length - 1 - end] === text[text.length - 1 - end]) {
    end++;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(start), document.positionAt(current.length - end)),
    text.slice(start, text.length - end)
  );

  return edit;
}
