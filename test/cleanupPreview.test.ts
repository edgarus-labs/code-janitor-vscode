import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PreviewResult } from '../src/cleanup/pipeline';
import { registerCleanupCommands } from '../src/commands/cleanupCommands';
import { PreviewFile, buildCleanupPreviewPlan } from '../src/commands/cleanupPreview';
import { runCleanupOnUris } from '../src/commands/cleanupCore';
import { FakeQuickPick, assertScriptsPassed, installPreviewMock, previewState } from './helpers/previewMock';
import { PreviewProject, csharpFiles, previewProject, removeTempDirectories, restoreOriginals, tempDirectory } from './helpers/previewFixtures';
import { TextDocument, Uri, createContext, resetMock, state, window, workspace } from './helpers/vscodeMock';

beforeEach(() => {
  resetMock();
  installPreviewMock();
  registerCleanupCommands(createContext());
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirectories();
  assertScriptsPassed();
});

async function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.commands.get(command);
  if (!handler) {
    throw new Error(`Command not registered: ${command}`);
  }

  const result = await handler(...args);
  assertScriptsPassed();

  return result;
}

/** What the user does in the next picker shown. */
function user(...steps: ((picker: FakeQuickPick) => void | Promise<void>)[]): void {
  previewState.pickerScripts.push(...steps);
}

const accept = (picker: FakeQuickPick) => picker.accept();

const CHANGED = ['Models/Customer.cs', 'Models/Order.cs', 'Services/Legacy.cs', 'Program.cs'];

/** The mock file system as a plain object, to compare the text of several files at once. */
function snapshot(project: PreviewProject, files: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(files.map((file) => [file, state.files.get(project.file(file))]));
}

/**
 * What the ordinary (non-preview) cleanup makes of the files - the reference for the applied
 * preview. Runs on the original text and leaves the mock file system as it was.
 */
async function ordinaryCleanup(project: PreviewProject, files: readonly string[]): Promise<Record<string, string | undefined>> {
  const current = new Map(state.files);
  restoreOriginals(project);
  try {
    await runCleanupOnUris(createContext(), files.map((file) => project.uri(file)));

    return snapshot(project, files);
  } finally {
    state.files = current;
  }
}

