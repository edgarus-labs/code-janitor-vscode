import * as vscode from 'vscode';

/**
 * A simple settings panel, in the spirit of the source extension's Options window.
 *
 * The form is generated from the extension's own `contributes.configuration`, so a new setting
 * shows up here automatically and there is no second list to keep in sync. The native Settings
 * editor remains the full-featured option; this panel exists to show every Code Janitor setting on
 * one page, grouped, with a scope switch.
 */

export type SettingKind = 'boolean' | 'string' | 'number' | 'enum' | 'stringArray';

export interface SettingDescriptor {
  key: string;
  kind: SettingKind;
  label: string;
  description: string;
  defaultValue: unknown;
  options?: { value: string; description?: string }[];
}

export interface SettingSection {
  title: string;
  order: number;
  settings: SettingDescriptor[];
}

interface RawSetting {
  type?: string | string[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: string[];
  enumDescriptions?: string[];
  order?: number;
  items?: { type?: string };
}

interface RawSection {
  title?: string;
  order?: number;
  properties?: Record<string, RawSetting>;
}

/**
 * Turns `contributes.configuration` into the form model. Kept separate from the webview so the
 * mapping is unit-testable.
 */
export function collectSettingSections(packageJson: unknown): SettingSection[] {
  const contributes = (packageJson as { contributes?: { configuration?: RawSection | RawSection[] } })?.contributes;
  const raw = contributes?.configuration;
  if (!raw) {
    return [];
  }

  const sections = Array.isArray(raw) ? raw : [raw];

  return sections
    .map((section, index) => ({
      title: section.title?.trim() || 'CodeJanitor',
      order: section.order ?? index,
      settings: Object.entries(section.properties ?? {})
        .map(([key, value]) => describeSetting(key, value))
        .sort(compareSettings),
    }))
    .filter((section) => section.settings.length > 0)
    .sort((a, b) => a.order - b.order);
}

function compareSettings(a: SettingDescriptor, b: SettingDescriptor): number {
  return a.label.localeCompare(b.label);
}

function describeSetting(key: string, raw: RawSetting): SettingDescriptor {
  return {
    key,
    kind: settingKind(raw),
    label: humanize(key),
    description: plainText(raw.markdownDescription ?? raw.description ?? ''),
    defaultValue: raw.default,
    options: raw.enum?.map((value, index) => ({ value, description: raw.enumDescriptions?.[index] })),
  };
}

/** Unwraps the markdown the Settings editor understands: `#some.setting#` links, code spans, bold. */
function plainText(description: string): string {
  return description
    .replace(/#([A-Za-z0-9_.]+)#/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*/g, '');
}

function settingKind(raw: RawSetting): SettingKind {
  if (raw.enum) {
    return 'enum';
  }

  const type = Array.isArray(raw.type) ? raw.type[0] : raw.type;

  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
      return 'stringArray';
    default:
      return 'string';
  }
}

/** `codeJanitor.cleanup.removeBlankLinesAtTop` becomes `Remove blank lines at top`. */
function humanize(key: string): string {
  const last = key.split('.').pop() ?? key;
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function registerSettingsUiCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.openSettings', () => SettingsPanel.show(context))
  );
}

