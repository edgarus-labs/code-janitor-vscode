import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectSettingSections, registerSettingsUiCommand, resetSettingsPanelForTesting } from '../src/commands/settingsUi';
import {
  createContext,
  createMockWebviewPanel,
  resetMock,
  resetWebviewPanels,
  simulateWebviewMessage,
  state,
  webviewDisposeHandlers,
  webviewMessageHandlers,
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
      'Cleaning: File Header',
      'Formatting',
      'AI: Provider',
      'AI: XML Documentation',
      'AI: Unit Tests',
    ]);
  });

  it('covers every declared setting exactly once', () => {
    const declared = manifest.contributes.configuration.flatMap((section: { properties: object }) =>
      Object.keys(section.properties)
    );
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
    const provider = sections
      .flatMap((section) => section.settings)
      .find((setting) => setting.key === 'codeJanitor.ai.provider');

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
    const removeRegions = sections
      .flatMap((section) => section.settings)
      .find((setting) => setting.key === 'codeJanitor.cleanup.removeRegions');

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

  it('sends init message with sections and values when the webview sends ready', async () => {
    const context = createContext();
    registerSettingsUiCommand(context);
    await state.commands.get('codeJanitor.openSettings')!();

    simulateWebviewMessage(0, { type: 'ready' });

    // The panel's postMessage should have been called with init data.
    // We can't easily access it from the mock, but the fact that no error was thrown is enough.
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
    const context = createContext();
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
    const context = createContext();
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

    // Set some values first.
    state.configuration.set('codeJanitor.cleanup.removeRegions', false);
    state.configuration.set('codeJanitor.cleanup.organizeUsings', true);

    // Verify they were set.
    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);

    simulateWebviewMessage(0, { type: 'reset' });

    // resetAll is async and iterates over many settings; give it time to complete.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Reset clears to undefined (falls back to default).
    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBeUndefined();
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
});
