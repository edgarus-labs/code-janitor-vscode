import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerNavigationCommands } from '../src/commands/navigation';
import { DEFAULT_RELATED_FILE_EXTENSIONS, findRelatedFile, parseRelatedFileExtensions, relatedFileCandidates } from '../src/commands/switchFile';
import { installPreviewMock, previewState } from './helpers/previewMock';
import { TextDocument, TextEditor, Uri, createContext, resetMock, state, window } from './helpers/vscodeMock';

beforeEach(() => {
  resetMock();
  installPreviewMock();
  registerNavigationCommands(createContext());
});

afterEach(() => {
  previewState.tabs = [];
});

function run(command: string): Promise<unknown> {
  const handler = state.commands.get(command);
  if (!handler) {
    throw new Error(`Command not registered: ${command}`);
  }

  return Promise.resolve(handler());
}

/** Built-in commands the navigation commands delegate to, with the arguments they were called with. */
function recordBuiltIns(...ids: string[]): [string, unknown[]][] {
  const calls: [string, unknown[]][] = [];
  for (const id of ids) {
    state.commands.set(id, (...args) => {
      calls.push([id, args]);
    });
  }

  return calls;
}

describe('Switch File: related file groups', () => {
  const groups = parseRelatedFileExtensions(DEFAULT_RELATED_FILE_EXTENSIONS);

  it('reads the Visual Studio expression: groups by "||", endings by spaces, lower case, at least two endings', () => {
    expect(parseRelatedFileExtensions('.CPP .h||.x||.a .b  .c||')).toEqual([
      ['.cpp', '.h'],
      ['.a', '.b', '.c'],
    ]);
  });

  it.each([
    ['/w/Form1.cs', ['/w/Form1.designer.cs']],
    ['/w/Form1.Designer.cs', ['/w/Form1.Designer.designer.cs', '/w/Form1.cs']],
    ['/w/View.xaml', ['/w/View.xaml.cs']],
    ['/w/View.xaml.cs', ['/w/View.xaml', '/w/View.xaml.designer.cs']],
    ['/w/Page.razor', ['/w/Page.razor.cs', '/w/Page.razor.css']],
    ['/w/Page.razor.css', ['/w/Page.razor', '/w/Page.razor.cs']],
    ['/w/Page.cshtml', ['/w/Page.cshtml.cs']],
    ['/w/Default.aspx.cs', ['/w/Default.aspx', '/w/Default.aspx.designer.cs']],
    ['/w/Site.master', ['/w/Site.master.cs']],
    ['/w/Control.ascx', ['/w/Control.ascx.cs']],
    ['/w/util.h', ['/w/util.cpp', '/w/util.c']],
    ['/w/util.cpp', ['/w/util.h']],
    ['/w/app.component.ts', ['/w/app.component.html', '/w/app.component.css']],
    ['/w/app.component.html', ['/w/app.component.css', '/w/app.component.ts']],
    ['/w/readme.md', []],
  ])('proposes for %s: %j', (file, expected) => {
    const proposed = relatedFileCandidates(file, groups);

    // The proposals start with the expected ones; other groups matching the same ending may follow.
    expect(proposed.slice(0, expected.length)).toEqual(expected);
    if (expected.length === 0) {
      expect(proposed).toEqual([]);
    }
  });

  it('matches the ending regardless of case, keeping the rest of the path as it is', () => {
    expect(relatedFileCandidates('/W/My.XAML', groups)).toEqual(['/W/My.xaml.cs']);
  });

  it('puts the endings after the matching one first, then those before it (Visual Studio order)', () => {
    expect(relatedFileCandidates('/w/a.b', [['.a', '.b', '.c', '.d']])).toEqual(['/w/a.c', '/w/a.d', '/w/a.a']);
  });
});

describe('Switch File: finding the file', () => {
  const groups = parseRelatedFileExtensions(DEFAULT_RELATED_FILE_EXTENSIONS);

  it('returns the first related file that exists, with the case it has on disk', async () => {
    state.files.set('/w/Form1.cs', '');
    state.files.set('/w/Form1.Designer.cs', '');

    expect(await findRelatedFile('/w/Form1.cs', groups)).toBe('/w/Form1.Designer.cs');
    expect(await findRelatedFile('/w/Form1.Designer.cs', groups)).toBe('/w/Form1.cs');
  });

  it('prefers the earlier candidate when several exist', async () => {
    state.files.set('/w/Page.razor', '');
    state.files.set('/w/Page.razor.cs', '');
    state.files.set('/w/Page.razor.css', '');

    expect(await findRelatedFile('/w/Page.razor.cs', groups)).toBe('/w/Page.razor.css');
    expect(await findRelatedFile('/w/Page.razor', groups)).toBe('/w/Page.razor.cs');
  });

  it('returns nothing when no related file exists, and never the file itself', async () => {
    state.files.set('/w/Lonely.cs', '');

    expect(await findRelatedFile('/w/Lonely.cs', groups)).toBeUndefined();
    expect(await findRelatedFile('/w/notes.md', groups)).toBeUndefined();
  });

  it('does not treat a folder as a related file', async () => {
    state.files.set('/w/Thing.cs', '');
    state.files.set('/w/Thing.designer.cs/inner.txt', '');

    expect(await findRelatedFile('/w/Thing.cs', groups)).toBeUndefined();
  });
});

