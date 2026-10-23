import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODE_STYLE_GROUPS, CODE_STYLE_RULES } from '../src/cleanup/codeStyleRules';
import {
  collectSettingSections,
  parseListInput,
  parseNumberInput,
  readOverrideNotes,
  registerSettingsUiCommand,
  resetSettingsPanelForTesting,
} from '../src/commands/settingsUi';
import { useFakeEngine } from './helpers/fakeEngine';
import { readCleanupSettings } from '../src/commands/settings';
import {
  ConfigurationTarget,
  Uri,
  createContext,
  createMockWebviewPanel,
  resetMock,
  resetWebviewPanels,
  simulateWebviewMessage,
  state,
  webviewDisposeHandlers,
  webviewPostedMessages,
  webviewMessageHandlers,
  window,
  workspace as vscodeWorkspace,
} from './helpers/vscodeMock';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

describe('collectSettingSections', () => {
  const sections = collectSettingSections(manifest);

  it('builds one group per configuration section, in declared order', () => {
    expect(sections.map((section) => section.title)).toEqual([
      'General',
      'Cleaning: File Types',
      'Cleaning: Usings and Namespaces',
      'Cleaning: Insert',
      'Cleaning: Remove',
      'Cleaning: Update',
      'Cleaning: Modern C#',
      'Cleaning: Code Style',
      'Cleaning: File Header',
      'Formatting',
      'Cleaning: External Tools',
      'Cleaning: Razor',
      'Reorganizing',
      'AI: Provider',
      'AI: XML Documentation',
      'AI: Unit Tests',
      'Spade (Code Structure)',
      'Navigation',
      'Features',
    ]);
  });

  it('covers every declared setting exactly once', () => {
    const declared = manifest.contributes.configuration.flatMap((section: { properties: object }) => Object.keys(section.properties));
    const collected = sections.flatMap((section) => section.settings.map((setting) => setting.key));

    expect([...collected].sort()).toEqual([...declared].sort());
  });

  it('maps each JSON type onto an editor kind', () => {
    const byKey = new Map(sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting]));

    expect(byKey.get('codeJanitor.cleanup.onSave')?.kind).toBe('boolean');
    expect(byKey.get('codeJanitor.cleanup.fileHeaderCSharp')?.kind).toBe('string');
    expect(byKey.get('codeJanitor.ai.customTimeoutSeconds')?.kind).toBe('number');
    expect(byKey.get('codeJanitor.cleanup.exclude')?.kind).toBe('stringArray');
    expect(byKey.get('codeJanitor.ai.provider')?.kind).toBe('enum');
  });

  it('carries the enum choices and their descriptions', () => {
    const provider = sections.flatMap((section) => section.settings).find((setting) => setting.key === 'codeJanitor.ai.provider');

    expect(provider?.options?.map((option) => option.value)).toEqual(['copilot', 'custom']);
    expect(provider?.options?.[0].description).toContain('Copilot');
  });

  it('keeps the declared defaults', () => {
    const byKey = new Map(sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting]));

    expect(byKey.get('codeJanitor.cleanup.removeRegions')?.defaultValue).toBe(true);
    expect(byKey.get('codeJanitor.cleanup.onSave')?.defaultValue).toBe(false);
    expect(byKey.get('codeJanitor.ai.xmlDoc.maxMembersPerFile')?.defaultValue).toBe(25);
    expect(byKey.get('codeJanitor.cleanup.exclude')?.defaultValue).toEqual([]);
  });

  it('derives readable labels from the setting keys', () => {
    const byKey = new Map(sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting]));

    expect(byKey.get('codeJanitor.cleanup.removeBlankLinesAtTop')?.label).toBe('Remove blank lines at top');
    expect(byKey.get('codeJanitor.ai.xmlDoc.maxMembersPerFile')?.label).toBe('Max members per file');
  });

  it('strips markdown markers from descriptions', () => {
    const removeRegions = sections.flatMap((section) => section.settings).find((setting) => setting.key === 'codeJanitor.cleanup.removeRegions');

    expect(removeRegions?.description).toContain('#region');
    expect(removeRegions?.description).not.toContain('`');
  });

  it('accepts the legacy single-object configuration shape', () => {
    const sectionsFromObject = collectSettingSections({
      contributes: {
        configuration: {
          title: 'Legacy',
          properties: { 'codeJanitor.demo': { type: 'boolean', default: true, description: 'Demo.' } },
        },
      },
    });

    expect(sectionsFromObject).toHaveLength(1);
    expect(sectionsFromObject[0].settings[0].key).toBe('codeJanitor.demo');
  });

  it('returns nothing when there is no configuration', () => {
    expect(collectSettingSections({})).toEqual([]);
    expect(collectSettingSections(undefined)).toEqual([]);
  });
});

