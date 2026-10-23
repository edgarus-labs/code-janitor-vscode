import * as path from 'node:path';
import * as vscode from 'vscode';
import { REPOSITORY_CONFIG_NAMES } from '../cleanup/repositoryOverrides';
import { EngineDiagnostic } from '../engine/protocol';
import { documentParams, engine, reportEngineUnavailable } from '../engine/vscodeEngine';
import { logError, logInfo } from '../logging';
import { applyFileOutcome, engineOutcome, isPathCleanable } from './cleanupCore';

/**
 * `.editorconfig` violations as diagnostics ("Code Janitor" in the Problems panel): what cleanup
 * would fix and what it cannot, as the C# engine analyzes them a moment after a C# document is shown
 * in an editor tab or changes, and dropped when the document changed again meanwhile. Documents a command
 * opens without showing them (the preview apply, the rename) are not analyzed. Quick fixes fix one
 * occurrence, every occurrence of the rule in the file, or run the whole cleanup.
 */

const SOURCE = 'Code Janitor';
/** Pause after the last edit before a document is analyzed again. */
export const ANALYSIS_DELAY_MS = 500;
/** The files whose saving changes the settings of every document (matched ignoring case). */
const SETTINGS_FILE_NAMES: ReadonlySet<string> = new Set(['.editorconfig', '.globalconfig', ...REPOSITORY_CONFIG_NAMES]);

/** The engine's severities (`.editorconfig` and Roslyn names alike); hidden ones are not shown. */
const SEVERITIES: Readonly<Record<string, vscode.DiagnosticSeverity | undefined>> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  suggestion: vscode.DiagnosticSeverity.Information,
  info: vscode.DiagnosticSeverity.Information,
  silent: undefined,
  hidden: undefined,
  none: undefined,
};

/** Documentation of a rule, by the prefix of its id. */
const DOCUMENTATION: Readonly<Record<string, (id: string) => string>> = {
  IDE: (id) => `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/${id === 'IDE1006' ? 'naming-rules' : id.toLowerCase()}`,
  CA: (id) => `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/${id.toLowerCase()}`,
  SA: (id) => `https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/${id}.md`,
  MA: (id) => `https://github.com/meziantou/Meziantou.Analyzer/blob/main/docs/Rules/${id}.md`,
};

interface Analyzed {
  readonly version: number;
  readonly entries: readonly { readonly diagnostic: vscode.Diagnostic; readonly finding: EngineDiagnostic }[];
}

/** A quick fix of one occurrence; its edit is computed by the engine when VS Code resolves it. */
class OccurrenceFix extends vscode.CodeAction {
  constructor(
    readonly document: vscode.TextDocument,
    readonly version: number,
    readonly finding: EngineDiagnostic
  ) {
    super(`Fix ${finding.id}`, vscode.CodeActionKind.QuickFix);
  }
}

