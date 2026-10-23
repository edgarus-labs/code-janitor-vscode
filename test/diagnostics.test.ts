import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken } from 'vscode-jsonrpc';
import {
  CancellationTokenSource,
  Diagnostic,
  DiagnosticSeverity,
  TextDocument,
  Uri,
  createContext,
  resetMock,
  showInTab,
  state,
  workspace,
} from './helpers/vscodeMock';
import { ANALYSIS_DELAY_MS, CleanupDiagnostics, registerCleanupDiagnostics } from '../src/commands/diagnostics';
import { createOutputChannel } from '../src/logging';
import { EngineDiagnostic } from '../src/engine/protocol';
import { EngineParams, FakeEngine, cleanupResult, useFakeEngine } from './helpers/fakeEngine';

const SOURCE = [
  'namespace Demo;',
  '',
  'internal class Counter',
  '{',
  '    public int total;',
  '',
  '    public void Add(int value)',
  '    {',
  '        if (value > 0)',
  '            total += value;',
  '',
  '        if (value < 0)',
  '            total -= value;',
  '    }',
  '}',
  '',
].join('\n');

/** What the fake engine finds: IDE0011 on every `if` without braces, IDE1006 on `total` (not fixable), a hidden IDE0055. */
function analyze(text: string): EngineDiagnostic[] {
  const lines = text.split('\n');
  const braces = lines.flatMap((line, index) =>
    /^\s*if \(/.test(line) && !/^\s*\{/.test(lines[index + 1] ?? '')
      ? [
          {
            id: 'IDE0011',
            message: 'Add braces',
            severity: 'warning',
            startLine: index,
            startColumn: 8,
            endLine: index + 1,
            endColumn: lines[index + 1].length,
            fixable: true,
            helpLink: null,
          },
        ]
      : []
  );
  const naming = lines.flatMap((line, index) =>
    line.includes('public int total;')
      ? [
          {
            id: 'IDE1006',
            message: "Naming rule violation: 'total'",
            severity: 'suggestion',
            startLine: index,
            startColumn: 15,
            endLine: index,
            endColumn: 20,
            fixable: false,
            helpLink: 'https://example.test/naming',
          },
        ]
      : []
  );

  return [
    ...braces,
    ...naming,
    { id: 'IDE0055', message: 'Fix formatting', severity: 'hidden', startLine: 0, startColumn: 0, endLine: 0, endColumn: 1, fixable: true, helpLink: null },
  ];
}

/** Adds braces to the `if` on `line` (0-based), or to every `if` without a line. */
function addBraces(text: string, line?: number): string {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^\s*if \(/.test(lines[index]) && !/^\s*\{/.test(lines[index + 1] ?? '') && (line === undefined || line === index)) {
      const indent = /^\s*/.exec(lines[index])![0];
      lines.splice(index + 1, 1, `${indent}{`, lines[index + 1], `${indent}}`);
    }
  }

  return lines.join('\n');
}

/** Lets the in-memory engine answer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await nextTurn();
  }
}

let root: string;
let document: TextDocument;
let engine: FakeEngine;

beforeEach(() => {
  resetMock();
  // Only the pause before an analysis is faked: the in-memory engine needs real immediates.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  engine = useFakeEngine({
    analyze: (params) => ({ diagnostics: analyze(params.text) }),
    fixRule: (params: EngineParams) => cleanupResult(addBraces(params.text, params.line as number | undefined)),
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-diagnostics-'));
  document = new TextDocument(Uri.file(path.join(root, 'Counter.cs')), SOURCE, 'csharp');
  state.documents.push(document);
  showInTab(document.uri);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

const published = () => state.diagnostics.get(document.uri.toString()) ?? [];
const summary = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((diagnostic) => ({
    code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
    severity: diagnostic.severity,
    lines: [diagnostic.range.start.line, diagnostic.range.end.line],
  }));

function edit(text: string): void {
  document.setText(text);
  state.documentListeners.change.forEach((listener) => listener({ document }));
}

describe('.editorconfig diagnostics', () => {
  it('shows each diagnostic of the engine with its severity and a link to the rule, once the document is analyzed', async () => {
    registerCleanupDiagnostics(createContext());
    expect(published()).toEqual([]);

    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    expect(summary(published())).toEqual([
      { code: 'IDE0011', severity: DiagnosticSeverity.Warning, lines: [8, 9] },
      { code: 'IDE0011', severity: DiagnosticSeverity.Warning, lines: [11, 12] },
      { code: 'IDE1006', severity: DiagnosticSeverity.Information, lines: [4, 4] },
    ]);
    const braces = published()[0];
    expect(braces.source).toBe('Code Janitor');
    expect(braces.code).toMatchObject({ target: { fsPath: 'learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0011' } });
    expect(published()[2].code).toMatchObject({ target: { fsPath: 'example.test/naming' } });
    expect(published()[2].message).toContain('(not fixed by Code Janitor)');
    expect(engine.requests('analyze')).toEqual([
      expect.objectContaining({ filePath: document.uri.fsPath, text: SOURCE, settings: expect.objectContaining({ removeRegions: true }) }),
    ]);
  });

  it('analyzes only the latest text once the edits pause', async () => {
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS - 1);
    edit(SOURCE.replace('        if (value < 0)\n            total -= value;\n', ''));
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS - 1);
    await settle();

    expect(published()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(summary(published()).map((diagnostic) => diagnostic.code)).toEqual(['IDE0011', 'IDE1006']);
    expect(engine.requests('analyze')).toHaveLength(1);
  });

  it('shows nothing when diagnostics are turned off or the file is too large, and clears them on close', async () => {
    state.configuration.set('codeJanitor.diagnostics.maxFileSizeKB', 0.1);
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    expect(published()).toEqual([]);

    state.configuration.set('codeJanitor.diagnostics.maxFileSizeKB', 256);
    edit(SOURCE);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    expect(published()).toHaveLength(3);

    state.documentListeners.close.forEach((listener) => listener(document));
    expect(state.diagnostics.has(document.uri.toString())).toBe(false);

    state.configuration.set('codeJanitor.diagnostics.enabled', false);
    edit(SOURCE);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    expect(published()).toEqual([]);
  });

  it('offers to fix the occurrence (fixRule on its line), every occurrence of the rule in the file, or to run the cleanup', async () => {
    const context = createContext();
    registerCleanupDiagnostics(context);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    const [provider] = state.codeActionProviders as unknown as CleanupDiagnostics[];
    const first = published()[0];

    const actions = provider.provideCodeActions(document as never, first.range as never, { diagnostics: [first] } as never);

    expect(actions.map((action) => action.title)).toEqual(['Fix IDE0011', 'Fix all IDE0011 in file', 'Run Code Janitor cleanup']);
    expect(actions[2].command?.command).toBe('codeJanitor.cleanupActiveFile');

    const resolved = await provider.resolveCodeAction(actions[0], new (await import('./helpers/vscodeMock')).CancellationTokenSource().token as never);
    expect(engine.requests('fixRule').at(-1)).toMatchObject({ ruleId: 'IDE0011', line: 8, text: SOURCE });
    await workspace.applyEdit(resolved.edit as never);
    expect(document.getText()).toContain('        if (value > 0)\n        {\n            total += value;\n        }\n');
    expect(document.getText()).toContain('        if (value < 0)\n            total -= value;\n');

    await state.commands.get('codeJanitor.fixRuleInFile')!(...(actions[1].command!.arguments ?? []));
    expect(engine.requests('fixRule').at(-1)).toMatchObject({ ruleId: 'IDE0011' });
    expect(engine.requests('fixRule').at(-1)).not.toHaveProperty('line');
    expect(document.getText()).toContain('        if (value < 0)\n        {\n            total -= value;\n        }\n');
    expect(document.getText()).toContain('public int total;');
  });

  it('offers no fix for a violation cleanup cannot fix, and none once the document changed', async () => {
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    const [provider] = state.codeActionProviders;
    const [braces, , naming] = published();

    expect(provider.provideCodeActions(document, naming.range, { diagnostics: [naming] }).map((action) => action.title)).toEqual(['Run Code Janitor cleanup']);

    document.setText(`${SOURCE}// edited\n`);
    expect(provider.provideCodeActions(document, braces.range, { diagnostics: [braces] })).toEqual([]);
  });

  it('leaves the quick fix without an edit when the document changed while the engine fixed it', async () => {
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    const [provider] = state.codeActionProviders as unknown as CleanupDiagnostics[];
    const [action] = provider.provideCodeActions(document as never, published()[0].range as never, { diagnostics: [published()[0]] } as never);

    document.setText(`${SOURCE}// edited\n`);
    const resolved = await provider.resolveCodeAction(action, new (await import('./helpers/vscodeMock')).CancellationTokenSource().token as never);

    expect(resolved.edit).toBeUndefined();
  });

  it('shows nothing for a document the engine cannot analyze', async () => {
    engine = useFakeEngine({ analyze: () => Promise.reject(new Error('the engine failed')) });
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    expect(engine.requests('analyze')).toHaveLength(1);
    expect(published()).toEqual([]);
  });

  it.each(['.editorconfig', '.globalconfig', '.codejanitor', '.code-janitor.json'])('refreshes every document when %s is saved', (name) => {
    const refreshAll = vi.spyOn(CleanupDiagnostics.prototype, 'refreshAll');
    registerCleanupDiagnostics(createContext());

    state.documentListeners.save.forEach((listener) => listener(new TextDocument(Uri.file(path.join(root, 'sub', name)), '{}', 'json')));

    expect(refreshAll).toHaveBeenCalledTimes(1);
    refreshAll.mockRestore();
  });

  it('does not touch the Problems panel for edits of documents it never analyzed', async () => {
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    const notes = new TextDocument(Uri.file(path.join(root, 'README.md')), '# Notes', 'markdown');
    state.documents.push(notes);

    state.documentListeners.change.forEach((listener) => listener({ document: notes }));
    state.documentListeners.change.forEach((listener) => listener({ document: notes }));

    expect(state.diagnosticDeletions).toEqual([]);
  });

  it('analyzes a C# document only once it is shown in an editor, not when a command opens it to edit it', async () => {
    registerCleanupDiagnostics(createContext());
    const hidden = new TextDocument(Uri.file(path.join(root, 'Hidden.cs')), SOURCE, 'csharp');
    state.documents.push(hidden);
    state.documentListeners.open.forEach((listener) => listener(hidden));
    hidden.setText(SOURCE.replace('public int total;', 'public int Total;'));
    state.documentListeners.change.forEach((listener) => listener({ document: hidden }));
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    expect(state.diagnostics.has(hidden.uri.toString())).toBe(false);
    expect(published()).toHaveLength(3);

    showInTab(hidden.uri);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    expect(summary(state.diagnostics.get(hidden.uri.toString()) ?? []).map((diagnostic) => diagnostic.code)).toEqual(['IDE0011', 'IDE0011']);
  });
});

describe('cancellation and closed documents', () => {
  it('does not analyze a document that was closed before its analysis was due', async () => {
    registerCleanupDiagnostics(createContext());

    state.documentListeners.close.forEach((listener) => listener(document));
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    expect(engine.requests('analyze')).toEqual([]);
    expect(published()).toEqual([]);
  });

  it('cancels the analysis in flight when the document is edited, and analyzes the new text', async () => {
    const tokens: CancellationToken[] = [];
    engine = useFakeEngine({
      analyze: (_params, token) => {
        tokens.push(token);

        return tokens.length === 1 ? Promise.withResolvers<never>().promise : { diagnostics: [] };
      },
    });
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    expect(tokens).toHaveLength(1);

    edit(`${SOURCE}// edited\n`);
    await settle();

    expect(tokens[0].isCancellationRequested).toBe(true);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    expect(engine.requests('analyze')).toHaveLength(2);
  });

  it('cancels the analysis in flight when a settings file is saved, and analyzes the document again', async () => {
    const tokens: CancellationToken[] = [];
    engine = useFakeEngine({
      analyze: (_params, token) => {
        tokens.push(token);

        return tokens.length === 1 ? Promise.withResolvers<never>().promise : { diagnostics: [] };
      },
    });
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    state.documentListeners.save.forEach((listener) => listener(new TextDocument(Uri.file(path.join(root, '.editorconfig')), 'root = true', 'ini')));
    await settle();
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    expect(tokens[0].isCancellationRequested).toBe(true);
    expect(engine.requests('analyze')).toHaveLength(2);
  });

  it('cancels the analysis in flight when the document is closed, without logging an error', async () => {
    createOutputChannel(createContext());
    const tokens: CancellationToken[] = [];
    engine = useFakeEngine({
      analyze: (_params, token) => {
        tokens.push(token);
        const { promise, reject } = Promise.withResolvers<never>();
        token.onCancellationRequested(() => reject(new Error('the request was cancelled')));

        return promise;
      },
    });
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();

    state.documentListeners.close.forEach((listener) => listener(document));
    await settle();

    expect(tokens[0].isCancellationRequested).toBe(true);
    expect(state.outputChannelLines.filter((line) => line.includes('ERROR'))).toEqual([]);
  });

  it('does not log a quick fix cancelled by VS Code as an error', async () => {
    createOutputChannel(createContext());
    const source = new CancellationTokenSource();
    engine = useFakeEngine({
      analyze: (params) => ({ diagnostics: analyze(params.text) }),
      fixRule: () => {
        source.cancel();
        throw new Error('the request was cancelled');
      },
    });
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    await settle();
    const [provider] = state.codeActionProviders as unknown as CleanupDiagnostics[];
    const [action] = provider.provideCodeActions(document as never, published()[0].range as never, { diagnostics: [published()[0]] } as never);

    const resolved = await provider.resolveCodeAction(action, source.token as never);

    expect(resolved.edit).toBeUndefined();
    expect(state.outputChannelLines.filter((line) => line.includes('ERROR'))).toEqual([]);
  });
});
