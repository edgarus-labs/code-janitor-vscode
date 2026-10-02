import * as vscode from 'vscode';
import { CODE_STYLE_GROUPS, CODE_STYLE_RULES, formatCodeStyleSetting, parseCodeStyleSetting } from '../cleanup/codeStyleRules';
import { editorConfigOverrideNotes } from '../cleanup/overrideNotes';
import { readCleanupSettings } from './settings';

/**
 * A simple settings panel, in the spirit of the source extension's Options window.
 *
 * The form is generated from the extension's own `contributes.configuration`, so a new setting
 * shows up here automatically and there is no second list to keep in sync. The native Settings
 * editor remains the full-featured option; this panel exists to show every Code Janitor setting on
 * one page, grouped, with a scope switch.
 */

export type SettingKind = 'boolean' | 'string' | 'number' | 'enum' | 'stringArray' | 'codeStyleRules';

/** The setting that stores the enabled Code Style rules (see `cleanup/codeStyleRules.ts`). */
export const CODE_STYLE_RULES_SETTING = 'codeJanitor.cleanup.codeStyleRules';

/** One Code Style rule as the panel shows it: a switch and a value, in the group of the Visual Studio Options page. */
export interface CodeStyleRuleDescriptor {
  key: string;
  group: string;
  label: string;
  diagnosticIds: string[];
  /** The accepted values; empty when the value is free text. */
  values: string[];
  defaultValue: string;
}

export interface SettingDescriptor {
  key: string;
  kind: SettingKind;
  label: string;
  description: string;
  defaultValue: unknown;
  options?: { value: string; description?: string }[];
  /** For `codeStyleRules`: the catalog of rules, grouped by `group` in the order listed. */
  rules?: CodeStyleRuleDescriptor[];
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
    kind: key === CODE_STYLE_RULES_SETTING ? 'codeStyleRules' : settingKind(raw),
    ...(key === CODE_STYLE_RULES_SETTING && { rules: describeCodeStyleRules() }),
    label: humanize(key),
    description: plainText(raw.markdownDescription ?? raw.description ?? ''),
    defaultValue: raw.default,
    options: raw.enum?.map((value, index) => ({ value, description: raw.enumDescriptions?.[index] })),
  };
}

/** The catalog of rules, grouped as in the Visual Studio Options page (groups in catalog order). */
function describeCodeStyleRules(): CodeStyleRuleDescriptor[] {
  return CODE_STYLE_GROUPS.flatMap((group) =>
    CODE_STYLE_RULES.filter((rule) => rule.group === group).map((rule) => ({
      key: rule.key,
      group,
      label: rule.description,
      diagnosticIds: [...rule.diagnosticIds],
      values: [...rule.values],
      defaultValue: rule.defaultValue,
    }))
  );
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

function nonEmpty(value: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/** What the workspace's `.editorconfig` overrides, as the panel shows it (see `cleanup/overrideNotes.ts`). */
export interface OverrideNotes {
  /** Note by setting id (`codeJanitor.cleanup.convertToVarWhenApparent`). */
  notes: Record<string, string>;
  /** Note by Code Style rule option name (`csharp_prefer_braces`). */
  ruleNotes: Record<string, string>;
}

/**
 * The notes for the first workspace folder: a setting (or rule) `.editorconfig` decides there shows
 * `Overridden by .editorconfig: <key> in <path>` and is disabled. Nothing without a workspace.
 */
export function readOverrideNotes(): OverrideNotes {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const notes: OverrideNotes = { notes: {}, ruleNotes: {} };
  if (!root) {
    return notes;
  }

  const ruleKeys = new Set(CODE_STYLE_RULES.map((rule) => rule.key));
  for (const [name, note] of editorConfigOverrideNotes(root, readCleanupSettings(root))) {
    if (ruleKeys.has(name)) {
      notes.ruleNotes[name] = note;
    } else {
      // The nine per-kind explicit access modifier flags are one setting in VS Code.
      notes.notes[`codeJanitor.cleanup.${name.startsWith('insertExplicitAccessModifiersOn') ? 'insertExplicitAccessModifiers' : name}`] = note;
    }
  }

  return notes;
}

export function registerSettingsUiCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.openSettings', () => SettingsPanel.show(context))
  );
}

