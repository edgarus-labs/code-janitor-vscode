import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConfigurationTarget,
  Position,
  Selection,
  TextDocument,
  TextEdit,
  TextEditor,
  Uri,
  createContext,
  ExtensionContext,
  resetMock,
  state,
  window,
  workspace,
} from './helpers/vscodeMock';
import { activate } from '../src/extension';
import { registerCleanupCommands } from '../src/commands/cleanupCommands';
import { collectFiles, expandToCleanableFiles, isSupportedFile, runCleanupOnUris } from '../src/commands/cleanupCore';
import { registerEditorCommands, suggestNamespace } from '../src/commands/editorCommands';
import { registerFormatOnSave } from '../src/commands/formatOnSave';
import { readCleanupSettings, readCleanupSettingsForUri, readXmlDocOptions } from '../src/commands/settings';
import { exportRepositorySettings, importRepositorySettings, registerRepositorySettingsCommands } from '../src/commands/repositorySettings';
import { HeaderPosition, HeaderUpdateMode } from '../src/cleanup/types';
import { createOutputChannel } from '../src/logging';
import { EngineClient, EngineUnavailableError } from '../src/engine/client';
import { ENGINE_WATCH_GLOB, setEngine } from '../src/engine/vscodeEngine';
import { SAVE_CLEANUP_TIMEOUT_MS } from '../src/commands/formatOnSave';
import { EngineParams, FakeEngine, cleanupResult, trimTrailingWhitespace, useFakeEngine } from './helpers/fakeEngine';

/** Trailing whitespace is the smallest change every default cleanup configuration performs. */
const UNCLEAN = 'internal class C   \n{\n}\n';
const XML_DOCUMENTED = '/// <summary>Doc.</summary>\ninternal class C\n{\n}\n';

beforeEach(() => {
  resetMock();
});

/** Temporary folders created by the running test, removed after it whether it passes or fails. */
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-'));
  tempRoots.push(root);

  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A `codeJanitor` configuration with separate User and Workspace values (keys relative to the section).
 * As in VS Code, `get` merges an object value across the scopes and any other value is overridden.
 */
function scopedConfiguration(
  user: Record<string, unknown>,
  workspaceValues: Record<string, unknown>
): { user: Record<string, unknown>; workspace: Record<string, unknown> } {
  const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
  vi.spyOn(workspace, 'getConfiguration').mockImplementation(
    () =>
      ({
        get: (key: string, defaultValue?: unknown) => {
          const [userValue, workspaceValue] = [user[key], workspaceValues[key]];

          return (isObject(userValue) && isObject(workspaceValue) ? { ...userValue, ...workspaceValue } : (workspaceValue ?? userValue)) ?? defaultValue;
        },
        inspect: (key: string) => ({ globalValue: user[key], workspaceValue: workspaceValues[key] }),
        update: (key: string, value: unknown, target: unknown) => {
          (target === ConfigurationTarget.Global ? user : workspaceValues)[key] = value;

          return Promise.resolve();
        },
      }) as never
  );

  return { user, workspace: workspaceValues };
}

function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.commands.get(command);
  if (!handler) {
    throw new Error(`Command not registered: ${command}`);
  }

  return Promise.resolve(handler(...args));
}

describe('readCleanupSettings', () => {
  it('uses the defaults of the source extension', () => {
    const settings = readCleanupSettings();

    expect(settings.insertExplicitAccessModifiersOnClasses).toBe(true);
    expect(settings.insertBlankLinePaddingBeforeClasses).toBe(true);
    expect(settings.removeEndOfLineWhitespace).toBe(true);
    expect(settings.removeRegions).toBe(true);
    expect(settings.convertToFileScopedNamespace).toBe(false);
  });

  it('lets region removal be turned off', () => {
    state.configuration.set('codeJanitor.cleanup.removeRegions', false);

    expect(readCleanupSettings().removeRegions).toBe(false);
  });

  it('fans the single access modifier toggle out to every kind', () => {
    state.configuration.set('codeJanitor.cleanup.insertExplicitAccessModifiers', false);

    const settings = readCleanupSettings();
    const flags = Object.entries(settings)
      .filter(([key]) => key.startsWith('insertExplicitAccessModifiers'))
      .map(([, value]) => value);

    expect(flags).toHaveLength(9);
    expect(flags.every((value) => value === false)).toBe(true);
  });

  it('fans the single blank line padding toggle out to every kind', () => {
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePadding', false);

    const settings = readCleanupSettings();

    expect(settings.insertBlankLinePaddingBeforeMethods).toBe(false);
    expect(settings.insertBlankLinePaddingAfterRegionTags).toBe(false);
    expect(settings.insertBlankLinePaddingBeforeCaseStatements).toBe(false);
  });

  it('maps the file header enumerations', () => {
    state.configuration.set('codeJanitor.cleanup.fileHeaderPosition', 'afterUsings');
    state.configuration.set('codeJanitor.cleanup.fileHeaderUpdateMode', 'replace');

    const settings = readCleanupSettings();

    expect(settings.fileHeaderPosition).toBe(HeaderPosition.AfterUsings);
    expect(settings.fileHeaderUpdateMode).toBe(HeaderUpdateMode.Replace);
  });

  it('lets a per-kind blank line padding setting override the group toggle', () => {
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePadding', false);
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePaddingBeforeMethods', true);
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePaddingAfterFieldsSingleLine', true);
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePaddingBetweenPropertiesMultiLineAccessors', true);

    const settings = readCleanupSettings();

    expect(settings.insertBlankLinePaddingBeforeMethods).toBe(true);
    expect(settings.insertBlankLinePaddingAfterMethods).toBe(false);
    expect(settings.insertBlankLinePaddingAfterFieldsSingleLine).toBe(true);
    expect(settings.insertBlankLinePaddingBetweenPropertiesMultiLineAccessors).toBe(true);
  });

  it('reads the comment formatting options, defaulting to the source extension', () => {
    expect(readCleanupSettings().commentFormat).toEqual({
      wrapColumn: 100,
      skipWrapOnLastWord: true,
      ignoreLinesStartingWith: ['ReSharper disable ', 'ReSharper enable '],
      xmlAlignParamTags: false,
      xmlKeepTagsTogether: false,
      xmlSpaceSingleTags: false,
      xmlSpaceTags: false,
      xmlSplitAllTags: false,
      xmlSplitSummaryTagToMultipleLines: true,
      xmlTagsToLowerCase: false,
      xmlValueIndent: 0,
    });

    state.configuration.set('codeJanitor.formatting.commentWrapColumn', 80);
    state.configuration.set('codeJanitor.formatting.commentXmlTagsToLowerCase', true);
    state.configuration.set('codeJanitor.formatting.commentIgnoreLinesStartingWith', ['TODO']);

    expect(readCleanupSettings().commentFormat).toMatchObject({ wrapColumn: 80, xmlTagsToLowerCase: true, ignoreLinesStartingWith: ['TODO'] });
  });

  it('reads the file header of every language and the markup and using options', () => {
    const defaults = readCleanupSettings();
    expect(defaults.fileHeaderVB).toBe('');
    expect(defaults.removeBlankLinesBeforeClosingTags).toBe(true);
    expect(defaults.removeBlankSpacesBeforeClosingAngleBrackets).toBe(true);
    expect(defaults.insertBlankSpaceBeforeSelfClosingAngleBrackets).toBe(true);
    expect(defaults.usingStatementsToReinsertWhenRemoved).toEqual([]);

    state.configuration.set('codeJanitor.cleanup.fileHeaderVB', "' VB");
    state.configuration.set('codeJanitor.cleanup.fileHeaderTypeScript', '// TS');
    state.configuration.set('codeJanitor.cleanup.removeBlankLinesBeforeClosingTags', false);
    state.configuration.set('codeJanitor.cleanup.usingStatementsToReinsertWhenRemoved', ['using System.Linq;']);

    const settings = readCleanupSettings();

    expect(settings.fileHeaderVB).toBe("' VB");
    expect(settings.fileHeaderTypeScript).toBe('// TS');
    expect(settings.removeBlankLinesBeforeClosingTags).toBe(false);
    expect(settings.usingStatementsToReinsertWhenRemoved).toEqual(['using System.Linq;']);
  });

  it('reads the XML documentation budget', () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.maxMembersPerFile', 5);
    state.configuration.set('codeJanitor.ai.xmlDoc.ignorePattern', 'Foo');

    expect(readXmlDocOptions()).toMatchObject({ maxMembersPerFile: 5, ignorePattern: 'Foo', ignoreObsolete: true });
  });

  it('loads cleanup policy from a .codejanitor file in the repository root', () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({ cleanup: { removeRegions: false, organizeUsings: true, insertBlankLinePadding: false } })
    );

    const settings = readCleanupSettings(root);

    expect(settings.removeRegions).toBe(false);
    expect(settings.organizeUsings).toBe(true);
    expect(settings.insertBlankLinePaddingBeforeClasses).toBe(false);
    expect(settings.insertBlankLinePaddingAfterMethods).toBe(false);
  });

  it('logs the Visual Studio .codejanitor keys that VS Code ignores once per session', () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({ cleanup: { applyEditorConfigNaming: false, applyAnalyzerCodeFixes: true, removeRegions: false } })
    );
    createOutputChannel(createContext());
    const ignored = () => state.outputChannelLines.filter((line) => line.includes('is ignored by VS Code'));

    expect(readCleanupSettings(root).removeRegions).toBe(false);
    readCleanupSettings(root);
    expect(ignored()).toEqual([
      expect.stringMatching(/'\.codejanitor' key applyEditorConfigNaming is ignored by VS Code: \.editorconfig rules always apply\.$/),
      expect.stringMatching(/'\.codejanitor' key applyAnalyzerCodeFixes is ignored by VS Code: fixes from third-party analyzers are never applied\.$/),
    ]);
  });

  it('lets a key in the repository policy win over the explicit VS Code setting', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    state.configuration.set('codeJanitor.cleanup.removeRegions', true);
    state.configuration.set('codeJanitor.cleanup.organizeUsings', true);

    const settings = readCleanupSettings(root);

    expect(settings.removeRegions).toBe(false);
    // A key the policy does not list keeps following the user's setting.
    expect(settings.organizeUsings).toBe(true);
  });

  it('lets the policy alias win over the explicit fan-out setting, and an individual key over the alias', () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({ cleanup: { insertBlankLinePadding: false, insertBlankLinePaddingBeforeClasses: true } })
    );
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePadding', true);

    const settings = readCleanupSettings(root);

    expect(settings.insertBlankLinePaddingAfterMethods).toBe(false);
    expect(settings.insertBlankLinePaddingBeforeClasses).toBe(true);
  });

  it('finds the nearest .codejanitor by walking up from the cleaned file directory', () => {
    const root = tempRoot();
    const nested = path.join(root, 'src', 'Feature');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));

    expect(readCleanupSettings(nested).removeRegions).toBe(false);
  });

  it('lets the nearest .codejanitor win as a whole over one in a parent directory', () => {
    const root = tempRoot();
    const nested = path.join(root, 'src');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false, organizeUsings: true } }));
    fs.writeFileSync(path.join(nested, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: true } }));

    const settings = readCleanupSettings(nested);

    expect(settings.removeRegions).toBe(true);
    expect(settings.organizeUsings).toBe(false);
  });

  it('reads the policy of the document being cleaned, not of the first workspace folder', () => {
    const root = tempRoot();
    const other = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    fs.writeFileSync(path.join(other, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: true } }));
    state.workspaceFolders = [{ uri: Uri.file(root), name: 'root' }];

    expect(readCleanupSettingsForUri(Uri.file(path.join(other, 'Sample.cs'))).removeRegions).toBe(true);
    expect(readCleanupSettingsForUri(Uri.file(path.join(root, 'Sample.cs'))).removeRegions).toBe(false);
    expect(readCleanupSettings().removeRegions).toBe(false);
  });

  it('reads the enabled Code Style rules from the object setting, ignoring invalid entries', () => {
    state.configuration.set('codeJanitor.cleanup.codeStyleRules', {
      csharp_prefer_braces: 'When_Multiline',
      dotnet_style_null_propagation: 'sometimes',
      unknown_rule: 'true',
    });

    expect(readCleanupSettings().codeStyleRules).toEqual({ csharp_prefer_braces: 'when_multiline' });
  });

  it('applies the .codejanitor codeStyle section over the Code Style setting: a value enables, null disables', () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({ cleanup: { codeStyle: { csharp_prefer_braces: 'false', dotnet_style_null_propagation: null, csharp_style_throw_expression: 'True' } } })
    );
    state.configuration.set('codeJanitor.cleanup.codeStyleRules', {
      csharp_prefer_braces: 'true',
      dotnet_style_null_propagation: 'true',
      csharp_prefer_simple_using_statement: 'true',
    });

    expect(readCleanupSettings(root).codeStyleRules).toEqual({
      csharp_prefer_braces: 'false',
      csharp_prefer_simple_using_statement: 'true',
      csharp_style_throw_expression: 'true',
    });
  });
});

