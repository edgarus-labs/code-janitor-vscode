import { beforeEach, describe, expect, it } from 'vitest';
import { TextDocument, TextEditor, Uri, createContext, resetMock, state, window } from './helpers/vscodeMock';
import { cleanupFileGlob, isCleanupTarget, runCleanupOnUris, runFormatRazorOnUris } from '../src/commands/cleanupCore';
import { registerRazorCommands } from '../src/commands/razorCommands';

const MESSY = '@if(a){var x=1;}\n';
const FORMATTED = '@if (a)\n{\n    var x = 1;\n}\n';

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

function openDocument(path: string, content: string, language = 'razor'): TextDocument {
  const document = new TextDocument(Uri.file(path), content, language);
  state.documents.push(document);

  return document;
}

describe('codeJanitor.formatRazor', () => {
  it('formats the active Razor file whatever the cleanup setting says', async () => {
    const document = openDocument('/w/Page.razor', MESSY);
    window.activeTextEditor = new TextEditor(document);
    registerRazorCommands(createContext());

    await run('codeJanitor.formatRazor');

    expect(document.getText()).toBe(FORMATTED);
  });

  it('formats the selected files and leaves the others alone', async () => {
    state.files.set('/w/A.razor', MESSY);
    state.files.set('/w/B.cshtml', MESSY);
    state.files.set('/w/C.cs', MESSY);
    registerRazorCommands(createContext());

    await run('codeJanitor.formatRazor', Uri.file('/w/A.razor'), [Uri.file('/w/A.razor'), Uri.file('/w/B.cshtml'), Uri.file('/w/C.cs')]);

    expect(state.files.get('/w/A.razor')).toBe(FORMATTED);
    expect(state.files.get('/w/B.cshtml')).toBe(FORMATTED);
    expect(state.files.get('/w/C.cs')).toBe(MESSY);
  });

  it('says so when the active file is not a Razor file, and changes nothing', async () => {
    const document = openDocument('/w/a.cs', MESSY, 'csharp');
    window.activeTextEditor = new TextEditor(document);
    registerRazorCommands(createContext());

    await run('codeJanitor.formatRazor');

    expect(document.getText()).toBe(MESSY);
    expect(state.informationMessages).toContain('Code Janitor: the active file is not a Razor file (.razor or .cshtml).');
  });

  it('reports a missing active editor', async () => {
    registerRazorCommands(createContext());

    await run('codeJanitor.formatRazor');

    expect(state.informationMessages).toContain('Code Janitor: no active editor.');
  });

  it('skips files excluded by codeJanitor.cleanup.exclude', async () => {
    state.configuration.set('codeJanitor.cleanup.exclude', ['Generated']);
    state.files.set('/w/Generated/A.razor', MESSY);

    const result = await runFormatRazorOnUris([Uri.file('/w/Generated/A.razor')]);

    expect(result.changed).toBe(0);
    expect(state.files.get('/w/Generated/A.razor')).toBe(MESSY);
  });
});

describe('Razor files in the cleanup', () => {
  it('are formatted when codeJanitor.cleanup.formatRazorComponents is on', async () => {
    state.configuration.set('codeJanitor.cleanup.formatRazorComponents', true);
    state.files.set('/w/A.razor', MESSY);
    state.files.set('/w/B.cshtml', MESSY);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/A.razor'), Uri.file('/w/B.cshtml')]);

    expect(result.changed).toBe(2);
    expect(state.files.get('/w/A.razor')).toBe(FORMATTED);
    expect(state.files.get('/w/B.cshtml')).toBe(FORMATTED);
  });

  it('are not touched while the setting is off, as in Visual Studio', async () => {
    state.files.set('/w/A.razor', MESSY);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/A.razor')]);

    expect(result.changed).toBe(0);
    expect(state.files.get('/w/A.razor')).toBe(MESSY);
  });

  it('get the layout rules too when other file types are cleaned', async () => {
    state.configuration.set('codeJanitor.cleanup.formatRazorComponents', true);
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    state.files.set('/w/A.razor', `${MESSY}<p>x</p>   \n`);

    await runCleanupOnUris(createContext(), [Uri.file('/w/A.razor')]);

    expect(state.files.get('/w/A.razor')).toBe(`${FORMATTED}<p>x</p>\n`);
  });

  it('respect codeJanitor.cleanup.include and exclude', () => {
    state.configuration.set('codeJanitor.cleanup.formatRazorComponents', true);
    state.configuration.set('codeJanitor.cleanup.exclude', ['Legacy']);
    state.configuration.set('codeJanitor.cleanup.include', ['Components']);

    expect(isCleanupTarget(Uri.file('/w/Components/A.razor'))).toBe(true);
    expect(isCleanupTarget(Uri.file('/w/Components/Legacy/A.razor'))).toBe(false);
    expect(isCleanupTarget(Uri.file('/w/Pages/A.razor'))).toBe(false);
  });

  it('are searched for in folders only while formatting them is on', () => {
    expect(cleanupFileGlob()).toBe('**/*.cs');
    state.configuration.set('codeJanitor.cleanup.formatRazorComponents', true);
    expect(cleanupFileGlob()).toBe('**/*.{cs,razor,cshtml}');
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    expect(cleanupFileGlob()).toBe('**/*');
  });

  it('use the configured indentation', async () => {
    state.configuration.set('codeJanitor.cleanup.formatRazorComponents', true);
    state.configuration.set('codeJanitor.razor.indentSize', 2);
    state.configuration.set('codeJanitor.razor.indentStyle', 'space');
    state.files.set('/w/A.razor', MESSY);

    await runCleanupOnUris(createContext(), [Uri.file('/w/A.razor')]);

    expect(state.files.get('/w/A.razor')).toBe('@if (a)\n{\n  var x = 1;\n}\n');
  });
});
