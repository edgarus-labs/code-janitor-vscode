import * as path from 'node:path';
import * as vscode from 'vscode';
import { replaceChangedPart } from '../commands/editorText';
import { readReorganizeSettings } from '../commands/reorganizeSettings';
import { readCleanupSettingsForUri } from '../commands/settings';
import { EngineCommand } from '../engine/protocol';
import { documentParams, engine, reportEngineUnavailable } from '../engine/vscodeEngine';
import { logError } from '../logging';
import { insertRegionAroundLines } from '../text/regionEdits';
import { SpadeDisplayOptions, SpadeNode, SpadeSortOrder, Structure, buildSpadeTree, describeSpadeNode, dropPlan, spadeNodeAtLine } from './spadeModel';

const VIEW_ID = 'codeJanitor.spade';
const DRAG_MIME_TYPE = 'application/vnd.code.tree.codejanitor.spade';
const REFRESH_DELAY_MS = 400;
const CURSOR_DELAY_MS = 150;
const SORT_ORDERS: readonly SpadeSortOrder[] = ['file', 'type', 'alphabetical'];

/** The Spade view (the Visual Studio Spade tool window) and its commands. */
export function registerSpade(context: vscode.ExtensionContext): void {
  const spade = new Spade();
  context.subscriptions.push(
    spade,
    vscode.commands.registerCommand('codeJanitor.showSpade', () => spade.show()),
    vscode.commands.registerCommand('codeJanitor.spade.refresh', () => spade.refresh()),
    vscode.commands.registerCommand('codeJanitor.spade.search', () => spade.search()),
    vscode.commands.registerCommand('codeJanitor.spade.clearSearch', () => spade.clearSearch()),
    vscode.commands.registerCommand('codeJanitor.spade.sortByFile', () => spade.sort('file')),
    vscode.commands.registerCommand('codeJanitor.spade.sortByType', () => spade.sort('type')),
    vscode.commands.registerCommand('codeJanitor.spade.sortAlphabetically', () => spade.sort('alphabetical')),
    // From the Command Palette or a keybinding the item commands get no node: they do nothing.
    vscode.commands.registerCommand('codeJanitor.spade.goToMember', (node?: SpadeNode) => node && spade.goToMember(node)),
    vscode.commands.registerCommand(
      'codeJanitor.spade.deleteMember',
      (node?: SpadeNode, selected?: readonly SpadeNode[]) => node && spade.deleteMembers(node, selected)
    ),
    vscode.commands.registerCommand('codeJanitor.spade.findReferences', (node?: SpadeNode) => node && spade.findReferences(node)),
    vscode.commands.registerCommand('codeJanitor.spade.insertRegion', (node?: SpadeNode) => node && spade.insertRegion(node)),
    vscode.commands.registerCommand('codeJanitor.spade.removeRegion', (node?: SpadeNode) => node && spade.removeRegion(node))
  );
}

