import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Diagnostic, DiagnosticSeverity, TextDocument, Uri, createContext, resetMock, showInTab, state, workspace } from './helpers/vscodeMock';
import { ANALYSIS_DELAY_MS, CleanupDiagnostics, registerCleanupDiagnostics } from '../src/commands/diagnostics';

const EDITORCONFIG = [
  'root = true',
  '',
  '[*.cs]',
  'csharp_prefer_braces = true:warning',
  'dotnet_naming_rule.public_fields.symbols = public_fields',
  'dotnet_naming_rule.public_fields.style = pascal',
  'dotnet_naming_rule.public_fields.severity = suggestion',
  'dotnet_naming_symbols.public_fields.applicable_kinds = field',
  'dotnet_naming_symbols.public_fields.applicable_accessibilities = public',
  'dotnet_naming_style.pascal.capitalization = pascal_case',
  '',
].join('\n');

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

let root: string;
let document: TextDocument;

beforeEach(() => {
  resetMock();
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-diagnostics-'));
  fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
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
  it('shows each violation with its .editorconfig severity and a link to the rule, once the document is analyzed', async () => {
    registerCleanupDiagnostics(createContext());
    expect(published()).toEqual([]);

    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);

    expect(summary(published())).toEqual([
      { code: 'IDE0011', severity: DiagnosticSeverity.Warning, lines: [8, 9] },
      { code: 'IDE0011', severity: DiagnosticSeverity.Warning, lines: [11, 12] },
      { code: 'IDE1006', severity: DiagnosticSeverity.Information, lines: [4, 4] },
    ]);
    const braces = published()[0];
    expect(braces.source).toBe('Code Janitor');
    expect(braces.code).toMatchObject({ target: { fsPath: 'learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0011' } });
    expect(published()[2].message).toContain('(not fixed by Code Janitor)');
  });

  it('analyzes only the latest text once the edits pause', async () => {
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS - 1);
    edit(SOURCE.replace('        if (value < 0)\n            total -= value;\n', ''));
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS - 1);

    expect(published()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(summary(published()).map((diagnostic) => diagnostic.code)).toEqual(['IDE0011', 'IDE1006']);
  });

  it('shows nothing when diagnostics are turned off or the file is too large, and clears them on close', async () => {
    state.configuration.set('codeJanitor.diagnostics.maxFileSizeKB', 0.1);
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    expect(published()).toEqual([]);

    state.configuration.set('codeJanitor.diagnostics.maxFileSizeKB', 256);
    edit(SOURCE);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    expect(published()).toHaveLength(3);

    state.documentListeners.close.forEach((listener) => listener(document));
    expect(state.diagnostics.has(document.uri.toString())).toBe(false);

    state.configuration.set('codeJanitor.diagnostics.enabled', false);
    edit(SOURCE);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    expect(published()).toEqual([]);
  });

  it('offers to fix the occurrence, every occurrence of the rule in the file, or to run the cleanup', async () => {
    const context = createContext();
    registerCleanupDiagnostics(context);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    const [provider] = state.codeActionProviders;
    const first = published()[0];

    const actions = provider.provideCodeActions(document, first.range, { diagnostics: [first] });

    expect(actions.map((action) => action.title)).toEqual(['Fix IDE0011', 'Fix all IDE0011 in file', 'Run Code Janitor cleanup']);
    expect(actions[2].command?.command).toBe('codeJanitor.cleanupActiveFile');

    await workspace.applyEdit(actions[0].edit!);
    expect(document.getText()).toContain('        if (value > 0)\n        {\n            total += value;\n        }\n');
    expect(document.getText()).toContain('        if (value < 0)\n            total -= value;\n');

    await state.commands.get('codeJanitor.fixRuleInFile')!(...(actions[1].command!.arguments ?? []));
    expect(document.getText()).toContain('        if (value < 0)\n        {\n            total -= value;\n        }\n');
    expect(document.getText()).toContain('public int total;');
  });

  it('offers no fix for a violation cleanup cannot fix, and none once the document changed', async () => {
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    const [provider] = state.codeActionProviders;
    const [braces, , naming] = published();

    expect(provider.provideCodeActions(document, naming.range, { diagnostics: [naming] }).map((action) => action.title)).toEqual([
      'Run Code Janitor cleanup',
    ]);

    document.setText(`${SOURCE}// edited\n`);
    expect(provider.provideCodeActions(document, braces.range, { diagnostics: [braces] })).toEqual([]);
  });

  it('reads and parses the other files of the folder once, and again only after one of them changes on disk', async () => {
    const sibling = path.join(root, 'Other.cs');
    state.files.set(sibling, 'namespace Demo;\n\ninternal sealed class Other\n{\n}\n');
    const reads = vi.spyOn(workspace.fs, 'readFile');
    const siblingReads = () => reads.mock.calls.filter(([uri]) => uri.fsPath === sibling).length;
    registerCleanupDiagnostics(createContext());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);

    edit(SOURCE.replace('public int total;', 'public int total; // edited'));
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);
    expect(summary(published()).map((diagnostic) => diagnostic.code)).toEqual(['IDE0011', 'IDE0011', 'IDE1006']);
    expect([siblingReads(), state.readDirectoryCalls]).toEqual([1, 1]);

    state.files.set(sibling, 'namespace Demo;\n\ninternal class Other : Counter\n{\n}\n');
    state.diskListeners.forEach((listener) => listener(Uri.file(sibling)));
    edit(SOURCE);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);

    expect([siblingReads(), state.readDirectoryCalls]).toEqual([2, 2]);
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

    expect(state.diagnostics.has(hidden.uri.toString())).toBe(false);
    expect(published()).toHaveLength(3);

    showInTab(hidden.uri);
    await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);

    expect(summary(state.diagnostics.get(hidden.uri.toString()) ?? []).map((diagnostic) => diagnostic.code)).toEqual(['IDE0011', 'IDE0011']);
  });
});