describe('Switch File command', () => {
  function activate(filePath: string): void {
    window.activeTextEditor = new TextEditor(new TextDocument(Uri.file(filePath), '', 'csharp'));
  }

  it('opens the related file', async () => {
    const opened: unknown[] = [];
    state.commands.set('vscode.open', (uri) => {
      opened.push(uri);
    });
    state.files.set('/w/View.xaml', '');
    state.files.set('/w/View.xaml.cs', '');
    activate('/w/View.xaml.cs');

    await run('codeJanitor.switchFile');

    expect((opened as Uri[]).map((uri) => uri.fsPath)).toEqual(['/w/View.xaml']);
  });

  it('uses the configured groups instead of the defaults', async () => {
    const opened: Uri[] = [];
    state.commands.set('vscode.open', (uri) => {
      opened.push(uri as Uri);
    });
    state.configuration.set('codeJanitor.switching.relatedFileExtensions', '.feature .steps.cs');
    state.files.set('/w/Login.feature', '');
    state.files.set('/w/Login.steps.cs', '');
    activate('/w/Login.feature');

    await run('codeJanitor.switchFile');

    expect(opened.map((uri) => uri.fsPath)).toEqual(['/w/Login.steps.cs']);
  });

  it('says when there is no related file or no file', async () => {
    const opened: unknown[] = [];
    state.commands.set('vscode.open', (uri) => {
      opened.push(uri);
    });

    await run('codeJanitor.switchFile');
    expect(state.informationMessages.at(-1)).toBe('Code Janitor: no active file to switch from.');

    state.files.set('/w/Alone.cs', '');
    activate('/w/Alone.cs');
    await run('codeJanitor.switchFile');
    expect(state.informationMessages.at(-1)).toBe('Code Janitor: no related file found for Alone.cs.');
    expect(opened).toEqual([]);
  });
});

describe('workflow commands', () => {
  it('toggles read-only for the session through the built-in command', async () => {
    const calls = recordBuiltIns('workbench.action.files.toggleActiveEditorReadonlyInSession');
    window.activeTextEditor = new TextEditor(new TextDocument(Uri.file('/w/a.cs'), '', 'csharp'));

    await run('codeJanitor.toggleReadOnly');

    expect(calls).toEqual([['workbench.action.files.toggleActiveEditorReadonlyInSession', []]]);
  });

  it('reveals the active file in the Explorer', async () => {
    const calls = recordBuiltIns('workbench.files.action.showActiveFileInExplorer');
    window.activeTextEditor = new TextEditor(new TextDocument(Uri.file('/w/a.cs'), '', 'csharp'));

    await run('codeJanitor.findInExplorer');

    expect(calls).toEqual([['workbench.files.action.showActiveFileInExplorer', []]]);
  });

  it('needs an active editor to toggle read-only or reveal', async () => {
    const calls = recordBuiltIns('workbench.action.files.toggleActiveEditorReadonlyInSession', 'workbench.files.action.showActiveFileInExplorer');

    await run('codeJanitor.toggleReadOnly');
    await run('codeJanitor.findInExplorer');

    expect(calls).toEqual([]);
    expect(state.informationMessages).toEqual(['Code Janitor: no active editor.', 'Code Janitor: no active editor.']);
  });

  it('collapses the Explorer', async () => {
    const calls = recordBuiltIns('workbench.files.action.collapseExplorerFolders');

    await run('codeJanitor.collapseExplorer');

    expect(calls).toEqual([['workbench.files.action.collapseExplorerFolders', []]]);
  });

  it('collapses the focused Explorer folder for "collapse selected"', async () => {
    const calls = recordBuiltIns('workbench.files.action.focusFilesExplorer', 'list.collapse');

    await run('codeJanitor.collapseSelectedInExplorer');

    expect(calls.map(([id]) => id)).toEqual(['workbench.files.action.focusFilesExplorer', 'list.collapse']);
  });
});

describe('Close All Read-Only', () => {
  const tab = (filePath: string, isDirty = false) => ({ input: { uri: Uri.file(filePath) }, isDirty });

  it('closes the editors of read-only files without unsaved changes, and nothing else', async () => {
    const readOnly = tab('/w/ro.cs');
    const readOnlyDirty = tab('/w/ro-dirty.cs', true);
    const writable = tab('/w/rw.cs');
    const gitView = { input: { uri: Uri.parse('git:///w/HEAD.cs') }, isDirty: false };
    const diff = { input: { original: Uri.file('/w/ro.cs'), modified: Uri.file('/w/ro.cs') }, isDirty: false };
    previewState.tabs = [readOnly, readOnlyDirty, writable, gitView, diff];
    previewState.readOnlyPaths.add('/w/ro.cs');
    previewState.readOnlyPaths.add('/w/ro-dirty.cs');
    previewState.readOnlySchemes.add('git');

    await run('codeJanitor.closeAllReadOnly');

    expect(previewState.closedTabs).toEqual([readOnly, gitView]);
    expect(previewState.tabs).toEqual([readOnlyDirty, writable, diff]);
    expect(state.informationMessages.at(-1)).toBe('Code Janitor: closed 2 read-only editor(s).');
  });

  it('tells when no read-only editor is open', async () => {
    previewState.tabs = [tab('/w/rw.cs')];

    await run('codeJanitor.closeAllReadOnly');

    expect(previewState.closedTabs).toEqual([]);
    expect(state.informationMessages.at(-1)).toBe('Code Janitor: no read-only editors are open.');
  });
});
