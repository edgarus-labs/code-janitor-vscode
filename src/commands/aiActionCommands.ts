import * as vscode from 'vscode';
import {
  EXPLAIN_SYSTEM_PROMPT,
  REFACTOR_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  buildExplainPrompt,
  buildRefactorPrompt,
  buildReviewPrompt,
  buildTestsPrompt,
  extractCodeSnippet,
  testsSystemPrompt,
} from '../ai/aiActions';
import { getAiChatCompletion } from '../ai/aiService';
import { findEnclosingMember } from '../cleanup/memberAtPosition';
import { logError } from '../logging';

interface Target {
  name: string;
  code: string;
  range: vscode.Range;
}

/** Explain, review, refactor and unit-test generation, ported from the AI commands of the original. */
export function registerAiActionCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.aiExplain', () =>
      runMarkdownAction(context, 'Explaining code...', EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt)
    ),
    vscode.commands.registerCommand('codeJanitor.aiCodeReview', () =>
      runMarkdownAction(context, 'Reviewing code...', REVIEW_SYSTEM_PROMPT, buildReviewPrompt)
    ),
    vscode.commands.registerCommand('codeJanitor.aiRefactor', () => runRefactor(context)),
    vscode.commands.registerCommand('codeJanitor.cleanAndRefactor', async () => {
      // Deterministic cleanup never needs confirmation; the AI refactor step still shows its own
      // diff preview and asks before touching anything, exactly like running it on its own.
      await vscode.commands.executeCommand('codeJanitor.cleanupActiveFile');
      await runRefactor(context);
    }),
    vscode.commands.registerCommand('codeJanitor.aiGenerateUnitTests', () => runGenerateTests(context))
  );
}

async function runMarkdownAction(
  context: vscode.ExtensionContext,
  title: string,
  systemPrompt: string,
  buildPrompt: (name: string, code: string) => string
): Promise<void> {
  const target = resolveTarget();
  if (!target) {
    return;
  }

  const response = await requestCompletion(context, title, systemPrompt, buildPrompt(target.name, target.code));
  if (response === undefined) {
    return;
  }

  const document = await vscode.workspace.openTextDocument({ content: response, language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function runRefactor(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const target = resolveTarget();
  if (!editor || !target) {
    return;
  }

  const response = await requestCompletion(
    context,
    'Refactoring code...',
    REFACTOR_SYSTEM_PROMPT,
    buildRefactorPrompt(target.name, target.code)
  );

  if (response === undefined) {
    return;
  }

  const refactored = extractCodeSnippet(response);
  if (!refactored) {
    void vscode.window.showWarningMessage('Code Janitor: the AI response contained no code to apply.');

    return;
  }

  const summary = await vscode.workspace.openTextDocument({ content: response, language: 'markdown' });
  await vscode.window.showTextDocument(summary, { preview: true, viewColumn: vscode.ViewColumn.Beside });

  const choice = await vscode.window.showInformationMessage(
    `Code Janitor: replace '${target.name}' with the refactored version?`,
    { modal: true },
    'Apply'
  );

  if (choice === 'Apply') {
    await editor.edit((builder) => builder.replace(target.range, refactored));
  }
}

async function runGenerateTests(context: vscode.ExtensionContext): Promise<void> {
  const target = resolveTarget();
  if (!target) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const framework = cfg.get<string>('ai.tests.framework', 'xUnit');
  const mocking = cfg.get<string>('ai.tests.mockingLibrary', 'Moq');

  const response = await requestCompletion(
    context,
    'Generating unit tests...',
    testsSystemPrompt(framework, mocking),
    buildTestsPrompt(target.name, target.code, framework, mocking)
  );

  if (response === undefined) {
    return;
  }

  const tests = extractCodeSnippet(response);
  const document = await vscode.workspace.openTextDocument({ content: tests, language: 'csharp' });
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

/** The selection when there is one, otherwise the member under the caret, otherwise the file. */
function resolveTarget(): Target | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file first.');

    return undefined;
  }

  const document = editor.document;

  if (!editor.selection.isEmpty) {
    return {
      name: 'selection',
      code: document.getText(editor.selection),
      range: new vscode.Range(editor.selection.start, editor.selection.end),
    };
  }

  const member = findEnclosingMember(document.getText(), document.offsetAt(editor.selection.active));
  if (member) {
    const start = document.getText().indexOf(member.text);

    return {
      name: member.name,
      code: member.text,
      range: new vscode.Range(document.positionAt(start), document.positionAt(start + member.text.length)),
    };
  }

  const content = document.getText();

  return {
    name: document.fileName.split(/[\\/]/).pop() ?? 'file',
    code: content,
    range: new vscode.Range(document.positionAt(0), document.positionAt(content.length)),
  };
}

async function requestCompletion(
  context: vscode.ExtensionContext,
  title: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string | undefined> {
  try {
    const maxTokens = vscode.workspace.getConfiguration('codeJanitor').get<number>('ai.maxTokensPerRequest', 2048);

    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Code Janitor: ${title}`, cancellable: false },
      () => getAiChatCompletion(context, systemPrompt, userPrompt, maxTokens)
    );

    if (!response.trim()) {
      void vscode.window.showWarningMessage(
        'Code Janitor: the AI model returned an empty response. Please check your model settings.'
      );

      return undefined;
    }

    return response.trim();
  } catch (err) {
    logError(title, err);
    void vscode.window.showErrorMessage(`Code Janitor: ${(err as Error).message}`);

    return undefined;
  }
}
