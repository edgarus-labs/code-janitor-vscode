import * as vscode from 'vscode';
import { storeCustomApiKey, testAiConnection } from '../ai/aiService';
import { CopilotModelInfo, describeCopilotModels } from '../ai/copilotClient';
import { logInfo } from '../logging';

interface ModelPick extends vscode.QuickPickItem {
  model?: CopilotModelInfo;
}

export function registerAiUtilityCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.selectCopilotModel', () => selectCopilotModel()),

    vscode.commands.registerCommand('codeJanitor.testAiConnection', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Code Janitor: testing AI connection...' },
        () => testAiConnection(context)
      );

      if (result.succeeded) {
        logInfo(`Test AI Connection: ${result.message}`);
        void vscode.window.showInformationMessage(`Code Janitor: ${result.message}`);
      } else {
        logInfo(`Test AI Connection failed: ${result.message}`);
        void vscode.window.showErrorMessage(`Code Janitor: ${result.message}`);
      }
    }),

    vscode.commands.registerCommand('codeJanitor.setAiApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'Code Janitor: Custom AI Endpoint API Key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Leave empty to clear the stored key',
      });

      if (apiKey === undefined) {
        return;
      }

      await storeCustomApiKey(context, apiKey);
      void vscode.window.showInformationMessage(apiKey ? 'Code Janitor: API key stored securely.' : 'Code Janitor: API key cleared.');
    })
  );
}

/**
 * Reads the models the signed-in GitHub Copilot actually offers and stores the chosen one, so the
 * AI features use a model that is known to exist rather than a hand-typed name.
 */
async function selectCopilotModel(): Promise<void> {
  const models = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Janitor: reading GitHub Copilot models...' },
    () => describeCopilotModels()
  );

  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      'Code Janitor: no GitHub Copilot model is available. Install the GitHub Copilot Chat extension and sign in, then try again.'
    );

    return;
  }

  const config = vscode.workspace.getConfiguration('codeJanitor');
  const current = config.get<string>('ai.copilotModel', '');

  // Sorted so the picker is stable across runs; the API gives no ordering guarantee.
  const sortedModels = [...models].sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));

  const picks: ModelPick[] = [
    {
      label: 'Automatic',
      description: current ? undefined : 'current',
      detail: `Use whichever model Copilot offers first (currently ${models[0].family}).`,
    },
    ...sortedModels.map((model) => ({
      label: model.family,
      description: model.family === current || model.id === current ? 'current' : model.name,
      detail: `id: ${model.id} · context window: ${model.maxInputTokens.toLocaleString('en-US')} tokens`,
      model,
    })),
  ];

  const picked = await vscode.window.showQuickPick(picks, {
    title: 'Code Janitor: Use GitHub Copilot Model',
    placeHolder: 'Pick the model the AI features should use',
    matchOnDetail: true,
  });

  if (!picked) {
    return;
  }

  await config.update('ai.copilotModel', picked.model?.family ?? '', vscode.ConfigurationTarget.Global);
  await config.update('ai.provider', 'copilot', vscode.ConfigurationTarget.Global);

  logInfo(`Use GitHub Copilot Model: set to "${picked.model?.family ?? 'automatic'}".`);
  void vscode.window.showInformationMessage(
    picked.model
      ? `Code Janitor: AI features will use the GitHub Copilot model "${picked.model.family}".`
      : 'Code Janitor: AI features will use the first GitHub Copilot model available.'
  );
}