describe('repository settings commands', () => {
  it('exports cleanup settings as a .codejanitor file', async () => {
    const root = tempRoot();
    state.configuration.set('codeJanitor.cleanup.removeRegions', false);
    state.configuration.set('codeJanitor.cleanup.organizeUsings', true);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.removeRegions).toBe(false);
    expect(exported.cleanup.organizeUsings).toBe(true);
    expect(exported.cleanup.insertBlankLinePaddingBeforeClasses).toBeUndefined();
  });

  it('imports repository settings into workspace settings', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false, organizeUsings: true } }));

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);
    expect(state.configuration.get('codeJanitor.cleanup.organizeUsings')).toBe(true);
  });

  it('never exports the reorganize settings object into .codejanitor', async () => {
    const root = tempRoot();

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> };
    expect(exported.cleanup).not.toHaveProperty('reorganize');
  });

  it('does not import a reorganize object from .codejanitor into an unregistered setting', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false, reorganize: { runAtStartOfCleanup: true } } }));

    await importRepositorySettings(root);

    expect(state.configuration.has('codeJanitor.cleanup.reorganize')).toBe(false);
    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);
  });

  it('exports only the enabled Code Style rules, as an empty section when none is enabled', async () => {
    const root = tempRoot();

    await exportRepositorySettings(root);
    expect((JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> }).cleanup.codeStyle).toEqual({});

    state.configuration.set('codeJanitor.cleanup.codeStyleRules', {
      dotnet_style_null_propagation: 'True',
      csharp_prefer_braces: 'when_multiline',
      unknown_rule: 'true',
      csharp_preferred_modifier_order: 'public,loud',
    });
    state.informationMessages.length = 0;
    fs.rmSync(path.join(root, '.codejanitor'));
    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> };
    expect(exported.cleanup.codeStyle).toEqual({ csharp_prefer_braces: 'when_multiline', dotnet_style_null_propagation: 'true' });
    expect(Object.keys(exported.cleanup)).not.toContain('codeStyleRules');
  });

  it('round-trips export and import, including the Code Style rules', async () => {
    const root = tempRoot();
    state.configuration.set('codeJanitor.cleanup.removeRegions', false);
    state.configuration.set('codeJanitor.cleanup.codeStyleRules', { csharp_prefer_braces: 'when_multiline' });
    await exportRepositorySettings(root);
    state.configuration.clear();

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);
    expect(state.configuration.get('codeJanitor.cleanup.codeStyleRules')).toEqual({ csharp_prefer_braces: 'when_multiline' });
  });

  it('imports the codeStyle section over the Workspace rules: a value enables or changes a rule, null disables it', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({
        cleanup: {
          codeStyle: { csharp_prefer_braces: 'false', dotnet_style_null_propagation: null, csharp_style_throw_expression: 'true', unknown_rule: 'true' },
        },
      })
    );
    const scopes = scopedConfiguration({}, { 'cleanup.codeStyleRules': { csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' } });

    await importRepositorySettings(root);

    expect(scopes.workspace['cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: 'false', csharp_style_throw_expression: 'true' });
    expect(state.informationMessages).toEqual(['Code Janitor: imported 3 repository setting(s) into workspace settings.']);
  });

  it('does not touch the Code Style setting when the file has no codeStyle section', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    state.configuration.set('codeJanitor.cleanup.codeStyleRules', { csharp_prefer_braces: 'true' });

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.codeStyleRules')).toEqual({ csharp_prefer_braces: 'true' });
  });

  it('exports only the settings set in VS Code, so the others keep following each user setting', async () => {
    const root = tempRoot();
    state.configuration.set('codeJanitor.cleanup.removeRegions', false);
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePadding', false);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> };
    expect(exported.cleanup).toEqual({ removeRegions: false, insertBlankLinePadding: false, codeStyle: {} });
  });

  it('keeps what the overwritten file lists for the settings not set in VS Code', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({
        cleanup: {
          removeRegions: true,
          organizeUsings: false,
          fileHeaderPosition: 'afterUsings',
          insertBlankLinePaddingBeforeFieldsSingleLine: true,
          insertExplicitAccessModifiers: false,
          insertBlankLinePaddingBeforeClasses: false,
        },
      })
    );
    state.modalChoice = 'Overwrite';
    state.configuration.set('codeJanitor.cleanup.removeRegions', false);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> };
    expect(exported.cleanup).toEqual({
      removeRegions: false,
      organizeUsings: false,
      fileHeaderPosition: 'afterUsings',
      insertBlankLinePaddingBeforeFieldsSingleLine: true,
      insertExplicitAccessModifiers: false,
      insertBlankLinePaddingBeforeClasses: false,
      codeStyle: {},
    });
  });

  it('keeps the codeStyle section of the overwritten file, null pins included, with the rules set in VS Code winning', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({
        cleanup: {
          organizeUsings: false,
          codeStyle: {
            csharp_style_throw_expression: 'true',
            csharp_prefer_braces: null,
            dotnet_style_null_propagation: 'true',
            csharp_prefer_simple_using_statement: 'true',
          },
        },
      })
    );
    state.modalChoice = 'Overwrite';
    state.configuration.set('codeJanitor.cleanup.codeStyleRules', { csharp_prefer_braces: 'when_multiline', dotnet_style_null_propagation: null });

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> };
    expect(exported.cleanup).toEqual({
      organizeUsings: false,
      codeStyle: {
        csharp_style_throw_expression: 'true',
        csharp_prefer_braces: 'when_multiline',
        dotnet_style_null_propagation: null,
        csharp_prefer_simple_using_statement: 'true',
      },
    });
  });

  it('keeps a null pin of the overwritten file for a rule VS Code does not enable', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { codeStyle: { csharp_prefer_braces: null } } }));
    state.modalChoice = 'Overwrite';

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: Record<string, unknown> };
    expect(exported.cleanup).toEqual({ codeStyle: { csharp_prefer_braces: null } });
  });

  it('imports the codeStyle section over the Workspace rules only, writing null for a rule the file turns off and User settings enable', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({
        cleanup: { codeStyle: { csharp_prefer_braces: null, dotnet_style_null_propagation: null, csharp_prefer_simple_using_statement: 'true' } },
      })
    );
    const scopes = scopedConfiguration(
      { 'cleanup.codeStyleRules': { csharp_prefer_braces: 'true', csharp_style_throw_expression: 'true' } },
      { 'cleanup.codeStyleRules': { dotnet_style_null_propagation: 'true' } }
    );

    await importRepositorySettings(root);

    // The User rules are not copied into the (often committed) workspace settings; the one the file
    // turns off gets null, which wins when VS Code merges the scopes.
    expect(scopes.workspace['cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: null, csharp_prefer_simple_using_statement: 'true' });
    expect(scopes.user['cleanup.codeStyleRules']).toEqual({ csharp_prefer_braces: 'true', csharp_style_throw_expression: 'true' });
    expect(state.informationMessages).toEqual(['Code Janitor: imported 3 repository setting(s) into workspace settings.']);
  });

  it('registers export and import commands', () => {
    const context = createContext();
    registerRepositorySettingsCommands(context);

    expect([...state.commands.keys()]).toEqual(expect.arrayContaining(['codeJanitor.exportRepositorySettings', 'codeJanitor.importRepositorySettings']));
  });

  it('exports with file header position and update mode', async () => {
    const root = tempRoot();
    state.configuration.set('codeJanitor.cleanup.fileHeaderPosition', 'afterUsings');
    state.configuration.set('codeJanitor.cleanup.fileHeaderUpdateMode', 'replace');

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.fileHeaderPosition).toBe('afterUsings');
    expect(exported.cleanup.fileHeaderUpdateMode).toBe('replace');
  });

  it('exports grouped blank line padding setting', async () => {
    const root = tempRoot();
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePadding', false);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.insertBlankLinePadding).toBe(false);
    expect(exported.cleanup.insertBlankLinePaddingBeforeClasses).toBeUndefined();
  });

  it('exports grouped explicit access modifiers setting', async () => {
    const root = tempRoot();
    state.configuration.set('codeJanitor.cleanup.insertExplicitAccessModifiers', false);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.insertExplicitAccessModifiers).toBe(false);
    expect(exported.cleanup.insertExplicitAccessModifiersOnClasses).toBeUndefined();
  });

  it('omits grouped settings when not configured', async () => {
    const root = tempRoot();

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.insertBlankLinePadding).toBeUndefined();
    expect(exported.cleanup.insertExplicitAccessModifiers).toBeUndefined();
  });

  it('asks before overwriting an existing .codejanitor', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), '{"cleanup":{}}');
    state.modalChoice = undefined; // dismiss

    await exportRepositorySettings(root);

    // File should not be overwritten
    expect(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')).toBe('{"cleanup":{}}');
  });

  it('overwrites when the user confirms', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), '{"cleanup":{}}');
    state.modalChoice = 'Overwrite';

    await exportRepositorySettings(root);

    const content = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as { cleanup: object };
    expect(content.cleanup).toBeDefined();
  });

  it('reports when no workspace is open for export', async () => {
    await exportRepositorySettings();

    expect(state.informationMessages).toContain('Code Janitor: open a workspace to export repository settings.');
  });

  it('reports when no workspace is open for import', async () => {
    await importRepositorySettings();

    expect(state.informationMessages).toContain('Code Janitor: open a workspace to import repository settings.');
  });

  it('reports when .codejanitor is not found for import', async () => {
    const root = tempRoot();

    await importRepositorySettings(root);

    expect(state.informationMessages).toContain('Code Janitor: .codejanitor was not found.');
  });

  it('imports file header position and update mode', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { fileHeaderPosition: 'afterUsings', fileHeaderUpdateMode: 'replace' } }));

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.fileHeaderPosition')).toBe('afterUsings');
    expect(state.configuration.get('codeJanitor.cleanup.fileHeaderUpdateMode')).toBe('replace');
  });

  it('imports grouped settings when all values match', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({
        cleanup: {
          insertBlankLinePaddingBeforeClasses: false,
          insertBlankLinePaddingAfterClasses: false,
          insertBlankLinePaddingBeforeMethods: false,
          insertBlankLinePaddingAfterMethods: false,
          insertBlankLinePaddingBeforeDelegates: false,
          insertBlankLinePaddingAfterDelegates: false,
          insertBlankLinePaddingBeforeEnumerations: false,
          insertBlankLinePaddingAfterEnumerations: false,
          insertBlankLinePaddingBeforeEvents: false,
          insertBlankLinePaddingAfterEvents: false,
          insertBlankLinePaddingBeforeFieldsMultiLine: false,
          insertBlankLinePaddingAfterFieldsMultiLine: false,
          insertBlankLinePaddingBeforeInterfaces: false,
          insertBlankLinePaddingAfterInterfaces: false,
          insertBlankLinePaddingBeforeNamespaces: false,
          insertBlankLinePaddingAfterNamespaces: false,
          insertBlankLinePaddingBeforePropertiesMultiLine: false,
          insertBlankLinePaddingAfterPropertiesMultiLine: false,
          insertBlankLinePaddingBeforeStructs: false,
          insertBlankLinePaddingAfterStructs: false,
          insertBlankLinePaddingBeforeRegionTags: false,
          insertBlankLinePaddingAfterRegionTags: false,
          insertBlankLinePaddingBeforeEndRegionTags: false,
          insertBlankLinePaddingAfterEndRegionTags: false,
          insertBlankLinePaddingBeforeUsingStatementBlocks: false,
          insertBlankLinePaddingAfterUsingStatementBlocks: false,
          insertBlankLinePaddingBeforeCaseStatements: false,
        },
      })
    );

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.insertBlankLinePadding')).toBe(false);
  });

  it('writes only settings VS Code declares, importing grouped keys through their group setting', async () => {
    const declared = new Set(
      (
        JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
          contributes: { configuration: { properties: Record<string, unknown> }[] };
        }
      ).contributes.configuration.flatMap((section) => Object.keys(section.properties))
    );
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({ cleanup: { insertBlankLinePadding: false, insertBlankLinePaddingBeforeFieldsSingleLine: false, removeRegions: false } })
    );

    await importRepositorySettings(root);

    expect(state.configurationUpdates.map((update) => update.key).filter((key) => !declared.has(key))).toEqual([]);
    expect(state.configuration.get('codeJanitor.cleanup.insertBlankLinePadding')).toBe(false);
    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);
  });

  it('does not import grouped settings when values differ', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({
        cleanup: {
          insertBlankLinePaddingBeforeClasses: true,
          insertBlankLinePaddingAfterClasses: false,
        },
      })
    );

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.insertBlankLinePadding')).toBeUndefined();
  });
});