class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private scope: 'user' | 'workspace' = 'user';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly sections: SettingSection[]
  ) {
    this.panel.webview.html = buildHtml(this.panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codeJanitor')) {
          this.postValues();
        }
      }),
      this.panel
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  static show(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(column);

      return;
    }

    const panel = vscode.window.createWebviewPanel('codeJanitorSettings', 'Code Janitor Settings', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });

    SettingsPanel.current = new SettingsPanel(panel, collectSettingSections(context.extension.packageJSON));
  }

  private handleMessage(message: { type?: string; key?: string; value?: unknown; scope?: string }): void {
    switch (message?.type) {
      case 'ready':
        void this.panel.webview.postMessage({
          type: 'init',
          sections: this.sections,
          values: this.readValues(),
          scope: this.scope,
          workspaceAvailable: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
        });

        return;

      case 'scope':
        this.scope = message.scope === 'workspace' ? 'workspace' : 'user';
        this.postValues();

        return;

      case 'update':
        if (message.key) {
          void this.update(message.key, message.value);
        }

        return;

      case 'reset':
        void this.resetAll();

        return;

      case 'exportRepository':
        void vscode.commands.executeCommand('codeJanitor.exportRepositorySettings');

        return;

      case 'importRepository':
        void vscode.commands.executeCommand('codeJanitor.importRepositorySettings');

        return;

      default:
        return;
    }
  }

  private get target(): vscode.ConfigurationTarget {
    return this.scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  }

  private async update(key: string, value: unknown): Promise<void> {
    try {
      await vscode.workspace.getConfiguration().update(key, value, this.target);
    } catch (err) {
      void vscode.window.showErrorMessage(`Code Janitor: ${(err as Error).message}`);
    }
  }

  /** Clearing a value makes the setting fall back to its default, which is what "reset" means. */
  private async resetAll(): Promise<void> {
    for (const section of this.sections) {
      for (const setting of section.settings) {
        await this.update(setting.key, undefined);
      }
    }

    this.postValues();
  }

  private readValues(): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration();
    const values: Record<string, unknown> = {};

    for (const section of this.sections) {
      for (const setting of section.settings) {
        const inspected = config.inspect(setting.key);
        const override =
          this.scope === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue;

        values[setting.key] = override ?? setting.defaultValue;
      }
    }

    return values;
  }

  private postValues(): void {
    void this.panel.webview.postMessage({ type: 'values', values: this.readValues(), scope: this.scope });
  }

  private dispose(): void {
    SettingsPanel.current = undefined;

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

function buildHtml(webview: vscode.Webview): string {
  const nonce = createNonce();

  // Every value is rendered from postMessage data via textContent/value, never interpolated here.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Janitor Settings</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 24px 32px; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 16px 0 12px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); }
  h1 { font-size: 1.4em; margin: 0; flex: 1 1 auto; }
  h2 { font-size: 1.05em; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  .setting { padding: 10px 0; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .label { font-weight: 600; }
  .description { opacity: 0.85; margin: 3px 0 6px; line-height: 1.45; }
  .modified { color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); font-weight: 600; margin-left: 6px; font-size: 0.85em; }
  input[type="text"], input[type="number"], select, textarea { width: 100%; max-width: 560px; box-sizing: border-box; padding: 4px 6px; font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  textarea { min-height: 68px; resize: vertical; font-family: var(--vscode-editor-font-family); }
  label.check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
  button, select.scope { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 5px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  select.scope { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); }
  .hint { opacity: 0.75; flex-basis: 100%; }
</style>
</head>
<body>
<header>
  <h1>Code Janitor Settings</h1>
  <label for="scope">Scope</label>
  <select id="scope" class="scope">
    <option value="user">User</option>
    <option value="workspace">Workspace</option>
  </select>
  <button id="export" type="button">Export .codejanitor</button>
  <button id="import" type="button">Import .codejanitor</button>
  <button id="reset" type="button">Reset all to defaults</button>
  <div class="hint">Changes are saved immediately. Settings left at their default are not written to settings.json.</div>
</header>
<main id="content"></main>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const scopeSelect = document.getElementById('scope');
  let controls = {};
  let defaults = {};

  document.getElementById('reset').addEventListener('click', function () {
    vscode.postMessage({ type: 'reset' });
  });

  document.getElementById('export').addEventListener('click', function () {
    vscode.postMessage({ type: 'exportRepository' });
  });

  document.getElementById('import').addEventListener('click', function () {
    vscode.postMessage({ type: 'importRepository' });
  });

  scopeSelect.addEventListener('change', function () {
    vscode.postMessage({ type: 'scope', scope: scopeSelect.value });
  });

  function send(key, value) {
    vscode.postMessage({ type: 'update', key: key, value: value });
  }

  function sameAsDefault(key, value) {
    return JSON.stringify(value) === JSON.stringify(defaults[key]);
  }

  function markModified(key) {
    const badge = controls[key] && controls[key].badge;
    if (badge) {
      badge.textContent = sameAsDefault(key, controls[key].read()) ? '' : 'Modified';
    }
  }

  function buildSetting(setting) {
    const wrapper = document.createElement('div');
    wrapper.className = 'setting';

    const badge = document.createElement('span');
    badge.className = 'modified';

    let read;
    let write;

    if (setting.kind === 'boolean') {
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      const text = document.createElement('span');
      text.className = 'label';
      text.textContent = setting.label;
      text.appendChild(badge);
      label.appendChild(box);
      label.appendChild(text);
      wrapper.appendChild(label);
      box.addEventListener('change', function () {
        send(setting.key, box.checked);
        markModified(setting.key);
      });
      read = function () { return box.checked; };
      write = function (value) { box.checked = value === true; };
    } else {
      const title = document.createElement('div');
      title.className = 'label';
      title.textContent = setting.label;
      title.appendChild(badge);
      wrapper.appendChild(title);
    }

    if (setting.description) {
      const description = document.createElement('div');
      description.className = 'description';
      description.textContent = setting.description;
      wrapper.appendChild(description);
    }

    if (setting.kind === 'enum') {
      const select = document.createElement('select');
      (setting.options || []).forEach(function (option) {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.description ? option.value + ' \\u2014 ' + option.description : option.value;
        select.appendChild(item);
      });
      wrapper.appendChild(select);
      select.addEventListener('change', function () {
        send(setting.key, select.value);
        markModified(setting.key);
      });
      read = function () { return select.value; };
      write = function (value) { select.value = value == null ? '' : String(value); };
    } else if (setting.kind === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      wrapper.appendChild(input);
      input.addEventListener('change', function () {
        const parsed = Number(input.value);
        send(setting.key, isNaN(parsed) ? setting.defaultValue : parsed);
        markModified(setting.key);
      });
      read = function () { return Number(input.value); };
      write = function (value) { input.value = value == null ? '' : String(value); };
    } else if (setting.kind === 'stringArray') {
      const area = document.createElement('textarea');
      area.placeholder = 'One regular expression per line';
      wrapper.appendChild(area);
      area.addEventListener('change', function () {
        const lines = area.value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
        send(setting.key, lines);
        markModified(setting.key);
      });
      read = function () {
        return area.value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
      };
      write = function (value) { area.value = Array.isArray(value) ? value.join('\\n') : ''; };
    } else if (setting.kind === 'string') {
      const input = document.createElement('input');
      input.type = 'text';
      wrapper.appendChild(input);
      input.addEventListener('change', function () {
        send(setting.key, input.value);
        markModified(setting.key);
      });
      read = function () { return input.value; };
      write = function (value) { input.value = value == null ? '' : String(value); };
    }

    controls[setting.key] = { read: read, write: write, badge: badge };

    return wrapper;
  }

  function render(sections) {
    content.textContent = '';
    controls = {};

    sections.forEach(function (section) {
      const heading = document.createElement('h2');
      heading.textContent = section.title;
      content.appendChild(heading);

      section.settings.forEach(function (setting) {
        defaults[setting.key] = setting.defaultValue;
        content.appendChild(buildSetting(setting));
      });
    });
  }

  function applyValues(values) {
    Object.keys(controls).forEach(function (key) {
      controls[key].write(values[key]);
      markModified(key);
    });
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message.type === 'init') {
      render(message.sections);
      scopeSelect.value = message.scope;
      if (!message.workspaceAvailable) {
        scopeSelect.options[1].disabled = true;
      }
      applyValues(message.values);
    } else if (message.type === 'values') {
      scopeSelect.value = message.scope;
      applyValues(message.values);
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return nonce;
}
