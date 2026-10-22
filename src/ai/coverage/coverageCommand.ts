import * as vscode from 'vscode';
import { documentParams, engine, reportEngineUnavailable } from '../../engine/vscodeEngine';
import { logError } from '../../logging';
import { getAiChatCompletion } from '../aiService';
import { BranchesResult, CoverageCancelledError, CoverageOptions, generateTestsToTargetCoverage, normalizeCoverageOptions } from './coverageTarget';

/** The settings behind each option of the prompt, as the Visual Studio options dialog saves them. */
const OPTION_SETTINGS: Readonly<Record<keyof CoverageOptions, string>> = {
  targetCoveragePercentage: 'ai.tests.targetCoveragePercentage',
  maxIterations: 'ai.tests.maxCoverageIterations',
  testFramework: 'ai.tests.framework',
  mockingLibrary: 'ai.tests.mockingLibrary',
};

/**
 * Generate Tests to Target Coverage (AI), the Visual Studio `AiTargetCoverageCommand`: the member at the cursor (or the
 * file), the options prompt, the generation with progress and cancel, then the coverage report and the tests.
 */
export async function runGenerateTestsToTargetCoverage(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file first.');

    return;
  }

  const document = editor.document;
  const { line, character } = editor.selection.active;
  const params = documentParams(document.uri, document.getText());
  let analysis: BranchesResult;
  try {
    analysis = await engine().query<BranchesResult>({ ...params, query: 'branches', arguments: { line, character } });
  } catch (err) {
    if (!reportEngineUnavailable(err)) {
      logError(`Finding the branches of ${document.uri.fsPath}`, err);
      void vscode.window.showErrorMessage(`Code Janitor: ${err instanceof Error ? err.message : String(err)}`);
    }

    return;
  }

  const target = analysis.target;
  if (!target || !target.text.trim()) {
    void vscode.window.showInformationMessage('Code Janitor: could not find code to generate tests for.');

    return;
  }

  const options = await promptOptions(target.name);
  if (!options) {
    return;
  }

  const maxTokens = vscode.workspace.getConfiguration('codeJanitor').get<number>('ai.maxTokensPerRequest', 2048);
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Code Janitor: tests for '${target.name}'`, cancellable: true },
      (progress, token) =>
        generateTestsToTargetCoverage({
          targetName: target.name,
          code: target.text,
          branches: analysis.branches,
          options,
          complete: (systemPrompt, userPrompt) => getAiChatCompletion(context, systemPrompt, userPrompt, maxTokens),
          evaluate: async (testCode) => {
            const evaluated = await engine().query<BranchesResult>({ ...params, query: 'branches', arguments: { line, character, testCode } });
            if (!evaluated.coverage) {
              throw new Error('The C# engine did not evaluate the generated tests.');
            }

            return evaluated.coverage;
          },
          progress: (report) => progress.report({ message: report.message }),
          isCancelled: () => token.isCancellationRequested,
        })
    );

    const report = await vscode.workspace.openTextDocument({ content: result.report, language: 'markdown' });
    await vscode.window.showTextDocument(report, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const tests = await vscode.workspace.openTextDocument({ content: result.testCode, language: 'csharp' });
    await vscode.window.showTextDocument(tests, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  } catch (err) {
    if (err instanceof CoverageCancelledError) {
      return;
    }

    if (!reportEngineUnavailable(err)) {
      logError('Generate Tests to Target Coverage', err);
      void vscode.window.showErrorMessage(`Code Janitor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface OptionItem extends vscode.QuickPickItem {
  readonly key: keyof CoverageOptions | 'start';
}

/**
 * The Visual Studio options dialog as a quick pick: the options prefilled from the settings, each one editable, then
 * Start; the changed options are saved to the settings. Undefined when dismissed.
 */
async function promptOptions(targetName: string): Promise<CoverageOptions | undefined> {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const initial = normalizeCoverageOptions({
    targetCoveragePercentage: cfg.get<number>(OPTION_SETTINGS.targetCoveragePercentage, 90),
    maxIterations: cfg.get<number>(OPTION_SETTINGS.maxIterations, 3),
    testFramework: cfg.get<string>(OPTION_SETTINGS.testFramework, 'xUnit'),
    mockingLibrary: cfg.get<string>(OPTION_SETTINGS.mockingLibrary, 'Moq'),
  });
  let options = initial;
  const title = `Generate Tests to Target Coverage: ${targetName}`;

  for (;;) {
    const items: OptionItem[] = [
      { key: 'start', label: 'Start', description: 'Generate the tests with these options' },
      { key: 'targetCoveragePercentage', label: 'Target coverage', description: `${options.targetCoveragePercentage}%` },
      { key: 'maxIterations', label: 'Max iterations', description: String(options.maxIterations) },
      { key: 'testFramework', label: 'Test framework', description: options.testFramework },
      { key: 'mockingLibrary', label: 'Mocking library', description: options.mockingLibrary },
    ];
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Change an option, or Start' });
    if (!picked) {
      return undefined;
    }

    if (picked.key === 'start') {
      break;
    }

    const key = picked.key;
    const numeric = key === 'targetCoveragePercentage' || key === 'maxIterations';
    const value = await vscode.window.showInputBox({
      title,
      prompt: key === 'targetCoveragePercentage' ? 'Target branch coverage, 10 to 100 (%).' : key === 'maxIterations' ? 'Generation rounds, 1 to 10.' : `${picked.label}.`,
      value: String(options[key]),
      validateInput: (input) => (numeric && !/^\s*\d+\s*$/.test(input) ? 'Enter a whole number.' : undefined),
    });
    if (value !== undefined) {
      options = normalizeCoverageOptions({ ...options, [key]: numeric ? Number(value) : value });
    }
  }

  for (const key of Object.keys(OPTION_SETTINGS) as (keyof CoverageOptions)[]) {
    if (options[key] !== initial[key]) {
      await cfg.update(OPTION_SETTINGS[key], options[key], vscode.ConfigurationTarget.Global);
    }
  }

  return options;
}