describe('isSupportedFile', () => {
  it('always accepts C# files', () => {
    expect(isSupportedFile(Uri.file('/w/a.cs'))).toBe(true);
  });

  it('rejects other file types by default', () => {
    expect(isSupportedFile(Uri.file('/w/a.md'))).toBe(false);
  });

  it('accepts other file types when the setting is on', () => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);

    expect(isSupportedFile(Uri.file('/w/a.md'))).toBe(true);
  });

  it('accepts an open document in csharp language mode even without a .cs extension', () => {
    // Models an unsaved new file (untitled:Untitled-1), which has no file extension yet.
    const untitled = Uri.file('/w/Untitled-1');
    state.documents.push(new TextDocument(untitled, 'class C { }', 'csharp'));

    expect(isSupportedFile(untitled)).toBe(true);
  });
});

describe('cleanup path filters', () => {
  it('excludes files matching an exclusion expression', () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['\\.designer\\.cs$']);

    expect(isSupportedFile(Uri.file('/w/Form.Designer.cs'))).toBe(false);
    expect(isSupportedFile(Uri.file('/w/Form.cs'))).toBe(true);
  });

  it('matches expressions case-insensitively against the whole path', () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['[\\\\/]OBJ[\\\\/]']);

    expect(isSupportedFile(Uri.file('/w/obj/Generated.cs'))).toBe(false);
  });

  it('restricts cleanup to the inclusion expressions when any are set', () => {
    state.configuration.set('codeJanitor.cleanup.include', ['[\\\\/]src[\\\\/]']);

    expect(isSupportedFile(Uri.file('/w/src/a.cs'))).toBe(true);
    expect(isSupportedFile(Uri.file('/w/tools/a.cs'))).toBe(false);
  });

  it('lets an exclusion win over an inclusion', () => {
    state.configuration.set('codeJanitor.cleanup.include', ['[\\\\/]src[\\\\/]']);
    state.configuration.set('codeJanitor.cleanup.exclude', ['\\.g\\.cs$']);

    expect(isSupportedFile(Uri.file('/w/src/a.g.cs'))).toBe(false);
  });

  it('ignores invalid and empty expressions instead of failing', () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['(unclosed', '   ']);

    expect(isSupportedFile(Uri.file('/w/a.cs'))).toBe(true);
  });

  it('warns once about an invalid expression', () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['(unclosed-once']);

    isSupportedFile(Uri.file('/w/a.cs'));
    isSupportedFile(Uri.file('/w/b.cs'));

    expect(state.warningMessages).toEqual([expect.stringContaining('(unclosed-once')]);
  });

  it('skips excluded files during a cleanup run', async () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['\\.designer\\.cs$']);
    state.files.set('/w/Form.Designer.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Form.Designer.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0, unresolved: 0, created: 0 });
    expect(state.files.get('/w/Form.Designer.cs')).toBe(UNCLEAN);
  });
});

