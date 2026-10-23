import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc';
import { registerCleanupCommands } from '../src/commands/cleanupCommands';
import { runCleanupOnUris } from '../src/commands/cleanupCore';
import { registerFormatOnSave } from '../src/commands/formatOnSave';
import type { XmlDocTargetResult } from '../src/engine/protocol';
import { createOutputChannel } from '../src/logging';
import { cleanupResult, trimTrailingWhitespace, useFakeEngine } from './helpers/fakeEngine';
import type { EngineParams, FakeEngine } from './helpers/fakeEngine';
import {
  CancellationTokenSource,
  ConfigurationTarget,
  Position,
  Range,
  TextDocument,
  TextEdit,
  TextEditor,
  Uri,
  createContext,
  resetMock,
  state,
  window,
  workspace,
} from './helpers/vscodeMock';
import type { WillSaveEvent } from './helpers/vscodeMock';

const { getAiChatCompletion } = vi.hoisted(() => ({ getAiChatCompletion: vi.fn<(...args: unknown[]) => Promise<string>>() }));

vi.mock('../src/ai/aiService', () => ({
  getAiChatCompletion,
  testAiConnection: () => Promise.resolve({ succeeded: true, message: '' }),
  storeCustomApiKey: () => Promise.resolve(),
}));

// A new file: every line counts as changed, so Cleanup Changed Files cleans it without Git.
vi.mock('../src/cleanup/gitBaseline', () => ({ readHeadVersion: () => Promise.resolve({ kind: 'new' }) }));

const UNCLEAN = 'internal class C   \n{\n}\n';
const CLEAN = 'internal class C\n{\n}\n';
const PARTIAL_PROMPT_CHOICES = ['Yes', 'No', 'Always', 'Never'];

let engine: FakeEngine;

