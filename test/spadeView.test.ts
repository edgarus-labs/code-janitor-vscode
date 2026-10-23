import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationTarget,
  DataTransfer,
  MockTreeView,
  Position,
  Selection,
  TextDocument,
  TextEditor,
  TextEditorRevealType,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  createContext,
  resetMock,
  setActiveEditor,
  state,
  viewState,
  window,
} from './helpers/vscodeMock';
import { EngineParams, FakeEngine, cleanupResult, useFakeEngine } from './helpers/fakeEngine';
import { registerSpade } from '../src/spade/spadeView';
import { SpadeNode, Structure, StructureItem } from '../src/spade/spadeModel';

const SOURCE = [
  'namespace N',
  '{',
  '    public class Sample',
  '    {',
  '        private int count;',
  '',
  '        public Sample()',
  '        {',
  '        }',
  '',
  '        public int Add(int x, int y)',
  '        {',
  '            return x + y;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function item(kind: string, name: string, startLine: number, endLine: number, extra: Partial<StructureItem> = {}): StructureItem {
  return {
    kind,
    name,
    access: 'public',
    modifiers: ['public'],
    returnType: null,
    parameters: [],
    typeParameters: [],
    baseTypes: [],
    startLine,
    endLine,
    complexity: null,
    accessors: [],
    children: [],
    ...extra,
  };
}

function structure(addComplexity = 1, regions: Structure['regions'] = []): Structure {
  return {
    items: [
      item('namespace', 'N', 0, 15, {
        access: null,
        modifiers: [],
        children: [
          item('class', 'Sample', 2, 14, {
            children: [
              item('field', 'count', 4, 4, { access: 'private', modifiers: ['private'], returnType: 'int' }),
              item('constructor', 'Sample', 6, 8, { complexity: 1 }),
              item('method', 'Add', 10, 13, {
                returnType: 'int',
                parameters: [
                  { name: 'x', type: 'int' },
                  { name: 'y', type: 'int' },
                ],
                complexity: addComplexity,
              }),
            ],
          }),
        ],
      }),
    ],
    regions,
  };
}

let engine: FakeEngine;
let document: TextDocument;
let editor: TextEditor;
let currentStructure: Structure;
let commandResults: Record<string, (params: EngineParams) => string>;

function view(): MockTreeView<SpadeNode> {
  return viewState.treeViews.get('codeJanitor.spade') as MockTreeView<SpadeNode>;
}

function provider(): { getChildren(node?: SpadeNode): SpadeNode[]; getTreeItem(node: SpadeNode): TreeItem; getParent(node: SpadeNode): SpadeNode | undefined } {
  return view().options.treeDataProvider as never;
}

function run(command: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(state.commands.get(command)!(...args));
}

/** The node at a path of names from the roots. */
function node(...path: string[]): SpadeNode {
  let nodes = provider().getChildren();
  let found: SpadeNode | undefined;
  for (const name of path) {
    found = nodes.find((candidate) => candidate.name === name);
    nodes = provider().getChildren(found!);
  }

  return found!;
}

function labels(nodes: readonly SpadeNode[]): string[] {
  return nodes.map((child) => {
    const label = provider().getTreeItem(child).label;

    return typeof label === 'string' ? label : label.label;
  });
}

function commandCalls(name: string): EngineParams[] {
  return engine.requests('command').filter((params) => params.command === name);
}

