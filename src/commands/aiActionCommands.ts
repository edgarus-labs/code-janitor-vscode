import * as vscode from 'vscode';
import {
  COVERAGE_REPORT_SYSTEM_PROMPT,
  EXPLAIN_SYSTEM_PROMPT,
  REFACTOR_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  buildCoverageGapTestsPrompt,
  buildCoverageReportPrompt,
  buildExplainPrompt,
  buildRefactorPrompt,
  buildReviewPrompt,
  buildTestsPrompt,
  extractCodeSnippet,
  testsSystemPrompt,
} from '../ai/aiActions';
import { getAiChatCompletion } from '../ai/aiService';
import { runGenerateTestsToTargetCoverage } from '../ai/coverage/coverageCommand';
import { MemberAtPosition } from '../engine/protocol';
import { documentParams, engine, reportEngineUnavailable } from '../engine/vscodeEngine';
import { logError } from '../logging';

interface Target {
  name: string;
  code: string;
  range: vscode.Range;
}

const COVERAGE_GLOB = '**/{coverage.cobertura.xml,coverage.opencover.xml,lcov.info,*.coveragexml,*.coverage.xml}';
const COVERAGE_EXCLUDE = '**/{bin,obj,node_modules,.git,.vs}/**';
const MAX_COVERAGE_INPUT_CHARS = 120_000;

/** Explain, review, refactor and unit-test generation, ported from the AI commands of the original. */
export function registerAiActionCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.aiExplain', () => runMarkdownAction(context, 'Explaining code...', EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt)),
    vscode.commands.registerCommand('codeJanitor.aiCodeReview', () => runMarkdownAction(context, 'Reviewing code...', REVIEW_SYSTEM_PROMPT, buildReviewPrompt)),
    vscode.commands.registerCommand('codeJanitor.aiRefactor', () => runRefactor(context)),
    vscode.commands.registerCommand('codeJanitor.cleanAndRefactor', async () => {
      // Deterministic cleanup never needs confirmation; the AI refactor step still shows its own
      // diff preview and asks before touching anything, exactly like running it on its own.
      await vscode.commands.executeCommand('codeJanitor.cleanupActiveFile');
      await runRefactor(context);
    }),
    vscode.commands.registerCommand('codeJanitor.aiGenerateUnitTests', () => runGenerateTests(context)),
    vscode.commands.registerCommand('codeJanitor.aiCoverageReport', () => runCoverageReport(context)),
    vscode.commands.registerCommand('codeJanitor.aiGenerateTestsFromCoverageGaps', () => runGenerateTestsFromCoverageGaps(context)),
    vscode.commands.registerCommand('codeJanitor.aiGenerateTestsToTargetCoverage', () => runGenerateTestsToTargetCoverage(context))
  );
}