describe('multi-file cleanup preview: the plan', () => {
  it('gives every selected file an explicit status and writes nothing', async () => {
    const project = previewProject();
    const applyEdit = vi.spyOn(workspace, 'applyEdit');
    const writeFile = vi.spyOn(workspace.fs, 'writeFile');
    const files = [...CHANGED, 'Services/Pricing.cs', 'Notes.txt'];
    user((picker) => {
      expect(picker.items.map((item) => `${item.label} | ${item.description}`)).toEqual([
        '$(diff) Models/Customer.cs | 6 changes',
        '$(diff) Models/Order.cs | 6 changes',
        '$(diff) Services/Legacy.cs | 2 changes',
        '$(diff) Program.cs | 1 change',
        '$(check) Services/Pricing.cs | No changes',
        '$(circle-slash) Notes.txt | Skipped: not a C# file (the preview covers C# text cleanup)',
      ]);
      expect(picker.canSelectMany).toBe(true);
      expect(picker.selectedItems.map((item) => item.label)).toHaveLength(4);
      expect(picker.title).toContain('4 of 4 file(s) selected');
      picker.escape();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, files.map((file) => project.uri(file)));

    expect(applyEdit).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(snapshot(project, files)).toEqual(Object.fromEntries(files.map((file) => [file, project.originals.get(project.file(file))])));
    expect([...project.originals].every(([file, text]) => fs.readFileSync(file, 'utf8') === text)).toBe(true);
  });

  it('shows why a file is skipped: excluded, too large, not UTF-8, unreadable', async () => {
    const project = previewProject();
    state.configuration.set('codeJanitor.cleanup.exclude', ['Program\\.cs$']);
    state.configuration.set('codeJanitor.preview.maxFileSizeKb', 1);
    state.files.set(project.file('Models/Order.cs'), `// ${'x'.repeat(2000)}\n${project.originals.get(project.file('Models/Order.cs'))}`);
    const invalid = project.file('Models/Invalid.cs');
    state.files.set(invalid, 'class A { }\n');
    const readFile = workspace.fs.readFile.bind(workspace.fs);
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((uri: Uri) =>
      uri.fsPath === invalid ? Promise.resolve(new Uint8Array([0x63, 0xff, 0xfe, 0x00])) : readFile(uri)
    );

    const plan = await buildCleanupPreviewPlan([
      project.uri('Program.cs'),
      project.uri('Models/Order.cs'),
      Uri.file(invalid),
      project.uri('Models/Missing.cs'),
      project.uri('Models/Customer.cs'),
    ]);

    expect(plan.files.map((file) => [file.label, file.status, file.message])).toEqual([
      ['Program.cs', 'skipped', 'Skipped: excluded by the codeJanitor.cleanup.include / exclude settings'],
      ['Models/Order.cs', 'skipped', expect.stringMatching(/^Skipped: too large \(\d+ KiB; the limit is 1 KiB\)$/)],
      ['Models/Invalid.cs', 'skipped', 'Skipped: the file is not UTF-8 text, which the preview cannot apply safely'],
      ['Models/Missing.cs', 'error', expect.stringMatching(/^Error: the file could not be read/)],
      ['Models/Customer.cs', 'changes', '6 changes'],
    ]);
    expect(plan.files.filter((file) => file.include).map((file) => file.label)).toEqual(['Models/Customer.cs']);
  });

  it('notes the syntax problems of a file and what the preview does not show', async () => {
    const project = previewProject();
    state.files.set(project.file('Models/Broken.cs'), 'class Broken\n{\n    void M()\n    {\n        int x = 1\n        x++;\n    }   \n}\n');

    const plan = await buildCleanupPreviewPlan([project.uri('Models/Broken.cs')]);

    expect(plan.files[0].notes.join(' ')).toMatch(/syntax problems? in the file/);
  });

  it('counts the .editorconfig violations cleanup cannot fix and shows them with the file', async () => {
    const root = tempDirectory();
    fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*.cs]\ncsharp_style_var_elsewhere = true:warning\ncsharp_prefer_braces = true:warning\n');
    const source = 'internal class A\n{\n    private void M(bool b)\n    {\n        Widget w = Create();\n        if (b) return;\n    }\n}\n';
    state.files.set(path.join(root, 'A.cs'), source);
    user((picker) => {
      expect(picker.items[0].detail).toContain('1 .editorconfig violation(s) not fixed');
      picker.escape();
    });

    const plan = await buildCleanupPreviewPlan([Uri.file(path.join(root, 'A.cs'))]);
    expect(plan.unresolved).toBe(1);
    expect(plan.files[0].unresolved).toBe(1);

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [Uri.file(path.join(root, 'A.cs'))]);
  });

  it('says that a one-type-per-file split is not part of the preview', async () => {
    const root = tempDirectory();
    fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*.cs]\ndotnet_diagnostic.SA1402.severity = warning\n');
    const filePath = path.join(root, 'Foo.cs');
    state.files.set(filePath, 'namespace Demo;\n\ninternal class Foo\n{\n}\n\ninternal class Bar\n{\n    int x;   \n}\n');

    const plan = await buildCleanupPreviewPlan([Uri.file(filePath)]);

    expect(plan.files[0].status).toBe('changes');
    expect(plan.files[0].notes).toEqual([expect.stringContaining('one type per file')]);
  });

  it('stops preparing when the user cancels the progress, changing nothing', async () => {
    const project = previewProject();
    vi.spyOn(window, 'withProgress').mockImplementation((_options, task) =>
      task({ report: () => undefined }, { isCancellationRequested: true, onCancellationRequested: () => undefined })
    );

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Program.cs')]);

    expect(state.informationMessages.at(-1)).toBe('Code Janitor: the cleanup preview was cancelled; nothing was changed.');
    expect(previewState.pickers).toHaveLength(0);
  });

  it('never offers a result with more syntax problems than the original', () => {
    const original = 'class A\n{\n}\n';
    const file = PreviewFile.planned(Uri.file('/w/A.cs'), 'A.cs', original, {
      compute: (source) => new PreviewResult(source, 'class A\n{\n    int x\n}\n', []),
    });

    expect(file.canApply).toBe(false);
    expect(file.status).toBe('error');
    expect(file.message).toMatch(/^Not applied: the result would add \d+ syntax problems?$/);
    expect(file.include).toBe(false);
  });

  it('reports the rules of each file as Changed, No change or Excluded, recalculated from the original text', async () => {
    const project = previewProject();
    const plan = await buildCleanupPreviewPlan([project.uri('Models/Order.cs')]);
    const [file] = plan.files;
    const outcomes = () => Object.fromEntries(file.rules.filter((rule) => ['Remove trailing whitespace', 'Normalize blank lines', 'IDE0011', 'IDE0090'].includes(rule.name)).map((rule) => [rule.name, rule.outcome]));
    const allKeys = new Set(file.rules.map((rule) => rule.key));
    const full = file.updated;

    expect(outcomes()).toEqual({ 'Remove trailing whitespace': 'Changed', 'Normalize blank lines': 'Changed', IDE0011: 'Changed', IDE0090: 'Changed' });

    file.setIncludedRules(new Set([...allKeys].filter((key) => !key.endsWith(':IDE0011'))));
    expect(outcomes()).toMatchObject({ IDE0011: 'Excluded', IDE0090: 'Changed' });
    expect(file.updated).toContain('if (price < 0)\n                throw');

    // Re-including one rule while excluding another: nothing of the earlier selection survives.
    file.setIncludedRules(new Set([...allKeys].filter((key) => key !== file.rules.find((rule) => rule.name === 'Normalize blank lines')?.key)));
    expect(outcomes()).toMatchObject({ IDE0011: 'Changed', 'Normalize blank lines': 'Excluded' });
    expect(file.updated).toContain('if (price < 0)\n            {');
    expect(file.updated).toContain('\n\n\n');

    file.setIncludedRules(allKeys);
    expect(file.updated).toBe(full);
  });

  it('marks a rule that did not change the file as No change, and leaves the file out when no rule is left', async () => {
    const project = previewProject();
    const plan = await buildCleanupPreviewPlan([project.uri('Program.cs')]);
    const [file] = plan.files;

    expect(file.rules.find((rule) => rule.name === 'Remove trailing whitespace')?.outcome).toBe('No change');
    expect(file.include).toBe(true);

    file.setIncludedRules(new Set());
    expect(file.canApply).toBe(false);
    expect(file.include).toBe(false);
    expect(file.message).toBe('No changes');

    file.setIncludedRules(new Set(file.rules.map((rule) => rule.key)));
    expect(file.include).toBe(true);
  });
});