describe('collectFiles', () => {
  it('leaves out a file that cannot be read and logs why', async () => {
    createOutputChannel(createContext());
    state.files.set('/w/a.cs', 'class A {}\n');

    const files = await collectFiles([Uri.file('/w/missing.cs'), Uri.file('/w/a.cs')]);

    expect(files.map((file) => file.uri.fsPath)).toEqual(['/w/a.cs']);
    expect(state.outputChannelLines.some((line) => line.includes('ERROR') && line.includes('File not found: /w/missing.cs'))).toBe(true);
  });
});

describe('expandToCleanableFiles', () => {
  it('returns a single file unchanged', async () => {
    const files = await expandToCleanableFiles(Uri.file('/w/a.cs'));

    expect(files.map((file) => file.fsPath)).toEqual(['/w/a.cs']);
  });

  it('expands a folder to the files it contains', async () => {
    state.directories.add('/w/src');
    state.foundFiles = [Uri.file('/w/src/a.cs')];

    const files = await expandToCleanableFiles(Uri.file('/w/src'));

    expect(files.map((file) => file.fsPath)).toEqual(['/w/src/a.cs']);
  });
});

/** The fake engine's commands: what each does to the text, roughly as the real one would. */
function engineCommand(params: EngineParams): ReturnType<typeof cleanupResult> {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  switch (params.command) {
    case 'removeXmlDocumentation':
      return cleanupResult(params.text.replace(/^\s*\/\/\/.*\n/gm, ''));
    case 'removeRegions':
      return cleanupResult(params.text.replace(/^\s*#(end)?region.*\n/gm, ''));
    case 'formatComments':
      return cleanupResult(params.text.replace(/\/\/(\S)/g, '// $1'));
    case 'fixNamespace':
      return cleanupResult(params.text.replace(/namespace \S+/, `namespace ${(args.namespace as string | undefined) ?? 'Engine.Expected'}`));
    case 'splitTopLevelTypes': {
      const split = /\n\ninternal class (\w+)\n\{\n\}\n$/.exec(params.text);

      return split
        ? cleanupResult(params.text.slice(0, split.index + 1), {
            newFiles: [{ path: path.join(path.dirname(params.filePath), `${split[1]}.cs`), text: split[0].slice(2) }],
          })
        : cleanupResult(params.text);
    }

    default:
      return cleanupResult(params.text);
  }
}

describe('runCleanupOnUris', () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = useFakeEngine({ command: engineCommand });
  });

  it('writes a cleaned file back to disk', async () => {
    state.files.set('/w/a.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toEqual({ changed: 1, failed: 0, unresolved: 0, created: 0 });
    expect(state.files.get('/w/a.cs')).toBe('internal class C\n{\n}\n');
  });

  it("sends the file's text, the user settings without the .codejanitor policy and the other unsaved C# documents", async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    state.workspaceFolders = [{ uri: Uri.file(root), name: 'root' }];
    state.configuration.set('codeJanitor.cleanup.fileHeaderPosition', 'afterUsings');
    const filePath = path.join(root, 'a.cs');
    state.files.set(filePath, UNCLEAN);
    const unsaved = new TextDocument(Uri.file(path.join(root, 'Other.cs')), 'internal class Other { }\n', 'csharp');
    unsaved.isDirty = true;
    const saved = new TextDocument(Uri.file(path.join(root, 'Saved.cs')), 'internal class Saved { }\n', 'csharp');
    state.documents.push(unsaved, saved, new TextDocument(Uri.file(path.join(root, 'notes.md')), 'text', 'markdown'));

    await runCleanupOnUris(createContext(), [Uri.file(filePath)]);

    const [request] = engine.requests('cleanup');
    expect(request).toMatchObject({ filePath, text: UNCLEAN, unsavedDocuments: [{ path: unsaved.uri.fsPath, text: 'internal class Other { }\n' }] });
    expect(request.settings).toMatchObject({ removeRegions: true, fileHeaderPosition: 'afterUsings', renamePublicSymbolsAcrossWorkspace: false });
    expect(request).not.toHaveProperty('changedLines');
    expect(request).not.toHaveProperty('excludedRules');
  });

  it('edits an open document instead of the file on disk', async () => {
    const document = new TextDocument(Uri.file('/w/b.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);
    state.files.set('/w/b.cs', 'stale content');

    const result = await runCleanupOnUris(createContext(), [document.uri]);

    expect(result.changed).toBe(1);
    expect(document.getText()).not.toContain('   \n');
    expect(state.files.get('/w/b.cs')).toBe('stale content');
  });

  it('leaves an open document the user edits during the cleanup as the user left it, and reports it', async () => {
    const document = new TextDocument(Uri.file('/w/b.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);
    const typed = `${UNCLEAN}// typed meanwhile\n`;
    // The user types while the engine cleans the file.
    useFakeEngine({
      cleanup: (params) => {
        document.setText(typed);

        return cleanupResult(params.text.replace('   ', ''));
      },
    });

    const result = await runCleanupOnUris(createContext(), [document.uri]);

    expect(result.failed).toBe(1);
    expect(document.getText()).toBe(typed);
    expect(state.warningMessages.at(-1)).toBe('Code Janitor: /w/b.cs - the document was edited during cleanup');
  });

  it('reports nothing to do when every file is filtered out', async () => {
    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.md')]);

    expect(result).toEqual({ changed: 0, failed: 0, unresolved: 0, created: 0 });
    expect(state.informationMessages).toContain('Code Janitor: no files to clean up.');
  });

  it('runs only the layout rules for other file types, without the engine', async () => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    state.files.set('/w/a.md', 'text   \n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.md')]);

    expect(result.changed).toBe(1);
    expect(state.files.get('/w/a.md')).toBe('text\n');
    expect(engine.requests('cleanup')).toEqual([]);
  });

  it('leaves an already clean file untouched', async () => {
    state.files.set('/w/a.cs', 'internal class C\n{\n}\n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0, unresolved: 0, created: 0 });
  });

  it('counts a file that cannot be read as failed and logs why', async () => {
    createOutputChannel(createContext());

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/missing.cs')]);

    expect(result).toEqual({ changed: 0, failed: 1, unresolved: 0, created: 0 });
    expect(state.outputChannelLines.some((line) => line.includes('File not found: /w/missing.cs'))).toBe(true);
  });

  it("logs the engine's messages and the violations it could not fix, counting the violations", async () => {
    createOutputChannel(createContext());
    useFakeEngine({
      cleanup: (params) =>
        cleanupResult(params.text, {
          issues: ['IDE0055 was skipped: its fix would add a compiler error.'],
          unresolved: [{ id: 'IDE1006', message: "Naming rule violation: 'total'", severity: 'warning', line: 5, column: 16, reason: 'it is not private' }],
        }),
    });
    state.files.set('/w/a.cs', 'internal class C\n{\n}\n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result.unresolved).toBe(1);
    expect(state.outputChannelLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cleanup: /w/a.cs: IDE0055 was skipped: its fix would add a compiler error.'),
        expect.stringContaining("/w/a.cs:5: IDE1006 (warning): Naming rule violation: 'total' - not fixed: it is not private"),
      ])
    );
  });

  it('writes the text of a cleanup whose step failed, counts the file as failed and warns', async () => {
    createOutputChannel(createContext());
    useFakeEngine({ cleanup: (params) => cleanupResult(trimTrailingWhitespace(params.text), { failures: ['RemoveRegions failed: boom'] }) });
    state.files.set('/w/a.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toEqual({ changed: 1, failed: 1, unresolved: 0, created: 0 });
    expect(state.files.get('/w/a.cs')).toBe(trimTrailingWhitespace(UNCLEAN));
    expect(state.warningMessages).toEqual([expect.stringContaining('RemoveRegions failed: boom')]);
  });

  it('counts and logs a failure that arrives as the run is cancelled', async () => {
    createOutputChannel(createContext());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
    useFakeEngine({
      cleanup: () => {
        token.isCancellationRequested = true;
        throw new Error('disk full');
      },
    });
    state.files.set('/w/a.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')], { token: token as never });

    expect(result).toMatchObject({ failed: 1, cancelled: true });
    expect(state.outputChannelLines.some((line) => line.includes('disk full'))).toBe(true);
  });

  it("shows the engine's warnings and still counts the file as cleaned", async () => {
    createOutputChannel(createContext());
    useFakeEngine({ cleanup: (params) => cleanupResult(params.text, { warnings: ['Could not load /w/App.csproj: bad XML'] }) });
    state.files.set('/w/a.cs', 'internal class C\n{\n}\n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0, unresolved: 0, created: 0 });
    expect(state.warningMessages).toEqual([expect.stringContaining('Could not load /w/App.csproj: bad XML')]);
  });

  it('applies the files a cleanup creates and the other files it changes in one edit, saving those that were not open', async () => {
    useFakeEngine({
      cleanup: () =>
        cleanupResult('internal class Foo\n{\n}\n', {
          newFiles: [{ path: '/w/Bar.cs', text: 'internal class Bar\n{\n}\n' }],
          otherFiles: [{ path: '/w/Use.cs', text: 'internal class Use : Bar\n{\n}\n' }],
        }),
    });
    state.files.set('/w/Foo.cs', 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n');
    state.files.set('/w/Use.cs', 'internal class Use : Foo.Bar\n{\n}\n');
    const applyEdit = vi.spyOn(workspace, 'applyEdit');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Foo.cs')], { renameAcrossWorkspace: true });

    expect(result).toEqual({ changed: 1, failed: 0, unresolved: 0, created: 1 });
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect([state.files.get('/w/Foo.cs'), state.files.get('/w/Bar.cs'), state.files.get('/w/Use.cs')]).toEqual([
      'internal class Foo\n{\n}\n',
      'internal class Bar\n{\n}\n',
      'internal class Use : Bar\n{\n}\n',
    ]);
  });

  it('lets renames change other files only in the batch commands that ask for it', async () => {
    state.files.set('/w/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')], { renameAcrossWorkspace: true });
    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(engine.requests('cleanup').map((params) => params.settings.renamePublicSymbolsAcrossWorkspace)).toEqual([false, false]);
    state.configuration.set('codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace', true);
    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')], { renameAcrossWorkspace: true });
    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);
    expect(
      engine
        .requests('cleanup')
        .slice(2)
        .map((params) => params.settings.renamePublicSymbolsAcrossWorkspace)
    ).toEqual([true, false]);
  });

  it('reads each file of a batch when its turn comes, so it sees what the cleanup of an earlier file changed in it', async () => {
    useFakeEngine({
      cleanup: (params) =>
        params.filePath === '/w/A.cs'
          ? cleanupResult(params.text, { otherFiles: [{ path: '/w/B.cs', text: 'internal class B : Renamed { }\n' }] })
          : cleanupResult(params.text),
    });
    state.files.set('/w/A.cs', 'internal class Renamed { }\n');
    state.files.set('/w/B.cs', 'internal class B : old { }\n');

    await runCleanupOnUris(createContext(), [Uri.file('/w/A.cs'), Uri.file('/w/B.cs')], { renameAcrossWorkspace: true });

    expect(state.files.get('/w/B.cs')).toBe('internal class B : Renamed { }\n');
  });

  it('writes nothing of a result whose new file already exists, and counts the file as failed', async () => {
    useFakeEngine({ cleanup: () => cleanupResult('internal class Foo\n{\n}\n', { newFiles: [{ path: '/w/Bar.cs', text: 'internal class Bar\n{\n}\n' }] }) });
    const source = 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    state.files.set('/w/Foo.cs', source);
    state.applyEditResult = false;

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Foo.cs')]);

    expect(result).toEqual({ changed: 0, failed: 1, unresolved: 0, created: 0 });
    expect(state.files.get('/w/Foo.cs')).toBe(source);
    expect(state.warningMessages.at(-1)).toContain('VS Code did not apply the edit; no file was changed and no new file was created');
  });

  it('counts an open file whose edit VS Code rejects as failed, not changed', async () => {
    const document = new TextDocument(Uri.file('/w/C.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);
    state.applyEditResult = false;

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/C.cs')]);

    expect(result).toEqual({ changed: 0, failed: 1, unresolved: 0, created: 0 });
  });

  it('counts a file the engine fails on, warns with its reason and goes on with the others', async () => {
    useFakeEngine({
      cleanup: (params) => (params.filePath === '/w/bad.cs' ? Promise.reject(new Error('the project could not be loaded')) : cleanupResult('clean\n')),
    });
    state.files.set('/w/bad.cs', UNCLEAN);
    state.files.set('/w/good.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/bad.cs'), Uri.file('/w/good.cs')]);

    expect(result).toEqual({ changed: 1, failed: 1, unresolved: 0, created: 0 });
    expect(state.warningMessages).toEqual(['Code Janitor: /w/bad.cs - the project could not be loaded']);
  });
});

