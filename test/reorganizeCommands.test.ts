import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Position, Selection, TextDocument, TextEditor, Uri, createContext, resetMock, state, window } from './helpers/vscodeMock';
import { registerEditorCommands } from '../src/commands/editorCommands';
import { registerReorganizeCommands } from '../src/commands/reorganizeCommands';

const UNSORTED = 'class C\n{\n    void B() { }\n    int _a;\n}\n';
const SORTED = 'class C\n{\n    int _a;\n    void B() { }\n}\n';
/** The reorganized UNSORTED: moved members are padded the way the default cleanup padding asks. */
const REORGANIZED = 'class C\n{\n    int _a;\n\n    void B() { }\n}\n';
const WITH_CONDITIONAL = 'class C\n{\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n    int _a;\n}\n';

beforeEach(() => {
  resetMock();
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

describe('codeJanitor.reorganizeActiveFile', () => {
  it('reorganizes the active C# document', async () => {
    const editor = open(UNSORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(REORGANIZED);
  });

  it('reads the reorganize settings and the cleanup padding from the configuration', async () => {
    state.configuration.set('codeJanitor.reorganize.alphabetizeMembersOfTheSameGroup', false);
    state.configuration.set('codeJanitor.reorganize.methodsOrder', 1);
    state.configuration.set('codeJanitor.reorganize.fieldsOrder', 2);
    const editor = open(SORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe('class C\n{\n    void B() { }\n\n    int _a;\n}\n');
  });

  it('says so when there is nothing to reorganize', async () => {
    open(SORTED);

    await run('codeJanitor.reorganizeActiveFile');

    expect(state.informationMessages).toContain('Code Janitor: nothing to reorganize.');
  });

  it("uses the .codejanitor nearest to the file, not the workspace folder's", async () => {
    const { nested } = workspaceWithNestedPolicy();
    const editor = open(UNSORTED, undefined, 'csharp', path.join(nested, 'C.cs'));

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(SORTED);
  });

  it('asks about a file with preprocessor conditionals and reorganizes it on yes, leaving the setting alone', async () => {
    state.modalChoice = 'Reorganize';
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe('class C\n{\n    int _a;\n\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n}\n');
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
    expect(state.configurationUpdates).toEqual([expect.objectContaining({ key: 'codeJanitor.reorganize.performWhenPreprocessorConditionals', value: 'no' })]);
  });

  it('leaves the file alone when the question is dismissed or answered with Skip', async () => {
    state.modalChoice = 'Skip';
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(WITH_CONDITIONAL);
  });

  it('does not ask when the policy is already no, and says why the file was skipped', async () => {
    state.configuration.set('codeJanitor.reorganize.performWhenPreprocessorConditionals', 'no');
    const editor = open(WITH_CONDITIONAL);

    await run('codeJanitor.reorganizeActiveFile');

    expect(state.warningMessages).toEqual([]);
    expect(editor.document.getText()).toBe(WITH_CONDITIONAL);
    expect(state.informationMessages).toContain('Code Janitor: C.cs has preprocessor conditionals, so it was not reorganized.');
  });

  it('does not reorganize a file that is not C#', async () => {
    const editor = open(UNSORTED, undefined, 'plaintext');

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe(UNSORTED);
    expect(state.informationMessages).toContain('Code Janitor: open a C# file to reorganize it.');
  });

  it('reports the types it had to leave alone', async () => {
    const editor = open('class C { void B() { } int A; }\n');

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe('class C { void B() { } int A; }\n');
    expect(state.informationMessages.at(-1)).toContain('1 type(s) left alone');
  });

  it('changes only the part of the document that moved', async () => {
    const editor = open('// header\n' + UNSORTED + '// footer\n', new Selection(new Position(0, 3), new Position(0, 3)));
    let replaced = 0;
    const original = editor.edit.bind(editor);
    editor.edit = (callback) =>
      original((builder) =>
        callback({
          replace: (range, text) => {
            replaced = editor.document.offsetAt(range.end) - editor.document.offsetAt(range.start);
            builder.replace(range, text);
          },
        })
      );

    await run('codeJanitor.reorganizeActiveFile');

    expect(editor.document.getText()).toBe('// header\n' + REORGANIZED + '// footer\n');
    expect(replaced).toBeLessThan(UNSORTED.length);
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
    expect(state.files.get('/w/A.cs')).toContain('    int _a;\n\n    void B() { }\n#if DEBUG');
    expect(state.files.get('/w/B.cs')).toContain('    int _a;\n\n    void B() { }\n#if DEBUG');
  });

  it('reorganizes every file with the .codejanitor nearest to it', async () => {
    const { root, nested } = workspaceWithNestedPolicy();
    const outer = path.join(root, 'A.cs');
    const inner = path.join(nested, 'B.cs');
    state.files.set(outer, UNSORTED);
    state.files.set(inner, UNSORTED);

    await run('codeJanitor.reorganizeSelectedFiles', undefined, [Uri.file(outer), Uri.file(inner)]);

    expect([state.files.get(outer), state.files.get(inner)]).toEqual([REORGANIZED, SORTED]);
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
    const editor = open('class C\n{\n    int _a;\n    int _b;\n}\n', new Selection(new Position(2, 6), new Position(3, 4)), 'csharp', path.join(nested, 'C.cs'));

    await run('codeJanitor.insertRegion');

    expect(editor.document.getText()).toBe('class C\n{\n    #region New Region\n    int _a;\n    int _b;\n    #endregion New Region\n}\n');
  });

  it('removeRegion removes the region the cursor is on', async () => {
    const editor = open('{\n  #region A\n  a;\n  #endregion\n  #region B\n  b;\n  #endregion\n}\n', new Selection(new Position(3, 2), new Position(3, 2)));

    await run('codeJanitor.removeRegion');

    expect(editor.document.getText()).toBe('{\n  a;\n  #region B\n  b;\n  #endregion\n}\n');
  });

  it('removeRegion removes only the region the cursor is on, not the regions nested in it', async () => {
    const editor = open(
      '{\n  #region Outer\n  #region Inner\n  a;\n  #endregion\n  #endregion\n}\n',
      new Selection(new Position(1, 2), new Position(1, 2))
    );

    await run('codeJanitor.removeRegion');

    expect(editor.document.getText()).toBe('{\n  #region Inner\n  a;\n  #endregion\n}\n');
  });

  it('removeRegion removes the regions inside the selection', async () => {
    const editor = open('{\n  #region A\n  a;\n  #endregion\n  #region B\n  b;\n  #endregion\n}\n', new Selection(new Position(0, 0), new Position(7, 0)));

    await run('codeJanitor.removeRegion');

    expect(editor.document.getText()).toBe('{\n  a;\n  b;\n}\n');
  });

  it('removeRegion says what to do when there is no region under the cursor or in the selection', async () => {
    const editor = open('{\n  a;\n}\n', new Selection(new Position(1, 0), new Position(1, 0)));

    await run('codeJanitor.removeRegion');

    expect(editor.document.getText()).toBe('{\n  a;\n}\n');
    expect(state.informationMessages.at(-1)).toContain('no region');
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