describe('Code Style rules setting', () => {
  const codeStyleManifest = {
    contributes: {
      configuration: [
        { title: 'Cleaning: Code Style', properties: { 'codeJanitor.cleanup.codeStyleRules': { type: 'object', default: {}, description: 'Rules.' } } },
      ],
    },
  };

  it('is described with every rule, grouped like the Visual Studio Options page', () => {
    const [setting] = collectSettingSections(codeStyleManifest)[0].settings;

    expect(setting.kind).toBe('codeStyleRules');
    expect(setting.defaultValue).toEqual({});
    expect(setting.rules).toHaveLength(CODE_STYLE_RULES.length);
    expect([...new Set(setting.rules!.map((rule) => rule.group))]).toEqual([...CODE_STYLE_GROUPS]);
    expect(setting.rules![0]).toMatchObject({
      key: 'csharp_preferred_modifier_order',
      group: 'Modifiers',
      label: 'Order modifiers',
      diagnosticIds: ['IDE0036'],
      values: [],
    });
    expect(setting.rules!.find((rule) => rule.key === 'csharp_prefer_braces')).toMatchObject({
      values: ['true', 'false', 'when_multiline'],
      defaultValue: 'true',
    });
  });
});

describe('override notes', () => {
  let workspace: string;

  beforeEach(() => {
    resetMock();
    // An empty root .editorconfig above the workspace isolates the test from files on the machine.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-panel-'));
    workspace = path.join(parent, 'repo');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(parent, '.editorconfig'), 'root = true\n');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  it('shows the notes the C# engine reports for the workspace folder, sending it the user settings', async () => {
    const configPath = path.join(workspace, '.editorconfig');
    const explicit = ['Classes', 'Delegates', 'Enumerations', 'Events', 'Fields', 'Interfaces', 'Methods', 'Properties', 'Structs'];
    const engine = useFakeEngine({
      overrideNotes: () => ({
        notes: {
          convertToVarWhenApparent: `Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in ${configPath}`,
          ...Object.fromEntries(
            explicit.map((kind) => [
              `insertExplicitAccessModifiersOn${kind}`,
              `Overridden by .editorconfig: dotnet_style_require_accessibility_modifiers in ${configPath}`,
            ])
          ),
          csharp_prefer_braces: `Overridden by .editorconfig: csharp_prefer_braces in ${configPath}`,
        },
      }),
    });
    state.workspaceFolders = [{ uri: Uri.file(workspace), name: 'repo' }];

    expect(await readOverrideNotes()).toEqual({
      notes: {
        'codeJanitor.cleanup.convertToVarWhenApparent': `Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in ${configPath}`,
        'codeJanitor.cleanup.insertExplicitAccessModifiers': `Overridden by .editorconfig: dotnet_style_require_accessibility_modifiers in ${configPath}`,
      },
      ruleNotes: { csharp_prefer_braces: `Overridden by .editorconfig: csharp_prefer_braces in ${configPath}` },
    });
    expect(engine.requests('overrideNotes')).toEqual([
      { directory: workspace, settings: expect.objectContaining({ removeRegions: true, fileHeaderPosition: 'documentStart' }) },
    ]);
  });

  it('shows and locks nothing without a workspace, without asking the engine', async () => {
    const engine = useFakeEngine();

    expect(await readOverrideNotes()).toEqual({ notes: {}, ruleNotes: {} });
    expect(engine.requests('overrideNotes')).toEqual([]);
  });

  it('shows only the .codejanitor notes when the engine is unavailable', async () => {
    const policyPath = path.join(workspace, '.codejanitor');
    fs.writeFileSync(policyPath, JSON.stringify({ cleanup: { removeRegions: false } }));
    useFakeEngine({ overrideNotes: () => Promise.reject(new Error('no .NET')) });
    state.workspaceFolders = [{ uri: Uri.file(workspace), name: 'repo' }];

    expect(await readOverrideNotes()).toEqual({
      notes: { 'codeJanitor.cleanup.removeRegions': `Overridden by .codejanitor: removeRegions in ${policyPath}` },
      ruleNotes: {},
    });
  });

  it('names the key and the file for each setting and rule .codejanitor pins, unless the engine reports .editorconfig decides it', async () => {
    const policyPath = path.join(workspace, '.codejanitor');
    const configPath = path.join(workspace, '.editorconfig');
    fs.writeFileSync(
      policyPath,
      JSON.stringify({
        cleanup: {
          removeRegions: false,
          insertBlankLineBeforeReturnAndThrow: true,
          insertBlankLinePadding: false,
          insertBlankLinePaddingBeforeFieldsSingleLine: true,
          makeFieldsReadonlyWhenSafe: false,
          codeStyle: { csharp_prefer_braces: null, dotnet_style_null_propagation: 'true' },
        },
      })
    );
    useFakeEngine({
      overrideNotes: () => ({
        notes: {
          makeFieldsReadonlyWhenSafe: `Overridden by .editorconfig: dotnet_style_readonly_field in ${configPath}`,
          csharp_prefer_braces: `Overridden by .editorconfig: csharp_prefer_braces in ${configPath}`,
        },
      }),
    });
    state.workspaceFolders = [{ uri: Uri.file(workspace), name: 'repo' }];

    expect(await readOverrideNotes()).toEqual({
      notes: {
        'codeJanitor.cleanup.removeRegions': `Overridden by .codejanitor: removeRegions in ${policyPath}`,
        'codeJanitor.cleanup.insertBlankLineBeforeReturnAndThrow': `Overridden by .codejanitor: insertBlankLineBeforeReturnAndThrow in ${policyPath}`,
        'codeJanitor.cleanup.insertBlankLinePadding': `Overridden by .codejanitor: insertBlankLinePadding in ${policyPath}`,
        'codeJanitor.cleanup.insertBlankLinePaddingBeforeFieldsSingleLine': `Overridden by .codejanitor: insertBlankLinePaddingBeforeFieldsSingleLine in ${policyPath}`,
        'codeJanitor.cleanup.makeFieldsReadonlyWhenSafe': `Overridden by .editorconfig: dotnet_style_readonly_field in ${configPath}`,
      },
      ruleNotes: {
        csharp_prefer_braces: `Overridden by .editorconfig: csharp_prefer_braces in ${configPath}`,
        dotnet_style_null_propagation: `Overridden by .codejanitor: dotnet_style_null_propagation in ${policyPath}`,
      },
    });
  });

  it('locks a group setting only when .codejanitor pins every flag of the group, since the others follow the setting', async () => {
    fs.writeFileSync(
      path.join(workspace, '.codejanitor'),
      JSON.stringify({ cleanup: { insertBlankLinePaddingBeforeClasses: false, insertExplicitAccessModifiersOnFields: false } })
    );
    useFakeEngine();
    state.workspaceFolders = [{ uri: Uri.file(workspace), name: 'repo' }];

    expect(await readOverrideNotes()).toEqual({ notes: {}, ruleNotes: {} });
  });

  it('shows the stored Code Style rules with the values the editor offers', async () => {
    state.configuration.set('codeJanitor.cleanup.codeStyleRules', {
      csharp_prefer_braces: 'True',
      dotnet_style_null_propagation: 'maybe',
      unknown_rule: 'true',
    });
    const created: { __postedMessages: unknown[] }[] = [];
    const spy = vi.spyOn(window, 'createWebviewPanel').mockImplementation(() => {
      const panel = createMockWebviewPanel();
      created.push(panel as unknown as { __postedMessages: unknown[] });

      return panel;
    });
    resetWebviewPanels();
    resetSettingsPanelForTesting();
    registerSettingsUiCommand(
      createContext({
        contributes: {
          configuration: [{ title: 'Cleaning: Code Style', properties: { 'codeJanitor.cleanup.codeStyleRules': { type: 'object', default: {} } } }],
        },
      })
    );
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'ready' });
    await vi.waitFor(() => expect(created[0].__postedMessages).toHaveLength(1));

    const init = created[0].__postedMessages[0] as { values: Record<string, unknown> };
    expect(init.values['codeJanitor.cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: 'true' });
    spy.mockRestore();
  });

  it('sends the notes with the values, and stores only valid Code Style rules', async () => {
    useFakeEngine({
      overrideNotes: () => ({ notes: { makeFieldsReadonlyWhenSafe: 'Overridden by .editorconfig: dotnet_style_readonly_field in /repo/.editorconfig' } }),
    });
    state.workspaceFolders = [{ uri: Uri.file(workspace), name: 'repo' }];
    const created: { __postedMessages: unknown[] }[] = [];
    const spy = vi.spyOn(window, 'createWebviewPanel').mockImplementation(() => {
      const panel = createMockWebviewPanel();
      created.push(panel as unknown as { __postedMessages: unknown[] });

      return panel;
    });
    resetWebviewPanels();
    resetSettingsPanelForTesting();
    const context = createContext({
      contributes: {
        configuration: [{ title: 'Cleaning: Code Style', properties: { 'codeJanitor.cleanup.codeStyleRules': { type: 'object', default: {} } } }],
      },
    });
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'ready' });
    simulateWebviewMessage(0, {
      type: 'update',
      key: 'codeJanitor.cleanup.codeStyleRules',
      value: { csharp_prefer_braces: 'When_Multiline', csharp_preferred_modifier_order: 'public,loud', unknown_rule: 'true' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const init = created[0].__postedMessages[0] as { type: string; notes: Record<string, string> };
    expect(init.type).toBe('init');
    expect(init.notes['codeJanitor.cleanup.makeFieldsReadonlyWhenSafe']).toContain('Overridden by .editorconfig: dotnet_style_readonly_field in');
    expect(state.configuration.get('codeJanitor.cleanup.codeStyleRules')).toEqual({ csharp_prefer_braces: 'when_multiline' });

    simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.cleanup.codeStyleRules', value: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.configuration.get('codeJanitor.cleanup.codeStyleRules')).toBeUndefined();
    spy.mockRestore();
  });

  it('turns off in Workspace scope a rule the User settings enable, with null, since VS Code merges the setting', async () => {
    const scopes: Record<'user' | 'workspace', Record<string, unknown>> = {
      user: { 'codeJanitor.cleanup.codeStyleRules': { csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' } },
      workspace: {},
    };
    const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
    const configuration = vi.spyOn(vscodeWorkspace, 'getConfiguration').mockImplementation(
      (section?: string) =>
        ({
          // As in VS Code, an object value is merged across the scopes (the Workspace entry wins per key).
          get: (relativeKey: string, defaultValue?: unknown) => {
            const key = section ? `${section}.${relativeKey}` : relativeKey;
            const [userValue, workspaceValue] = [scopes.user[key], scopes.workspace[key]];

            return (isObject(userValue) && isObject(workspaceValue) ? { ...userValue, ...workspaceValue } : (workspaceValue ?? userValue)) ?? defaultValue;
          },
          inspect: (key: string) => ({ globalValue: scopes.user[key], workspaceValue: scopes.workspace[key] }),
          update: (key: string, value: unknown, target: unknown) => {
            scopes[target === ConfigurationTarget.Global ? 'user' : 'workspace'][key] = value;

            return Promise.resolve();
          },
        }) as never
    );
    state.workspaceFolders = [{ uri: Uri.file(workspace), name: 'repo' }];
    const panels: { __postedMessages: unknown[] }[] = [];
    const spy = vi.spyOn(window, 'createWebviewPanel').mockImplementation(() => {
      const panel = createMockWebviewPanel();
      panels.push(panel as unknown as { __postedMessages: unknown[] });

      return panel;
    });
    try {
      resetWebviewPanels();
      resetSettingsPanelForTesting();
      registerSettingsUiCommand(
        createContext({
          contributes: {
            configuration: [{ title: 'Cleaning: Code Style', properties: { 'codeJanitor.cleanup.codeStyleRules': { type: 'object', default: {} } } }],
          },
        })
      );
      await state.commands.get('codeJanitor.openSettings')!();
      simulateWebviewMessage(0, { type: 'ready' });
      simulateWebviewMessage(0, { type: 'scope', scope: 'workspace' });
      await vi.waitFor(() => expect(panels[0].__postedMessages).toHaveLength(2));
      // Workspace scope shows the rules in effect there, the User settings' included: what an update then writes keeps them.
      const shown = panels[0].__postedMessages.at(-1) as { values: Record<string, unknown> };
      expect(shown.values['codeJanitor.cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' });

      // Only braces stays checked: null propagation, on in the User settings, is turned off here.
      simulateWebviewMessage(0, {
        type: 'update',
        key: 'codeJanitor.cleanup.codeStyleRules',
        value: { csharp_prefer_braces: 'true', csharp_style_throw_expression: 'true' },
      });
      await vi.waitFor(() =>
        expect(scopes.workspace['codeJanitor.cleanup.codeStyleRules']).toEqual({
          csharp_prefer_braces: 'true',
          csharp_style_throw_expression: 'true',
          dotnet_style_null_propagation: null,
        })
      );
      // The merged setting the cleanup reads has the rule off, and the User settings keep it on.
      expect(readCleanupSettings().codeStyleRules).toEqual({ csharp_prefer_braces: 'true', csharp_style_throw_expression: 'true' });
      expect(scopes.user['codeJanitor.cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' });

      // The User scope has nothing below it to turn off: unchecking removes the rule.
      simulateWebviewMessage(0, { type: 'scope', scope: 'user' });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.cleanup.codeStyleRules', value: { csharp_prefer_braces: 'true' } });
      await vi.waitFor(() => expect(scopes.user['codeJanitor.cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: 'true' }));
    } finally {
      spy.mockRestore();
      configuration.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- SettingsPanel

describe('SettingsPanel', () => {
  beforeEach(() => {
    resetMock();
    resetWebviewPanels();
    resetSettingsPanelForTesting();
  });

  it('registers the openSettings command', () => {
    const context = createContext();
    registerSettingsUiCommand(context);

    expect(state.commands.has('codeJanitor.openSettings')).toBe(true);
  });

  it('creates a webview panel when the command is invoked', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);

    await state.commands.get('codeJanitor.openSettings')!();

    // The webview panel should have been created.
    expect(webviewMessageHandlers.length).toBeGreaterThan(0);
  });

  it('handles scope change to workspace', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    // Should not throw.
    simulateWebviewMessage(0, { type: 'scope', scope: 'workspace' });
    simulateWebviewMessage(0, { type: 'scope', scope: 'user' });
  });

  it('handles update message by writing to configuration', async () => {
    const context = createContext(manifest);
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    // Verify the handler was registered.
    expect(webviewMessageHandlers[0]).toBeDefined();
    expect(webviewMessageHandlers[0].length).toBeGreaterThan(0);

    simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.cleanup.removeRegions', value: false });

    // Wait for the async update chain to complete.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);
  });

  it('handles update message with workspace scope', async () => {
    const context = createContext(manifest);
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    // Switch to workspace scope first, then update.
    simulateWebviewMessage(0, { type: 'scope', scope: 'workspace' });
    simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.cleanup.removeRegions', value: true });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(true);
  });

  it('ignores update message without key', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'update', value: false });

    // Should not throw and no config should be written.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.configuration.size).toBe(0);
  });

  it('handles reset message by clearing all settings', async () => {
    const context = createContext(manifest);
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    state.configuration.set('codeJanitor.cleanup.removeRegions', false);
    state.configuration.set('codeJanitor.cleanup.organizeUsings', true);
    state.modalChoice = 'Reset';

    simulateWebviewMessage(0, { type: 'reset' });
    await vi.waitFor(() => expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBeUndefined());
  });

  it('handles exportRepository message', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'exportRepository' });
  });

  it('handles importRepository message', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'importRepository' });
  });

  it('ignores unknown message types', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'unknownType' });
  });

  it('ignores null message', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, null);
  });

  it('ignores message without type', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { key: 'codeJanitor.cleanup.removeRegions' });
  });

  it('reuses the existing panel on second open', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();
    const panelCount = webviewMessageHandlers.length;

    await state.commands.get('codeJanitor.openSettings')!();

    // Should not create a second panel.
    expect(webviewMessageHandlers.length).toBe(panelCount);
  });

  describe('hardening', () => {
    const posted = (type: string): { type: string; [key: string]: unknown }[] =>
      (webviewPostedMessages[0] ?? []).filter((message): message is { type: string } => (message as { type?: string })?.type === type);
    const open = async (): Promise<void> => {
      registerSettingsUiCommand(createContext(manifest));
      await state.commands.get('codeJanitor.openSettings')!();
    };
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const written = (): string[] => state.configurationUpdates.map((update) => update.key);

    it('answers ready with every setting section and the effective values', async () => {
      await open();

      simulateWebviewMessage(0, { type: 'ready' });
      await vi.waitFor(() => expect(posted('init')).toHaveLength(1));

      const init = posted('init')[0] as unknown as { sections: { settings: { key: string }[] }[]; values: Record<string, unknown>; scope: string };
      expect(init.sections.flatMap((section) => section.settings.map((setting) => setting.key))).toContain('codeJanitor.cleanup.removeRegions');
      expect(init.values['codeJanitor.cleanup.removeRegions']).toBe(true);
      expect(init.scope).toBe('user');
    });

    it('does not answer ready after the panel was disposed', async () => {
      await open();

      simulateWebviewMessage(0, { type: 'ready' });
      webviewDisposeHandlers[0].forEach((handler) => handler());
      await settle();

      expect(posted('init')).toEqual([]);
    });

    it('reports a failure to load the settings instead of leaving the rejection unhandled', async () => {
      await open();
      const configuration = vi.spyOn(vscodeWorkspace, 'getConfiguration').mockImplementation(() => {
        throw new Error('settings unavailable');
      });

      try {
        simulateWebviewMessage(0, { type: 'ready' });
        await settle();
      } finally {
        configuration.mockRestore();
      }

      expect(state.errorMessages.join('\n')).toContain('settings unavailable');
    });

    it('refuses a key that is not a Code Janitor setting', async () => {
      await open();

      simulateWebviewMessage(0, { type: 'update', key: 'editor.fontSize', value: 40 });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.noSuchSetting', value: true });
      await settle();

      expect(written()).toEqual([]);
      expect(state.errorMessages).toHaveLength(2);
    });

    it('refuses a value of the wrong type, outside the manifest range, or not an allowed choice', async () => {
      await open();

      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.cleanup.removeRegions', value: 'yes' });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.razor.indentSize', value: 99 });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.razor.indentSize', value: 2.5 });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.diagnostics.maxFileSizeKB', value: 0 });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.diagnostics.maxFileSizeKB', value: Number.NaN });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.ai.provider', value: 'other' });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.cleanup.exclude', value: ['ok', 3] });
      await settle();

      expect(written()).toEqual([]);
      expect(state.errorMessages).toHaveLength(7);
    });

    it('stores a valid value and clears a setting whose value is missing, as an emptied number field sends', async () => {
      await open();

      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.razor.indentSize', value: 2 });
      simulateWebviewMessage(0, { type: 'update', key: 'codeJanitor.diagnostics.maxFileSizeKB' });
      await settle();

      expect(state.configurationUpdates.map((update) => [update.key, update.value])).toEqual([
        ['codeJanitor.razor.indentSize', 2],
        ['codeJanitor.diagnostics.maxFileSizeKB', undefined],
      ]);
      expect(state.errorMessages).toEqual([]);
    });

    it('asks before resetting every setting and writes only the settings that have a value', async () => {
      await open();
      state.configuration.set('codeJanitor.cleanup.removeRegions', false);
      state.configuration.set('codeJanitor.cleanup.organizeUsings', true);

      state.modalChoice = undefined;
      simulateWebviewMessage(0, { type: 'reset' });
      await settle();
      expect(state.configurationUpdates).toEqual([]);
      expect(state.warningMessages).toHaveLength(1);

      state.modalChoice = 'Reset';
      simulateWebviewMessage(0, { type: 'reset' });
      await settle();

      expect([...written()].sort()).toEqual(['codeJanitor.cleanup.organizeUsings', 'codeJanitor.cleanup.removeRegions']);
      expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBeUndefined();
    });

    it('labels every input of the form for assistive technology', async () => {
      const create = vi.spyOn(window, 'createWebviewPanel');
      try {
        await open();
        const html = (create.mock.results[0].value as { webview: { html: string } }).webview.html;

        expect(html).toContain("setAttribute('aria-label'");
        expect(html).toMatch(/id="search"[^>]*aria-label=/);
        expect(html).toMatch(/<label for="scope">/);
      } finally {
        create.mockRestore();
      }
    });
  });
});

describe('settings form input parsing', () => {
  it('reads an empty or non-numeric number field as no value instead of 0', () => {
    expect(parseNumberInput('')).toBeUndefined();
    expect(parseNumberInput('   ')).toBeUndefined();
    expect(parseNumberInput('abc')).toBeUndefined();
    expect(parseNumberInput('0')).toBe(0);
    expect(parseNumberInput(' 12.5 ')).toBe(12.5);
  });

  it('keeps the exact text of each list line, dropping only blank lines', () => {
    expect(parseListInput('a \n\n  \r\n b\r\n')).toEqual(['a ', ' b']);
    expect(parseListInput('')).toEqual([]);
  });
});
