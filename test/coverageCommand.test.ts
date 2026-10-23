import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationTarget,
  Position,
  Selection,
  TextDocument,
  TextEditor,
  Uri,
  createContext,
  resetMock,
  state,
  viewState,
  window,
} from './helpers/vscodeMock';
import { useFakeEngine } from './helpers/fakeEngine';
import type { FakeEngine } from './helpers/fakeEngine';
import { registerAiActionCommands } from '../src/commands/aiActionCommands';
import type { BranchesResult } from '../src/ai/coverage/coverageTarget';

const { getAiChatCompletion } = vi.hoisted(() => ({ getAiChatCompletion: vi.fn<(...args: unknown[]) => Promise<string>>() }));

vi.mock('../src/ai/aiService', () => ({
  getAiChatCompletion: (...args: unknown[]) => getAiChatCompletion(...args),
  testAiConnection: vi.fn(),
  storeCustomApiKey: vi.fn(),
}));

const SOURCE =
  'class Sample\n{\n    public int Check(object x)\n    {\n        if (x == null) throw new System.ArgumentNullException();\n        return 1;\n    }\n}\n';
const COMMAND = 'codeJanitor.aiGenerateTestsToTargetCoverage';
const TESTS = 'public class CheckTests\n{\n    [Fact]\n    public void Check_WhenNull_Throws() { }\n}';

const ANALYSIS: BranchesResult = {
  target: { name: 'Check', kind: 'method', startLine: 2, endLine: 6, text: 'public int Check(object x)\n    { ... }' },
  branches: [
    { id: 'B1', type: 'guardClause', description: 'Guard Clause: If (x == null) early exit/throw', condition: 'x == null', line: 4 },
    {
      id: 'B2',
      type: 'throwException',
      description: 'Explicit error path: new System.ArgumentNullException()',
      condition: 'new System.ArgumentNullException()',
      line: 4,
    },
  ],
  coverage: null,
};

let engine: FakeEngine;
let evaluations: number[];

function run(): Promise<unknown> {
  return Promise.resolve(state.commands.get(COMMAND)!());
}

beforeEach(() => {
  resetMock();
  getAiChatCompletion.mockReset();
  getAiChatCompletion.mockResolvedValue(`\`\`\`csharp\n${TESTS}\n\`\`\``);
  evaluations = [100];
  engine = useFakeEngine({
    query: (params) => {
      const args = params.arguments;
      const testCode = typeof args === 'object' && args !== null && 'testCode' in args ? args.testCode : undefined;
      if (testCode === undefined) {
        return ANALYSIS;
      }

      const percentage = evaluations.shift() ?? 0;

      return {
        ...ANALYSIS,
        coverage: {
          totalBranches: 2,
          coveredBranches: percentage / 50,
          percentage,
          covered: percentage === 100 ? ['B1', 'B2'] : ['B1'],
          uncovered: percentage === 100 ? [] : ['B2'],
          scenarios: [],
        },
      };
    },
  });
  const document = new TextDocument(Uri.file('/w/Sample.cs'), SOURCE, 'csharp');
  window.activeTextEditor = new TextEditor(document, new Selection(new Position(4, 10), new Position(4, 10)));
  state.quickPickChoice = 'Start';
  registerAiActionCommands(createContext() as never);
});

describe('Generate Tests to Target Coverage (AI)', () => {
  it('generates tests until the estimated coverage reaches the target, then shows the report and the tests', async () => {
    await run();

    const queries = engine.requests('query');
    expect(queries[0]).toMatchObject({ filePath: '/w/Sample.cs', text: SOURCE, query: 'branches', arguments: { line: 4, character: 10 } });
    expect(queries[1]).toMatchObject({ query: 'branches', arguments: { line: 4, character: 10, testCode: TESTS } });
    expect(getAiChatCompletion).toHaveBeenCalledTimes(1);
    expect(getAiChatCompletion.mock.calls[0][2]).toContain("for the following C# code ('Check')");
    expect(state.quickPickItems.map((item) => item.label)).toEqual(['Start', 'Target coverage', 'Max iterations', 'Test framework', 'Mocking library']);
    expect(state.openedDocuments).toEqual([
      { language: 'markdown', content: expect.stringContaining('- **Achieved Coverage:** 100%') },
      { language: 'csharp', content: TESTS },
    ]);
    expect(viewState.progressReports).toContainEqual(
      expect.objectContaining({ message: 'Iteration 1/3 complete. Current estimated coverage: 100% (Target: 90%)' })
    );
    expect(state.configurationUpdates).toEqual([]);
  });

  it('changes the options in the prompt, saving them as the Visual Studio dialog does', async () => {
    evaluations = [50, 50, 50];
    viewState.quickPickChoices = ['Target coverage', 'Max iterations', 'Test framework', 'Start'];
    viewState.inputBoxResults = ['95', '2', 'NUnit'];

    await run();

    expect(state.configurationUpdates).toEqual([
      { key: 'codeJanitor.ai.tests.targetCoveragePercentage', value: 95, target: ConfigurationTarget.Global },
      { key: 'codeJanitor.ai.tests.maxCoverageIterations', value: 2, target: ConfigurationTarget.Global },
      { key: 'codeJanitor.ai.tests.framework', value: 'NUnit', target: ConfigurationTarget.Global },
    ]);
    expect(getAiChatCompletion).toHaveBeenCalledTimes(2);
    expect(getAiChatCompletion.mock.calls[0][1]).toContain('using NUnit and Moq');
    expect(state.openedDocuments[0].content).toContain('- **Status:** Max Iterations Reached');
  });

  it('does nothing when the options prompt is dismissed', async () => {
    state.quickPickChoice = undefined;

    await run();

    expect(getAiChatCompletion).not.toHaveBeenCalled();
    expect(state.openedDocuments).toEqual([]);
  });

  it('shows the error of a failed iteration', async () => {
    getAiChatCompletion.mockRejectedValue(new Error('No GitHub Copilot model is available.'));

    await run();

    expect(state.errorMessages).toEqual(['Code Janitor: Error during iteration 1: No GitHub Copilot model is available.']);
    expect(state.openedDocuments).toEqual([]);
  });

  it('asks for a C# editor', async () => {
    window.activeTextEditor = undefined;

    await run();

    expect(state.informationMessages).toEqual(['Code Janitor: open a C# file first.']);
    expect(engine.requests('query')).toEqual([]);
  });
});
