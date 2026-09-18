/**
 * In-memory stand-in for the `vscode` module, aliased in `vitest.config.ts`.
 *
 * The command layer is otherwise untestable without downloading a VS Code instance; this mock
 * implements just the API surface the commands touch, so the tests exercise the real command
 * handlers (document collection, WorkspaceEdit application, Git integration, settings mapping).
 */

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position
  ) {}
}

export class Selection extends Range {
  get active(): Position {
    return this.end;
  }

  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string
  ) {}

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath.replace(/\\/g, '/')}`;
  }
}

export class RelativePattern {
  constructor(
    readonly base: Uri,
    readonly pattern: string
  ) {}
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;

// ---------------------------------------------------------------- webview

export interface MockWebviewPanel {
  webview: {
    html: string;
    cspSource: string;
    postMessage: (message: unknown) => Thenable<boolean>;
    onDidReceiveMessage: (handler: (message: unknown) => void) => { dispose(): void };
  };
  reveal: (column: number) => void;
  dispose: () => void;
  onDidDispose: (handler: () => void) => { dispose(): void };
}

/** Registered webview message handlers. */
export const webviewMessageHandlers: ((message: unknown) => void)[][] = [];
export const webviewDisposeHandlers: (() => void)[][] = [];

let nextWebviewPanelId = 0;

/** Resets webview panel tracking - call from test setup. */
export function resetWebviewPanels(): void {
  webviewMessageHandlers.length = 0;
  webviewDisposeHandlers.length = 0;
  nextWebviewPanelId = 0;
}

export function createMockWebviewPanel(): MockWebviewPanel {
  const id = nextWebviewPanelId++;
  const messageHandlers: ((message: unknown) => void)[] = [];
  const disposeHandlers: (() => void)[] = [];
  const postedMessages: unknown[] = [];
  webviewMessageHandlers[id] = messageHandlers;
  webviewDisposeHandlers[id] = disposeHandlers;

  const panel: MockWebviewPanel = {
    webview: {
      html: '',
      cspSource: 'mock-csp',
      postMessage: (message) => {
        postedMessages.push(message);

        return Promise.resolve(true);
      },
      onDidReceiveMessage: (handler) => {
        messageHandlers.push(handler);

        return { dispose: () => messageHandlers.splice(messageHandlers.indexOf(handler), 1) };
      },
    },
    reveal: () => undefined,
    dispose: () => {
      for (const handler of disposeHandlers) {
        handler();
      }
    },
    onDidDispose: (handler) => {
      disposeHandlers.push(handler);

      return { dispose: () => disposeHandlers.splice(disposeHandlers.indexOf(handler), 1) };
    },
  };

  // Attach the id and message log so tests can target this panel.
  (panel as MockWebviewPanel & { __panelId: number; __postedMessages: unknown[] }).__panelId = id;
  (panel as MockWebviewPanel & { __postedMessages: unknown[] }).__postedMessages = postedMessages;

  return panel;
}

/** Fires a message to all handlers on the panel created with the given id. */
export function simulateWebviewMessage(panelId: number, message: unknown): void {
  for (const handler of webviewMessageHandlers[panelId] ?? []) {
    handler(message);
  }
}

export class TextEdit {
  private constructor(
    readonly range: Range,
    readonly newText: string
  ) {}

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
}

export class TextDocument {
  isClosed = false;

  version = 1;

  constructor(
    readonly uri: Uri,
    private content: string,
    readonly languageId: string
  ) {}

  get fileName(): string {
    return this.uri.fsPath;
  }

  get lineCount(): number {
    return this.content.split(/\r\n|\r|\n/).length;
  }

  getText(range?: Range): string {
    if (!range) {
      return this.content;
    }

    return this.content.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  setText(text: string): void {
    this.content = text;
    this.version++;
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.content.length));
    const before = this.content.slice(0, clamped);
    const lines = before.split(/\r\n|\r|\n/);

    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }

  offsetAt(position: Position): number {
    const lines = this.content.split(/\r\n|\r|\n/);
    const separator = this.content.includes('\r\n') ? 2 : 1;
    let offset = 0;

    for (let i = 0; i < position.line && i < lines.length; i++) {
      offset += lines[i].length + separator;
    }

    return offset + position.character;
  }

  lineAt(line: number): { text: string; range: Range } {
    const text = this.content.split(/\r\n|\r|\n/)[line] ?? '';

    return { text, range: new Range(new Position(line, 0), new Position(line, text.length)) };
  }
}

export class TextEditor {
  selection: Selection;

  constructor(
    readonly document: TextDocument,
    selection?: Selection
  ) {
    this.selection = selection ?? new Selection(new Position(0, 0), new Position(0, 0));
  }

  async edit(callback: (builder: { replace(range: Range, text: string): void }) => void): Promise<boolean> {
    const edits: { range: Range; text: string }[] = [];
    callback({ replace: (range, text) => edits.push({ range, text }) });

    applyRangeEdits(this.document, edits);

    return true;
  }
}

interface RecordedEdit {
  range: Range;
  text: string;
}

export class WorkspaceEdit {
  readonly edits = new Map<string, RecordedEdit[]>();

  replace(uri: Uri, range: Range, text: string): void {
    const key = uri.toString();
    const list = this.edits.get(key) ?? [];
    list.push({ range, text });
    this.edits.set(key, list);
  }

  get size(): number {
    return this.edits.size;
  }
}

function applyRangeEdits(document: TextDocument, edits: readonly RecordedEdit[]): void {
  const ordered = [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
  let content = document.getText();

  for (const edit of ordered) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    content = content.slice(0, start) + edit.text + content.slice(end);
  }

  document.setText(content);
}

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
}

/** Everything a test can arrange or assert on. */
export const state = {
  configuration: new Map<string, unknown>(),
  configurationUpdates: [] as { key: string; value: unknown; target: unknown }[],
  /** Every setting key the code under test asked for, so it can be checked against the manifest. */
  configurationReads: [] as string[],
  files: new Map<string, string>(),
  /** Paths in `files` that should also report the `SymbolicLink` bit from `readDirectory`. */
  symlinkedFiles: new Set<string>(),
  directories: new Set<string>(),
  documents: [] as TextDocument[],
  workspaceFolders: [] as WorkspaceFolder[],
  foundFiles: [] as Uri[],
  extensions: new Map<string, unknown>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  informationMessages: [] as string[],
  warningMessages: [] as string[],
  errorMessages: [] as string[],
  inputBoxResult: undefined as string | undefined,
  modalChoice: undefined as string | undefined,
  /** Label of the quick pick item to choose, or undefined to simulate dismissal. */
  quickPickChoice: undefined as string | undefined,
  quickPickItems: [] as { label: string }[],
  copilotModels: [] as { id: string; family: string; vendor: string; name: string; maxInputTokens: number }[],
  openedDocuments: [] as { content: string; language: string }[],
  willSaveHandlers: [] as ((event: WillSaveEvent) => void)[],
  outputChannelLines: [] as string[],
  readDirectoryCalls: 0,
};

export function resetMock(): void {
  state.configuration = new Map();
  state.configurationUpdates = [];
  state.configurationReads = [];
  state.files = new Map();
  state.symlinkedFiles = new Set();
  state.directories = new Set();
  state.documents = [];
  state.workspaceFolders = [];
  state.readDirectoryCalls = 0;
  state.foundFiles = [];
  state.extensions = new Map();
  state.commands = new Map();
  state.informationMessages = [];
  state.warningMessages = [];
  state.errorMessages = [];
  state.inputBoxResult = undefined;
  state.modalChoice = undefined;
  state.quickPickChoice = undefined;
  state.quickPickItems = [];
  state.copilotModels = [];
  state.openedDocuments = [];
  state.willSaveHandlers = [];
  state.outputChannelLines = [];
  window.activeTextEditor = undefined;
}

export interface WillSaveEvent {
  document: TextDocument;
  waitUntil(edits: Thenable<TextEdit[]>): void;
}

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  extensionUri: Uri;
  extension: { packageJSON: unknown };
  secrets: { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void> };
}

export function createContext(packageJSON?: unknown): ExtensionContext {
  const secrets = new Map<string, string>();

  return {
    subscriptions: [],
    extensionUri: Uri.file('/ext'),
    extension: { packageJSON: packageJSON ?? { version: '0.0.0-test' } },
    secrets: {
      get: (key) => Promise.resolve(secrets.get(key)),
      store: (key, value) => {
        secrets.set(key, value);

        return Promise.resolve();
      },
      delete: (key) => {
        secrets.delete(key);

        return Promise.resolve();
      },
    },
  };
}

export const window = {
  activeTextEditor: undefined as TextEditor | undefined,

  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => {
        state.outputChannelLines.push(line);
      },
      append: (text: string) => {
        state.outputChannelLines.push(text);
      },
      show: (..._args: unknown[]) => undefined,
      dispose: () => undefined,
    };
  },

  showInformationMessage(message: string, ..._rest: unknown[]): Thenable<string | undefined> {
    state.informationMessages.push(message);

    return Promise.resolve(state.modalChoice);
  },

  showWarningMessage(message: string, ..._rest: unknown[]): Thenable<string | undefined> {
    state.warningMessages.push(message);

    return Promise.resolve(state.modalChoice);
  },

  showErrorMessage(message: string): Thenable<string | undefined> {
    state.errorMessages.push(message);

    return Promise.resolve(undefined);
  },

  showInputBox(_options?: unknown): Thenable<string | undefined> {
    return Promise.resolve(state.inputBoxResult);
  },

  showQuickPick<T extends { label: string }>(items: T[], _options?: unknown): Thenable<T | undefined> {
    state.quickPickItems = items;

    return Promise.resolve(items.find((item) => item.label === state.quickPickChoice));
  },

  showTextDocument(document: TextDocument, _options?: unknown): Thenable<TextEditor> {
    return Promise.resolve(new TextEditor(document));
  },

  withProgress<T>(_options: unknown, task: (progress: unknown, token: unknown) => Thenable<T>): Thenable<T> {
    return task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => undefined });
  },

  createWebviewPanel(
    _viewType: string,
    _title: string,
    _column: number,
    _options: unknown
  ): MockWebviewPanel {
    return createMockWebviewPanel();
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): { dispose(): void } {
    state.commands.set(id, handler);

    return { dispose: () => state.commands.delete(id) };
  },

  /**
   * Dispatches to a registered handler if there is one for `id` (so a command that composes
   * another Code Janitor command, e.g. via `executeCommand`, is exercised for real), otherwise
   * resolves `undefined` - the built-in VS Code commands used in a few places (`vscode.diff`,
   * `workbench.action.closeActiveEditor`, ...) have no handler here and are just no-ops.
   */
  executeCommand(id: string, ...args: unknown[]): Thenable<unknown> {
    const handler = state.commands.get(id);

    return Promise.resolve(handler?.(...args));
  },
};

export const extensions = {
  getExtension(id: string): unknown {
    return state.extensions.get(id);
  },
};

export const workspace = {
  get textDocuments(): TextDocument[] {
    return state.documents;
  },

  get workspaceFolders(): WorkspaceFolder[] {
    return state.workspaceFolders;
  },

  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : '';

    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = `${prefix}${key}`;
        state.configurationReads.push(full);

        return (state.configuration.has(full) ? (state.configuration.get(full) as T) : defaultValue);
      },
      update(key: string, value: unknown, target?: unknown): Thenable<void> {
        const full = `${prefix}${key}`;
        state.configuration.set(full, value);
        state.configurationUpdates.push({ key: full, value, target });

        return Promise.resolve();
      },
      inspect<T>(key: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined {
        const full = `${prefix}${key}`;

        return state.configuration.has(full)
          ? { globalValue: state.configuration.get(full) as T, workspaceValue: undefined }
          : undefined;
      },
    };
  },

  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return state.workspaceFolders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath));
  },

  findFiles(_include: string | RelativePattern, _exclude?: string): Thenable<Uri[]> {
    return Promise.resolve(state.foundFiles);
  },

  openTextDocument(options: { content: string; language: string }): Thenable<TextDocument> {
    state.openedDocuments.push(options);

    return Promise.resolve(new TextDocument(Uri.file('/untitled'), options.content, options.language));
  },

  applyEdit(edit: WorkspaceEdit): Thenable<boolean> {
    for (const [key, edits] of edit.edits) {
      const document = state.documents.find((candidate) => candidate.uri.toString() === key);
      if (document) {
        applyRangeEdits(document, edits);
      }
    }

    return Promise.resolve(true);
  },

  onWillSaveTextDocument(handler: (event: WillSaveEvent) => void): { dispose(): void } {
    state.willSaveHandlers.push(handler);

    return { dispose: () => undefined };
  },

  onDidChangeConfiguration(_handler: (event: { affectsConfiguration(section: string): boolean }) => void): { dispose(): void } {
    return { dispose: () => undefined };
  },

  fs: {
    readFile(uri: Uri): Thenable<Uint8Array> {
      const content = state.files.get(uri.fsPath);
      if (content === undefined) {
        return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
      }

      return Promise.resolve(new TextEncoder().encode(content));
    },

    writeFile(uri: Uri, content: Uint8Array): Thenable<void> {
      state.files.set(uri.fsPath, new TextDecoder().decode(content));

      return Promise.resolve();
    },

    stat(uri: Uri): Thenable<{ type: number }> {
      if (state.directories.has(uri.fsPath)) {
        return Promise.resolve({ type: FileType.Directory });
      }

      return Promise.resolve({ type: FileType.File });
    },

    /** Lists the immediate children of `uri` derived from the flat `state.files` map. */
    readDirectory(uri: Uri): Thenable<[string, number][]> {
      state.readDirectoryCalls++;
      const dir = uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
      const seen = new Map<string, number>();

      for (const filePath of state.files.keys()) {
        const normalized = filePath.replace(/\\/g, '/');
        if (!normalized.startsWith(`${dir}/`)) {
          continue;
        }

        const rest = normalized.slice(dir.length + 1);
        const isNested = rest.includes('/');
        const name = isNested ? rest.slice(0, rest.indexOf('/')) : rest;

        const type = isNested
          ? FileType.Directory
          : state.symlinkedFiles.has(filePath)
            ? FileType.File | FileType.SymbolicLink
            : FileType.File;
        seen.set(name, type);
      }

      return Promise.resolve([...seen.entries()]);
    },
  },
};

export const lm = {
  selectChatModels(_selector?: unknown): Thenable<unknown[]> {
    return Promise.resolve(state.copilotModels);
  },
};

export class LanguageModelChatMessage {
  static User(content: string): { content: string; role: string } {
    return { content, role: 'user' };
  }
}

export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  dispose(): void {}
}

export interface MockChatModel {
  id: string;
  family: string;
  vendor: string;
  name: string;
  maxInputTokens: number;
  sendRequest(messages: unknown[], _options: unknown, _token: unknown): Thenable<{ text: AsyncIterable<string> }>;
}

export function createMockChatModel(
  overrides: Partial<MockChatModel> = {},
  fragments: string[] = ['Hello']
): MockChatModel {
  return {
    id: 'copilot-4o',
    family: 'copilot-4o',
    vendor: 'copilot',
    name: 'GPT-4o',
    maxInputTokens: 128000,
    sendRequest: () =>
      Promise.resolve({
        text: (async function* () {
          for (const f of fragments) yield f;
        })(),
      }),
    ...overrides,
  };
}