beforeEach(async () => {
  resetMock();
  currentStructure = structure();
  commandResults = {};
  engine = useFakeEngine({
    query: (params) => (params.query === 'structure' ? currentStructure : params.query === 'memberLines' ? { startLine: 10, endLine: 13 } : null),
    command: (params) => cleanupResult(commandResults[String(params.command)]?.(params) ?? params.text),
  });
  document = new TextDocument(Uri.file('/w/Sample.cs'), SOURCE, 'csharp');
  state.documents.push(document);
  editor = new TextEditor(document);
  window.activeTextEditor = editor;
  registerSpade(createContext() as never);
  await run('codeJanitor.spade.refresh');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Spade view', () => {
  it('shows the namespaces, types and members of the active C# editor', () => {
    const [namespace] = provider().getChildren();
    const type = provider().getChildren(namespace)[0];

    expect(engine.requests('query')[0]).toMatchObject({ filePath: '/w/Sample.cs', query: 'structure' });
    expect(view().description).toBe('Sample.cs');
    expect(provider().getTreeItem(namespace)).toMatchObject({ contextValue: 'namespace', collapsibleState: TreeItemCollapsibleState.Expanded });
    expect(provider().getTreeItem(type).contextValue).toBe('type');
    expect(labels(provider().getChildren(type))).toEqual(['count : int', 'Sample()', 'Add(int x, int y) : int']);
    const add = provider().getTreeItem(node('N', 'Sample', 'Add'));
    expect(add).toMatchObject({ contextValue: 'member', collapsibleState: TreeItemCollapsibleState.None, description: '1' });
    expect(add.command).toMatchObject({ command: 'codeJanitor.spade.goToMember', arguments: [node('N', 'Sample', 'Add')] });
    expect(provider().getParent(node('N', 'Sample', 'Add'))).toBe(type);
  });

  it('colours the icon of a member as complex as the warning or alert threshold', async () => {
    currentStructure = structure(16);
    await run('codeJanitor.spade.refresh');
    expect(provider().getTreeItem(node('N', 'Sample', 'Add')).iconPath).toMatchObject({ id: 'symbol-method', color: { id: 'list.errorForeground' } });

    currentStructure = structure(10);
    await run('codeJanitor.spade.refresh');
    expect(provider().getTreeItem(node('N', 'Sample', 'Add')).iconPath).toMatchObject({ color: { id: 'list.warningForeground' } });
  });

  it('empties with a message when the active editor is not C#, and follows the next C# editor', async () => {
    setActiveEditor(new TextEditor(new TextDocument(Uri.file('/w/readme.md'), '# Hi', 'markdown')));
    await Promise.resolve();

    expect(provider().getChildren()).toEqual([]);
    expect(view().message).toBe('Open a C# file to see its members.');

    setActiveEditor(editor);
    await vi.waitFor(() => expect(provider().getChildren()).toHaveLength(1));
    expect(view().message).toBeUndefined();
  });

  it('refreshes once after a burst of edits', async () => {
    vi.useFakeTimers();
    const before = engine.requests('query').length;
    state.documentListeners.change.forEach((listener) => listener({ document }));
    state.documentListeners.change.forEach((listener) => listener({ document }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(engine.requests('query').length).toBe(before + 1);
  });

  it('does not read the members of the C# editors followed while hidden, and reads the active one once shown', async () => {
    view().visible = false;
    const [other, third] = ['Other.cs', 'Third.cs'].map((name) => new TextDocument(Uri.file(`/w/${name}`), SOURCE, 'csharp'));
    state.documents.push(other, third);
    setActiveEditor(new TextEditor(other));

    expect(view().description).toBe('Other.cs');
    expect(provider().getChildren()).toEqual([]);
    setActiveEditor(new TextEditor(third));
    view().visible = true;
    view().visibilityListeners.forEach((listener) => listener({ visible: true }));
    await vi.waitFor(() => expect([view().description, provider().getChildren().length]).toEqual(['Third.cs', 1]));

    const read = engine.requests('query').filter((params) => params.query === 'structure' && params.filePath !== '/w/Sample.cs');
    expect(read.map((params) => params.filePath)).toEqual(['/w/Third.cs']);
  });

  it('sorts alphabetically, by type and by file, saving the choice', async () => {
    await run('codeJanitor.spade.sortAlphabetically');
    expect(state.configurationUpdates).toContainEqual({ key: 'codeJanitor.spade.primarySortOrder', value: 'alphabetical', target: ConfigurationTarget.Global });
    expect(labels(provider().getChildren(node('N', 'Sample')))).toEqual(['Add(int x, int y) : int', 'count : int', 'Sample()']);

    await run('codeJanitor.spade.sortByType');
    expect(labels(provider().getChildren(node('N', 'Classes', 'Sample')))).toEqual(['Fields', 'Constructors', 'Methods']);
    expect(provider().getTreeItem(node('N', 'Classes', 'Sample', 'Fields')).contextValue).toBe('group');

    await run('codeJanitor.spade.sortByFile');
    expect(state.configuration.get('codeJanitor.spade.primarySortOrder')).toBe('file');
    expect(labels(provider().getChildren(node('N', 'Sample')))).toEqual(['count : int', 'Sample()', 'Add(int x, int y) : int']);
  });

  it('filters by name and clears the filter', async () => {
    state.inputBoxResult = 'ad';
    await run('codeJanitor.spade.search');

    expect(viewState.executedCommands).toContainEqual({ id: 'setContext', args: ['codeJanitor.spade.searching', true] });
    expect(labels(provider().getChildren(node('N', 'Sample')))).toEqual(['Add(int x, int y) : int']);
    expect(provider().getTreeItem(node('N', 'Sample', 'Add')).label).toEqual({ label: 'Add(int x, int y) : int', highlights: [[0, 2]] });
    expect(view().message).toBe('Members matching "ad"');

    await run('codeJanitor.spade.clearSearch');
    expect(viewState.executedCommands).toContainEqual({ id: 'setContext', args: ['codeJanitor.spade.searching', false] });
    expect(provider().getChildren(node('N', 'Sample'))).toHaveLength(3);
    expect(view().message).toBeUndefined();
  });

  it('goes to a member, centring the whole member or just showing it', async () => {
    await run('codeJanitor.spade.goToMember', node('N', 'Sample', 'Add'));
    const shown = window.activeTextEditor!;
    expect(shown.selection.active).toEqual(new Position(10, 19));
    expect(shown.revealed.at(-1)).toMatchObject({ range: { start: { line: 10 }, end: { line: 13 } }, type: TextEditorRevealType.InCenter });

    state.configuration.set('codeJanitor.spade.centerOnWhole', false);
    await run('codeJanitor.spade.goToMember', node('N', 'Sample', 'Add'));
    expect(window.activeTextEditor!.revealed.at(-1)!.type).toBe(TextEditorRevealType.Default);
  });

  it('reveals the member under the cursor', async () => {
    vi.useFakeTimers();
    editor.selection = new Selection(new Position(12, 4), new Position(12, 4));
    viewState.selectionListeners.forEach((listener) => listener({ textEditor: editor, selections: [editor.selection] }));

    await vi.advanceTimersByTimeAsync(500);

    expect(view().reveals.at(-1)).toMatchObject({ element: { name: 'Add' }, options: { select: true, focus: false } });
  });

  it('deletes a member after confirmation, in one edit of the editor', async () => {
    commandResults.deleteMember = (params) => params.text.replace('        private int count;\n\n', '');
    await run('codeJanitor.spade.deleteMember', node('N', 'Sample', 'count'));
    expect(commandCalls('deleteMember')).toEqual([]);

    state.modalChoice = 'Delete';
    await run('codeJanitor.spade.deleteMember', node('N', 'Sample', 'count'));

    expect(state.warningMessages.at(-1)).toBe("Delete 'count'?");
    expect(commandCalls('deleteMember')[0].arguments).toEqual({ line: 4, name: 'count' });
    expect(document.getText()).not.toContain('count');
    expect(document.version).toBe(2);
  });

  it('deletes the selected members from the last one up, chaining the texts', async () => {
    state.modalChoice = 'Delete';
    commandResults.deleteMember = (params) => `${params.text}// ${JSON.stringify(params.arguments)}\n`;

    await run('codeJanitor.spade.deleteMember', node('N', 'Sample', 'count'), [node('N', 'Sample', 'count'), node('N', 'Sample', 'Add')]);

    expect(state.warningMessages.at(-1)).toBe('Delete 2 items?');
    expect(commandCalls('deleteMember').map((params) => params.arguments)).toEqual([
      { line: 10, name: 'Add' },
      { line: 4, name: 'count' },
    ]);
    expect(commandCalls('deleteMember')[1].text).toBe(`${SOURCE}// {"line":10,"name":"Add"}\n`);
    expect(document.getText()).toBe(`${SOURCE}// {"line":10,"name":"Add"}\n// {"line":4,"name":"count"}\n`);
  });

  it('refuses to delete, insert or remove a region, or move with a tree read from an older version of the file, and refreshes it', async () => {
    currentStructure = structure(1, [{ name: 'Fields', startLine: 3, endLine: 5, children: [] }]);
    await run('codeJanitor.spade.refresh');
    state.modalChoice = 'Delete';
    const transfer = new DataTransfer();
    const controller = view().options.dragAndDropController!;
    await controller.handleDrag!([node('N', 'Sample', 'Sample')], transfer, undefined);

    for (const act of [
      () => run('codeJanitor.spade.deleteMember', node('N', 'Sample', 'Fields', 'count')),
      () => run('codeJanitor.spade.insertRegion', node('N', 'Sample', 'Add')),
      () => run('codeJanitor.spade.removeRegion', node('N', 'Sample', 'Fields')),
      () => controller.handleDrop!(node('N', 'Sample', 'Add'), transfer, undefined),
    ]) {
      // An edit (a line added above, an undo) the tree has not been refreshed for yet.
      document.setText(`// a line above\n${document.getText()}`);
      const edited = document.getText();
      const queries = engine.requests('query').filter((params) => params.query === 'structure').length;
      const warnings = state.warningMessages.length;
      await act();

      expect(state.warningMessages.slice(warnings)).toContain('Code Janitor: the file changed meanwhile; try again.');
      await vi.waitFor(() => expect(engine.requests('query').filter((params) => params.query === 'structure').length).toBe(queries + 1));
      expect(document.getText()).toBe(edited);
    }

    expect(engine.requests('command')).toEqual([]);
    expect(engine.requests('query').filter((params) => params.query === 'memberLines')).toEqual([]);
  });

  it('finds the references of a member at its name', async () => {
    await run('codeJanitor.spade.findReferences', node('N', 'Sample', 'Add'));

    const call = viewState.executedCommands.find((command) => command.id === 'references-view.findReferences')!;
    expect(call.args).toEqual([document.uri, new Position(10, 19)]);
  });

  it('puts a region around a member and its comments', async () => {
    await run('codeJanitor.spade.insertRegion', node('N', 'Sample', 'Add'));

    expect(engine.requests('query').at(-1)).toMatchObject({ query: 'memberLines', arguments: { line: 10, name: 'Add' } });
    const lines = document.getText().split('\n');
    expect(lines.slice(10, 18)).toEqual([
      '        #region New Region',
      '',
      '        public int Add(int x, int y)',
      '        {',
      '            return x + y;',
      '        }',
      '',
      '        #endregion New Region',
    ]);
    expect(window.activeTextEditor!.document.getText(window.activeTextEditor!.selection)).toBe('New Region');
  });

  it('removes a region with the engine', async () => {
    currentStructure = structure(1, [{ name: 'Fields', startLine: 3, endLine: 5, children: [] }]);
    await run('codeJanitor.spade.refresh');
    commandResults.removeRegions = (params) => params.text.replace('x + y', 'y + x');

    await run('codeJanitor.spade.removeRegion', node('N', 'Sample', 'Fields'));

    expect(commandCalls('removeRegions')[0].arguments).toEqual({ line: 3 });
    expect(document.getText()).toContain('y + x');
  });

  it('moves a dropped member after a later sibling with the engine, and reports a refused move', async () => {
    const controller = view().options.dragAndDropController!;
    const transfer = new DataTransfer();
    commandResults.moveMember = (params) => `${params.text}// moved\n`;

    await controller.handleDrag!([node('N', 'Sample', 'count')], transfer, undefined);
    await controller.handleDrop!(node('N', 'Sample', 'Add'), transfer, undefined);

    expect(commandCalls('moveMember')[0].arguments).toEqual({ line: 4, name: 'count', targetLine: 10, targetName: 'Add', position: 'after' });
    expect(document.getText()).toBe(`${SOURCE}// moved\n`);
    await run('codeJanitor.spade.refresh');

    commandResults.moveMember = () => {
      throw new Error("Moving 'count' would add the compiler error CS0103: nope");
    };
    await controller.handleDrop!(node('N', 'Sample', 'Sample'), transfer, undefined);
    expect(state.warningMessages.at(-1)).toBe("Code Janitor: Moving 'count' would add the compiler error CS0103: nope");

    await controller.handleDrop!(node('N', 'Sample'), transfer, undefined);
    expect(state.informationMessages.at(-1)).toBe("Code Janitor: 'count' can only be moved among the members of 'Sample'.");
  });

  it('folds and unfolds a type collapsed or expanded in the tree, unless synchronizeOutlining is off', () => {
    view().collapseListeners.forEach((listener) => listener({ element: node('N', 'Sample') }));
    view().expandListeners.forEach((listener) => listener({ element: node('N', 'Sample') }));
    view().collapseListeners.forEach((listener) => listener({ element: node('N', 'Sample', 'Add') }));

    const folds = viewState.executedCommands.filter((command) => command.id === 'editor.fold' || command.id === 'editor.unfold');
    expect(folds).toEqual([
      { id: 'editor.fold', args: [{ levels: 1, selectionLines: [3] }] },
      { id: 'editor.unfold', args: [{ levels: 1, selectionLines: [3] }] },
    ]);

    state.configuration.set('codeJanitor.spade.synchronizeOutlining', false);
    view().collapseListeners.forEach((listener) => listener({ element: node('N', 'Sample') }));
    expect(viewState.executedCommands.filter((command) => command.id === 'editor.fold')).toHaveLength(1);
  });

  it('shows the view on Show Spade', async () => {
    await run('codeJanitor.showSpade');

    expect(viewState.executedCommands.map((command) => command.id)).toContain('codeJanitor.spade.focus');
  });
});
