import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Position,
  Range,
  Selection,
  TextDocument,
  TextEditor,
  Uri,
  WorkspaceEdit,
  createContext,
  resetMock,
  state,
  window,
  workspace,
} from './helpers/vscodeMock';
import { registerEditorCommands } from '../src/commands/editorCommands';
import { registerReorganizeCommands } from '../src/commands/reorganizeCommands';
import { EngineParams, FakeEngine, cleanupResult, useFakeEngine } from './helpers/fakeEngine';

const UNSORTED = 'class C\n{\n    void B() { }\n    int _a;\n}\n';
const SORTED = 'class C\n{\n    int _a;\n    void B() { }\n}\n';
/** What the fake engine makes of UNSORTED. */
const REORGANIZED = 'class C\n{\n    int _a;\n\n    void B() { }\n}\n';
const WITH_CONDITIONAL = 'class C\n{\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n    int _a;\n}\n';
const ONE_LINER = 'class C { void B() { } int A; }\n';

/**
 * The fake engine's reorganize: moves `int _a;` before `void B() { }`, unless the file has preprocessor
 * conditionals and the call does not allow them; a one-line type is left alone.
 */
function reorganize(params: EngineParams): ReturnType<typeof cleanupResult> {
  const allowed = (params.arguments as { performWhenPreprocessorConditionals?: string } | undefined)?.performWhenPreprocessorConditionals === 'yes';
  if (params.text.includes('#if') && !allowed) {
    return cleanupResult(params.text);
  }

  const moved = params.text.replace('    void B() { }\n', '').replace('    int _a;\n', '    int _a;\n\n    void B() { }\n');

  return cleanupResult(params.text.indexOf('void B') < params.text.indexOf('int _a') ? moved : params.text);
}

let engine: FakeEngine;

beforeEach(() => {
  resetMock();
  engine = useFakeEngine({
    command: (params) => reorganize(params),
    query: (params) => ({
      blockedByPreprocessor: params.text.includes('#if'),
      skipped: params.text === ONE_LINER ? ['C: a member shares a line with another, so the type was left alone'] : [],
    }),
  });
  registerReorganizeCommands(createContext());
  registerEditorCommands(createContext());
});

async function run(command: string, ...args: unknown[]): Promise<void> {
  await state.commands.get(command)!(...args);
}

function open(source: string, selection?: Selection, languageId = 'csharp', file = '/w/C.cs'): TextEditor {
  const document = new TextDocument(Uri.file(file), source, languageId);
  state.documents.push(document);
  const editor = new TextEditor(document, selection);
  window.activeTextEditor = editor;

  return editor;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A workspace folder whose `Legacy` subfolder has its own `.codejanitor` turning the blank-line padding off. */
function workspaceWithNestedPolicy(): { root: string; nested: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-reorganize-'));
  tempRoots.push(root);
  const nested = path.join(root, 'Legacy');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '.codejanitor'), JSON.stringify({ cleanup: { insertBlankLinePadding: false } }));
  state.workspaceFolders = [{ uri: Uri.file(root), name: 'w' }];

  return { root, nested };
}

/** The `reorganize` commands the engine received, as `[file, performWhenPreprocessorConditionals]`. */
const reorganized = () =>
  engine
    .requests('command')
    .map((params) => [params.filePath, (params.arguments as { performWhenPreprocessorConditionals?: string }).performWhenPreprocessorConditionals]);

