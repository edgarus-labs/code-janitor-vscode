import * as vscode from 'vscode';
import { getAiChatCompletion } from '../ai/aiService';
import { findXmlDocTargets } from '../ai/xmlDocDuringCleanup';
import { XmlDocTargetResult } from '../engine/protocol';
import { reportEngineUnavailable } from '../engine/vscodeEngine';
import { XML_DOC_SYSTEM_PROMPT, XmlDocPlanItem, insertXmlDocumentation } from '../engine/xmlDoc';
import { CollectedFile, collectFiles, expandToCSharpFiles, isCSharp, isPathCleanable, writeFileContent } from './cleanupCore';
import { logDiagnostic, logError } from '../logging';
import { readXmlDocOptions } from './settings';

/**
 * AI XML-doc command. The C# engine finds the members that lack documentation (`xmlDocTargets`), the
 * planner builds the prompt for each one, this command performs the AI request per member, and the
 * renderer inserts the comment blocks - including the deterministic param/returns/exception tags.
 */

export function registerGenerateXmlDocCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.generateXmlDoc', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'csharp') {
        void vscode.window.showInformationMessage('Code Janitor: open a C# file to generate XML documentation.');

        return;
      }

      try {
        await generateXmlDocForDocument(context, editor);
      } catch (err) {
        if (reportEngineUnavailable(err)) {
          return;
        }

        logError('Generate XML Documentation', err);
        void vscode.window.showErrorMessage(`Code Janitor: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('codeJanitor.generateXmlDocSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

      await runGenerateXmlDocOnUris(context, expanded);
    }),

    vscode.commands.registerCommand('codeJanitor.generateXmlDocWorkspace', async () => {
      const files = await vscode.workspace.findFiles('**/*.cs', '**/{bin,obj,node_modules,.git}/**');

      if (files.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no C# files found in the workspace.');

        return;
      }

      await runGenerateXmlDocOnUris(context, files);
    })
  );
}

async function generateXmlDocForDocument(context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const options = readXmlDocOptions();
  const content = document.getText();
  const versionBeforeRun = document.version;

  const { found, plan: targets } = await findXmlDocTargets(document.uri, content, options);
  if (targets.length === 0) {
    logDiagnostic(`Generate XML Documentation: no undocumented members in ${document.fileName}.`);
    void vscode.window.showInformationMessage('Code Janitor: no undocumented members found in this file.');

    return;
  }

  const aiTargets = targets.filter((target) => target.requiresAi);
  logDiagnostic(
    `Generate XML Documentation: planned ${targets.length} member(s) in ${document.fileName} ` +
      `(${aiTargets.length} via AI, ${targets.length - aiTargets.length} deterministic).`
  );

  const allowFallback = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('ai.xmlDoc.allowDeterministicFallback', true);

  const collected = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Janitor: generating XML documentation', cancellable: true },
    (progress, token) => collectSummariesForTargets(context, aiTargets, allowFallback, token, (message, increment) => progress.report({ message, increment }))
  );

  if (collected === undefined) {
    return;
  }

  const { summaries, viaAi } = collected;

  if (changedWhileGenerating(document, versionBeforeRun)) {
    return;
  }

  const output = insertXmlDocumentation(content, found, summaries);
  if (output === content) {
    void vscode.window.showInformationMessage('Code Janitor: no documentation was generated.');

    return;
  }

  const previewChanges = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('ai.xmlDoc.previewChanges', false);

  if (previewChanges && !(await confirmWithPreview(document, output))) {
    return;
  }

  if (changedWhileGenerating(document, versionBeforeRun)) {
    return;
  }

  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
  const applied = await editor.edit((editBuilder) => editBuilder.replace(fullRange, output));

  if (applied) {
    const documented = targets.filter((target) => !target.requiresAi || summaries[target.index]?.trim()).length;
    logDiagnostic(`Generate XML Documentation: applied to ${document.fileName}.`);
    void vscode.window.showInformationMessage(`Code Janitor: documented ${documented} member(s) - ${viaAi} via AI, ${documented - viaAi} deterministic.`);
  } else {
    void vscode.window.showWarningMessage('Code Janitor: VS Code did not apply the generated XML documentation.');
  }
}

/** Whether `document` changed since `version`, which abandons the insertion (its text was planned from that version), with a warning. */
function changedWhileGenerating(document: vscode.TextDocument, version: number): boolean {
  if (document.version === version) {
    return false;
  }

  void vscode.window.showWarningMessage('Code Janitor: the file changed while documentation was being generated - nothing was inserted.');

  return true;
}

/** Shows the proposed result next to the original and asks whether to apply it. */
async function confirmWithPreview(document: vscode.TextDocument, output: string): Promise<boolean> {
  const preview = await vscode.workspace.openTextDocument({ content: output, language: document.languageId });

  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    preview.uri,
    `Code Janitor: XML documentation preview (${document.fileName.split(/[\\/]/).pop()})`
  );

  const choice = await vscode.window.showInformationMessage('Code Janitor: apply the generated XML documentation?', { modal: true }, 'Apply');

  return choice === 'Apply';
}

/**
 * Runs one AI request per planned member, reporting progress through the caller's callback and
 * checking the caller's cancellation token between requests. Returns `undefined` when cancelled,
 * so the caller can abort without touching the document.
 */
async function collectSummariesForTargets(
  context: vscode.ExtensionContext,
  aiTargets: readonly XmlDocPlanItem[],
  allowFallback: boolean,
  token: vscode.CancellationToken,
  reportProgress?: (message: string, increment: number) => void
): Promise<{ summaries: Record<number, string>; viaAi: number } | undefined> {
  if (aiTargets.length === 0) {
    return { summaries: {}, viaAi: 0 };
  }

  const summaries: Record<number, string> = {};
  let viaAi = 0;

  for (let i = 0; i < aiTargets.length; i++) {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const target = aiTargets[i];
    reportProgress?.(`${target.kind} ${target.memberName} (${i + 1}/${aiTargets.length})`, 100 / aiTargets.length);

    try {
      const maxTokens = vscode.workspace.getConfiguration('codeJanitor').get<number>('ai.xmlDoc.maxTokensPerRequest', 256);

      const completion = await getAiChatCompletion(context, XML_DOC_SYSTEM_PROMPT, target.prompt ?? '', maxTokens);
      if (completion.trim()) {
        summaries[target.index] = completion;
        viaAi++;
        continue;
      }
    } catch (err) {
      logError(`AI request for ${target.kind} ${target.memberName}`, err);
      // Fall through to the deterministic summary below.
    }

    if (allowFallback) {
      summaries[target.index] = target.fallbackSummary;
    }
  }

  return { summaries, viaAi };
}

interface PlannedFile {
  file: CollectedFile;
  found: readonly XmlDocTargetResult[];
  targets: readonly XmlDocPlanItem[];
}

/**
 * Generates XML documentation across every given file. Because this can mean firing many AI
 * requests unattended, files are planned (a cheap, deterministic, AI-free pass) first, and if any
 * file needs an AI request the user is asked to confirm the total count before a single request is
 * sent - unlike the single-file command, which never needed this because one file is never a
 * surprise.
 */
async function runGenerateXmlDocOnUris(context: vscode.ExtensionContext, uris: vscode.Uri[]): Promise<void> {
  const targets = uris.filter((uri) => isCSharp(uri) && isPathCleanable(uri));
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Code Janitor: no C# files to document.');

    return;
  }

  const options = readXmlDocOptions();
  const collected = await collectFiles(targets);

  const planned: PlannedFile[] = [];
  for (const file of collected) {
    try {
      const { found, plan } = await findXmlDocTargets(file.uri, file.content, options);
      if (plan.length > 0) {
        planned.push({ file, found, targets: plan });
      }
    } catch (err) {
      if (reportEngineUnavailable(err)) {
        return;
      }

      logError(`Generate XML Documentation (batch) for ${file.uri.fsPath}`, err);
    }
  }

  if (planned.length === 0) {
    void vscode.window.showInformationMessage('Code Janitor: no undocumented members found.');

    return;
  }

  const totalAiTargets = planned.reduce((sum, entry) => sum + entry.targets.filter((t) => t.requiresAi).length, 0);

  if (totalAiTargets > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Code Janitor: this will send ${totalAiTargets} AI request(s) across ${planned.length} file(s). Continue?`,
      { modal: true },
      'Continue'
    );

    if (choice !== 'Continue') {
      return;
    }
  }

  logDiagnostic(`Generate XML Documentation (batch): starting on ${planned.length} file(s), ${totalAiTargets} AI request(s).`);

  const allowFallback = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('ai.xmlDoc.allowDeterministicFallback', true);

  let documented = 0;
  let failed = 0;
  let cancelled = false;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Janitor: generating XML documentation', cancellable: true },
    async (progress, token) => {
      for (let i = 0; i < planned.length; i++) {
        if (token.isCancellationRequested) {
          cancelled = true;
          break;
        }

        const { file, found, targets: fileTargets } = planned[i];
        const name = file.uri.fsPath.split(/[\\/]/).pop();
        progress.report({ message: `${name} (${i + 1}/${planned.length})`, increment: 100 / planned.length });

        try {
          const aiTargets = fileTargets.filter((t) => t.requiresAi);
          const collected = await collectSummariesForTargets(context, aiTargets, allowFallback, token);

          if (collected === undefined) {
            cancelled = true;
            break;
          }

          const output = insertXmlDocumentation(file.content, found, collected.summaries);
          if (output !== file.content) {
            await writeFileContent(file, output);
            documented++;
          }
        } catch (err) {
          failed++;
          logError(`Generate XML Documentation (batch) for ${file.uri.fsPath}`, err);
        }
      }
    }
  );

  logDiagnostic(`Generate XML Documentation (batch): finished - ${documented} file(s) documented, ${failed} failed` + (cancelled ? ', cancelled.' : '.'));

  const parts = [`${documented} file(s) documented`];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (cancelled) {
    parts.push('cancelled before finishing');
  }

  void vscode.window.showInformationMessage(`Code Janitor: ${parts.join(', ')}.`);
}
