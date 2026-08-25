import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Position,
  Selection,
  TextDocument,
  TextEditor,
  Uri,
  createContext,
  lm,
  resetMock,
  state,
  window,
} from './helpers/vscodeMock';

const getAiChatCompletion = vi.fn<(...args: unknown[]) => Promise<string>>();
const testAiConnection = vi.fn<(...args: unknown[]) => Promise<{ succeeded: boolean; message: string }>>();
const storeCustomApiKey = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('../src/ai/aiService', () => ({
  getAiChatCompletion: (...args: unknown[]) => getAiChatCompletion(...args),
  testAiConnection: (...args: unknown[]) => testAiConnection(...args),
  storeCustomApiKey: (...args: unknown[]) => storeCustomApiKey(...args),
}));

const { registerAiActionCommands } = await import('../src/commands/aiActionCommands');
const { registerAiUtilityCommands } = await import('../src/commands/aiUtilityCommands');
const { registerGenerateXmlDocCommand } = await import('../src/commands/generateXmlDoc');
const { registerCleanupCommands } = await import('../src/commands/cleanupCommands');

const SOURCE = 'internal class Sample\n{\n    public int Add(int x, int y)\n    {\n        return x + y;\n    }\n}\n';

beforeEach(() => {
  resetMock();
  getAiChatCompletion.mockReset();
  testAiConnection.mockReset();
  storeCustomApiKey.mockReset();
});

function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.commands.get(command);
  if (!handler) {
    throw new Error(`Command not registered: ${command}`);
  }

  return Promise.resolve(handler(...args));
}

function openCSharp(content = SOURCE): TextDocument {
  const document = new TextDocument(Uri.file('/w/Sample.cs'), content, 'csharp');
  state.documents.push(document);
  window.activeTextEditor = new TextEditor(document);

  return document;
}

describe('generateXmlDoc', () => {
  it('requires a C# document', async () => {
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(state.informationMessages).toContain('Code Janitor: open a C# file to generate XML documentation.');
  });

  it('reports when nothing needs documenting', async () => {
    openCSharp('/// <summary>Documented.</summary>\ninternal class Sample\n{\n}\n');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(state.informationMessages).toContain('Code Janitor: no undocumented members found in this file.');
    expect(getAiChatCompletion).not.toHaveBeenCalled();
  });

  it('inserts the summaries the model returns', async () => {
    const document = openCSharp();
    getAiChatCompletion.mockResolvedValue('Adds two numbers.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).toContain('/// Adds two numbers.');
    expect(document.getText()).toContain('<param name="x">');
    expect(state.informationMessages.some((message) => message.includes('documented 2 member(s)'))).toBe(true);
  });

  it('makes one request per member that needs AI', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('Does something.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(getAiChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('abandons the edit when the document changed while requests were in flight', async () => {
    const document = openCSharp();
    getAiChatCompletion.mockImplementation(async () => {
      document.setText(`${SOURCE}\n// edited by the user\n`);

      return 'Adds two numbers.';
    });

    registerGenerateXmlDocCommand(createContext());
    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).not.toContain('/// Adds two numbers.');
    expect(state.warningMessages).toContain(
      'Code Janitor: the file changed while documentation was being generated - nothing was inserted.'
    );
  });

  it('falls back to a deterministic summary when the model returns nothing', async () => {
    const document = openCSharp();
    getAiChatCompletion.mockResolvedValue('   ');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).toContain('/// <summary>');
  });

  it('does not apply the preview when the user declines', async () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.previewChanges', true);
    state.modalChoice = undefined;
    const document = openCSharp();
    getAiChatCompletion.mockResolvedValue('Adds two numbers.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).toBe(SOURCE);
    expect(state.openedDocuments).toHaveLength(1);
  });

  it('applies the preview when the user confirms', async () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.previewChanges', true);
    state.modalChoice = 'Apply';
    const document = openCSharp();
    getAiChatCompletion.mockResolvedValue('Adds two numbers.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).toContain('/// Adds two numbers.');
  });

  it('leaves the document untouched when every request fails and fallback is off', async () => {
    const document = openCSharp();
    getAiChatCompletion.mockRejectedValue(new Error('endpoint unreachable'));
    state.configuration.set('codeJanitor.ai.xmlDoc.allowDeterministicFallback', false);
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).toBe(SOURCE);
    expect(state.informationMessages).toContain('Code Janitor: no documentation was generated.');
  });

  it('still documents members after a failed request when fallback is on', async () => {
    const document = openCSharp();
    getAiChatCompletion.mockRejectedValue(new Error('endpoint unreachable'));
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(document.getText()).toContain('/// <summary>');
  });
});