beforeEach(() => {
  resetMock();
  getAiChatCompletion.mockReset();
  createOutputChannel(createContext());
  state.workspaceFolders = [{ uri: Uri.file('/w'), name: 'w' }];
  engine = useFakeEngine();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const output = (text: string) => state.outputChannelLines.some((line) => line.includes(text));

describe('a file outside the workspace folders (performPartialCleanupOnExternal)', () => {
  it('asks once before cleaning, with Yes, No, Always and Never, and with Yes cleans it partially', async () => {
    const showWarning = vi.spyOn(window, 'showWarningMessage');
    state.modalChoice = 'Yes';
    state.files.set('/ext/a.cs', UNCLEAN);
    state.files.set('/ext/b.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs'), Uri.file('/ext/b.cs')]);

    expect(showWarning).toHaveBeenCalledTimes(1);
    expect(showWarning.mock.calls[0][0]).toContain('/ext/a.cs is not in a workspace folder');
    expect(showWarning.mock.calls[0].slice(1)).toEqual([expect.objectContaining({ modal: true }), ...PARTIAL_PROMPT_CHOICES]);
    expect(result.changed).toBe(2);
    expect(engine.requests('cleanup').map((params) => [params.partial, params.settings.renamePublicSymbolsAcrossWorkspace])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(state.configurationUpdates).toEqual([]);
  });

  it.each([['No'], [undefined]])('leaves the file as it is when the answer is %s', async (choice) => {
    state.modalChoice = choice;
    state.files.set('/ext/a.cs', UNCLEAN);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);

    expect(result.changed).toBe(0);
    expect(engine.requests('cleanup')).toEqual([]);
    expect(state.files.get('/ext/a.cs')).toBe(UNCLEAN);
  });

  it('remembers Always in the user settings and cleans the file partially', async () => {
    state.modalChoice = 'Always';
    state.files.set('/ext/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);

    expect(state.configurationUpdates).toEqual([
      { key: 'codeJanitor.cleanup.performPartialCleanupOnExternal', value: 'always', target: ConfigurationTarget.Global },
    ]);
    expect(engine.requests('cleanup')[0].partial).toBe(true);
  });

  it('remembers Never in the user settings and leaves the file as it is', async () => {
    state.modalChoice = 'Never';
    state.files.set('/ext/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);

    expect(state.configurationUpdates).toEqual([
      { key: 'codeJanitor.cleanup.performPartialCleanupOnExternal', value: 'never', target: ConfigurationTarget.Global },
    ]);
    expect(engine.requests('cleanup')).toEqual([]);
  });

  it('with always, cleans partially without asking', async () => {
    const showWarning = vi.spyOn(window, 'showWarningMessage');
    state.configuration.set('codeJanitor.cleanup.performPartialCleanupOnExternal', 'always');
    state.files.set('/ext/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);

    expect(showWarning).not.toHaveBeenCalled();
    expect(engine.requests('cleanup')[0].partial).toBe(true);
  });

  it('with never, skips the file without asking, saying why only in diagnostics mode', async () => {
    state.configuration.set('codeJanitor.cleanup.performPartialCleanupOnExternal', 'never');
    state.files.set('/ext/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);
    expect(output('/ext/a.cs skipped')).toBe(false);
    state.configuration.set('codeJanitor.general.diagnosticsMode', true);
    await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);

    expect(engine.requests('cleanup')).toEqual([]);
    expect(state.warningMessages).toEqual([]);
    expect(output('Cleanup: /ext/a.cs skipped: it is not in a workspace folder (codeJanitor.cleanup.performPartialCleanupOnExternal is never).')).toBe(true);
  });

  it('cleans a file in a workspace folder fully, without asking', async () => {
    state.files.set('/w/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(state.warningMessages).toEqual([]);
    expect(engine.requests('cleanup')[0]).not.toHaveProperty('partial');
  });

  it('cleans every file fully when no workspace folder is open', async () => {
    state.workspaceFolders = [];
    state.files.set('/ext/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/ext/a.cs')]);

    expect(state.warningMessages).toEqual([]);
    expect(engine.requests('cleanup')[0]).not.toHaveProperty('partial');
  });
});

describe('cleanup on save', () => {
  function triggerSave(document: TextDocument): Promise<TextEdit[]> {
    let captured: Promise<TextEdit[]> | undefined;
    const event: WillSaveEvent = {
      document,
      waitUntil: (edits) => {
        captured = edits as Promise<TextEdit[]>;
      },
    };
    state.willSaveHandlers[0](event);

    return captured ?? Promise.resolve([]);
  }

  beforeEach(() => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    registerFormatOnSave(createContext());
  });

  it('asks the engine for a cleanup on save, with skipOrganizeUsingsDuringCleanupOnSave', async () => {
    state.configuration.set('codeJanitor.cleanup.skipOrganizeUsingsDuringCleanupOnSave', true);

    await triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'));

    const [request] = engine.requests('cleanup');
    expect(request.onSave).toBe(true);
    expect(request).not.toHaveProperty('partial');
    expect(request.settings.skipOrganizeUsingsDuringCleanupOnSave).toBe(true);
  });

  it('never sends skipOrganizeUsingsDuringCleanupOnSave with a cleanup command', async () => {
    state.configuration.set('codeJanitor.cleanup.skipOrganizeUsingsDuringCleanupOnSave', true);
    state.files.set('/w/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    const [request] = engine.requests('cleanup');
    expect(request).not.toHaveProperty('onSave');
    expect(request.settings).not.toHaveProperty('skipOrganizeUsingsDuringCleanupOnSave');
  });

  it('cleans a file outside the workspace folders partially without asking, unless the setting is never', async () => {
    const edits = await triggerSave(new TextDocument(Uri.file('/ext/a.cs'), UNCLEAN, 'csharp'));
    state.configuration.set('codeJanitor.cleanup.performPartialCleanupOnExternal', 'never');
    const never = await triggerSave(new TextDocument(Uri.file('/ext/b.cs'), UNCLEAN, 'csharp'));

    expect(edits).toHaveLength(1);
    expect(never).toEqual([]);
    expect(state.warningMessages).toEqual([]);
    expect(engine.requests('cleanup').map((params) => [params.filePath, params.onSave, params.partial])).toEqual([['/ext/a.cs', true, true]]);
  });

  it('always logs why a save was skipped because it would change other files', async () => {
    useFakeEngine({ cleanup: () => cleanupResult(CLEAN, { newFiles: [{ path: '/w/Bar.cs', text: 'internal class Bar { }\n' }] }) });

    await triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'));

    expect(output('Cleanup on save of /w/a.cs skipped: it would also change or create other files')).toBe(true);
  });

  it('logs a save skipped by the performPartialCleanupOnExternal choice only in diagnostics mode', async () => {
    state.configuration.set('codeJanitor.cleanup.performPartialCleanupOnExternal', 'never');

    await triggerSave(new TextDocument(Uri.file('/ext/a.cs'), UNCLEAN, 'csharp'));
    expect(output('Cleanup on save of /ext/a.cs skipped')).toBe(false);
    state.configuration.set('codeJanitor.general.diagnosticsMode', true);
    await triggerSave(new TextDocument(Uri.file('/ext/a.cs'), UNCLEAN, 'csharp'));

    expect(output('Cleanup on save of /ext/a.cs skipped: it is not in a workspace folder')).toBe(true);
  });

  it('runs neither Format Document, nor the other cleaning commands, nor AI documentation', async () => {
    state.configuration.set('codeJanitor.cleanup.runFormatDocument', true);
    state.configuration.set('codeJanitor.thirdParty.otherCleaningCommands', ['other.format']);
    state.configuration.set('codeJanitor.ai.xmlDoc.runDuringCleanup', true);
    const executed: string[] = [];
    state.commands.set('vscode.executeFormatDocumentProvider', () => executed.push('format'));
    state.commands.set('other.format', () => executed.push('other.format'));

    const edits = await triggerSave(new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp'));

    expect(edits).toHaveLength(1);
    expect(executed).toEqual([]);
    expect(getAiChatCompletion).not.toHaveBeenCalled();
  });
});

describe('external tools after the cleanup of an open document', () => {
  function openDocument(path: string, text = UNCLEAN): TextDocument {
    const document = new TextDocument(Uri.file(path), text, 'csharp');
    state.documents.push(document);

    return document;
  }

  it('runs Format Document (runFormatDocument) on the cleaned document and applies its edits', async () => {
    state.configuration.set('codeJanitor.cleanup.runFormatDocument', true);
    const document = openDocument('/w/a.cs');
    const formatted: unknown[][] = [];
    state.commands.set('vscode.executeFormatDocumentProvider', (...args: unknown[]) => {
      formatted.push(args);

      return [TextEdit.replace(new Range(new Position(0, 0), new Position(0, 8)), 'public')];
    });

    const result = await runCleanupOnUris(createContext(), [document.uri]);

    expect(result.changed).toBe(1);
    expect(formatted).toEqual([[document.uri, { tabSize: 4, insertSpaces: true }]]);
    expect(document.getText()).toBe('public class C\n{\n}\n');
  });

  it('runs the other cleaning commands in order with the document active, logs a failing one and goes on', async () => {
    state.configuration.set('codeJanitor.thirdParty.otherCleaningCommands', ['first.cmd', 'broken.cmd', 'last.cmd']);
    const document = openDocument('/w/a.cs');
    const previous = openDocument('/w/previous.cs', CLEAN);
    window.activeTextEditor = new TextEditor(previous);
    const shown = vi.spyOn(window, 'showTextDocument');
    const executed: string[] = [];
    state.commands.set('first.cmd', () => executed.push('first.cmd'));
    state.commands.set('broken.cmd', () => {
      throw new Error('no formatter for this file');
    });
    state.commands.set('last.cmd', () => executed.push('last.cmd'));

    const result = await runCleanupOnUris(createContext(), [document.uri]);

    expect(result).toMatchObject({ changed: 1, failed: 0 });
    expect(executed).toEqual(['first.cmd', 'last.cmd']);
    expect(shown.mock.calls.map(([shownDocument]) => shownDocument)).toEqual([document, previous]);
    expect(output('ERROR - Other cleaning command broken.cmd on /w/a.cs: Error: no formatter for this file')).toBe(true);
  });

  it('runs nothing for a file that is not open', async () => {
    state.configuration.set('codeJanitor.cleanup.runFormatDocument', true);
    state.configuration.set('codeJanitor.thirdParty.otherCleaningCommands', ['other.format']);
    const executed: string[] = [];
    state.commands.set('vscode.executeFormatDocumentProvider', () => executed.push('format'));
    state.commands.set('other.format', () => executed.push('other.format'));
    state.files.set('/w/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(executed).toEqual([]);
  });

  it('runs nothing for a document whose cleanup failed', async () => {
    state.configuration.set('codeJanitor.thirdParty.otherCleaningCommands', ['other.format']);
    useFakeEngine({
      cleanup: () => {
        throw new Error('engine failure');
      },
    });
    const executed: string[] = [];
    state.commands.set('other.format', () => executed.push('other.format'));
    const document = openDocument('/w/a.cs');

    const result = await runCleanupOnUris(createContext(), [document.uri]);

    expect(result.failed).toBe(1);
    expect(executed).toEqual([]);
  });
});

describe('diagnostics mode', () => {
  it('writes the informational messages of a batch and the files it skips only in diagnostics mode', async () => {
    state.files.set('/w/a.cs', UNCLEAN);
    const batch = [Uri.file('/w/a.cs'), Uri.file('/w/notes.md')];

    await runCleanupOnUris(createContext(), batch);
    expect(state.outputChannelLines).toEqual([]);
    state.configuration.set('codeJanitor.general.diagnosticsMode', true);
    await runCleanupOnUris(createContext(), batch);

    expect(output('Cleanup: starting on 1 file(s).')).toBe(true);
    expect(output('Cleanup: /w/notes.md skipped: not a file type or path cleanup acts on.')).toBe(true);
    expect(output('Cleanup: finished - 0 changed, 0 failed.')).toBe(true);
  });
});

/** The fake engine's `xmlDocTargets`: `public void M()` methods without `///` above them. */
function xmlDocTargets(text: string): XmlDocTargetResult[] {
  const lines = text.split('\n');

  return lines.flatMap((line, index): XmlDocTargetResult[] => {
    const match = /^(\s*)public void (\w+)\(\)/.exec(line);
    if (!match || (lines[index - 1] ?? '').trim().startsWith('///')) {
      return [];
    }

    return [
      {
        name: match[2],
        kind: 'method',
        text: line.trim(),
        insertionLine: index,
        indent: match[1],
        signature: line.trim(),
        body: '',
        parameters: [],
        typeParameters: [],
        returnType: 'void',
        containingType: { name: 'C', kind: 'class' },
        exceptions: [],
        accessors: null,
        baseTypes: [],
        members: [],
        modifiers: ['public'],
      },
    ];
  });
}

describe('AI XML documentation during cleanup (ai.xmlDoc.runDuringCleanup)', () => {
  const SOURCE = 'internal class C\n{\n    public void Run() { }\n}\n';

  beforeEach(() => {
    engine = useFakeEngine({ query: (params: EngineParams) => (params.query === 'xmlDocTargets' ? xmlDocTargets(params.text) : null) });
    getAiChatCompletion.mockResolvedValue('Runs the job.');
  });

  it('documents the cleaned C# files and reports the summary', async () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.runDuringCleanup', true);
    state.files.set('/w/a.cs', SOURCE);
    const context = createContext();

    await runCleanupOnUris(context, [Uri.file('/w/a.cs')]);

    expect(getAiChatCompletion).toHaveBeenCalledTimes(1);
    expect(getAiChatCompletion.mock.calls[0][0]).toBe(context);
    expect(state.files.get('/w/a.cs')).toContain('    /// <summary>\n    /// Runs the job.\n    /// </summary>\n    public void Run() { }');
    expect(output('AI XML documentation during cleanup: 1 member(s) documented in 1 file(s)')).toBe(true);
  });

  it('runs before the external tools, so they see the documentation', async () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.runDuringCleanup', true);
    state.configuration.set('codeJanitor.thirdParty.otherCleaningCommands', ['other.format']);
    const document = new TextDocument(Uri.file('/w/a.cs'), SOURCE, 'csharp');
    state.documents.push(document);
    const seen: string[] = [];
    state.commands.set('other.format', () => seen.push(document.getText()));

    await runCleanupOnUris(createContext(), [document.uri]);

    expect(seen).toEqual([expect.stringContaining('/// Runs the job.')]);
  });

  it('does nothing while the setting is off', async () => {
    state.files.set('/w/a.cs', SOURCE);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(getAiChatCompletion).not.toHaveBeenCalled();
    expect(engine.requests('query')).toEqual([]);
  });

  it('does not document when only the lines changed since the last commit are cleaned', async () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.runDuringCleanup', true);
    state.configuration.set('codeJanitor.cleanup.onlyChangedLines', true);
    state.files.set('/w/a.cs', SOURCE);

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')], { honorOnlyChangedLines: true });

    expect(result.failed).toBe(0);
    expect(engine.requests('cleanup')[0].changedLines).toBeNull();
    expect(getAiChatCompletion).not.toHaveBeenCalled();
  });
});

describe('onlyChangedLines gates the changed lines', () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function rootWithPolicy(cleanup: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'cj-changed-'));
    roots.push(root);
    writeFileSync(join(root, '.codejanitor'), JSON.stringify({ cleanup }));
    state.workspaceFolders = [{ uri: Uri.file(root), name: 'root' }];

    return root;
  }

  it('sends no changed lines from a command that honors them while the setting is off', async () => {
    state.files.set('/w/a.cs', UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')], { honorOnlyChangedLines: true });

    expect(engine.requests('cleanup')[0]).not.toHaveProperty('changedLines');
  });

  it('sends no changed lines on save while the setting is off', async () => {
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    registerFormatOnSave(createContext());
    const document = new TextDocument(Uri.file('/w/a.cs'), UNCLEAN, 'csharp');
    const edits: Thenable<TextEdit[]>[] = [];

    state.willSaveHandlers[0]({ document, waitUntil: (pending) => edits.push(pending) });
    await Promise.all(edits);

    expect(engine.requests('cleanup')[0]).not.toHaveProperty('changedLines');
  });

  it('sends the changed lines when the nearest .codejanitor turns the setting on', async () => {
    const root = rootWithPolicy({ onlyChangedLines: true });
    state.files.set(join(root, 'a.cs'), UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file(join(root, 'a.cs'))], { honorOnlyChangedLines: true });

    expect(engine.requests('cleanup')[0].changedLines).toBeNull();
  });

  it('sends no changed lines when the nearest .codejanitor turns the setting off over the user setting', async () => {
    const root = rootWithPolicy({ onlyChangedLines: false });
    state.configuration.set('codeJanitor.cleanup.onlyChangedLines', true);
    state.files.set(join(root, 'a.cs'), UNCLEAN);

    await runCleanupOnUris(createContext(), [Uri.file(join(root, 'a.cs'))], { honorOnlyChangedLines: true });

    expect(engine.requests('cleanup')[0]).not.toHaveProperty('changedLines');
  });

  it('cleans another file type in full while the setting is off, and leaves it as it is while it is on', async () => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
    state.files.set('/w/notes.txt', 'text   \n');

    await runCleanupOnUris(createContext(), [Uri.file('/w/notes.txt')], { honorOnlyChangedLines: true });
    expect(state.files.get('/w/notes.txt')).toBe('text\n');

    state.files.set('/w/notes.txt', 'text   \n');
    state.configuration.set('codeJanitor.cleanup.onlyChangedLines', true);
    await runCleanupOnUris(createContext(), [Uri.file('/w/notes.txt')], { honorOnlyChangedLines: true });

    expect(state.files.get('/w/notes.txt')).toBe('text   \n');
  });
});

