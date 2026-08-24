import * as vscode from 'vscode';
import { getAiChatCompletion } from '../ai/aiService';

const MAX_SIGNATURE_LINES = 10;
const MAX_BODY_PREVIEW_LINES = 60;

/**
 * MVP AI XML-doc command: user places the cursor on a member's signature line (class/method/
 * property/etc.), the command gathers the signature (and a short body preview for context),
 * asks the configured AI provider for a `///` doc comment, and inserts it above the member.
 * Unlike the Visual Studio extension's Roslyn-based AiXmlDocumentationLogic, member boundaries
 * here are found heuristically (line/brace based) rather than via a full syntax tree - a
 * pragmatic MVP scope for the first VS Code port iteration.
 */
export function registerGenerateXmlDocCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.generateXmlDoc', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'csharp') {
        void vscode.window.showInformationMessage('CodeJanitor: place the cursor in a C# file on the member you want documented.');

        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeJanitor: generating XML documentation...' },
        async () => {
          try {
            await generateXmlDocAtCursor(context, editor);
          } catch (err) {
            void vscode.window.showErrorMessage(`CodeJanitor: ${(err as Error).message}`);
          }
        }
      );
    })
  );
}

async function generateXmlDocAtCursor(context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const startLine = editor.selection.active.line;

  const { signature, indentation } = collectSignature(document, startLine);
  if (!signature.trim()) {
    void vscode.window.showInformationMessage('CodeJanitor: could not find a member signature at the cursor.');

    return;
  }

  const bodyPreview = collectBodyPreview(document, startLine);

  const systemPrompt =
    'You are a C# documentation assistant. Given a member signature (and optional body preview), ' +
    'produce a triple-slash XML documentation comment for it. Output ONLY the comment lines, each ' +
    'starting with "///", no markdown code fences, no explanations, no leading/trailing blank lines.';

  const userPrompt = `Member signature:\n${signature}\n\nBody preview (may be truncated):\n${bodyPreview}`;

  const raw = await getAiChatCompletion(context, systemPrompt, userPrompt);
  const commentLines = formatAsXmlDocComment(raw, indentation);

  if (commentLines.length === 0) {
    void vscode.window.showWarningMessage('CodeJanitor: the AI response did not contain any documentation lines.');

    return;
  }

  const insertPosition = new vscode.Position(startLine, 0);
  await editor.edit((editBuilder) => {
    editBuilder.insert(insertPosition, commentLines.join('\n') + '\n');
  });
}

function collectSignature(document: vscode.TextDocument, startLine: number): { signature: string; indentation: string } {
  const firstLineText = document.lineAt(startLine).text;
  const indentation = firstLineText.match(/^[ \t]*/)?.[0] ?? '';

  const lines: string[] = [];
  for (let i = startLine; i < Math.min(document.lineCount, startLine + MAX_SIGNATURE_LINES); i++) {
    const text = document.lineAt(i).text;
    lines.push(text);

    if (text.includes('{') || text.trimEnd().endsWith(';')) {
      break;
    }
  }

  return { signature: lines.join('\n'), indentation };
}

function collectBodyPreview(document: vscode.TextDocument, startLine: number): string {
  const endLine = Math.min(document.lineCount, startLine + MAX_SIGNATURE_LINES + MAX_BODY_PREVIEW_LINES);
  const lines: string[] = [];

  for (let i = startLine; i < endLine; i++) {
    lines.push(document.lineAt(i).text);
  }

  return lines.join('\n');
}

function formatAsXmlDocComment(raw: string, indentation: string): string[] {
  const withoutFences = raw.replace(/```[a-zA-Z]*\n?/g, '').trim();

  return withoutFences
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith('///') ? line : `/// ${line}`))
    .map((line) => `${indentation}${line}`);
}