describe('generateXmlDoc batch commands', () => {
  it('reports when no files are selected', async () => {
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocSelectedFiles');

    expect(state.informationMessages).toContain('Code Janitor: no files selected.');
  });

  it('reports when there are no C# files in the workspace', async () => {
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocWorkspace');

    expect(state.informationMessages).toContain('Code Janitor: no C# files found in the workspace.');
  });

  it('reports when no undocumented members exist across the selection, without calling AI', async () => {
    state.files.set('/w/a.cs', '/// <summary>Documented.</summary>\ninternal class Sample\n{\n}\n');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.informationMessages).toContain('Code Janitor: no undocumented members found.');
    expect(getAiChatCompletion).not.toHaveBeenCalled();
  });

  it('asks for confirmation before sending any AI request, and sends nothing if declined', async () => {
    state.files.set('/w/a.cs', SOURCE);
    state.modalChoice = undefined;
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.warningMessages.some((message) => message.includes('AI request'))).toBe(true);
    expect(getAiChatCompletion).not.toHaveBeenCalled();
    expect(state.files.get('/w/a.cs')).toBe(SOURCE);
  });

  it('documents every selected file once the user continues', async () => {
    state.files.set('/w/a.cs', SOURCE);
    state.files.set('/w/b.cs', SOURCE);
    state.modalChoice = 'Continue';
    getAiChatCompletion.mockResolvedValue('Adds two numbers.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs'), Uri.file('/w/b.cs')]);

    expect(state.files.get('/w/a.cs')).toContain('/// Adds two numbers.');
    expect(state.files.get('/w/b.cs')).toContain('/// Adds two numbers.');
    expect(state.informationMessages.some((message) => message.includes('2 file(s) documented'))).toBe(true);
  });

  it('documents every C# file in the workspace', async () => {
    state.foundFiles = [Uri.file('/w/a.cs')];
    state.files.set('/w/a.cs', SOURCE);
    state.modalChoice = 'Continue';
    getAiChatCompletion.mockResolvedValue('Adds two numbers.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocWorkspace');

    expect(state.files.get('/w/a.cs')).toContain('/// Adds two numbers.');
  });

  it('never asks for confirmation when nothing needs an AI request (deterministic-only members)', async () => {
    state.files.set(
      '/w/a.cs',
      '/// <summary>Documented.</summary>\ninternal class Sample\n{\n    public int Value;\n}\n'
    );
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDocSelectedFiles', Uri.file('/w/a.cs'), [Uri.file('/w/a.cs')]);

    expect(state.warningMessages).toEqual([]);
    expect(state.files.get('/w/a.cs')).toContain('/// <summary>');
    expect(state.files.get('/w/a.cs')).toContain('Value');
  });
});

describe('AI editor actions', () => {
  it('opens the explanation in a markdown document', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('This class adds numbers.');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiExplain');

    expect(state.openedDocuments).toEqual([{ content: 'This class adds numbers.', language: 'markdown' }]);
  });

  it('opens the review in a markdown document', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('Looks fine.');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiCodeReview');

    expect(state.openedDocuments).toEqual([{ content: 'Looks fine.', language: 'markdown' }]);
  });

  it('warns about an empty model response', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('   ');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiExplain');

    expect(state.warningMessages.join(' ')).toContain('empty response');
    expect(state.openedDocuments).toHaveLength(0);
  });

  it('requires a C# document', async () => {
    window.activeTextEditor = new TextEditor(new TextDocument(Uri.file('/w/a.md'), 'text', 'markdown'));
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiExplain');

    expect(state.informationMessages).toContain('Code Janitor: open a C# file first.');
    expect(getAiChatCompletion).not.toHaveBeenCalled();
  });

  it('applies a refactoring the user confirms', async () => {
    const document = openCSharp();
    window.activeTextEditor = new TextEditor(document, new Selection(new Position(0, 0), new Position(1, 1)));
    state.modalChoice = 'Apply';
    getAiChatCompletion.mockResolvedValue('Here you go:\n```csharp\ninternal sealed class Sample\n```\n');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiRefactor');

    expect(document.getText()).toContain('internal sealed class Sample');
  });

  it('Clean and Refactor (Cleanup + AI) cleans up first, then offers the AI refactor', async () => {
    const document = openCSharp(
      'internal class Sample   \n{\n    public int Add(int x, int y)\n    {\n        return x + y;\n    }\n}\n'
    );
    window.activeTextEditor = new TextEditor(document, new Selection(new Position(0, 0), new Position(0, 1)));
    state.modalChoice = 'Apply';
    getAiChatCompletion.mockResolvedValue('```csharp\ninternal sealed class Sample\n```');
    registerCleanupCommands(createContext());
    registerAiActionCommands(createContext());

    await run('codeJanitor.cleanAndRefactor');

    expect(document.getText()).not.toContain('   \n');
    expect(document.getText()).toContain('internal sealed class Sample');
  });

  it('leaves the document alone when the refactoring is declined', async () => {
    const document = openCSharp();
    window.activeTextEditor = new TextEditor(document, new Selection(new Position(0, 0), new Position(1, 1)));
    state.modalChoice = undefined;
    getAiChatCompletion.mockResolvedValue('```csharp\ninternal sealed class Sample\n```');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiRefactor');

    expect(document.getText()).toBe(SOURCE);
  });

  it('opens generated unit tests in a C# document', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('```csharp\npublic class SampleTests { }\n```');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiGenerateUnitTests');

    expect(state.openedDocuments[0].language).toBe('csharp');
    expect(state.openedDocuments[0].content).toContain('SampleTests');
  });
});

