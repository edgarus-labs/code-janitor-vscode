import * as vscode from 'vscode';

/**
 * "Local Copilot" detection for VS Code: unlike the Visual Studio extension (which scrapes
 * Windows Credential Manager / log files - Windows-only and VS-specific), the correct
 * cross-platform equivalent here is the built-in Language Model API. It reports a usable model
 * only when the GitHub Copilot Chat extension is installed and the user is signed in/entitled.
 */
export async function detectCopilotModels(preferredFamily?: string): Promise<vscode.LanguageModelChat[]> {
  try {
    const selector: vscode.LanguageModelChatSelector = preferredFamily
      ? { vendor: 'copilot', family: preferredFamily }
      : { vendor: 'copilot' };

    return await vscode.lm.selectChatModels(selector);
  } catch {
    return [];
  }
}

export async function isCopilotAvailable(): Promise<boolean> {
  const models = await detectCopilotModels();

  return models.length > 0;
}

export async function getCopilotChatCompletion(systemPrompt: string, userPrompt: string, preferredFamily?: string): Promise<string> {
  const models = await detectCopilotModels(preferredFamily);
  if (models.length === 0) {
    throw new Error(
      'No GitHub Copilot Chat model is available. Install/sign in to GitHub Copilot Chat, or switch codeJanitor.ai.provider to "custom".'
    );
  }

  const model = models[0];
  const messages = [vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n${userPrompt}`)];

  const request = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

  let content = '';
  for await (const fragment of request.text) {
    content += fragment;
  }

  return content.trim();
}