async function runMarkdownAction(
  context: vscode.ExtensionContext,
  title: string,
  systemPrompt: string,
  buildPrompt: (name: string, code: string) => string
): Promise<void> {
  const target = await resolveTarget();
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

async function runGenerateTestsFromCoverageGaps(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage('Code Janitor: open a workspace with a coverage report first.');

    return;
  }

  const coverageFile = await pickCoverageFile();
  if (!coverageFile) {
    return;
  }

  const coverageText = await readCoverageFile(coverageFile);
  if (!coverageText.trim()) {
    void vscode.window.showWarningMessage('Code Janitor: the selected coverage report is empty.');

    return;
  }

  const sourceFile = await pickSourceFileFromCoverage(coverageText);
  if (!sourceFile) {
    return;
  }

  const sourceText = await readCoverageFile(sourceFile);
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const framework = cfg.get<string>('ai.tests.framework', 'xUnit');
  const mocking = cfg.get<string>('ai.tests.mockingLibrary', 'Moq');
  const coverageFileName = coverageFile.fsPath.split(/[\\/]/).pop() ?? 'coverage report';
  const sourceName = sourceFile.fsPath.split(/[\\/]/).pop() ?? 'source file';

  const response = await requestCompletion(
    context,
    'Generating tests from coverage gaps...',
    testsSystemPrompt(framework, mocking),
    buildCoverageGapTestsPrompt(sourceName, sourceText, coverageFileName, trimCoverageInput(coverageText), framework, mocking)
  );

  if (response === undefined) {
    return;
  }

  const tests = extractCodeSnippet(response);
  const document = await vscode.workspace.openTextDocument({ content: tests, language: 'csharp' });
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

async function runRefactor(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const versionBeforeTarget = editor?.document.version;
  const target = await resolveTarget();
  if (!editor || !target) {
    return;
  }

  const response = await requestCompletion(context, 'Refactoring code...', REFACTOR_SYSTEM_PROMPT, buildRefactorPrompt(target.name, target.code));

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

  const choice = await vscode.window.showInformationMessage(`Code Janitor: replace '${target.name}' with the refactored version?`, { modal: true }, 'Apply');

  if (choice !== 'Apply') {
    return;
  }

  if (editor.document.isClosed || editor.document.version !== versionBeforeTarget) {
    void vscode.window.showWarningMessage('Code Janitor: the document changed while the refactoring was being prepared - nothing was replaced.');

    return;
  }

  if (!(await editor.edit((builder) => builder.replace(target.range, refactored)))) {
    void vscode.window.showWarningMessage('Code Janitor: VS Code did not apply the refactoring.');
  }
}

async function runGenerateTests(context: vscode.ExtensionContext): Promise<void> {
  const target = await resolveTarget();
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

async function runCoverageReport(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage('Code Janitor: open a workspace with a coverage report first.');

    return;
  }

  const coverageFile = await pickCoverageFile();
  if (!coverageFile) {
    return;
  }

  const coverageText = await readCoverageFile(coverageFile);
  if (!coverageText.trim()) {
    void vscode.window.showWarningMessage('Code Janitor: the selected coverage report is empty.');

    return;
  }

  const fileName = coverageFile.fsPath.split(/[\\/]/).pop() ?? 'coverage report';
  const response = await requestCompletion(
    context,
    'Analyzing coverage report...',
    COVERAGE_REPORT_SYSTEM_PROMPT,
    buildCoverageReportPrompt(fileName, trimCoverageInput(coverageText))
  );

  if (response === undefined) {
    return;
  }

  const document = await vscode.workspace.openTextDocument({ content: response, language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function pickCoverageFile(): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles(COVERAGE_GLOB, COVERAGE_EXCLUDE);
  if (!files.length) {
    void vscode.window.showInformationMessage(
      'Code Janitor: no coverage report found. Generate coverage.cobertura.xml, coverage.opencover.xml, or lcov.info first.'
    );

    return undefined;
  }

  if (files.length === 1) {
    return files[0];
  }

  const picked = await vscode.window.showQuickPick(
    files.map((uri) => ({ label: workspaceRelativePath(uri), uri })),
    { placeHolder: 'Choose a coverage report to analyze' }
  );

  return picked?.uri;
}

async function readCoverageFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);

  return new TextDecoder('utf-8').decode(bytes);
}

async function pickSourceFileFromCoverage(coverageText: string): Promise<vscode.Uri | undefined> {
  const candidates = extractSourcePathsFromCoverage(coverageText)
    .map(resolveWorkspaceSourceUri)
    .filter((uri): uri is vscode.Uri => uri !== undefined);

  const unique = uniqueUris(candidates);
  if (!unique.length) {
    void vscode.window.showInformationMessage(
      'Code Janitor: no source files were found in the coverage report. Use Cobertura, OpenCover, or lcov with source file paths.'
    );

    return undefined;
  }

  if (unique.length === 1) {
    return unique[0];
  }

  const picked = await vscode.window.showQuickPick(
    unique.map((uri) => ({ label: workspaceRelativePath(uri), uri })),
    { placeHolder: 'Choose the source file to generate coverage-gap tests for' }
  );

  return picked?.uri;
}

function extractSourcePathsFromCoverage(coverageText: string): string[] {
  const paths: string[] = [];
  const attributePattern = /\b(?:filename|fullPath|path)="([^"]+\.cs)"/gi;
  let attributeMatch: RegExpExecArray | null;

  while ((attributeMatch = attributePattern.exec(coverageText)) !== null) {
    paths.push(decodeXmlEntities(attributeMatch[1]));
  }

  const lcovPattern = /^SF:(.+\.cs)\s*$/gim;
  let lcovMatch: RegExpExecArray | null;

  while ((lcovMatch = lcovPattern.exec(coverageText)) !== null) {
    paths.push(lcovMatch[1].trim());
  }

  return [...new Set(paths.map((path) => path.replace(/\\/g, '/')))].filter((path) => !isGeneratedSource(path));
}