/** Test-only: resets the singleton so each test starts with a fresh panel. */
export function resetSettingsPanelForTesting(): void {
  SettingsPanel.resetForTesting();
}

class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static resetForTesting(): void {
    SettingsPanel.current = undefined;
  }

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
          ...readOverrideNotes(),
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
      // Only valid rules are stored (an empty selection is the default, which is not written).
      const stored = key === CODE_STYLE_RULES_SETTING && value !== undefined ? nonEmpty(formatCodeStyleSetting(parseCodeStyleSetting(value))) : value;
      await vscode.workspace.getConfiguration().update(key, stored, this.target);
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
    void this.panel.webview.postMessage({ type: 'values', values: this.readValues(), ...readOverrideNotes(), scope: this.scope });
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
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; }
  header {
    position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background);
    padding: 16px 24px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  h1 { font-size: 1.25em; font-weight: 600; margin: 0; flex: 1 1 auto; }
  .spacer { flex: 1 1 auto; }
  .layout { display: flex; align-items: flex-start; }
  nav.toc {
    position: sticky; top: 64px; align-self: flex-start; width: 232px; flex: 0 0 232px;
    max-height: calc(100vh - 88px); overflow-y: auto; padding: 16px 8px 16px 24px;
  }
  nav.toc a {
    display: block; padding: 6px 10px; border-radius: 6px; color: var(--vscode-foreground);
    text-decoration: none; opacity: 0.75; font-size: 0.95em; margin-bottom: 2px;
  }
  nav.toc a:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  nav.toc a.active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); opacity: 1; font-weight: 600; }
  main { flex: 1 1 auto; min-width: 0; padding: 16px 24px 48px; }
  .search {
    width: 100%; max-width: 420px; padding: 6px 10px; margin-bottom: 4px; font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px;
  }
  section.group { margin-top: 8px; scroll-margin-top: 72px; }
  h2 { font-size: 1.05em; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  .card {
    padding: 12px 14px; margin-bottom: 8px; border-radius: 8px;
    background: var(--vscode-editorWidget-background, transparent);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  }
  .card.hidden { display: none; }
  .label { font-weight: 600; }
  .description {
    display: flex; gap: 6px; align-items: flex-start;
    opacity: 0.85; margin: 3px 0 8px; line-height: 1.45; font-size: 0.95em;
  }
  .description .icon { flex: 0 0 auto; line-height: 1.45; opacity: 0.9; }
  .modified {
    color: var(--vscode-badge-foreground); background: var(--vscode-badge-background, var(--vscode-textLink-foreground));
    font-weight: 600; margin-left: 8px; font-size: 0.75em; padding: 1px 7px; border-radius: 999px; vertical-align: middle;
  }
  input[type="text"], input[type="number"], select, textarea {
    width: 100%; max-width: 560px; padding: 5px 8px; font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
  }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea { min-height: 64px; resize: vertical; font-family: var(--vscode-editor-font-family); }
  label.check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
  button, select.scope {
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.9em;
  }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground, transparent); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  select.scope { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); }
  .note {
    margin-top: 6px; padding: 4px 8px; font-size: 0.9em; border-radius: 4px;
    color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
    background: var(--vscode-editorInfo-background, transparent);
    border-left: 3px solid var(--vscode-editorInfo-foreground, var(--vscode-focusBorder));
  }
  .note[hidden] { display: none; }
  .rule-group { font-weight: 600; margin: 14px 0 6px; opacity: 0.9; }
  .rule-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 3px 0; }
  .rule-row label.check { flex: 1 1 260px; }
  .rule-row .value { flex: 0 1 280px; max-width: 280px; }
  .rule-ids { opacity: 0.6; font-size: 0.85em; }
  .rule-row .note { flex-basis: 100%; margin-top: 0; }
  .hint { opacity: 0.7; font-size: 0.85em; flex-basis: 100%; display: flex; gap: 6px; align-items: flex-start; }
  .empty { opacity: 0.7; padding: 24px 0; }
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
  <div class="spacer"></div>
  <button id="export" class="secondary" type="button">Export .codejanitor</button>
  <button id="import" class="secondary" type="button">Import .codejanitor</button>
  <button id="reset" class="secondary" type="button">Reset all to defaults</button>
  <div class="hint"><span>&#128161;</span><span>Changes are saved immediately. Settings left at their default are not written to settings.json.</span></div>