describe('codeJanitor.reorganizeActiveFile', () => {
  it('reorganizes the active C# document through the engine, asking first for its report', async () => {
    const editor = open(UNSORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(REORGANIZED);
    expect(engine.requests('query')).toEqual([expect.objectContaining({ filePath: '/w/C.cs', text: UNSORTED, query: 'reorganizeReport' })]);
    expect(engine.requests('command')).toEqual([expect.objectContaining({ filePath: '/w/C.cs', text: UNSORTED, command: 'reorganize' })]);
  });

  it('sends the reorganize settings of the configuration', async () => {
    state.configuration.set('codeJanitor.reorganize.alphabetizeMembersOfTheSameGroup', false);
    state.configuration.set('codeJanitor.reorganize.methodsOrder', 1);
    open(SORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(engine.requests('command')[0].settings.reorganize).toMatchObject({
      alphabetizeMembersOfTheSameGroup: false,
      memberTypes: expect.objectContaining({ methods: expect.objectContaining({ order: 1 }) }),
    });
  });

  it('says so when there is nothing to reorganize', async () => {
    open(SORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(state.informationMessages).toContain('Code Janitor: nothing to reorganize.');
  });

  it('sends the user settings without the nearest .codejanitor, which the engine applies itself', async () => {
    const { nested } = workspaceWithNestedPolicy();
    open(UNSORTED, undefined, 'csharp', path.join(nested, 'C.cs'));

    await run('codeJanitor.reorganizeActiveFile');

    expect(engine.requests('command')[0].settings.insertBlankLinePaddingBeforeMethods).toBe(true);
  });

  it('asks about a file with preprocessor conditionals and reorganizes it on yes, leaving the setting alone', async () => {
    state.modalChoice = 'Reorganize';
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe('class C\n{\n#if DEBUG\n    void Debug() { }\n#endif\n    int _a;\n\n    void B() { }\n}\n');
    expect(reorganized()).toEqual([['/w/C.cs', 'yes']]);
    expect(state.warningMessages[0]).toContain('preprocessor conditionals');
    expect(state.configurationUpdates).toEqual([]);
  });

  it('remembers "Always" in the setting and reorganizes', async () => {
    state.modalChoice = 'Always Reorganize';
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).not.toBe(WITH_CONDITIONAL);
    expect(state.configurationUpdates).toEqual([expect.objectContaining({ key: 'codeJanitor.reorganize.performWhenPreprocessorConditionals', value: 'yes' })]);
  });

  it('remembers "Never" in the setting and leaves the file alone', async () => {
    state.modalChoice = 'Never Reorganize';
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(WITH_CONDITIONAL);
    expect(reorganized()).toEqual([]);
    expect(state.configurationUpdates).toEqual([expect.objectContaining({ key: 'codeJanitor.reorganize.performWhenPreprocessorConditionals', value: 'no' })]);
  });

  it('leaves the file alone when the question is dismissed or answered with Skip', async () => {
    state.modalChoice = 'Skip';
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(WITH_CONDITIONAL);
    expect(reorganized()).toEqual([]);
  });

  it('does not ask when the policy is already no, and says why the file was skipped', async () => {
    state.configuration.set('codeJanitor.reorganize.performWhenPreprocessorConditionals', 'no');
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(state.warningMessages).toEqual([]);
    expect(editor.document.getText()).toBe(WITH_CONDITIONAL);
    expect(state.informationMessages).toContain('Code Janitor: C.cs has preprocessor conditionals, so it was not reorganized.');
  });

  it('passes a policy of yes on to the engine without asking', async () => {
    state.configuration.set('codeJanitor.reorganize.performWhenPreprocessorConditionals', 'yes');
    open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(state.warningMessages).toEqual([]);
    expect(reorganized()).toEqual([['/w/C.cs', 'yes']]);
  });

  it('does not reorganize a file that is not C#', async () => {
    const editor = open(UNSORTED, undefined, 'plaintext');

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(UNSORTED);
    expect(state.informationMessages).toContain('Code Janitor: open a C# file to reorganize it.');
    expect(engine.requests('query')).toEqual([]);
  });

  it('reports the types it had to leave alone', async () => {
    const editor = open(ONE_LINER);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(ONE_LINER);
    expect(state.informationMessages.at(-1)).toContain('1 type(s) left alone');
  });

  it('warns with the reason when the engine fails', async () => {
    useFakeEngine({ query: () => Promise.reject(new Error('the solution could not be loaded')) });
    open(UNSORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(state.warningMessages.at(-1)).toBe('Code Janitor: C.cs was not reorganized - the solution could not be loaded');
  });

  it('changes only the part of the document that moved', async () => {
    const editor = open('// header\n' + UNSORTED + '// footer\n', new Selection(new Position(0, 3), new Position(0, 3)));
    const applyEdit = vi.spyOn(workspace, 'applyEdit');

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe('// header\n' + REORGANIZED + '// footer\n');
    const [[{ range }]] = [...(applyEdit.mock.calls[0][0] as unknown as WorkspaceEdit).edits.values()] as { range: Range }[][];
    expect(editor.document.offsetAt(range.start)).toBeGreaterThan('// header\n'.length);
    applyEdit.mockRestore();
  });
});

describe('codeJanitor.reorganizeSelectedFiles', () => {
  it('reorganizes the selected C# files and only those', async () => {
    state.files.set('/w/A.cs', UNSORTED);
    state.files.set('/w/B.cs', UNSORTED);
    state.files.set('/w/notes.txt', UNSORTED);

    await run('codeJanitor.reorganizeSelectedFiles', Uri.file('/w/A.cs'), [Uri.file('/w/A.cs'), Uri.file('/w/notes.txt')]);

    expect(state.files.get('/w/A.cs')).toBe(REORGANIZED);
    expect(state.files.get('/w/B.cs')).toBe(UNSORTED);
    expect(state.files.get('/w/notes.txt')).toBe(UNSORTED);
    expect(state.informationMessages.at(-1)).toBe('Code Janitor: reorganize complete - 1 file(s) changed.');
  });

  it('reorganizes the unsaved content of an open file', async () => {
    const editor = open(UNSORTED);

    await run('codeJanitor.reorganizeSelectedFiles', editor.document.uri, [editor.document.uri]);

    expect(editor.document.getText()).toBe(REORGANIZED);
  });

  it('asks once for all the files with preprocessor conditionals', async () => {
    state.modalChoice = 'Reorganize';
    state.files.set('/w/A.cs', WITH_CONDITIONAL);
    state.files.set('/w/B.cs', WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeSelectedFiles', undefined, [Uri.file('/w/A.cs'), Uri.file('/w/B.cs')]);

    expect(state.warningMessages).toHaveLength(1);
    expect(state.warningMessages[0]).toContain('2 files');
    expect(reorganized()).toEqual([
      ['/w/A.cs', 'yes'],
      ['/w/B.cs', 'yes'],
    ]);
  });

  it('counts the files the engine fails on and the ones preprocessor conditionals skip', async () => {
    state.configuration.set('codeJanitor.reorganize.performWhenPreprocessorConditionals', 'no');
    useFakeEngine({
      query: (params) =>
        params.filePath === '/w/Bad.cs' ? Promise.reject(new Error('broken')) : { blockedByPreprocessor: params.text.includes('#if'), skipped: [] },
      command: (params) => reorganize(params),
    });
    state.files.set('/w/A.cs', UNSORTED);
    state.files.set('/w/Bad.cs', UNSORTED);
    state.files.set('/w/C.cs', WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeSelectedFiles', undefined, [Uri.file('/w/A.cs'), Uri.file('/w/Bad.cs'), Uri.file('/w/C.cs')]);

    expect(state.informationMessages.at(-1)).toBe(
      'Code Janitor: reorganize complete - 1 file(s) changed, 1 failed, 1 skipped because of preprocessor conditionals.'
    );
    expect(state.warningMessages).toEqual(['Code Janitor: /w/Bad.cs - broken']);
  });

  it('warns when nothing is selected', async () => {
    await run('codeJanitor.reorganizeSelectedFiles');

    expect(state.informationMessages).toContain('Code Janitor: no files selected.');
  });
});

describe('region commands', () => {
  it('insertRegion wraps the selected lines in a region and selects its name', async () => {
    const editor = open('class C\n{\n    int _a;\n    int _b;\n}\n', new Selection(new Position(2, 6), new Position(3, 4)));

    await run('codeJanitor.insertRegion');

    expect(editor.document.getText()).toBe('class C\n{\n    #region New Region\n\n    int _a;\n    int _b;\n\n    #endregion New Region\n}\n');
    expect(editor.selection.start).toEqual(new Position(2, 12));
    expect(editor.selection.end).toEqual(new Position(2, 22));
  });

  it('insertRegion leaves out a last line the selection only reaches the start of', async () => {
    const editor = open('{\n  a;\n  b;\n}\n', new Selection(new Position(1, 0), new Position(2, 0)));

    await run('codeJanitor.insertRegion');

    expect(editor.document.getText()).toContain('  #region New Region\n');
    expect(editor.document.getText()).toContain('  a;\n\n  #endregion New Region\n\n  b;');
  });

  it('insertRegion uses the .codejanitor nearest to the file', async () => {
    const { nested } = workspaceWithNestedPolicy();
    const editor = open(
      'class C\n{\n    int _a;\n    int _b;\n}\n',
      new Selection(new Position(2, 6), new Position(3, 4)),
      'csharp',
      path.join(nested, 'C.cs')
    );

    await run('codeJanitor.insertRegion');

    expect(editor.document.getText()).toBe('class C\n{\n    #region New Region\n    int _a;\n    int _b;\n    #endregion New Region\n}\n');
  });

  const REGIONS = '{\n  #region A\n  a;\n  #endregion\n  #region B\n  b;\n  #endregion\n}\n';
  const removeRegions = () => engine.requests('command').map((params) => [params.command, params.arguments]);

  it('removeRegion asks the engine to remove the region whose directive the cursor is on', async () => {
    engine = useFakeEngine({ command: () => cleanupResult('{\n  a;\n  #region B\n  b;\n  #endregion\n}\n') });
    const editor = open(REGIONS, new Selection(new Position(3, 2), new Position(3, 2)));

    await run('codeJanitor.removeRegion');

    expect(removeRegions()).toEqual([['removeRegions', { line: 3 }]]);
    expect(editor.document.getText()).toBe('{\n  a;\n  #region B\n  b;\n  #endregion\n}\n');
  });

  it('removeRegion asks the engine to remove the regions inside the selection', async () => {
    open(REGIONS, new Selection(new Position(0, 0), new Position(7, 0)));

    await run('codeJanitor.removeRegion');

    expect(removeRegions()).toEqual([['removeRegions', { startLine: 0, endLine: 6 }]]);
  });

  it('removeRegion says what to do when there is no region under the cursor or in the selection', async () => {
    const editor = open('{\n  a;\n}\n', new Selection(new Position(1, 0), new Position(1, 0)));

    await run('codeJanitor.removeRegion');

    expect(editor.document.getText()).toBe('{\n  a;\n}\n');
    expect(state.informationMessages.at(-1)).toContain('no region');
    expect(removeRegions()).toEqual([['removeRegions', { line: 1 }]]);
  });
});

describe('codeJanitor.sortLines', () => {
  it('sorts the selected lines like the Visual Studio command: empty lines dropped, each line ended', async () => {
    const editor = open('b\n\na\nc\n', new Selection(new Position(0, 0), new Position(3, 1)));

    await run('codeJanitor.sortLines');

    expect(editor.document.getText()).toBe('a\nb\nc\n');
  });

  it('sorts the current and the next line when nothing is selected', async () => {
    const editor = open('z\nb\na\n', new Selection(new Position(1, 0), new Position(1, 0)));

    await run('codeJanitor.sortLines');

    expect(editor.document.getText()).toBe('z\na\nb\n');
  });
});
