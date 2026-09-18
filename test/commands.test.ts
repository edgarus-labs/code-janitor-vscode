import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Position,
  Selection,
  TextDocument,
  TextEdit,
  TextEditor,
  Uri,
  createContext,
  resetMock,
  state,
  window,
} from './helpers/vscodeMock';
import { activate } from '../src/extension';
import { registerCleanupCommands } from '../src/commands/cleanupCommands';
import { expandToCleanableFiles, isSupportedFile, runCleanupOnUris } from '../src/commands/cleanupCore';
import { registerEditorCommands, suggestNamespace } from '../src/commands/editorCommands';
import { registerFormatOnSave } from '../src/commands/formatOnSave';
import { readCleanupSettings, readXmlDocOptions } from '../src/commands/settings';
import { exportRepositorySettings, importRepositorySettings, registerRepositorySettingsCommands } from '../src/commands/repositorySettings';
import { HeaderPosition, HeaderUpdateMode } from '../src/cleanup/types';

/** Trailing whitespace is the smallest change every default cleanup configuration performs. */
const UNCLEAN = 'internal class C   \n{\n}\n';
const XML_DOCUMENTED = '/// <summary>Doc.</summary>\ninternal class C\n{\n}\n';

beforeEach(() => {
  resetMock();
});

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

  it('reads the XML documentation budget', () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.maxMembersPerFile', 5);
    state.configuration.set('codeJanitor.ai.xmlDoc.ignorePattern', 'Foo');

    expect(readXmlDocOptions()).toMatchObject({ maxMembersPerFile: 5, ignorePattern: 'Foo', ignoreObsolete: true });
  });

  it('loads cleanup policy from a .codejanitor file in the repository root', () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
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

  it('lets explicit VS Code cleanup settings override the repository policy', () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    state.configuration.set('codeJanitor.cleanup.removeRegions', true);

    expect(readCleanupSettings(root).removeRegions).toBe(true);
  });
});