describe('multi-file cleanup preview: review', () => {
  it('opens a native diff of the original and the updated text for the active file, and cleans up after itself', async () => {
    const project = previewProject();
    user((picker) => {
      picker.activate('Order.cs');
      picker.escape();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs')]);

    expect(previewState.diffs).toHaveLength(1);
    const [diff] = previewState.diffs;
    expect(diff.before.scheme).toBe('codejanitor-preview');
    expect(diff.title).toBe('Code Janitor: Cleanup Preview (Models/Order.cs)');
    expect(diff.options).toEqual({ preview: true, preserveFocus: true });
    // Closed after the review; the virtual documents are released and no file was ever written.
    expect(previewState.tabs).toEqual([]);
    expect(previewState.closedTabs).toHaveLength(1);
    expect(previewState.text(diff.before)).toBe('');
    expect(snapshot(project, ['Models/Order.cs'])).toEqual({ 'Models/Order.cs': project.originals.get(project.file('Models/Order.cs')) });
  });

  it('serves the original and the updated text to the diff', async () => {
    const project = previewProject();
    const seen: string[] = [];
    user((picker) => {
      picker.activate('Order.cs');
      seen.push(previewState.text(previewState.diffs[0].before), previewState.text(previewState.diffs[0].after));
      picker.escape();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs')]);

    const expected = (await ordinaryCleanup(project, ['Models/Order.cs']))['Models/Order.cs'];
    expect(seen).toEqual([project.originals.get(project.file('Models/Order.cs')), expected]);
  });

  it('applies only the checked files, and refuses to check a file without changes', async () => {
    const project = previewProject();
    user((picker) => {
      picker.select('Customer.cs', 'Pricing.cs', 'Notes.txt');
      // The unchangeable files cannot be part of the selection: it is put back.
      expect(picker.selectedItems.map((item) => item.label)).toEqual(['$(diff) Models/Customer.cs']);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [
      project.uri('Models/Customer.cs'),
      project.uri('Models/Order.cs'),
      project.uri('Services/Pricing.cs'),
      project.uri('Notes.txt'),
    ]);

    const expected = await ordinaryCleanup(project, ['Models/Customer.cs']);
    expect(snapshot(project, ['Models/Customer.cs'])).toEqual(expected);
    expect(state.files.get(project.file('Models/Order.cs'))).toBe(project.originals.get(project.file('Models/Order.cs')));
  });

  it('does nothing when no file is checked, until the user cancels', async () => {
    const project = previewProject();
    user((picker) => {
      picker.select();
      picker.accept();
      expect(state.informationMessages).toContain('Code Janitor: check at least one file, or press Escape to cancel.');
      expect(picker.hidden).toBe(false);
      picker.escape();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs')]);

    expect(state.files.get(project.file('Models/Order.cs'))).toBe(project.originals.get(project.file('Models/Order.cs')));
  });

  it('lets the user choose the rules per file and recomputes from the original text each time', async () => {
    const project = previewProject();
    const order = project.file('Models/Order.cs');
    user(
      (picker) => picker.clickButton('Order.cs', 'Choose Rules...'),
      (picker) => picker.clickButton('Order.cs', 'Choose Rules...'),
      accept
    );
    // First: without IDE0011 (braces); then with it again, but without the blank-line normalization.
    const rules = ['Remove trailing whitespace', 'Normalize blank lines', 'IDE0090', 'IDE0011'];
    state.quickPickSelections = [rules.filter((rule) => rule !== 'IDE0011'), rules.filter((rule) => rule !== 'Normalize blank lines')];

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs')]);

    // The second round lists the rules as the first round left them.
    const choices = state.quickPickItems as { label: string; description: string }[];
    expect(choices.find((choice) => choice.label === 'IDE0011')?.description).toBe('Apply .editorconfig code style - Excluded');
    expect(choices.find((choice) => choice.label === 'IDE0090')?.description).toMatch(/^Apply \.editorconfig code style - Changed \(\d+ changes?\)$/);
    // Both rounds were shown; the diff was refreshed after each (new virtual documents).
    expect(previewState.diffs).toHaveLength(2);
    expect(previewState.diffs[0].after.toString()).not.toBe(previewState.diffs[1].after.toString());
    // The final text: braces applied (round 2 included IDE0011), blank lines not normalized (round 2 excluded it).
    expect(state.files.get(order)).toContain('if (price < 0)\n            {');
    expect(state.files.get(order)).toContain('\n\n\n');
    expect(state.files.get(order)).not.toMatch(/ +\n/);
  });

  it('keeps the rules as they were when the rule choice is cancelled', async () => {
    const project = previewProject();
    user((picker) => picker.clickButton('Order.cs', 'Choose Rules...'), accept);
    state.quickPickSelections = [undefined];

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs')]);

    expect(state.files.get(project.file('Models/Order.cs'))).toBe((await ordinaryCleanup(project, ['Models/Order.cs']))['Models/Order.cs']);
  });

  it('labels the rules as Changed, No change and Excluded in the rule choice', async () => {
    const project = previewProject();
    const describeRules = () => (state.quickPickItems as { label: string; description: string }[]).map((item) => `${item.label}: ${item.description}`);
    let first: string[] = [];
    user(
      (picker) => picker.clickButton('Program.cs', 'Choose Rules...'),
      (picker) => {
        first = describeRules();
        picker.clickButton('Program.cs', 'Choose Rules...');
      },
      (picker) => picker.escape()
    );
    // Round 1 keeps only IDE0090; round 2 is cancelled.
    state.quickPickSelections = [['IDE0090'], undefined];

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Program.cs')]);

    expect(first).toContain('Remove trailing whitespace: No change');
    expect(first.find((line) => line.startsWith('IDE0090'))).toContain('Changed (1 change)');
    const second = describeRules();
    expect(second).toContain('Remove trailing whitespace: Excluded');
    expect(second).toContain('Normalize blank lines: Excluded');
    expect(second.find((line) => line.startsWith('IDE0090'))).toContain('Changed (1 change)');
  });
});

describe('multi-file cleanup preview: applying', () => {
  it('applies the approved result of every selected file like the ordinary cleanup, in one edit and without saving', async () => {
    const project = previewProject();
    const applyEdit = vi.spyOn(workspace, 'applyEdit');
    const writeFile = vi.spyOn(workspace.fs, 'writeFile');
    const files = csharpFiles(project);
    state.directories.add(project.root);
    state.foundFiles = files.map((file) => project.uri(file));
    user(accept);

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [Uri.file(project.root)]);

    const preview = snapshot(project, files);
    // One WorkspaceEdit over all four changed files = one undo step; nothing saved.
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect((applyEdit.mock.calls[0][0] as unknown as { size: number }).size).toBe(CHANGED.length);
    expect(writeFile).not.toHaveBeenCalled();
    expect(await ordinaryCleanup(project, files)).toEqual(preview);
    expect(preview).not.toEqual(Object.fromEntries(files.map((file) => [file, project.originals.get(project.file(file))])));
    expect([...project.originals].every(([file, text]) => fs.readFileSync(file, 'utf8') === text)).toBe(true);
    expect(state.informationMessages.at(-1)).toContain('applied to 4 file(s)');
  });

  it('plans from the editor buffer and applies to the buffer of an open file', async () => {
    const project = previewProject();
    const file = project.file('Services/Pricing.cs');
    const document = new TextDocument(Uri.file(file), `${project.originals.get(file)}\n\n\n`, 'csharp');
    state.documents.push(document);
    user(accept);

    await run('codeJanitor.previewCleanupOpenFiles');

    expect(document.getText()).toBe(project.originals.get(file));
    expect(document.getText()).not.toBe(`${project.originals.get(file)}\n\n\n`);
    // The file on disk was clean and stays as it is.
    expect(state.files.get(file)).toBe(project.originals.get(file));
  });

  it('refuses a file whose text changed since the plan - open buffer and closed file alike - and applies the others', async () => {
    const project = previewProject();
    const orderPath = project.file('Models/Order.cs');
    const order = new TextDocument(Uri.file(orderPath), project.originals.get(orderPath)!, 'csharp');
    state.documents.push(order);
    user((picker) => {
      order.setText(`${order.getText()}// edited after the plan\n`);
      state.files.set(project.file('Models/Customer.cs'), `// changed on disk\n${project.originals.get(project.file('Models/Customer.cs'))}`);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [
      project.uri('Models/Order.cs'),
      project.uri('Models/Customer.cs'),
      project.uri('Program.cs'),
    ]);

    expect(order.getText()).toBe(`${project.originals.get(orderPath)}// edited after the plan\n`);
    expect(state.files.get(project.file('Models/Customer.cs'))).toBe(`// changed on disk\n${project.originals.get(project.file('Models/Customer.cs'))}`);
    expect(state.files.get(project.file('Program.cs'))).toContain('= new();');
    expect(state.warningMessages.at(-1)).toMatch(/applied to 1 file\(s\), not to 2\..*changed since the preview.*Models\/Order\.cs, Models\/Customer\.cs/);
  });

  it('refuses a file closed after the plan and reports it, without touching it', async () => {
    const project = previewProject();
    const file = project.file('Models/Order.cs');
    const order = new TextDocument(Uri.file(file), project.originals.get(file)!, 'csharp');
    state.documents.push(order);
    user((picker) => {
      order.isClosed = true;
      state.documents.splice(0);
      state.files.delete(file);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs')]);

    expect(order.getText()).toBe(project.originals.get(file));
    expect(state.warningMessages.at(-1)).toContain('changed since the preview');
  });

  it('applies the files VS Code accepts and reports the ones it rejects', async () => {
    const project = previewProject();
    const applyEdit = workspace.applyEdit.bind(workspace);
    vi.spyOn(workspace, 'applyEdit').mockImplementation((edit) => {
      const keys = [...(edit as unknown as { edits: Map<string, unknown> }).edits.keys()];

      return keys.length > 1 || keys[0].endsWith('Order.cs') ? Promise.resolve(false) : applyEdit(edit);
    });
    user(accept);

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Models/Order.cs'), project.uri('Program.cs')]);

    expect(state.files.get(project.file('Program.cs'))).toContain('= new();');
    expect(state.files.get(project.file('Models/Order.cs'))).toBe(project.originals.get(project.file('Models/Order.cs')));
    expect(state.warningMessages.at(-1)).toContain('Models/Order.cs: VS Code did not apply the edit');
  });

  it('keeps CRLF files intact', async () => {
    const project = previewProject();
    user(accept);

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Services/Legacy.cs')]);

    const text = state.files.get(project.file('Services/Legacy.cs'))!;
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toBe((await ordinaryCleanup(project, ['Services/Legacy.cs']))['Services/Legacy.cs']);
  });
});

describe('multi-file cleanup preview: scopes', () => {
  it('previews the selected folder and files, skipping what is not C#', async () => {
    const project = previewProject();
    state.directories.add(path.join(project.root, 'Models'));
    state.foundFiles = [project.uri('Models/Customer.cs'), project.uri('Models/Order.cs')];
    user((picker) => {
      expect(picker.items.map((item) => item.label)).toEqual([
        '$(diff) Models/Customer.cs',
        '$(diff) Models/Order.cs',
        '$(check) Services/Pricing.cs',
        '$(circle-slash) Notes.txt',
      ]);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupSelectedFiles', project.uri('Models'), [
      project.uri('Models'),
      project.uri('Services/Pricing.cs'),
      project.uri('Notes.txt'),
    ]);

    const files = ['Models/Customer.cs', 'Models/Order.cs'];
    expect(snapshot(project, files)).toEqual(await ordinaryCleanup(project, files));
    expect(state.files.get(project.file('Models/Customer.cs'))).not.toBe(project.originals.get(project.file('Models/Customer.cs')));
  });

  it('warns when nothing is selected', async () => {
    await run('codeJanitor.previewCleanupSelectedFiles');

    expect(state.informationMessages).toContain('Code Janitor: no files selected.');
  });

  it('previews the open C# files of the workspace only', async () => {
    const project = previewProject();
    for (const [file, language] of [['Program.cs', 'csharp'], ['Notes.txt', 'plaintext']] as const) {
      state.documents.push(new TextDocument(project.uri(file), project.originals.get(project.file(file))!, language));
    }

    state.documents.push(new TextDocument(Uri.parse('untitled://Untitled-1'), 'class A { }', 'csharp'));
    user((picker) => {
      expect(picker.items.map((item) => item.label)).toEqual(['$(diff) Program.cs']);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupOpenFiles');

    expect(state.documents[0].getText()).toContain('= new();');
  });

  it('tells when no C# file is open', async () => {
    await run('codeJanitor.previewCleanupOpenFiles');

    expect(state.informationMessages).toContain('Code Janitor: no open C# files to preview.');
  });

  it('previews the C# files the Git extension reports as changed', async () => {
    const project = previewProject();
    state.extensions.set('vscode.git', {
      activate: () =>
        Promise.resolve({
          getAPI: () => ({
            repositories: [
              {
                state: {
                  workingTreeChanges: [{ uri: project.uri('Program.cs') }, { uri: project.uri('Notes.txt') }],
                  indexChanges: [{ uri: project.uri('Models/Order.cs') }],
                  mergeChanges: [],
                },
              },
            ],
          }),
        }),
    });
    user((picker) => {
      expect(picker.items.map((item) => item.label)).toEqual(['$(diff) Program.cs', '$(diff) Models/Order.cs']);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupChangedFiles');

    const files = ['Program.cs', 'Models/Order.cs'];
    const applied = snapshot(project, files);
    expect(applied).toEqual(await ordinaryCleanup(project, files));
  });

  it('warns when the Git extension is unavailable, and when nothing changed', async () => {
    await run('codeJanitor.previewCleanupChangedFiles');
    expect(state.warningMessages).toContain('Code Janitor: the built-in Git extension is not available.');

    state.extensions.set('vscode.git', { activate: () => Promise.resolve({ getAPI: () => ({ repositories: [] }) }) });
    await run('codeJanitor.previewCleanupChangedFiles');
    expect(state.informationMessages).toContain('Code Janitor: no changed C# files to preview.');
  });

  it('previews only the lines changed since the last commit when onlyChangedLines is on', async () => {
    const root = tempDirectory();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
    const committed = 'namespace Demo;\n\ninternal class Counter\n{\n    public void Add(int value)\n    {\n        if (value > 0)\n            Add(value - 1);\n    }\n}\n';
    const edited = committed.replace('    }\n}\n', '    }\n\n    public void Remove(int value)\n    {\n        if (value > 0)\n            Remove(value - 1);\n    }\n}\n');
    fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*.cs]\ncsharp_prefer_braces = true:warning\n');
    fs.writeFileSync(path.join(root, 'Counter.cs'), committed);
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    state.configuration.set('codeJanitor.cleanup.onlyChangedLines', true);
    const counter = path.join(root, 'Counter.cs');
    state.files.set(counter, edited);
    state.extensions.set('vscode.git', {
      activate: () => Promise.resolve({ getAPI: () => ({ repositories: [{ state: { workingTreeChanges: [{ uri: Uri.file(counter) }] } }] }) }),
    });
    user((picker) => {
      expect(picker.items[0].detail).toContain('rules cannot be chosen one by one');
      picker.accept();
    });

    await run('codeJanitor.previewCleanupChangedFiles');

    const applied = state.files.get(counter);
    state.files.set(counter, edited);
    await runCleanupOnUris(createContext(), [Uri.file(counter)], { honorOnlyChangedLines: true });
    expect(applied).toBe(state.files.get(counter));
    expect(applied).toContain('        if (value > 0)\n        {\n            Remove(value - 1);');
    expect(applied).toContain('        if (value > 0)\n            Add(value - 1);');
  });

  it('previews the C# files of the workspace', async () => {
    const project = previewProject();
    state.foundFiles = csharpFiles(project).map((file) => project.uri(file));
    user(accept);

    await run('codeJanitor.previewCleanupWorkspace');

    const files = csharpFiles(project);
    const applied = snapshot(project, files);
    expect(applied).toEqual(await ordinaryCleanup(project, files));
  });

  it('tells when the workspace has no C# files', async () => {
    await run('codeJanitor.previewCleanupWorkspace');

    expect(state.informationMessages).toContain('Code Janitor: no C# files found in the workspace.');
  });

  it('says so when there is nothing to apply, listing the counts', async () => {
    const project = previewProject();

    await run('codeJanitor.previewCleanupSelectedFiles', undefined, [project.uri('Services/Pricing.cs'), project.uri('Notes.txt')]);

    expect(state.informationMessages.at(-1)).toBe(
      'Code Janitor: nothing to apply - 0 with changes, 1 already clean, 1 skipped, 0 failed (see the Code Janitor output).'
    );
    expect(previewState.pickers).toHaveLength(0);
  });
});

describe('Cleanup Selected Files options dialog', () => {
  it('starts the cleanup at once while the setting is off', async () => {
    const project = previewProject();

    await run('codeJanitor.cleanupSelectedFiles', undefined, [project.uri('Program.cs')]);

    expect(state.files.get(project.file('Program.cs'))).toContain('= new();');
    expect(previewState.pickers).toHaveLength(0);
    expect(state.quickPickItems).toEqual([]);
  });

  it('offers Start Cleanup and Preview C# Text Changes when the setting is on', async () => {
    const project = previewProject();
    state.configuration.set('codeJanitor.cleanup.showOptionsDialog', true);
    state.quickPickChoice = 'Start Cleanup';

    await run('codeJanitor.cleanupSelectedFiles', undefined, [project.uri('Program.cs')]);

    expect(state.quickPickItems.map((item) => item.label)).toEqual(['Start Cleanup', 'Preview C# Text Changes']);
    expect(state.files.get(project.file('Program.cs'))).toContain('= new();');
    expect(previewState.pickers).toHaveLength(0);
  });

  it('previews instead of cleaning when the preview is chosen', async () => {
    const project = previewProject();
    state.configuration.set('codeJanitor.cleanup.showOptionsDialog', true);
    state.quickPickChoice = 'Preview C# Text Changes';
    user((picker) => picker.escape());

    await run('codeJanitor.cleanupSelectedFiles', undefined, [project.uri('Program.cs')]);

    expect(previewState.pickers).toHaveLength(1);
    expect(state.files.get(project.file('Program.cs'))).toBe(project.originals.get(project.file('Program.cs')));
  });

  it('does nothing when the dialog is cancelled', async () => {
    const project = previewProject();
    state.configuration.set('codeJanitor.cleanup.showOptionsDialog', true);
    state.quickPickChoice = undefined;

    await run('codeJanitor.cleanupSelectedFiles', undefined, [project.uri('Program.cs')]);

    expect(previewState.pickers).toHaveLength(0);
    expect(state.files.get(project.file('Program.cs'))).toBe(project.originals.get(project.file('Program.cs')));
  });
});
