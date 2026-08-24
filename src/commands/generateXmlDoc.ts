import * as vscode from 'vscode';
import { getAiChatCompletion } from '../ai/aiService';
import {
  XML_DOC_SYSTEM_PROMPT,
  XmlDocTarget,
  applySummaries,
  planTargets,
} from '../cleanup/xmlDocumentation';
import { readXmlDocOptions } from './settings';

/**
 * AI XML-doc command. The Roslyn-equivalent analysis runs in-process: the planner decides which
 * members lack documentation and builds the prompt for each one, this command performs the AI
 * request per member, and the renderer inserts the comment blocks - including the deterministic
 * param/returns/exception tags.
 */
export function registerGenerateXmlDocCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.generateXmlDoc', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'csharp') {
        void vscode.window.showInformationMessage('CodeJanitor: open a C# file to generate XML documentation.');

        return;
      }

      try {
        await generateXmlDocForDocument(context, editor);
      } catch (err) {
        void vscode.window.showErrorMessage(`CodeJanitor: ${(err as Error).message}`);
      }
    })
  );
}

async function generateXmlDocForDocument(context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const options = readXmlDocOptions();
  const content = document.getText();
  const versionBeforeRun = document.version;

  const targets = planTargets(content, options);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('CodeJanitor: no undocumented members found in this file.');

    return;
  }

  const aiTargets = targets.filter((target) => target.requiresAi);
  const summaries = await collectSummaries(context, aiTargets);
  if (summaries === undefined) {
    return;
  }

  if (document.version !== versionBeforeRun) {
    void vscode.window.showWarningMessage(
      'CodeJanitor: the file changed while documentation was being generated - nothing was inserted.'
    );

    return;
  }

  const output = applySummaries(content, options, summaries);
  if (output === content) {
    void vscode.window.showInformationMessage('CodeJanitor: no documentation was generated.');

    return;
  }

  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
  const applied = await editor.edit((editBuilder) => editBuilder.replace(fullRange, output));

  if (applied) {
    const deterministic = targets.length - aiTargets.length;
    void vscode.window.showInformationMessage(
      `CodeJanitor: documented ${targets.length} member(s) - ${aiTargets.length} via AI, ${deterministic} deterministic.`
    );
  }
}

/**
 * Runs one AI request per planned member. Returns `undefined` when the user cancelled, so the
 * caller can abort without touching the document.
 */
async function collectSummaries(
  context: vscode.ExtensionContext,
  aiTargets: readonly XmlDocTarget[]
): Promise<Record<number, string> | undefined> {
  if (aiTargets.length === 0) {
    return {};
  }

  const allowFallback = vscode.workspace
    .getConfiguration('codeJanitor')
    .get<boolean>('ai.xmlDoc.allowDeterministicFallback', true);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeJanitor: generating XML documentation',
      cancellable: true,
    },
    async (progress, token) => {
      const summaries: Record<number, string> = {};

      for (let i = 0; i < aiTargets.length; i++) {
        if (token.isCancellationRequested) {
          return undefined;
        }

        const target = aiTargets[i];
        progress.report({
          message: `${target.kind} ${target.memberName} (${i + 1}/${aiTargets.length})`,
          increment: 100 / aiTargets.length,
        });

        try {
          const completion = await getAiChatCompletion(context, XML_DOC_SYSTEM_PROMPT, target.prompt ?? '');
          if (completion.trim()) {
            summaries[target.index] = completion;
            continue;
          }
        } catch {
          // Fall through to the deterministic summary below.
        }

        if (allowFallback) {
          summaries[target.index] = target.fallbackSummary;
        }
      }

      return summaries;
    }
  );
}