export function registerCleanupDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection(SOURCE);
  const diagnostics = new CleanupDiagnostics(collection);

  context.subscriptions.push(
    collection,
    diagnostics,
    vscode.workspace.onDidOpenTextDocument((document) => diagnostics.schedule(document)),
    vscode.workspace.onDidChangeTextDocument((event) => diagnostics.schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.forget(document.uri)),
    // A document is shown once its tab opens (after the document itself), and no longer once its last tab closes.
    vscode.window.tabGroups.onDidChangeTabs(({ opened, closed }) => {
      const uris = new Set([...opened, ...closed].map((tab) => tabUri(tab)?.toString()));
      vscode.workspace.textDocuments.filter((document) => uris.has(document.uri.toString())).forEach((document) => diagnostics.schedule(document));
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (SETTINGS_FILE_NAMES.has(path.win32.basename(document.uri.fsPath).toLowerCase())) {
        diagnostics.refreshAll();
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

export class CleanupDiagnostics implements vscode.CodeActionProvider<vscode.CodeAction>, vscode.Disposable {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly analyzed = new Map<string, Analyzed>();
  /** The analysis the engine is running for each document, with the version it was started for. */
  private readonly inFlight = new Map<string, { readonly source: vscode.CancellationTokenSource; readonly version: number }>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  /**
   * Analyzes `document` once it has not changed for {@link ANALYSIS_DELAY_MS}; clears it when it is not analyzed. An
   * analysis of an older text still running in the engine is cancelled.
   */
  schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (this.inFlight.get(key)?.version !== document.version) {
      this.cancelAnalysis(key);
    }

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

  /**
   * Clears what is known of `uri`, its pending and running analysis included; the Problems panel is updated only when it
   * shows something for it.
   */
  forget(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.cancelAnalysis(key);
    this.analyzed.delete(key);
    if (this.collection.has(uri)) {
      this.collection.delete(uri);
    }
  }

  refreshAll(): void {
    this.analyzed.clear();
    this.cancelAllAnalyses();
    vscode.workspace.textDocuments.forEach((document) => this.schedule(document));
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.cancelAllAnalyses();
  }

  private cancelAllAnalyses(): void {
    [...this.inFlight.keys()].forEach((key) => this.cancelAnalysis(key));
  }

  private cancelAnalysis(key: string): void {
    this.inFlight.get(key)?.source.cancel();
    this.inFlight.delete(key);
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
      if (!finding?.fixable) {
        continue;
      }

      const occurrence = new OccurrenceFix(document, document.version, finding);
      occurrence.diagnostics = [diagnostic];
      occurrence.isPreferred = true;
      actions.push(occurrence);

      if (!fixAll.has(finding.id)) {
        fixAll.add(finding.id);
        const action = new vscode.CodeAction(`Fix all ${finding.id} in file`, vscode.CodeActionKind.QuickFix);
        action.command = { title: action.title, command: 'codeJanitor.fixRuleInFile', arguments: [document.uri, finding.id] };
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

  /** The edit of a "Fix <ID>" quick fix: the engine fixes the rule on the diagnostic's line only. */
  async resolveCodeAction(action: vscode.CodeAction, token: vscode.CancellationToken): Promise<vscode.CodeAction> {
    if (!(action instanceof OccurrenceFix) || action.document.isClosed || action.document.version !== action.version) {
      return action;
    }

    const text = action.document.getText();
    try {
      const result = await engine().fixRule({ ...documentParams(action.document.uri, text), ruleId: action.finding.id, line: action.finding.startLine }, token);
      if (action.document.version === action.version && result.text !== text && result.otherFiles.length === 0 && result.newFiles.length === 0) {
        action.edit = replaceText(action.document, result.text.replace(/^\uFEFF/, ''));
      }
    } catch (err) {
      if (!token.isCancellationRequested && !reportEngineUnavailable(err)) {
        logError(`Fix ${action.finding.id} in ${action.document.uri.fsPath}`, err);
      }
    }

    return action;
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

    const file = { uri, content: document.getText(), isOpen: true };
    let outcome;
    try {
      outcome = engineOutcome(uri, await engine().fixRule({ ...documentParams(uri, file.content), ruleId }), `Fix all ${ruleId}`);
    } catch (err) {
      if (!reportEngineUnavailable(err)) {
        logError(`Fix all ${ruleId} in ${uri.fsPath}`, err);
        void vscode.window.showWarningMessage(`Code Janitor: ${ruleId} was not fixed in ${uri.fsPath} - ${(err as Error).message}`);
      }

      return;
    }

    if (document.getText() !== file.content) {
      void vscode.window.showWarningMessage(`Code Janitor: ${uri.fsPath} changed while ${ruleId} was being fixed; nothing was changed.`);

      return;
    }

    if (outcome.text === file.content && outcome.otherFiles.length === 0 && outcome.newFiles.length === 0) {
      void vscode.window.showInformationMessage(`Code Janitor: nothing to fix for ${ruleId}.`);

      return;
    }

    try {
      await applyFileOutcome(file, outcome);
    } catch (err) {
      void vscode.window.showWarningMessage(`Code Janitor: the fix of ${ruleId} was not applied to ${uri.fsPath} - ${(err as Error).message}`);

      return;
    }

    logInfo(`Fixed every ${ruleId} occurrence in ${uri.fsPath}.`);
  }

  private isAnalyzed(document: vscode.TextDocument): boolean {
    const config = vscode.workspace.getConfiguration('codeJanitor');
    const key = document.uri.toString();

    return (
      document.languageId === 'csharp' &&
      document.uri.scheme === 'file' &&
      config.get<boolean>('diagnostics.enabled', true) &&
      document.getText().length <= config.get<number>('diagnostics.maxFileSizeKB', 256) * 1024 &&
      isPathCleanable(document.uri) &&
      vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tabUri(tab)?.toString() === key))
    );
  }

  private async analyze(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const version = document.version;
    if (this.analyzed.get(key)?.version === version || this.inFlight.get(key)?.version === version) {
      return;
    }

    const source = new vscode.CancellationTokenSource();
    this.inFlight.set(key, { source, version });
    try {
      const { diagnostics } = await engine().analyze(documentParams(document.uri, document.getText()), source.token);
      // Superseded while the engine analyzed: the newer version is analyzed instead.
      if (source.token.isCancellationRequested || document.isClosed || document.version !== version) {
        return;
      }

      const entries = diagnostics.flatMap((finding) => {
        const diagnostic = toDiagnostic(finding);

        return diagnostic ? [{ diagnostic, finding }] : [];
      });
      this.analyzed.set(key, { version, entries });
      this.collection.set(
        document.uri,
        entries.map((entry) => entry.diagnostic)
      );
    } catch (err) {
      if (source.token.isCancellationRequested) {
        return;
      }

      if (!reportEngineUnavailable(err)) {
        logError(`Code Janitor diagnostics of ${document.uri.fsPath}`, err);
      }

      this.forget(document.uri);
    } finally {
      if (this.inFlight.get(key)?.source === source) {
        this.inFlight.delete(key);
      }

      source.dispose();
    }
  }
}

function toDiagnostic(finding: EngineDiagnostic): vscode.Diagnostic | undefined {
  const severity = SEVERITIES[finding.severity.toLowerCase()];
  if (severity === undefined) {
    return undefined;
  }

  const range = new vscode.Range(new vscode.Position(finding.startLine, finding.startColumn), new vscode.Position(finding.endLine, finding.endColumn));
  const diagnostic = new vscode.Diagnostic(range, finding.fixable ? finding.message : `${finding.message} (not fixed by Code Janitor)`, severity);
  diagnostic.source = SOURCE;
  const documentation = finding.helpLink || DOCUMENTATION[/^[A-Z]+/.exec(finding.id)?.[0] ?? '']?.(finding.id);
  diagnostic.code = documentation ? { value: finding.id, target: vscode.Uri.parse(documentation) } : finding.id;

  return diagnostic;
}

/** The document a text editor tab shows (`TabInputText`); none for diffs, webviews and the like. */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  return (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
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
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(current.length - end)), text.slice(start, text.length - end));

  return edit;
}
