/**
 * Adds to the in-memory `vscode` mock what the cleanup preview and the navigation commands use
 * beyond it: a scriptable `createQuickPick`, virtual-document providers, `vscode.diff`, editor tabs
 * and `fs.isWritableFileSystem`. Call `installPreviewMock()` after `resetMock()`.
 */
import { Uri, state, window, workspace } from './vscodeMock';

const originalStat = workspace.fs.stat.bind(workspace.fs);

type Listener<T> = (event: T) => void;

export interface FakeItem {
  label: string;
  description?: string;
  detail?: string;
  buttons?: { tooltip?: string }[];
  [key: string]: unknown;
}

/** The part of `vscode.QuickPick` the preview uses, driven by a test instead of a user. */
export class FakeQuickPick {
  title = '';

  placeholder = '';

  canSelectMany = false;

  ignoreFocusOut = false;

  matchOnDescription = false;

  matchOnDetail = false;

  items: FakeItem[] = [];

  selectedItems: FakeItem[] = [];

  activeItems: FakeItem[] = [];

  hidden = false;

  disposed = false;

  private readonly listeners = {
    accept: [] as Listener<void>[],
    hide: [] as Listener<void>[],
    selection: [] as Listener<FakeItem[]>[],
    active: [] as Listener<FakeItem[]>[],
    button: [] as Listener<{ item: FakeItem; button: { tooltip?: string } }>[],
  };

  onDidAccept = (listener: Listener<void>) => this.listen('accept', listener);

  onDidHide = (listener: Listener<void>) => this.listen('hide', listener);

  onDidChangeSelection = (listener: Listener<FakeItem[]>) => this.listen('selection', listener);

  onDidChangeActive = (listener: Listener<FakeItem[]>) => this.listen('active', listener);

  onDidTriggerItemButton = (listener: Listener<{ item: FakeItem; button: { tooltip?: string } }>) => this.listen('button', listener);

  show(): void {
    previewState.pickers.push(this);
    const script = previewState.pickerScripts.shift();
    // Like a user: acts after the picker is shown; with nothing scripted the user presses Escape.
    setTimeout(() => {
      if (!script) {
        this.hide();

        return;
      }

      // A failing expectation inside a script would otherwise be an unhandled error of the timer.
      Promise.resolve()
        .then(() => script(this))
        .catch((err: unknown) => {
          previewState.failures.push(err);
          this.hide();
        });
    }, 0);
  }

  hide(): void {
    if (!this.hidden) {
      this.hidden = true;
      this.emit('hide', undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  find(label: string): FakeItem {
    const item = this.items.find((candidate) => candidate.label.includes(label));
    if (!item) {
      throw new Error(`No item "${label}" in: ${this.items.map((candidate) => candidate.label).join(' | ')}`);
    }

    return item;
  }

  /** Checks exactly the items whose label contains one of `labels` (what a user does with the checkboxes). */
  select(...labels: string[]): void {
    this.selectedItems = labels.map((label) => this.find(label));
    this.emit('selection', this.selectedItems);
  }

  /** Checks the items that are checked now, and those of `labels`. */
  selectAlso(...labels: string[]): void {
    this.selectedItems = [...this.selectedItems, ...labels.map((label) => this.find(label))];
    this.emit('selection', this.selectedItems);
  }

  activate(label: string): void {
    this.activeItems = [this.find(label)];
    this.emit('active', this.activeItems);
  }

  clickButton(label: string, tooltip: string): void {
    const item = this.find(label);
    const button = item.buttons?.find((candidate) => candidate.tooltip === tooltip);
    if (!button) {
      throw new Error(`No button "${tooltip}" on ${item.label}`);
    }

    this.emit('button', { item, button });
  }

  accept(): void {
    this.emit('accept', undefined);
  }

  escape(): void {
    this.hide();
  }

  private listen<K extends keyof FakeQuickPick['listeners']>(kind: K, listener: Listener<never>): { dispose(): void } {
    (this.listeners[kind] as Listener<never>[]).push(listener);

    return { dispose: () => undefined };
  }

  private emit(kind: keyof FakeQuickPick['listeners'], event: unknown): void {
    for (const listener of this.listeners[kind] as Listener<unknown>[]) {
      listener(event);
    }
  }
}

interface Tab {
  input: unknown;
  isDirty: boolean;
}

export const previewState = {
  pickers: [] as FakeQuickPick[],
  /** Errors thrown by the scripts of the user (failed expectations); `assertScriptsPassed` rethrows them. */
  failures: [] as unknown[],
  /** What the user does with the next shown pickers, in order. */
  pickerScripts: [] as ((picker: FakeQuickPick) => void | Promise<void>)[],
  providers: new Map<string, { provideTextDocumentContent(uri: Uri): string }>(),
  diffs: [] as { before: Uri; after: Uri; title: string; options: unknown }[],
  tabs: [] as Tab[],
  closedTabs: [] as Tab[],
  /** Schemes reported as not writable. */
  readOnlySchemes: new Set<string>(),
  /**
   * Non-`file:` resources (`uri.toString()`) whose provider reports `FilePermission.Readonly`. VS Code never
   * reports it for `file:` URIs: the disk provider marks a file without write permission `Locked`, which the
   * extension host maps to `permissions: undefined`. Model those with a real file and `chmod`.
   */
  readOnlyResources: new Set<string>(),
  /** Text of a virtual document, as VS Code shows it in the diff. */
  text(uri: Uri): string {
    return previewState.providers.get(uri.scheme)?.provideTextDocumentContent(uri) ?? '';
  },
};

/** Rethrows the first error a user script threw - call it at the end of a test. */
export function assertScriptsPassed(): void {
  const [first] = previewState.failures;
  previewState.failures = [];
  if (first !== undefined) {
    throw first;
  }
}

export function installPreviewMock(): void {
  previewState.pickers = [];
  previewState.failures = [];
  previewState.pickerScripts = [];
  previewState.providers = new Map();
  previewState.diffs = [];
  previewState.tabs = [];
  previewState.closedTabs = [];
  previewState.readOnlySchemes = new Set();
  previewState.readOnlyResources = new Set();

  Object.assign(window, {
    createQuickPick: () => new FakeQuickPick(),
    tabGroups: {
      get all() {
        return [{ tabs: previewState.tabs }];
      },
      close(tabs: Tab[]) {
        previewState.closedTabs.push(...tabs);
        previewState.tabs = previewState.tabs.filter((tab) => !tabs.includes(tab));

        return Promise.resolve(true);
      },
    },
  });

  Object.assign(workspace, {
    registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri): string }) {
      previewState.providers.set(scheme, provider);

      return { dispose: () => previewState.providers.delete(scheme) };
    },
  });

  const fs = workspace.fs as unknown as {
    isWritableFileSystem: (scheme: string) => boolean | undefined;
    stat: (uri: Uri) => Thenable<{ type: number; permissions?: number }>;
  };
  fs.isWritableFileSystem = (scheme) => !previewState.readOnlySchemes.has(scheme);
  fs.stat = async (uri) => {
    const stat = await originalStat(uri);

    return uri.scheme !== 'file' && previewState.readOnlyResources.has(uri.toString()) ? { ...stat, permissions: 1 } : stat;
  };

  state.commands.set('vscode.diff', (before, after, title, options) => {
    previewState.diffs.push({ before: before as Uri, after: after as Uri, title: title as string, options });
    previewState.tabs.push({ input: { original: before, modified: after }, isDirty: false });
  });
}