describe('AI utility commands', () => {
  it('reports a successful connection test', async () => {
    testAiConnection.mockResolvedValue({ succeeded: true, message: 'Connected to gpt-4o.' });
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.testAiConnection');

    expect(state.informationMessages).toContain('Code Janitor: Connected to gpt-4o.');
  });

  it('reports a failed connection test as an error', async () => {
    testAiConnection.mockResolvedValue({ succeeded: false, message: 'No model available.' });
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.testAiConnection');

    expect(state.errorMessages).toContain('Code Janitor: No model available.');
  });

  it('stores the API key the user enters', async () => {
    state.inputBoxResult = 'secret-value';
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.setAiApiKey');

    expect(storeCustomApiKey).toHaveBeenCalledWith(expect.anything(), 'secret-value');
    expect(state.informationMessages).toContain('Code Janitor: API key stored securely.');
  });

  it('clears the stored key when the input is left empty', async () => {
    state.inputBoxResult = '';
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.setAiApiKey');

    expect(storeCustomApiKey).toHaveBeenCalledWith(expect.anything(), '');
    expect(state.informationMessages).toContain('Code Janitor: API key cleared.');
  });

  it('does nothing when the key prompt is cancelled', async () => {
    state.inputBoxResult = undefined;
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.setAiApiKey');

    expect(storeCustomApiKey).not.toHaveBeenCalled();
  });
});

describe('GitHub Copilot model selection', () => {
  const models = [
    { id: 'gpt-4o-2024', family: 'gpt-4o', vendor: 'copilot', name: 'GPT-4o', maxInputTokens: 128000 },
    { id: 'claude-sonnet', family: 'claude-3.5-sonnet', vendor: 'copilot', name: 'Claude 3.5', maxInputTokens: 200000 },
  ];

  it('warns when Copilot exposes no model', async () => {
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.selectCopilotModel');

    expect(state.warningMessages.join(' ')).toContain('no GitHub Copilot model is available');
    expect(state.configurationUpdates).toEqual([]);
  });

  it('offers exactly the models Copilot currently exposes, sorted, plus an automatic choice', async () => {
    state.copilotModels = models;
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.selectCopilotModel');

    // Alphabetical, not API order, and never more or fewer entries than the API actually returned.
    expect(state.quickPickItems.map((item) => item.label)).toEqual(['Automatic', 'claude-3.5-sonnet', 'gpt-4o']);
  });

  it('shows only Automatic when Copilot exposes a single model', async () => {
    state.copilotModels = [models[0]];
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.selectCopilotModel');

    expect(state.quickPickItems.map((item) => item.label)).toEqual(['Automatic', 'gpt-4o']);
  });

  it('never falls back to a built-in model list when the API throws', async () => {
    const { listCopilotModels } = await import('../src/ai/copilotClient');
    const spy = vi.spyOn(lm, 'selectChatModels').mockRejectedValueOnce(new Error('not entitled'));

    expect(await listCopilotModels()).toEqual([]);

    spy.mockRestore();
  });

  it('stores the picked model and switches the provider to Copilot', async () => {
    state.copilotModels = models;
    state.quickPickChoice = 'claude-3.5-sonnet';
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.selectCopilotModel');

    expect(state.configuration.get('codeJanitor.ai.copilotModel')).toBe('claude-3.5-sonnet');
    expect(state.configuration.get('codeJanitor.ai.provider')).toBe('copilot');
  });

  it('clears the preference when the automatic choice is picked', async () => {
    state.copilotModels = models;
    state.configuration.set('codeJanitor.ai.copilotModel', 'gpt-4o');
    state.quickPickChoice = 'Automatic';
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.selectCopilotModel');

    expect(state.configuration.get('codeJanitor.ai.copilotModel')).toBe('');
  });

  it('changes nothing when the picker is dismissed', async () => {
    state.copilotModels = models;
    state.quickPickChoice = undefined;
    registerAiUtilityCommands(createContext());

    await run('codeJanitor.selectCopilotModel');

    expect(state.configurationUpdates).toEqual([]);
  });
});

describe('AI token budgets', () => {
  it('keeps XML documentation summaries short', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('Adds two numbers.');
    registerGenerateXmlDocCommand(createContext());

    await run('codeJanitor.generateXmlDoc');

    expect(getAiChatCompletion).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), 256);
  });

  it('gives the explain action room for a full answer', async () => {
    openCSharp();
    getAiChatCompletion.mockResolvedValue('Explanation.');
    registerAiActionCommands(createContext());

    await run('codeJanitor.aiExplain');

    expect(getAiChatCompletion).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), 2048);
  });
});