describe('C# cleanup without .NET', () => {
  beforeEach(() => {
    setEngine(
      new EngineClient(
        async () => {
          throw new EngineUnavailableError("C# cleanup needs .NET 10 or newer (the .NET SDK to load projects); no 'dotnet' was found on PATH.");
        },
        { workspaceFolders: () => [], log: () => undefined }
      )
    );
  });

  it('shows one error with a link to install .NET, still cleans the other files and counts the C# files as failed', async () => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    state.errorChoice = 'Install .NET';
    state.files.set('/w/a.cs', UNCLEAN);
    state.files.set('/w/b.cs', UNCLEAN);
    state.files.set('/w/a.md', 'text   \n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs'), Uri.file('/w/b.cs'), Uri.file('/w/a.md')]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ changed: 1, failed: 2, unresolved: 0, created: 0 });
    expect(state.files.get('/w/a.md')).toBe('text\n');
    expect(state.files.get('/w/a.cs')).toBe(UNCLEAN);
    expect(state.errorMessages).toEqual([
      expect.stringMatching(/^Code Janitor: C# cleanup needs \.NET 10 or newer.*C# cleanup is unavailable; other files are still cleaned\.$/),
    ]);
    expect(state.errorActions[0]).toEqual(['Install .NET', 'Open Settings']);
    expect(state.openedExternal).toEqual(['https://dotnet.microsoft.com/download']);
    expect(state.warningMessages).toEqual([]);
  });

  it('does not repeat the error on the next command', async () => {
    state.files.set('/w/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);
    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(state.errorMessages).toHaveLength(1);
  });
});