class Spade implements vscode.TreeDataProvider<SpadeNode>, vscode.TreeDragAndDropController<SpadeNode>, vscode.Disposable {
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  readonly dropMimeTypes = [DRAG_MIME_TYPE];

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private readonly view: vscode.TreeView<SpadeNode>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private document: vscode.TextDocument | undefined;
  private structure: Structure | undefined;
  /** The version of the followed document the structure was read from. */
  private structureVersion: number | undefined;
  private failure: string | undefined;
  private roots: SpadeNode[] = [];
  private nodesById = new Map<string, SpadeNode>();
  private display: SpadeDisplayOptions = displayOptions();
  private filter = '';
  /** The latest refresh; an older one finishing late is dropped. */
  private sequence = 0;
  /** A change came while the view was hidden: refresh once it shows. */
  private stale = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this, dragAndDropController: this, canSelectMany: true, showCollapseAll: true });
    this.subscriptions.push(
      this.view,
      this.changed,
      this.view.onDidChangeVisibility((event) => {
        if (event.visible && this.stale) {
          void this.refresh();
        }
      }),
      this.view.onDidCollapseElement((event) => this.synchronizeOutlining(event.element, 'editor.fold')),
      this.view.onDidExpandElement((event) => this.synchronizeOutlining(event.element, 'editor.unfold')),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.follow(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.revealCursor(event.textEditor)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.document) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document === this.document) {
          this.follow(undefined, true);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codeJanitor.spade') || event.affectsConfiguration('codeJanitor.reorganize')) {
          this.render();
        }
      })
    );
    this.follow(vscode.window.activeTextEditor, true);
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.cursorTimer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  getTreeItem(node: SpadeNode): vscode.TreeItem {
    const display = describeSpadeNode(node, this.display);
    const match = this.filter ? node.name.toLowerCase().indexOf(this.filter.toLowerCase()) : -1;
    const item = new vscode.TreeItem(
      match >= 0 ? { label: display.label, highlights: [[match, match + this.filter.length]] } : display.label,
      node.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.id = node.id;
    item.description = display.description;
    item.tooltip = display.tooltip;
    item.contextValue = node.contextValue;
    const color = display.complexity === 'alert' ? 'list.errorForeground' : display.complexity === 'warning' ? 'list.warningForeground' : undefined;
    item.iconPath = new vscode.ThemeIcon(display.icon, color ? new vscode.ThemeColor(color) : undefined);
    if (node.contextValue !== 'group') {
      item.command = { command: 'codeJanitor.spade.goToMember', title: 'Go to Member', arguments: [node] };
    }

    return item;
  }

  getChildren(node?: SpadeNode): SpadeNode[] {
    return node ? [...node.children] : this.roots;
  }

  getParent(node: SpadeNode): SpadeNode | undefined {
    return node.parent;
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (this.stale) {
      await this.refresh();
    }
  }

  /** Asks the engine for the structure of the followed document and shows it; resolves to the root nodes shown. */
  async refresh(): Promise<readonly SpadeNode[]> {
    const sequence = ++this.sequence;
    const document = this.document;
    this.stale = false;
    if (!document) {
      this.structure = undefined;
      this.failure = undefined;
      this.render();

      return this.roots;
    }

    try {
      const version = document.version;
      const structure = await engine().query<Structure | null>({ ...documentParams(document.uri, document.getText()), query: 'structure' });
      if (sequence !== this.sequence) {
        return this.roots;
      }

      this.structure = structure ?? { items: [], regions: [] };
      this.structureVersion = version;
      this.failure = undefined;
    } catch (err) {
      if (sequence !== this.sequence) {
        return this.roots;
      }

      this.structure = undefined;
      this.structureVersion = undefined;
      this.failure = err instanceof Error ? err.message : String(err);
      if (!reportEngineUnavailable(err)) {
        logError(`Spade: reading the members of ${document.uri.fsPath}`, err);
      }
    }

    this.render();

    return this.roots;
  }

  async search(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Spade: Search Members',
      prompt: 'Show the members whose name holds this text.',
      value: this.filter,
    });
    if (value === undefined) {
      return;
    }

    if (!value.trim()) {
      await this.clearSearch();

      return;
    }

    this.filter = value.trim();
    await vscode.commands.executeCommand('setContext', 'codeJanitor.spade.searching', true);
    this.render();
  }

  async clearSearch(): Promise<void> {
    this.filter = '';
    await vscode.commands.executeCommand('setContext', 'codeJanitor.spade.searching', false);
    this.render();
  }

  async sort(order: SpadeSortOrder): Promise<void> {
    await vscode.workspace.getConfiguration('codeJanitor').update('spade.primarySortOrder', order, vscode.ConfigurationTarget.Global);
    this.render();
  }

  async goToMember(node: SpadeNode): Promise<void> {
    if (!this.document) {
      return;
    }

    const editor = await editorFor(this.document);
    const position = namePosition(editor.document, node);
    editor.selection = new vscode.Selection(position, position);
    const centerOnWhole = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('spade.centerOnWhole', true);
    editor.revealRange(
      new vscode.Range(new vscode.Position(node.startLine, 0), new vscode.Position(node.endLine, 0)),
      centerOnWhole ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.Default
    );
  }

  /** Spade's Delete: the selected types, members and regions (a region with what it holds), after confirmation, in one edit. */
  async deleteMembers(node: SpadeNode, selected?: readonly SpadeNode[]): Promise<void> {
    const document = this.document;
    const nodes = (selected?.length ? selected : [node]).filter((candidate) => ['type', 'member', 'region'].includes(candidate.contextValue));
    if (!document || nodes.length === 0) {
      return;
    }

    const question = nodes.length === 1 ? `Delete '${nodes[0].name}'?` : `Delete ${nodes.length} items?`;
    if ((await vscode.window.showWarningMessage(question, { modal: true }, 'Delete')) !== 'Delete') {
      return;
    }

    await this.guard('Delete', async () => {
      const version = document.version;
      if (!this.isReadFrom(version)) {
        return;
      }

      let text = document.getText();
      for (const target of [...nodes].sort((a, b) => b.startLine - a.startLine)) {
        text = await engineText(document, 'deleteMember', text, target.item ? { line: target.startLine, name: target.name } : { line: target.startLine });
      }

      await applyText(document, version, text);
    });
  }

  async findReferences(node: SpadeNode): Promise<void> {
    if (!this.document) {
      return;
    }

    const editor = await vscode.window.showTextDocument(this.document, { preview: false });
    const position = namePosition(editor.document, node);
    editor.selection = new vscode.Selection(position, position);
    try {
      await vscode.commands.executeCommand('references-view.findReferences', editor.document.uri, position);
    } catch {
      await vscode.commands.executeCommand('editor.action.goToReferences');
    }
  }

  /** Spade's Insert Region: a region around the member with its comments, its name selected for typing over. */
  async insertRegion(node: SpadeNode): Promise<void> {
    const document = this.document;
    if (!document) {
      return;
    }

    await this.guard('Insert Region', async () => {
      const version = document.version;
      if (!this.isReadFrom(version)) {
        return;
      }

      const text = document.getText();
      const lines = await engine().query<{ startLine: number; endLine: number } | null>({
        ...documentParams(document.uri, text),
        query: 'memberLines',
        arguments: { line: node.startLine, name: node.name },
      });
      if (!lines) {
        void vscode.window.showInformationMessage(
          `Code Janitor: '${node.name}' shares its lines with other code; select the lines and use Insert Region instead.`
        );

        return;
      }

      const inserted = insertRegionAroundLines(text, lines.startLine, lines.endLine, readCleanupSettingsForUri(document.uri));
      const editor = await applyText(document, version, inserted.text);
      if (editor) {
        editor.selection = new vscode.Selection(
          new vscode.Position(inserted.nameLine, inserted.nameStart),
          new vscode.Position(inserted.nameLine, inserted.nameEnd)
        );
      }
    });
  }

  async removeRegion(node: SpadeNode): Promise<void> {
    const document = this.document;
    if (!document) {
      return;
    }

    await this.guard('Remove Region', async () => {
      const version = document.version;
      if (this.isReadFrom(version)) {
        await applyText(document, version, await engineText(document, 'removeRegions', document.getText(), { line: node.startLine }));
      }
    });
  }

  handleDrag(source: readonly SpadeNode[], dataTransfer: vscode.DataTransfer): void {
    dataTransfer.set(DRAG_MIME_TYPE, new vscode.DataTransferItem(source.map((node) => node.id)));
  }

  /** Spade's drag and drop: the engine's `moveMember`, after a sibling below or before one above. */
  async handleDrop(target: SpadeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const ids: unknown = dataTransfer.get(DRAG_MIME_TYPE)?.value;
    const document = this.document;
    if (!target || !document || !Array.isArray(ids)) {
      return;
    }

    if (ids.length !== 1) {
      void vscode.window.showInformationMessage('Code Janitor: drag one member at a time.');

      return;
    }

    const source = this.nodesById.get(String(ids[0]));
    const plan = source && dropPlan(source, target);
    if (typeof plan === 'string') {
      void vscode.window.showInformationMessage(`Code Janitor: ${plan}`);

      return;
    }

    if (plan) {
      await this.guard('Move', async () => {
        const version = document.version;
        if (this.isReadFrom(version)) {
          await applyText(document, version, await engineText(document, 'moveMember', document.getText(), { ...plan }));
        }
      });
    }
  }

  /**
   * Follows a C# editor; another editor empties the view, no editor (focus in a panel) keeps it. While the view is
   * hidden (or `features.spade` hides it) the structure is read once it shows.
   */
  private follow(editor: vscode.TextEditor | undefined, force = false): void {
    if (!editor && !force) {
      return;
    }

    const document = editor?.document.languageId === 'csharp' ? editor.document : undefined;
    if (document === this.document && !force) {
      return;
    }

    this.document = document;
    this.structureVersion = undefined;
    if (!this.view.visible) {
      ++this.sequence;
      this.structure = undefined;
      this.failure = undefined;
      this.stale = true;
      this.render();

      return;
    }

    void this.refresh();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    if (!this.view.visible) {
      this.stale = true;

      return;
    }

    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  /** Whether the tree shows `version` of the followed document; otherwise warns and refreshes the tree. */
  private isReadFrom(version: number): boolean {
    if (version === this.structureVersion) {
      return true;
    }

    void vscode.window.showWarningMessage('Code Janitor: the file changed meanwhile; try again.');
    void this.refresh();

    return false;
  }

  /** Selects the member under the cursor of the followed document. */
  private revealCursor(editor: vscode.TextEditor): void {
    if (editor.document !== this.document) {
      return;
    }

    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => {
      const node = this.view.visible ? spadeNodeAtLine(this.roots, editor.selection.active.line) : undefined;
      if (node) {
        void this.view.reveal(node, { select: true, focus: false, expand: false });
      }
    }, CURSOR_DELAY_MS);
  }

  /** `spade.synchronizeOutlining`: folds or unfolds the type or region collapsed or expanded in the tree. */
  private synchronizeOutlining(node: SpadeNode, command: 'editor.fold' | 'editor.unfold'): void {
    const document = this.document;
    if (
      !document ||
      vscode.window.activeTextEditor?.document !== document ||
      (node.contextValue !== 'type' && node.contextValue !== 'region') ||
      !vscode.workspace.getConfiguration('codeJanitor').get<boolean>('spade.synchronizeOutlining', true)
    ) {
      return;
    }

    const line = node.contextValue === 'region' ? node.startLine : braceLine(document, node);
    if (line !== undefined) {
      void vscode.commands.executeCommand(command, { levels: 1, selectionLines: [line] });
    }
  }

  private render(): void {
    const cfg = vscode.workspace.getConfiguration('codeJanitor');
    const order = cfg.get<string>('spade.primarySortOrder', 'file');
    const reorganize = readReorganizeSettings();
    this.display = displayOptions();
    this.roots = this.structure
      ? buildSpadeTree(this.structure, {
          sortOrder: SORT_ORDERS.find((candidate) => candidate === order) ?? 'file',
          secondarySortTypeByName: cfg.get<boolean>('spade.secondarySortTypeByName', false),
          memberTypes: reorganize.memberTypes,
          primaryOrderByAccessLevel: reorganize.primaryOrderByAccessLevel,
          reverseOrderByAccessLevel: reorganize.reverseOrderByAccessLevel,
          filter: this.filter,
        })
      : [];
    this.nodesById = new Map();
    const index = (nodes: readonly SpadeNode[]): void =>
      nodes.forEach((node) => {
        this.nodesById.set(node.id, node);
        index(node.children);
      });
    index(this.roots);

    this.view.description = this.document ? path.basename(this.document.fileName) : undefined;
    this.view.message = !this.document
      ? 'Open a C# file to see its members.'
      : this.failure !== undefined
        ? `Code Janitor could not read the members: ${this.failure}`
        : this.filter && this.roots.length === 0
          ? `No member matches "${this.filter}".`
          : this.filter
            ? `Members matching "${this.filter}"`
            : undefined;
    this.changed.fire();
  }

  /** Runs an edit, reporting its failure (the engine's message, for example a move that would not compile). */
  private async guard(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (!reportEngineUnavailable(err)) {
        logError(`Spade: ${label}`, err);
        void vscode.window.showWarningMessage(`Code Janitor: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function displayOptions(): SpadeDisplayOptions {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');

  return {
    showItemMetadata: cfg.get<boolean>('spade.showItemMetadata', true),
    showItemTypes: cfg.get<boolean>('spade.showItemTypes', true),
    showMethodParameters: cfg.get<boolean>('spade.showMethodParameters', true),
    showItemComplexity: cfg.get<boolean>('spade.showItemComplexity', true),
    complexityWarningThreshold: cfg.get<number>('spade.complexityWarningThreshold', 10),
    complexityAlertThreshold: cfg.get<number>('spade.complexityAlertThreshold', 15),
  };
}

/** The editor showing `document`, opened without taking the focus when none does. */
async function editorFor(document: vscode.TextDocument): Promise<vscode.TextEditor> {
  return (
    vscode.window.visibleTextEditors.find((editor) => editor.document === document) ??
    vscode.window.showTextDocument(document, { preserveFocus: true, preview: false })
  );
}

async function engineText(document: vscode.TextDocument, command: EngineCommand, text: string, args: Record<string, unknown>): Promise<string> {
  return (await engine().command({ ...documentParams(document.uri, text), command, arguments: args })).text;
}

/** Replaces the document's text in one undoable edit, unless it changed since `version` was read. */
async function applyText(document: vscode.TextDocument, version: number, text: string): Promise<vscode.TextEditor | undefined> {
  if (document.version !== version) {
    void vscode.window.showWarningMessage('Code Janitor: the file changed meanwhile; try again.');

    return undefined;
  }

  const editor = await editorFor(document);

  return (await replaceChangedPart(editor, text)) ? editor : undefined;
}

/**
 * Where the member's name is (`this` of an indexer, `operator` of an operator or conversion), past its attributes;
 * the start of its first line when it is not found, and for regions.
 */
function namePosition(document: vscode.TextDocument, node: SpadeNode): vscode.Position {
  const first = document.lineAt(node.startLine).text;
  const fallback = new vscode.Position(node.startLine, first.length - first.trimStart().length);
  const item = node.item;
  if (!item) {
    return fallback;
  }

  const token = item.kind === 'indexer' ? 'this' : item.kind === 'operator' || item.kind === 'conversion' ? 'operator' : item.name;
  const pattern = new RegExp(`(?<![\\w@])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`);
  let depth = 0;
  for (let line = node.startLine; line <= Math.min(node.endLine, document.lineCount - 1); line++) {
    const text = document.lineAt(line).text;
    let start = 0;
    while (start < text.length) {
      if (depth === 0) {
        start += text.length - start - text.slice(start).trimStart().length;
        if (text[start] !== '[') {
          break;
        }
      }

      depth += text[start] === '[' ? 1 : text[start] === ']' ? -1 : 0;
      start++;
    }

    const match = depth === 0 ? pattern.exec(text.slice(start)) : null;
    if (match) {
      return new vscode.Position(line, start + match.index);
    }
  }

  return fallback;
}

/** The line of a type's opening brace, where the editor's folding range of its body is; undefined without a body. */
function braceLine(document: vscode.TextDocument, node: SpadeNode): number | undefined {
  for (let line = node.startLine; line <= Math.min(node.endLine, document.lineCount - 1); line++) {
    if (document.lineAt(line).text.includes('{')) {
      return line;
    }
  }

  return undefined;
}