function resolveWorkspaceSourceUri(path: string): vscode.Uri | undefined {
  const normalizedPath = path.replace(/\\/g, '/');
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedPath.toLowerCase().startsWith(`${folderPath.toLowerCase()}/`)) {
      return vscode.Uri.file(normalizedPath);
    }
  }

  const relativePath = normalizedPath.replace(/^\/+/, '');
  if (!relativePath || /^[a-z]:\//i.test(relativePath)) {
    return undefined;
  }

  return folders[0] ? vscode.Uri.file(`${folders[0].uri.fsPath.replace(/[\\/]$/, '')}/${relativePath}`) : undefined;
}

function uniqueUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();

  return uris.filter((uri) => {
    const key = uri.fsPath.toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

function isGeneratedSource(path: string): boolean {
  return /(?:\.g|\.generated|\.designer)\.cs$/i.test(path) || /[\\/](?:bin|obj)[\\/]/i.test(path);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function trimCoverageInput(content: string): string {
  if (content.length <= MAX_COVERAGE_INPUT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_COVERAGE_INPUT_CHARS)}\n\n[Code Janitor truncated this coverage report to the first ${MAX_COVERAGE_INPUT_CHARS} characters before sending it to AI.]`;
}

function workspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return uri.fsPath;
  }

  return uri.fsPath
    .slice(folder.uri.fsPath.length)
    .replace(/^[\\/]/, '')
    .replace(/\\/g, '/');
}

/** The selection when there is one, otherwise the member under the caret (as the C# engine finds it), otherwise the file. */
async function resolveTarget(): Promise<Target | undefined> {
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

  const content = document.getText();
  let member: MemberAtPosition | null = null;
  try {
    const { line, character } = editor.selection.active;
    member = await engine().query<MemberAtPosition | null>({
      ...documentParams(document.uri, content),
      query: 'memberAtPosition',
      arguments: { line, character },
    });
  } catch (err) {
    // Without the engine the action still runs, on the whole file.
    if (!reportEngineUnavailable(err)) {
      logError(`Finding the member at the caret in ${document.uri.fsPath}`, err);
    }
  }

  if (member) {
    // The member's own text within its lines: the replacement keeps the indentation before it.
    const start = content.indexOf(member.text, document.offsetAt(new vscode.Position(member.startLine, 0)));

    return {
      name: member.name,
      code: member.text,
      range:
        start >= 0
          ? new vscode.Range(document.positionAt(start), document.positionAt(start + member.text.length))
          : new vscode.Range(new vscode.Position(member.startLine, 0), document.lineAt(Math.min(member.endLine, document.lineCount - 1)).range.end),
    };
  }

  return {
    name: document.fileName.split(/[\\/]/).pop() ?? 'file',
    code: content,
    range: new vscode.Range(document.positionAt(0), document.positionAt(content.length)),
  };
}

async function requestCompletion(context: vscode.ExtensionContext, title: string, systemPrompt: string, userPrompt: string): Promise<string | undefined> {
  try {
    const maxTokens = vscode.workspace.getConfiguration('codeJanitor').get<number>('ai.maxTokensPerRequest', 2048);

    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Code Janitor: ${title}`, cancellable: false },
      () => getAiChatCompletion(context, systemPrompt, userPrompt, maxTokens)
    );

    if (!response.trim()) {
      void vscode.window.showWarningMessage('Code Janitor: the AI model returned an empty response. Please check your model settings.');

      return undefined;
    }

    return response.trim();
  } catch (err) {
    logError(title, err);
    void vscode.window.showErrorMessage(`Code Janitor: ${(err as Error).message}`);

    return undefined;
  }
}