describe('closed files that are not UTF-8 text', () => {
  /** Makes `workspace.fs.readFile` return `bytes` for `filePath`, the in-memory text for every other file. */
  function readsBytes(filePath: string, bytes: Uint8Array): void {
    const readFile = workspace.fs.readFile.bind(workspace.fs);
    state.files.set(filePath, 'placeholder');
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((uri) => (uri.fsPath === filePath ? Promise.resolve(bytes) : readFile(uri)));
  }

  beforeEach(() => {
    state.configuration.set('codeJanitor.cleanup.includeOtherFileTypes', true);
  });

  it('leaves a binary file as it is and says why', async () => {
    readsBytes('/w/logo.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
    const write = vi.spyOn(workspace.fs, 'writeFile');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/logo.png')]);

    expect(write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: 0, failed: 0 });
    expect(output('/w/logo.png skipped: it contains NUL bytes, so it is not text')).toBe(true);
  });

  it('leaves a file that is not valid UTF-8 as it is and says why', async () => {
    readsBytes('/w/legacy.cs', Uint8Array.from([...new TextEncoder().encode('// caf'), 0xe9, ...new TextEncoder().encode('   \nclass C { }\n')]));
    const write = vi.spyOn(workspace.fs, 'writeFile');

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/legacy.cs')]);

    expect(write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: 0, failed: 0 });
    expect(output('/w/legacy.cs skipped: it is not valid UTF-8')).toBe(true);
    expect(engine.requests('cleanup')).toEqual([]);
  });

  it('still cleans UTF-8 text with accented letters and keeps its byte order mark', async () => {
    state.files.set('/w/notes.txt', '\uFEFFcaf\u00e9   \n');
    state.configuration.set('codeJanitor.cleanup.removeByteOrderMark', false);
    const write = vi.spyOn(workspace.fs, 'writeFile');

    await runCleanupOnUris(createContext(), [Uri.file('/w/notes.txt')]);

    expect(Buffer.from(write.mock.calls[0][1]).equals(Buffer.from('\uFEFFcaf\u00e9\n', 'utf8'))).toBe(true);
  });
});