</header>
<div class="layout">
  <nav id="toc" class="toc"></nav>
  <main>
    <input id="search" class="search" type="search" placeholder="Search settings\u2026">
    <div id="content"></div>
    <div id="empty" class="empty" hidden>&#128269; No settings match your search.</div>
  </main>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const toc = document.getElementById('toc');
  const searchBox = document.getElementById('search');
  const emptyState = document.getElementById('empty');
  const scopeSelect = document.getElementById('scope');
  let controls = {};
  let defaults = {};
  let cards = [];

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
    wrapper.className = 'card';
    wrapper.dataset.searchText = (setting.label + ' ' + setting.description + ' ' + setting.key + ' ' +
      (setting.rules || []).map(function (rule) { return rule.label + ' ' + rule.key + ' ' + rule.group; }).join(' ')).toLowerCase();

    const badge = document.createElement('span');
    badge.className = 'modified';

    let read;
    let write;
    const inputs = [];
    let ruleRows = {};

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
      inputs.push(box);
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

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '\\u2139\\uFE0F';
      description.appendChild(icon);

      const text = document.createElement('span');
      text.textContent = setting.description;
      description.appendChild(text);

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
      inputs.push(select);
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
      inputs.push(input);
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
      inputs.push(area);
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
      inputs.push(input);
      input.addEventListener('change', function () {
        send(setting.key, input.value);
        markModified(setting.key);
      });
      read = function () { return input.value; };
      write = function (value) { input.value = value == null ? '' : String(value); };
    } else if (setting.kind === 'codeStyleRules') {
      const rules = setting.rules || [];
      const readAll = function () {
        const value = {};
        rules.forEach(function (rule) {
          const row = ruleRows[rule.key];
          if (row.box.checked) {
            value[rule.key] = row.value.value.trim();
          }
        });
        return value;
      };
      const changed = function () {
        send(setting.key, readAll());
        markModified(setting.key);
      };
      let currentGroup = null;

      rules.forEach(function (rule) {
        if (rule.group !== currentGroup) {
          currentGroup = rule.group;
          const heading = document.createElement('div');
          heading.className = 'rule-group';
          heading.textContent = rule.group;
          wrapper.appendChild(heading);
        }

        const row = document.createElement('div');
        row.className = 'rule-row';

        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        const text = document.createElement('span');
        text.textContent = rule.label;
        const ids = document.createElement('span');
        ids.className = 'rule-ids';
        ids.textContent = ' ' + rule.diagnosticIds.join(', ');
        text.appendChild(ids);
        label.appendChild(box);
        label.appendChild(text);
        row.appendChild(label);

        let valueInput;
        if (rule.values.length > 0) {
          valueInput = document.createElement('select');
          rule.values.forEach(function (value) {
            const item = document.createElement('option');
            item.value = value;
            item.textContent = value;
            valueInput.appendChild(item);
          });
        } else {
          valueInput = document.createElement('input');
          valueInput.type = 'text';
          valueInput.placeholder = 'Comma-separated modifiers';
        }
        valueInput.className = 'value';
        valueInput.title = rule.key;
        row.appendChild(valueInput);

        const ruleNote = document.createElement('div');
        ruleNote.className = 'note';
        ruleNote.hidden = true;
        row.appendChild(ruleNote);

        box.addEventListener('change', changed);
        valueInput.addEventListener('change', changed);
        ruleRows[rule.key] = { box: box, value: valueInput, note: ruleNote, rule: rule };
        wrapper.appendChild(row);
      });

      read = readAll;
      write = function (value) {
        rules.forEach(function (rule) {
          const row = ruleRows[rule.key];
          const current = value && typeof value[rule.key] === 'string' ? value[rule.key] : undefined;
          row.box.checked = current !== undefined;
          row.value.value = current !== undefined ? current : rule.defaultValue;
        });
      };
    }

    const note = document.createElement('div');
    note.className = 'note';
    note.hidden = true;
    wrapper.appendChild(note);

    controls[setting.key] = {
      read: read,
      write: write,
      badge: badge,
      setNote: function (text) {
        note.hidden = !text;
        note.textContent = text || '';
        inputs.forEach(function (input) { input.disabled = !!text; });
      },
      setRuleNotes: function (ruleNotes) {
        Object.keys(ruleRows).forEach(function (ruleKey) {
          const row = ruleRows[ruleKey];
          const text = ruleNotes[ruleKey];
          row.note.hidden = !text;
          row.note.textContent = text || '';
          row.box.disabled = !!text;
          row.value.disabled = !!text;
        });
      },
    };

    return wrapper;
  }

  function render(sections) {
    content.textContent = '';
    toc.textContent = '';
    controls = {};
    cards = [];

    sections.forEach(function (section, index) {
      const sectionId = 'section-' + index;

      const group = document.createElement('section');
      group.className = 'group';
      group.id = sectionId;

      const heading = document.createElement('h2');
      heading.textContent = section.title;
      group.appendChild(heading);

      section.settings.forEach(function (setting) {
        defaults[setting.key] = setting.defaultValue;
        const card = buildSetting(setting);
        cards.push(card);
        group.appendChild(card);
      });

      content.appendChild(group);

      const link = document.createElement('a');
      link.href = '#' + sectionId;
      link.textContent = section.title;
      link.addEventListener('click', function (event) {
        event.preventDefault();
        group.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      toc.appendChild(link);
    });

    observeSections();
  }

  function observeSections() {
    const links = Array.from(toc.querySelectorAll('a'));
    if (!('IntersectionObserver' in window) || links.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) {
          return;
        }

        links.forEach(function (link) { link.classList.remove('active'); });
        const active = toc.querySelector('a[href="#' + entry.target.id + '"]');
        if (active) {
          active.classList.add('active');
        }
      });
    }, { rootMargin: '-72px 0px -70% 0px' });

    document.querySelectorAll('section.group').forEach(function (section) { observer.observe(section); });
  }

  function applyFilter() {
    const query = searchBox.value.trim().toLowerCase();
    let visibleCount = 0;

    cards.forEach(function (card) {
      const matches = !query || card.dataset.searchText.indexOf(query) !== -1;
      card.classList.toggle('hidden', !matches);
      if (matches) {
        visibleCount++;
      }
    });

    document.querySelectorAll('section.group').forEach(function (section) {
      const visible = Array.from(section.querySelectorAll('.card')).some(function (card) {
        return !card.classList.contains('hidden');
      });
      section.style.display = visible ? '' : 'none';
    });

    emptyState.hidden = visibleCount !== 0;
  }

  searchBox.addEventListener('input', applyFilter);

  function applyValues(values, notes, ruleNotes) {
    Object.keys(controls).forEach(function (key) {
      controls[key].write(values[key]);
      controls[key].setNote(notes && notes[key]);
      if (controls[key].setRuleNotes) {
        controls[key].setRuleNotes(ruleNotes || {});
      }
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
      applyValues(message.values, message.notes, message.ruleNotes);
      applyFilter();
    } else if (message.type === 'values') {
      scopeSelect.value = message.scope;
      applyValues(message.values, message.notes, message.ruleNotes);
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