describe('repository settings commands', () => {
  it('exports cleanup settings as a .codejanitor file', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
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
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
    fs.writeFileSync(path.join(root, '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false, organizeUsings: true } }));

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.removeRegions')).toBe(false);
    expect(state.configuration.get('codeJanitor.cleanup.organizeUsings')).toBe(true);
  });

  it('registers export and import commands', () => {
    const context = createContext();
    registerRepositorySettingsCommands(context);

    expect([...state.commands.keys()]).toEqual(
      expect.arrayContaining(['codeJanitor.exportRepositorySettings', 'codeJanitor.importRepositorySettings'])
    );
  });

  it('exports with file header position and update mode', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
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
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
    state.configuration.set('codeJanitor.cleanup.insertBlankLinePadding', false);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.insertBlankLinePadding).toBe(false);
    expect(exported.cleanup.insertBlankLinePaddingBeforeClasses).toBeUndefined();
  });

  it('exports grouped explicit access modifiers setting', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
    state.configuration.set('codeJanitor.cleanup.insertExplicitAccessModifiers', false);

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.insertExplicitAccessModifiers).toBe(false);
    expect(exported.cleanup.insertExplicitAccessModifiersOnClasses).toBeUndefined();
  });

  it('omits grouped settings when not configured', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));

    await exportRepositorySettings(root);

    const exported = JSON.parse(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')) as {
      cleanup: Record<string, unknown>;
    };
    expect(exported.cleanup.insertBlankLinePadding).toBeUndefined();
    expect(exported.cleanup.insertExplicitAccessModifiers).toBeUndefined();
  });

  it('asks before overwriting an existing .codejanitor', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
    fs.writeFileSync(path.join(root, '.codejanitor'), '{"cleanup":{}}');
    state.modalChoice = undefined; // dismiss

    await exportRepositorySettings(root);

    // File should not be overwritten
    expect(fs.readFileSync(path.join(root, '.codejanitor'), 'utf8')).toBe('{"cleanup":{}}');
  });

  it('overwrites when the user confirms', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
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
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));

    await importRepositorySettings(root);

    expect(state.informationMessages).toContain('Code Janitor: .codejanitor was not found.');
  });

  it('imports file header position and update mode', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
    fs.writeFileSync(
      path.join(root, '.codejanitor'),
      JSON.stringify({ cleanup: { fileHeaderPosition: 'afterUsings', fileHeaderUpdateMode: 'replace' } })
    );

    await importRepositorySettings(root);

    expect(state.configuration.get('codeJanitor.cleanup.fileHeaderPosition')).toBe('afterUsings');
    expect(state.configuration.get('codeJanitor.cleanup.fileHeaderUpdateMode')).toBe('replace');
  });

  it('imports grouped settings when all values match', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
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

  it('does not import grouped settings when values differ', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'codejanitor-'));
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

  it('skips excluded files during a cleanup run', async () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['\\.designer\\.cs$']);
    state.files.set('/w/Form.Designer.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Form.Designer.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0 });
    expect(state.files.get('/w/Form.Designer.cs')).toBe(UNCLEAN);
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

describe('runCleanupOnUris', () => {
  it('writes a cleaned file back to disk', async () => {
    state.files.set('/w/a.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toEqual({ changed: 1, failed: 0 });
    expect(state.files.get('/w/a.cs')).not.toContain('   \n');
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

  it('reports nothing to do when every file is filtered out', async () => {
    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.md')]);

    expect(result).toEqual({ changed: 0, failed: 0 });
    expect(state.informationMessages).toContain('Code Janitor: no files to clean up.');
  });

  it('runs only the layout rules for other file types', async () => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    state.files.set('/w/a.md', 'text   \n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.md')]);

    expect(result.changed).toBe(1);
    expect(state.files.get('/w/a.md')).toBe('text\n');
  });

  it('leaves an already clean file untouched', async () => {
    state.files.set('/w/a.cs', 'internal class C\n{\n}\n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0 });
  });

  it('skips files that cannot be read', async () => {
    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/missing.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0 });
  });

  it('leaves a base class unsealed when its only subclass lives in a same-directory sibling file outside the batch', async () => {
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Animal.cs', 'internal class Animal\n{\n}\n');
    state.files.set('/w/Dog.cs', 'internal class Dog : Animal\n{\n}\n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Animal.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0 });
    expect(state.files.get('/w/Animal.cs')).toBe('internal class Animal\n{\n}\n');
  });

  it('leaves a base class unsealed when its only subclass lives in a symlinked same-directory sibling file', async () => {
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Animal.cs', 'internal class Animal\n{\n}\n');
    state.files.set('/w/Dog.cs', 'internal class Dog : Animal\n{\n}\n');
    state.symlinkedFiles.add('/w/Dog.cs');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Animal.cs')]);

    expect(result).toEqual({ changed: 0, failed: 0 });
    expect(state.files.get('/w/Animal.cs')).toBe('internal class Animal\n{\n}\n');
  });

  it('still seals a class whose only same-directory sibling has no reference to it', async () => {
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Widget.cs', 'internal class Widget\n{\n}\n');
    state.files.set('/w/Gadget.cs', 'internal class Gadget\n{\n}\n');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/Widget.cs')]);

    expect(result).toEqual({ changed: 1, failed: 0 });
    expect(state.files.get('/w/Widget.cs')).toBe('internal sealed class Widget\n{\n}\n');
  });
});

describe('cleanup commands', () => {
  const commandIds = [
    'codeJanitor.cleanupActiveFile',
    'codeJanitor.previewCleanupActiveFile',
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
  });

  it('does not propose sealing a class in the preview when a same-directory sibling subclasses it', async () => {
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Dog.cs', 'internal class Dog : Animal\n{\n}\n');
    const document = new TextDocument(Uri.file('/w/Animal.cs'), 'internal class Animal\n{\n}\n', 'csharp');
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

  it('removes XML documentation from selected files', async () => {
    state.files.set('/w/a.cs', XML_DOCUMENTED);
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeXmlDocSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.files.get('/w/a.cs')).not.toContain('///');
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

  it('fixes the namespace of selected files from their folder path, without prompting', async () => {
    state.workspaceFolders = [{ uri: Uri.file('/w'), name: 'MyApp' }];
    state.files.set('/w/Services/Thing.cs', 'namespace Old\n{\n    class Thing { }\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.fixNamespaceSelectedFiles', Uri.file('/w/Services/Thing.cs'), [
      Uri.file('/w/Services/Thing.cs'),
    ]);

    expect(state.files.get('/w/Services/Thing.cs')).toContain('namespace MyApp.Services');
    expect(state.inputBoxResult).toBeUndefined();
  });

  it('removes regions from selected files', async () => {
    state.files.set('/w/a.cs', '#region Fields\nclass C { }\n#endregion\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.removeRegionsSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.files.get('/w/a.cs')).toBe('class C { }\n');
  });

  it('formats comments in selected files', async () => {
    state.files.set('/w/a.cs', '//no space\nclass C { }\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.formatCommentsSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.files.get('/w/a.cs')).toContain('// no space');
  });

  it('warns when nothing is selected for namespace fixing, region removal or comment formatting', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.fixNamespaceSelectedFiles');
    await run('codeJanitor.removeRegionsSelectedFiles');
    await run('codeJanitor.formatCommentsSelectedFiles');

    expect(state.informationMessages.filter((m) => m === 'Code Janitor: no files selected.')).toHaveLength(3);
  });

  it('splits the active file into one file per top-level type', async () => {
    const document = new TextDocument(
      Uri.file('/w/Foo.cs'),
      'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n',
      'csharp'
    );
    state.documents.push(document);
    window.activeTextEditor = new TextEditor(document);
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypes');

    expect(document.getText()).toContain('class Foo');
    expect(document.getText()).not.toContain('class Bar');
    expect(state.files.get(path.join('/w', 'Bar.cs'))).toContain('class Bar');
  });

  it('reports a missing active editor for splitting top-level types', async () => {
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypes');

    expect(state.informationMessages).toContain('Code Janitor: no active editor.');
  });

  it('splits selected files into one file per top-level type', async () => {
    state.files.set('/w/Foo.cs', 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypesSelectedFiles', Uri.file('/w/Foo.cs'), [Uri.file('/w/Foo.cs')]);

    expect(state.files.get('/w/Foo.cs')).toContain('class Foo');
    expect(state.files.get('/w/Foo.cs')).not.toContain('class Bar');
    expect(state.files.get(path.join('/w', 'Bar.cs'))).toContain('class Bar');
  });

  it('does not seal a base type when splitting creates a subclass sibling in the same operation', async () => {
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Animals.cs', 'public class Animal\n{\n}\n\npublic class Dog : Animal\n{\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypesSelectedFiles', Uri.file('/w/Animals.cs'), [Uri.file('/w/Animals.cs')]);

    expect(state.files.get('/w/Animals.cs')).not.toContain('sealed');
    expect(state.files.get(path.join('/w', 'Dog.cs'))).toContain('class Dog : Animal');
  });

  it('does not seal a base type split from one selected file when its subclass is a different selected file in another directory', async () => {
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Animals.cs', 'public class Animal\n{\n}\n\npublic class Extra\n{\n}\n');
    state.files.set('/other/Dog.cs', 'public class Dog : Animal\n{\n}\n');
    registerCleanupCommands(createContext());

    await run('codeJanitor.splitTopLevelTypesSelectedFiles', undefined, [
      Uri.file('/w/Animals.cs'),
      Uri.file('/other/Dog.cs'),
    ]);

    expect(state.files.get('/w/Animals.cs')).not.toContain('sealed');
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

  it('returns a single full-document edit when enabled', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    registerFormatOnSave(createContext());

    const edits = await triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'))!;

    expect(edits).toHaveLength(1);
    expect(edits[0].newText).not.toContain('   \n');
  });

  it('returns no edits for an already clean document', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    registerFormatOnSave(createContext());

    const edits = await triggerSave(new TextDocument(Uri.file('/w/a.cs'), 'internal class C\n{\n}\n', 'csharp'))!;

    expect(edits).toEqual([]);
  });

  it('does not seal a class on save when a same-directory sibling subclasses it', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    state.configuration.set('codeJanitor.cleanup.sealClassesWhenSafe', true);
    state.files.set('/w/Dog.cs', 'internal class Dog : Animal\n{\n}\n');
    registerFormatOnSave(createContext());

    const edits = await triggerSave(new TextDocument(Uri.file('/w/Animal.cs'), 'internal class Animal\n{\n}\n', 'csharp'))!;

    expect(edits).toEqual([]);
  });

  it('honours the exclusion expressions', () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    state.configuration.set('codeJanitor.cleanup.exclude', ['\\.designer\\.cs$']);
    registerFormatOnSave(createContext());

    expect(triggerSave(new TextDocument(Uri.file('/w/Form.Designer.cs'), UNCLEAN, 'csharp'))).toBeUndefined();
  });
});

describe('editor commands', () => {
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
    const document = new TextDocument(
      Uri.file('/w/a.cs'),
      '#region Fields\nclass C { }\n#endregion\n',
      'csharp'
    );
    window.activeTextEditor = new TextEditor(document);
    registerEditorCommands(createContext());

    await run('codeJanitor.removeRegions');

    expect(document.getText()).toBe('class C { }\n');
  });

  it('removes XML documentation from the active document', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), '/// <summary>x</summary>\nclass C { }\n', 'csharp');
    window.activeTextEditor = new TextEditor(document);
    registerEditorCommands(createContext());

    await run('codeJanitor.removeXmlDoc');

    expect(document.getText()).toBe('class C { }\n');
  });

  it('reports when there is nothing to change', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), 'class C { }\n', 'csharp');
    window.activeTextEditor = new TextEditor(document);
    registerEditorCommands(createContext());

    await run('codeJanitor.removeRegions');

    expect(state.informationMessages).toContain('Code Janitor: nothing to change.');
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
    const document = new TextDocument(Uri.file('/w/a.cs'), 'namespace Old\n{\n    class C { }\n}\n', 'csharp');
    window.activeTextEditor = new TextEditor(document);
    state.inputBoxResult = 'New.Name';
    registerEditorCommands(createContext());

    await run('codeJanitor.fixNamespace');

    expect(document.getText()).toContain('namespace New.Name');
  });

  it('leaves the document alone when the namespace prompt is cancelled', async () => {
    const document = new TextDocument(Uri.file('/w/a.cs'), 'namespace Old\n{\n}\n', 'csharp');
    window.activeTextEditor = new TextEditor(document);
    state.inputBoxResult = undefined;
    registerEditorCommands(createContext());

    await run('codeJanitor.fixNamespace');

    expect(document.getText()).toContain('namespace Old');
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
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ) as {
    contributes: {
      commands: { command: string }[];
      configuration: { title: string; order?: number; properties: Record<string, unknown> }[];
      menus: { 'editor/context': { command?: string; submenu?: string }[]; [key: string]: unknown[] };
      submenus: { id: string; label: string }[];
    };
  };

  const declaredSettings = new Set(
    manifest.contributes.configuration.flatMap((section) => Object.keys(section.properties))
  );

  it('registers a handler for every command declared in the manifest', () => {
    activate(createContext());

    const declared = manifest.contributes.commands.map((entry) => entry.command);
    const missing = declared.filter((command) => !state.commands.has(command));

    expect(missing).toEqual([]);
  });

  it('registers no command that the manifest does not declare', () => {
    activate(createContext());

    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
    const undeclared = [...state.commands.keys()].filter((command) => !declared.has(command));

    expect(undeclared).toEqual([]);
  });

  it('subscribes the save hook', () => {
    activate(createContext());

    expect(state.willSaveHandlers).toHaveLength(1);
  });

  it('creates the output channel and logs activation', () => {
    activate(createContext());

    expect(state.outputChannelLines.some((line) => line.includes('Code Janitor activated'))).toBe(true);
  });

  it('shows the output channel on demand', () => {
    activate(createContext());
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
    ]);

    const aiGroups = new Set(submenu.filter((entry) => aiCommands.has(entry.command)).map((entry) => entry.group));
    const nonAiGroups = new Set(
      submenu.filter((entry) => !aiCommands.has(entry.command)).map((entry) => entry.group)
    );

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