describe('a closed file that changes while its cleanup runs', () => {
  it('is not overwritten from the stale read', async () => {
    state.files.set('/w/a.cs', UNCLEAN);
    useFakeEngine({
      cleanup: (params) => {
        state.files.set('/w/a.cs', 'internal class Edited { }\n');

        return cleanupResult(trimTrailingWhitespace(params.text));
      },
    });

    const result = await runCleanupOnUris(createContext(), [Uri.file('/w/a.cs')]);

    expect(result).toMatchObject({ changed: 0, failed: 1 });
    expect(state.files.get('/w/a.cs')).toBe('internal class Edited { }\n');
    expect(state.warningMessages.some((message) => message.includes('/w/a.cs') && message.includes('changed during cleanup'))).toBe(true);
  });
});

describe('cancelling a batch', () => {
  const [A, B, C_FILE] = ['/w/a.cs', '/w/b.cs', '/w/c.cs'];

  beforeEach(() => {
    [A, B, C_FILE].forEach((file) => state.files.set(file, UNCLEAN));
  });

  it('stops before the next file once the token is cancelled, and says so', async () => {
    const source = new CancellationTokenSource();
    useFakeEngine({
      cleanup: (params) => {
        source.cancel();

        return cleanupResult(trimTrailingWhitespace(params.text));
      },
    });

    const result = await runCleanupOnUris(
      createContext(),
      [A, B, C_FILE].map((file) => Uri.file(file)),
      { token: source.token as never }
    );

    expect(result).toMatchObject({ changed: 1, failed: 0, cancelled: true });
    expect(state.files.get(A)).toBe(CLEAN);
    expect(state.files.get(B)).toBe(UNCLEAN);
    expect(state.files.get(C_FILE)).toBe(UNCLEAN);
  });

  it('neither counts nor warns about the request that was cancelled in flight', async () => {
    const source = new CancellationTokenSource();
    useFakeEngine({
      cleanup: () => {
        source.cancel();
        throw new ResponseError(-32800, 'the request was cancelled');
      },
    });

    const result = await runCleanupOnUris(
      createContext(),
      [A, B].map((file) => Uri.file(file)),
      { token: source.token as never }
    );

    expect(result).toMatchObject({ changed: 0, failed: 0, cancelled: true });
    expect(state.warningMessages).toEqual([]);
    expect(state.files.get(A)).toBe(UNCLEAN);
  });

  it('is offered by the workspace cleanup, which reports the files it left alone', async () => {
    registerCleanupCommands(createContext());
    state.foundFiles = [Uri.file(A), Uri.file(B)];
    const source = new CancellationTokenSource();
    source.cancel();
    const progress = vi.spyOn(window, 'withProgress').mockImplementation((options, task) => task({ report: () => undefined }, source.token));

    await state.commands.get('codeJanitor.cleanupWorkspace')!();

    expect(progress.mock.calls[0][0]).toMatchObject({ cancellable: true });
    expect(engine.requests('cleanup')).toEqual([]);
    expect(state.informationMessages.some((message) => message.includes('cleanup complete') && message.includes('cancelled before finishing'))).toBe(true);
  });
});

describe('settings', () => {
  it('reads only settings the manifest declares', async () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> }[] };
    };
    const declared = new Set(manifest.contributes.configuration.flatMap((section) => Object.keys(section.properties)));
    state.configuration.set('codeJanitor.ai.xmlDoc.runDuringCleanup', true);
    state.configuration.set('codeJanitor.thirdParty.otherCleaningCommands', ['other.format']);
    state.configuration.set('codeJanitor.cleanup.runFormatDocument', true);
    state.modalChoice = 'Yes';
    const document = new TextDocument(Uri.file('/ext/a.cs'), UNCLEAN, 'csharp');
    state.documents.push(document);

    await runCleanupOnUris(createContext(), [document.uri]);
    registerFormatOnSave(createContext());
    state.configuration.set('codeJanitor.cleanup.onSave', true);
    const saved: Thenable<TextEdit[]>[] = [];
    state.willSaveHandlers[0]({ document, waitUntil: (edits) => saved.push(edits) });
    await Promise.all(saved);

    const undeclared = [...new Set(state.configurationReads)].filter((key) => key.startsWith('codeJanitor.') && !declared.has(key));
    expect(undeclared).toEqual([]);
  });
});