describe('cleanup commands', () => {
  const commandIds = [
    'codeJanitor.cleanupActiveFile',
    'codeJanitor.previewCleanupActiveFile',
    'codeJanitor.previewCleanupSelectedFiles',
    'codeJanitor.previewCleanupOpenFiles',
    'codeJanitor.previewCleanupChangedFiles',
    'codeJanitor.previewCleanupWorkspace',
    'codeJanitor.cleanupSelectedFiles',
    'codeJanitor.removeXmlDocSelectedFiles',
    'codeJanitor.fixNamespaceSelectedFiles',
    'codeJanitor.removeRegionsSelectedFiles',
    'codeJanitor.formatCommentsSelectedFiles',
    'codeJanitor.cleanupOpenFiles',
    'codeJanitor.cleanupChangedFiles',
    'codeJanitor.cleanupWorkspace',
    'codeJanitor.removeXmlDocWorkspace',
    'codeJanitor.toggleCleanupOnSave',
    'codeJanitor.splitTopLevelTypes',
    'codeJanitor.splitTopLevelTypesSelectedFiles',
  ];
  let engine: FakeEngine;

  beforeEach(() => {
    engine = useFakeEngine({ command: engineCommand });
  });

  /** The engine commands received, as `[command, file, arguments]`. */
  const commands = () => engine.requests('command').map((params) => [params.command, params.filePath, params.arguments]);

  it('registers every command and disposes them with the context', () => {
    const context = createContext();
    registerCleanupCommands(context);

    expect([...state.commands.keys()]).toEqual(expect.arrayContaining(commandIds));
    expect(context.subscriptions).toHaveLength(commandIds.length);
  });

  it('reports a missing active editor', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupActiveFile');

    expect(state.informationMessages).toContain('Code Janitor: no active editor.');
  });

  it('cleans the active file', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupActiveFile');

    expect(document.getText()).not.toContain('   \n');
    expect(state.informationMessages).toContain('Code Janitor: cleanup complete - 1 file(s) changed.');
  });

  it('warns about the violations the engine could not fix', async () => {
    useFakeEngine({
      cleanup: (params) =>
        cleanupResult(params.text.replace('   ', ''), {
          unresolved: [{ id: 'IDE0008', message: 'Use explicit type', severity: 'warning', line: 5, column: 9, reason: 'the type is unknown' }],
        }),
    });
    const document = new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupActiveFile');

    expect(state.warningMessages).toEqual([
      'Code Janitor: cleanup complete - 1 file(s) changed, 1 .editorconfig rule violation(s) not fixed (see the Code Janitor output).',
    ]);
  });

  it('counts the files a cleanup creates', async () => {
    useFakeEngine({ cleanup: () => cleanupResult('internal class Foo\n{\n}\n', { newFiles: [{ path: '/w/Bar.cs', text: 'internal class Bar\n{\n}\n' }] }) });
    state.files.set('/w/Foo.cs', 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupSelectedFiles', Uri.file('/w/Foo.cs'), [Uri.file('/w/Foo.cs')]);

    expect(state.informationMessages).toContain('Code Janitor: cleanup complete - 1 file(s) changed, 1 file(s) created (one type per file).');
  });

  it('splits an open file in one edit with its new files, so the disk never holds a type twice before the user saves', async () => {
    const filePath = '/w/Foo.cs';
    const source = 'namespace Demo;\n\ninternal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    useFakeEngine({
      cleanup: () =>
        cleanupResult('namespace Demo;\n\ninternal class Foo\n{\n}\n', {
          newFiles: [{ path: '/w/Bar.cs', text: 'namespace Demo;\n\ninternal class Bar\n{\n}\n' }],
        }),
    });
    state.files.set(filePath, source);
    const document = new TextDocument(Uri.file(filePath), source, 'csharp');
    state.documents.push(document);
    const applyEdit = vi.spyOn(workspace, 'applyEdit');

    const result = await runCleanupOnUris(createContext(), [Uri.file(filePath)]);

    expect(result).toEqual({ changed: 1, failed: 0, unresolved: 0, created: 1 });
    // One edit: undoing it removes the type from the new file and puts it back in the original.
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(document.getText()).toBe('namespace Demo;\n\ninternal class Foo\n{\n}\n');
    expect(state.documents.find((candidate) => candidate.uri.fsPath === '/w/Bar.cs')?.getText()).toBe('namespace Demo;\n\ninternal class Bar\n{\n}\n');
    // On disk: the original still has Bar, the new file is empty until saved.
    expect([state.files.get(filePath), state.files.get('/w/Bar.cs')]).toEqual([source, '']);
  });

  it('previews the active file, leaving out the rules the user unchecks, and applies the result', async () => {
    useFakeEngine({
      cleanup: (params) => {
        const excluded = (params.excludedRules as string[] | undefined) ?? [];
        const text = excluded.includes('IDE0090') ? params.text.replace('   ', '') : params.text.replace('   ', '').replace('new List<int>()', 'new()');

        return cleanupResult(text, {
          rules: [
            { id: 'IDE0090', name: 'Simplify new expression', changes: excluded.includes('IDE0090') ? 0 : 1, included: !excluded.includes('IDE0090') },
            { id: 'CJ0001', name: 'Remove trailing whitespace', changes: 1, included: true },
            { id: 'CJ0002', name: 'Remove regions', changes: 0, included: true },
          ],
        });
      },
    });
    const source = 'internal class A   \n{\n    private readonly List<int> _a = new List<int>();\n}\n';
    const document = new TextDocument(Uri.file('/w/A.cs'), source, 'csharp');
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);
    state.modalChoices = ['Choose Rules...', 'Apply'];
    state.quickPickSelections = [['Remove trailing whitespace (1 change)']];
    const requests = engine.requests;
    registerCleanupCommands(createContext());

    await run('codeJanitor.previewCleanupActiveFile');

    expect(state.quickPickItems.map((item) => item.label)).toEqual(['Simplify new expression (1 change)', 'Remove trailing whitespace (1 change)']);
    expect(state.openedDocuments).toHaveLength(2);
    expect(state.openedDocuments[0].content).toContain('= new();');
    expect(document.getText()).toBe('internal class A\n{\n    private readonly List<int> _a = new List<int>();\n}\n');
    expect(requests).toBeDefined();
  });

  it('says so when the preview of the active file has nothing to change', async () => {
    const document = new TextDocument(Uri.file('/w/A.cs'), 'internal class A\n{\n}\n', 'csharp');
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);
    registerCleanupCommands(createContext());

    await run('codeJanitor.previewCleanupActiveFile');

    expect(state.informationMessages).toContain('Code Janitor: file is already clean (no changes).');
    expect(state.openedDocuments).toHaveLength(0);
  });

  it('cleans every open file', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupOpenFiles');

    expect(document.getText()).not.toContain('   \n');
  });

  it('expands selected folders before cleaning', async () => {
    state.directories.add('/w/src');
    state.foundFiles = [Uri.file('/w/src/a.cs')];
    state.files.set('/w/src/a.cs', UNCLEAN);
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupSelectedFiles', Uri.file('/w/src'), [Uri.file('/w/src')]);

    expect(state.files.get('/w/src/a.cs')).not.toContain('   \n');
  });

  it('warns when nothing is selected', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupSelectedFiles');

    expect(state.informationMessages).toContain('Code Janitor: no files selected.');
  });

  it('removes XML documentation from selected files through the engine', async () => {
    state.files.set('/w/a.cs', XML_DOCUMENTED);
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeXmlDocSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.files.get('/w/a.cs')).not.toContain('///');
    expect(commands()).toEqual([['removeXmlDocumentation', '/w/a.cs', undefined]]);
  });

  it('expands selected folders to .cs files only when removing XML documentation, regardless of includeOtherFileTypes', async () => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    state.directories.add('/w/src');
    state.foundFiles = [Uri.file('/w/src/a.cs')];
    state.files.set('/w/src/a.cs', XML_DOCUMENTED);
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeXmlDocSelectedFiles', Uri.file('/w/src'), [Uri.file('/w/src')]);

    expect(state.files.get('/w/src/a.cs')).not.toContain('///');
  });

  it('warns when nothing is selected for XML documentation removal', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeXmlDocSelectedFiles');

    expect(state.informationMessages).toContain('Code Janitor: no files selected.');
  });

  it('fixes the namespace of selected files with the namespace the engine expects, without prompting', async () => {
    state.files.set('/w/Services/Thing.cs', 'namespace Old\n{\n    class Thing { }\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.fixNamespaceSelectedFiles', Uri.file('/w/Services/Thing.cs'), [Uri.file('/w/Services/Thing.cs')]);

    expect(state.files.get('/w/Services/Thing.cs')).toContain('namespace Engine.Expected');
    expect(commands()).toEqual([['fixNamespace', '/w/Services/Thing.cs', undefined]]);
    expect(state.inputBoxResult).toBeUndefined();
  });

  it('removes regions from selected files', async () => {
    state.files.set('/w/a.cs', '#region Fields\nclass C { }\n#endregion\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeRegionsSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.files.get('/w/a.cs')).toBe('class C { }\n');
    expect(commands()).toEqual([['removeRegions', '/w/a.cs', undefined]]);
  });

  it('formats comments in selected files', async () => {
    state.files.set('/w/a.cs', '//no space\nclass C { }\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.formatCommentsSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.files.get('/w/a.cs')).toContain('// no space');
    expect(commands()).toEqual([['formatComments', '/w/a.cs', undefined]]);
  });

  it('warns when nothing is selected for namespace fixing, region removal or comment formatting', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.fixNamespaceSelectedFiles');
    await run('codeJanitor.removeRegionsSelectedFiles');
    await run('codeJanitor.formatCommentsSelectedFiles');

    expect(state.informationMessages.filter((m) => m === 'Code Janitor: no files selected.')).toHaveLength(3);
  });

  it('splits the active file into one file per top-level type', async () => {
    const document = new TextDocument(Uri.file('/w/Foo.cs'), 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n', 'csharp');
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypes');

    expect(commands()).toEqual([['splitTopLevelTypes', '/w/Foo.cs', undefined]]);
    expect(document.getText()).toContain('class Foo');
    expect(document.getText()).not.toContain('class Bar');
    // Not on disk until the user saves: the new file is created unsaved, in the same edit as the original.
    expect(state.files.get(path.join('/w', 'Bar.cs'))).toBe('');
    expect(state.documents.find((candidate) => candidate.uri.fsPath === path.join('/w', 'Bar.cs'))?.getText()).toContain('class Bar');
    expect(state.informationMessages).toContain('Code Janitor: top-level types split - 2 file(s) changed.');
  });

  it('reports a missing active editor for splitting top-level types', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypes');

    expect(state.informationMessages).toContain('Code Janitor: no active editor.');
  });

  it('splits selected files into one file per top-level type, writing the new files of a closed file', async () => {
    state.files.set('/w/Foo.cs', 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypesSelectedFiles', Uri.file('/w/Foo.cs'), [Uri.file('/w/Foo.cs')]);

    expect(state.files.get('/w/Foo.cs')).toBe('internal class Foo\n{\n}\n');
    expect(state.files.get(path.join('/w', 'Bar.cs'))).toBe('internal class Bar\n{\n}\n');
  });

  it('leaves a single-type file untouched when splitting', async () => {
    state.files.set('/w/Foo.cs', 'internal class Foo\n{\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypesSelectedFiles', Uri.file('/w/Foo.cs'), [Uri.file('/w/Foo.cs')]);

    expect(state.files.get('/w/Foo.cs')).toBe('internal class Foo\n{\n}\n');
  });

  it('warns when nothing is selected for splitting top-level types', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypesSelectedFiles');

    expect(state.informationMessages).toContain('Code Janitor: no files selected.');
  });

  it('cleans the files the Git extension reports as changed', async () => {
    state.files.set('/w/a.cs', UNCLEAN);
    state.extensions.set('vscode.git', {
      activate: () =>
        Promise.resolve({
          getAPI: () => ({
            repositories: [
              {
                state: {
                  workingTreeChanges: [{ uri: Uri.file('/w/a.cs') }],
                  indexChanges: [{ uri: Uri.file('/w/a.cs') }],
                  mergeChanges: [],
                },
              },
            ],
          }),
        }),
    });

    registerCleanupCommands(createContext());
    await run('codeJanitor.cleanupChangedFiles');

    expect(state.files.get('/w/a.cs')).not.toContain('   \n');
  });

  it('warns when the Git extension is unavailable', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupChangedFiles');

    expect(state.warningMessages).toContain('Code Janitor: the built-in Git extension is not available.');
  });

  it('toggles cleanup on save in the workspace settings', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.toggleCleanupOnSave');

    expect(state.configuration.get('codeJanitor.cleanup.onSave')).toBe(true);
    expect(state.informationMessages).toContain('Code Janitor: cleanup on save enabled.');

    await run('codeJanitor.toggleCleanupOnSave');

    expect(state.configuration.get('codeJanitor.cleanup.onSave')).toBe(false);
    expect(state.informationMessages).toContain('Code Janitor: cleanup on save disabled.');
  });

  it('reports an empty workspace', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.cleanupWorkspace');

    expect(state.informationMessages).toContain('Code Janitor: no files found in the workspace.');
  });

  it('removes XML documentation from every C# file in the workspace', async () => {
    state.foundFiles = [Uri.file('/w/a.cs')];
    state.files.set('/w/a.cs', XML_DOCUMENTED);
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeXmlDocWorkspace');

    expect(state.files.get('/w/a.cs')).not.toContain('///');
  });

  it('reports an empty workspace for XML documentation removal', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeXmlDocWorkspace');

    expect(state.informationMessages).toContain('Code Janitor: no C# files found in the workspace.');
  });
});

