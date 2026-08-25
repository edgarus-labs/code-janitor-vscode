import * as vscode from 'vscode';

/**
 * GitHub Copilot access for VS Code. The Visual Studio extension detects Copilot by scraping
 * Windows Credential Manager and VS log files for a token; that is Windows-only, VS-specific and
 * would mean handling someone else's credentials. The sanctioned cross-platform equivalent here is
 * the built-in Language Model API, which reports usable models only when the GitHub Copilot Chat
 * extension is installed and the user is signed in and entitled - and never exposes the token.
 */

export interface CopilotModelInfo {
  id: string;
  family: string;
  vendor: string;
  name: string;
  maxInputTokens: number;
}

export async function listCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    return [];
  }
}

/** The models the user's own Copilot subscription currently exposes. */
export async function describeCopilotModels(): Promise<CopilotModelInfo[]> {
  const models = await listCopilotModels();

  return models.map((model) => ({
    id: model.id,
    family: model.family,
    vendor: model.vendor,
    name: model.name,
    maxInputTokens: model.maxInputTokens,
  }));
}

export async function isCopilotAvailable(): Promise<boolean> {
  return (await listCopilotModels()).length > 0;
}

export async function getCopilotChatCompletion(
  systemPrompt: string,
  userPrompt: string,
  preferredModel?: string
): Promise<string> {
  const model = await resolveCopilotModel(preferredModel);
  const messages = [vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n${userPrompt}`)];
  const request = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

  let content = '';
  for await (const fragment of request.text) {
    content += fragment;
  }

  return content.trim();
}

/**
 * Matching happens here rather than through a `family` selector so that an unknown preference is
 * reported as such instead of looking like "Copilot is unavailable".
 */
async function resolveCopilotModel(preferredModel?: string): Promise<vscode.LanguageModelChat> {
  const models = await listCopilotModels();

  if (models.length === 0) {
    throw new Error(
      'No GitHub Copilot Chat model is available. Install and sign in to GitHub Copilot Chat, or set codeJanitor.ai.provider to "custom".'
    );
  }

  if (!preferredModel) {
    return models[0];
  }

  const wanted = preferredModel.trim().toLowerCase();
  const match = models.find((model) => model.family.toLowerCase() === wanted || model.id.toLowerCase() === wanted);

  if (match) {
    return match;
  }

  const available = [...new Set(models.map((model) => model.family))].join(', ');

  throw new Error(
    `GitHub Copilot offers no model matching "${preferredModel}". Available: ${available}. ` +
      'Run "Code Janitor: Use GitHub Copilot Model..." to pick one.'
  );
}
