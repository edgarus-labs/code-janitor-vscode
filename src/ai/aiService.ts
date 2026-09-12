import * as vscode from 'vscode';
import { getCopilotChatCompletion, isCopilotAvailable } from './copilotClient';
import { CustomEndpointConfig, getCustomChatCompletion, isEndpointConfigured, testCustomConnection } from './customClient';

const SECRET_KEY = 'codeJanitor.ai.customApiKey';

export type AiProvider = 'copilot' | 'custom';

function getProvider(): AiProvider {
  return vscode.workspace.getConfiguration('codeJanitor').get<AiProvider>('ai.provider', 'copilot');
}

async function getCustomConfig(context: vscode.ExtensionContext): Promise<CustomEndpointConfig> {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const apiKey = await context.secrets.get(SECRET_KEY);

  return {
    endpointUrl: cfg.get<string>('ai.customEndpointUrl', ''),
    apiKey,
    apiKeyHeader: cfg.get<string>('ai.customApiKeyHeader', 'Authorization'),
    model: cfg.get<string>('ai.customModel', ''),
    timeoutSeconds: cfg.get<number>('ai.customTimeoutSeconds', 30),
    contextWindowTokens: cfg.get<number>('ai.customContextWindowTokens', 131072),
  };
}

export async function storeCustomApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
  if (apiKey) {
    await context.secrets.store(SECRET_KEY, apiKey);
  } else {
    await context.secrets.delete(SECRET_KEY);
  }
}

/**
 * Requests a chat completion from whichever provider is configured: GitHub Copilot Chat (via the
 * Language Model API, default) or a custom OpenAI/Claude-compatible endpoint. `maxTokens` bounds
 * the custom endpoint's answer; Copilot manages its own budget.
 */
export async function getAiChatCompletion(
  context: vscode.ExtensionContext,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048
): Promise<string> {
  const provider = getProvider();

  if (provider === 'custom') {
    const config = await getCustomConfig(context);

    return getCustomChatCompletion(systemPrompt, userPrompt, maxTokens, config);
  }

  const preferredModel = vscode.workspace.getConfiguration('codeJanitor').get<string>('ai.copilotModel', '');

  return getCopilotChatCompletion(systemPrompt, userPrompt, preferredModel || undefined);
}

export async function testAiConnection(context: vscode.ExtensionContext): Promise<{ succeeded: boolean; message: string }> {
  const provider = getProvider();

  if (provider === 'custom') {
    const config = await getCustomConfig(context);
    if (!isEndpointConfigured(config.endpointUrl)) {
      return { succeeded: false, message: 'Custom AI endpoint is not configured (codeJanitor.ai.customEndpointUrl).' };
    }

    const result = await testCustomConnection(config);
    const modelInfo =
      result.availableModels && result.availableModels.length > 0
        ? ` Discovered ${result.availableModels.length} model(s): ${result.availableModels.slice(0, 5).join(', ')}${
            result.availableModels.length > 5 ? '...' : ''
          }.`
        : '';

    return result.succeeded
      ? { succeeded: true, message: `Connected to ${config.endpointUrl}.${modelInfo}` }
      : { succeeded: false, message: result.errorMessage ?? 'Unknown error.' };
  }

  const available = await isCopilotAvailable();

  return available
    ? { succeeded: true, message: 'GitHub Copilot Chat model detected and available.' }
    : { succeeded: false, message: 'No GitHub Copilot Chat model available. Install/sign in to GitHub Copilot Chat, or switch to a custom endpoint.' };
}