describe('cleanup on save', () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = useFakeEngine();
  });

  function triggerSave(document: TextDocument): Promise<TextEdit[]> | undefined {
    let captured: Promise<TextEdit[]> | undefined;

    state.willSaveHandlers[0]({
      document,
      waitUntil: (edits) => {
        captured = edits as Promise<TextEdit[]>;
      },
    });

    return captured;
  }

  it('does nothing while the setting is off', () => {
    registerFormatOnSave(createContext());

    expect(triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'))).toBeUndefined();
  });

  it('ignores documents that are not C#', () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    registerFormatOnSave(createContext());

    expect(triggerSave(new TextDocument(Uri.file('/w/a.md'), 'text   \n', 'markdown'))).toBeUndefined();
  });

  it('returns a single full-document edit when enabled, from a cleanup without renames in other files', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    state.configuration.set('codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace', true);
    registerFormatOnSave(createContext());

    const edits = await triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'))!;

    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toBe('internal class C\n{\n}\n');
    expect(engine.requests('cleanup')[0].settings.renamePublicSymbolsAcrossWorkspace).toBe(false);
  });

  it('returns no edits for an already clean document', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    registerFormatOnSave(createContext());

    const edits = await triggerSave(new TextDocument(Uri.file('/w/a.cs'), 'internal class C\n{\n}\n', 'csharp'))!;

    expect(edits).toEqual([]);
  });

  it('changes nothing when the cleanup would also create or change other files, as VS Code may drop the edits of a save', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    createOutputChannel(createContext());
    useFakeEngine({ cleanup: () => cleanupResult('internal class Foo\n{\n}\n', { newFiles: [{ path: '/w/Bar.cs', text: 'internal class Bar\n{\n}\n' }] }) });
    registerFormatOnSave(createContext());

    const edits = await triggerSave(new TextDocument(Uri.file('/w/Foo.cs'), 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n', 'csharp'))!;

    expect(edits).toEqual([]);
    expect(state.files.has('/w/Bar.cs')).toBe(false);
    expect(
      state.outputChannelLines.some((line) => line.includes('Cleanup on save of /w/Foo.cs skipped: it would also change or create other files (/w/Bar.cs)'))
    ).toBe(true);
  });

  it('skips and logs a cleanup the engine does not finish in time, never holding up the save', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    createOutputChannel(createContext());
    const cancelled = Promise.withResolvers<void>();
    useFakeEngine({
      cleanup: (_params, token) => {
        token.onCancellationRequested(() => cancelled.resolve());

        return Promise.withResolvers<never>().promise;
      },
    });
    registerFormatOnSave(createContext());
    const started = Date.now();

    const edits = await triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'))!;

    expect(edits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(SAVE_CLEANUP_TIMEOUT_MS + 1000);
    expect(state.outputChannelLines.some((line) => line.includes(`the C# engine did not answer within ${SAVE_CLEANUP_TIMEOUT_MS} ms`))).toBe(true);
    await cancelled.promise;
  });

  it('logs a failure of cleanup on save and leaves the document as it is', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    createOutputChannel(createContext());
    registerFormatOnSave(createContext());
    const document = new TextDocument(Uri.file('/w/Broken.cs'), 'internal class Broken\n{\n}\n', 'csharp');
    document.getText = () => {
      throw new Error('the document cannot be read');
    };

    await expect(triggerSave(document)!).resolves.toEqual([]);
    expect(state.outputChannelLines.some((line) => line.includes('the document cannot be read'))).toBe(true);
  });

  it('honours the exclusion expressions', () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    state.configuration.set('codeJanitor.cleanup.exclude', ['\\.designer\\.cs$']);
    registerFormatOnSave(createContext());

    expect(triggerSave(new TextDocument(Uri.file('/w/Form.Designer.cs'), UNCLEAN, 'csharp'))).toBeUndefined();
  });
});

describe('editor commands', () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = useFakeEngine({ command: engineCommand });
  });

  /** An open C# document shown in the active editor. */
  function openActive(text: string, languageId = 'csharp'): TextDocument {
    const document = new TextDocument(Uri.file(languageId === 'csharp' ? '/w/a.cs' : '/w/a.md'), text, languageId);
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);

    return document;
  }

  it('registers every editor command', () => {
    registerEditorCommands(createContext());

    expect([...state.commands.keys()]).toEqual(
      expect.arrayContaining([
        'codeJanitor.fixNamespace',
        'codeJanitor.removeRegions',
        'codeJanitor.formatComments',
        'codeJanitor.removeXmlDoc',
        'codeJanitor.joinLines',
        'codeJanitor.sortLines',
      ])
    );
  });

  it('removes regions from the active document', async () => {
    const document = openActive('#region Fields\nclass C { }\n#endregion\n');
    registerEditorCommands(createContext());

    await run('codeJanitor.removeRegions');

    expect(document.getText()).toBe('class C { }\n');
  });

  it('removes XML documentation from the active document', async () => {
    const document = openActive('/// <summary>x</summary>\nclass C { }\n');
    registerEditorCommands(createContext());

    await run('codeJanitor.removeXmlDoc');

    expect(document.getText()).toBe('class C { }\n');
  });

  it('formats the comments of the active document', async () => {
    const document = openActive('//no space\nclass C { }\n');
    registerEditorCommands(createContext());

    await run('codeJanitor.formatComments');

    expect(document.getText()).toBe('// no space\nclass C { }\n');
    expect(engine.requests('command')[0]).toMatchObject({ command: 'formatComments', filePath: '/w/a.cs' });
  });

  it('reports when there is nothing to change', async () => {
    openActive('class C { }\n');
    registerEditorCommands(createContext());

    await run('codeJanitor.removeRegions');

    expect(state.informationMessages).toContain('Code Janitor: nothing to change.');
  });

  it('shows the reason when the engine fails', async () => {
    useFakeEngine({ command: () => Promise.reject(new Error('the file is in no project')) });
    openActive('#region A\n#endregion\n');
    registerEditorCommands(createContext());

    await run('codeJanitor.removeRegions');

    expect(state.errorMessages).toEqual(['Code Janitor: the file is in no project']);
  });

  it('requires a C# document', async () => {
    window.activeTextEditor = new TextEditor(new TextDocument(Uri.file('/w/a.md'), 'text', 'markdown'));
    registerEditorCommands(createContext());

    await run('codeJanitor.removeRegions');

    expect(state.informationMessages).toContain('Code Janitor: open a csharp file first.');
  });

  it('sorts the selected lines', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), 'b\na\nc\n', 'csharp');
    window.activeTextEditor = new TextEditor(document, new Selection(new Position(0, 0), new Position(2, 1)));
    registerEditorCommands(createContext());

    await run('codeJanitor.sortLines');

    expect(document.getText()).toBe('a\nb\nc\n');
  });

  it('joins the selected lines', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), 'a\n  b\n', 'csharp');
    window.activeTextEditor = new TextEditor(document, new Selection(new Position(0, 0), new Position(1, 3)));
    registerEditorCommands(createContext());

    await run('codeJanitor.joinLines');

    expect(document.getText()).toBe('a b\n');
  });

  it('rewrites the namespace with the value the user confirms', async () => {
    const document = openActive('namespace Old\n{\n    class C { }\n}\n');
    state.inputBoxResult = 'New.Name';
    registerEditorCommands(createContext());

    await run('codeJanitor.fixNamespace');

    expect(document.getText()).toContain('namespace New.Name');
    expect(engine.requests('command')[0]).toMatchObject({ command: 'fixNamespace', arguments: { namespace: 'New.Name' } });
  });

  it('leaves the document alone when the namespace prompt is cancelled', async () => {
    const document = openActive('namespace Old\n{\n}\n');
    state.inputBoxResult = undefined;
    registerEditorCommands(createContext());

    await run('codeJanitor.fixNamespace');

    expect(document.getText()).toContain('namespace Old');
    expect(engine.requests('command')).toEqual([]);
  });
});

describe('suggestNamespace', () => {
  it('derives the namespace from the folder structure', () => {
    state.workspaceFolders = [{ uri: Uri.file('/w'), name: 'MyApp' }];

    expect(suggestNamespace(Uri.file('/w/Services/Thing.cs'))).toBe('MyApp.Services');
  });

  it('uses the folder name alone at the workspace root', () => {
    state.workspaceFolders = [{ uri: Uri.file('/w'), name: 'MyApp' }];

    expect(suggestNamespace(Uri.file('/w/Thing.cs'))).toBe('MyApp');
  });

  it('sanitizes segments that are not valid identifiers', () => {
    state.workspaceFolders = [{ uri: Uri.file('/w'), name: 'My-App' }];

    expect(suggestNamespace(Uri.file('/w/2Models/A.cs'))).toBe('MyApp._2Models');
  });

  it('returns nothing outside a workspace folder', () => {
    expect(suggestNamespace(Uri.file('/other/A.cs'))).toBe('');
  });
});

describe('activation', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: {
      commands: { command: string }[];
      configuration: { title: string; order?: number; properties: Record<string, unknown> }[];
      menus: { 'editor/context': { command?: string; submenu?: string }[]; [key: string]: unknown[] };
      submenus: { id: string; label: string }[];
    };
  };

  const declaredSettings = new Set(manifest.contributes.configuration.flatMap((section) => Object.keys(section.properties)));

  /** Contexts activated in the running test: disposed after it, which removes what activation registered globally. */
  const contexts: ExtensionContext[] = [];
  afterEach(() => contexts.splice(0).forEach((context) => context.subscriptions.forEach((subscription) => subscription.dispose())));

  function activated(): ExtensionContext {
    const context = createContext();
    contexts.push(context);
    activate(context);

    return context;
  }

  it('watches the files the C# engine depends on, without starting it', () => {
    activated();

    expect(state.watchedGlobs).toContain(ENGINE_WATCH_GLOB);
    expect(() => state.diskListeners.forEach((listener) => listener(Uri.file('/w/App.csproj')))).not.toThrow();
  });

  it('registers a handler for every command declared in the manifest', () => {
    activated();

    const declared = manifest.contributes.commands.map((entry) => entry.command);
    const missing = declared.filter((command) => !state.commands.has(command));

    expect(missing).toEqual([]);
  });

  it('registers no command that the manifest does not declare', () => {
    activated();

    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
    const undeclared = [...state.commands.keys()].filter((command) => !declared.has(command));

    expect(undeclared).toEqual([]);
  });

  it('subscribes the save hook', () => {
    activated();

    expect(state.willSaveHandlers).toHaveLength(1);
  });

  it('creates the output channel and logs activation', () => {
    activated();

    expect(state.outputChannelLines.some((line) => line.includes('Code Janitor activated'))).toBe(true);
  });

  it('shows the output channel on demand', () => {
    activated();
    const handler = state.commands.get('codeJanitor.showOutputChannel');

    expect(() => handler?.()).not.toThrow();
  });

  it('declares every setting the code reads', () => {
    readCleanupSettings();
    readXmlDocOptions();
    isSupportedFile(Uri.file('/w/a.cs'));

    const read = [...new Set(state.configurationReads)];
    const undeclared = read.filter((key) => !declaredSettings.has(key));

    expect(read.length).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });

  it('declares each setting exactly once across the configuration sections', () => {
    const keys = manifest.contributes.configuration.flatMap((section) => Object.keys(section.properties));
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

    expect(duplicates).toEqual([]);
    expect(keys).toHaveLength(declaredSettings.size);
  });

  it('gives every configuration section a title', () => {
    const untitled = manifest.contributes.configuration.filter((section) => !section.title?.trim());

    expect(untitled).toEqual([]);
  });

  it('keeps Generate and Remove XML Documentation adjacent in the editor context submenu', () => {
    const submenu = manifest.contributes.menus['codeJanitor.editorSubmenu'] as { command: string; group: string }[];
    const generateIndex = submenu.findIndex((entry) => entry.command === 'codeJanitor.generateXmlDoc');
    const removeIndex = submenu.findIndex((entry) => entry.command === 'codeJanitor.removeXmlDoc');

    expect(generateIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBe(generateIndex + 1);
    expect(submenu[generateIndex].group).toBe(submenu[removeIndex].group);
  });

  it('never mixes an AI action into a non-AI menu group, or vice versa', () => {
    const submenu = manifest.contributes.menus['codeJanitor.editorSubmenu'] as { command: string; group: string }[];
    const aiCommands = new Set([
      'codeJanitor.aiExplain',
      'codeJanitor.aiCodeReview',
      'codeJanitor.aiRefactor',
      'codeJanitor.cleanAndRefactor',
      'codeJanitor.aiGenerateUnitTests',
      'codeJanitor.aiCoverageReport',
      'codeJanitor.aiGenerateTestsFromCoverageGaps',
      'codeJanitor.aiGenerateTestsToTargetCoverage',
    ]);

    const aiGroups = new Set(submenu.filter((entry) => aiCommands.has(entry.command)).map((entry) => entry.group));
    const nonAiGroups = new Set(submenu.filter((entry) => !aiCommands.has(entry.command)).map((entry) => entry.group));

    for (const group of aiGroups) {
      expect(nonAiGroups.has(group)).toBe(false);
    }
  });

  it('registers the editor submenu as a labeled entry in the editor context menu', () => {
    const editorContext = manifest.contributes.menus['editor/context'];
    const submenuEntry = editorContext.find((entry) => entry.submenu === 'codeJanitor.editorSubmenu');
    const label = manifest.contributes.submenus.find((entry) => entry.id === 'codeJanitor.editorSubmenu')?.label;

    expect(submenuEntry).toBeDefined();
    expect(label?.trim()).toBeTruthy();
  });

  it('registers the explorer submenu as a labeled entry in the explorer context menu', () => {
    const explorerContext = manifest.contributes.menus['explorer/context'] as { submenu?: string }[];
    const submenuEntry = explorerContext.find((entry) => entry.submenu === 'codeJanitor.explorerSubmenu');
    const label = manifest.contributes.submenus.find((entry) => entry.id === 'codeJanitor.explorerSubmenu')?.label;

    expect(submenuEntry).toBeDefined();
    expect(label?.trim()).toBeTruthy();
  });

  it('exposes coverage AI actions in the explorer submenu', () => {
    const submenu = manifest.contributes.menus['codeJanitor.explorerSubmenu'] as { command: string; group: string }[];

    expect(submenu).toEqual(
      expect.arrayContaining([
        { command: 'codeJanitor.aiCoverageReport', group: '3_ai' },
        { command: 'codeJanitor.aiGenerateTestsFromCoverageGaps', group: '3_ai' },
      ])
    );
  });

  it('gives the explorer submenu the batch XML documentation removal command', () => {
    const explorerSubmenu = manifest.contributes.menus['codeJanitor.explorerSubmenu'] as { command: string }[];

    expect(explorerSubmenu.some((entry) => entry.command === 'codeJanitor.removeXmlDocSelectedFiles')).toBe(true);
  });

  it('puts Cleanup Selected Files inside the explorer submenu instead of a separate, unlabeled entry', () => {
    const explorerContext = manifest.contributes.menus['explorer/context'] as { command?: string }[];
    const explorerSubmenu = manifest.contributes.menus['codeJanitor.explorerSubmenu'] as { command: string }[];

    expect(explorerContext.some((entry) => entry.command === 'codeJanitor.cleanupSelectedFiles')).toBe(false);
    expect(explorerSubmenu.some((entry) => entry.command === 'codeJanitor.cleanupSelectedFiles')).toBe(true);
  });
});
