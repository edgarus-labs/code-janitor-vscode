import * as vscode from 'vscode';
import { storeCustomApiKey, testAiConnection } from '../ai/aiService';

export function registerAiUtilityCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.testAiConnection', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeJanitor: testing AI connection...' },
        () => testAiConnection(context)
      );

      if (result.succeeded) {
        void vscode.window.showInformationMessage(`CodeJanitor: ${result.message}`);
      } else {
        void vscode.window.showErrorMessage(`CodeJanitor: ${result.message}`);
      }
    }),

    vscode.commands.registerCommand('codeJanitor.setAiApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'CodeJanitor: Custom AI Endpoint API Key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Leave empty to clear the stored key',
      });

      if (apiKey === undefined) {
        return;
      }

      await storeCustomApiKey(context, apiKey);
      void vscode.window.showInformationMessage(apiKey ? 'CodeJanitor: API key stored securely.' : 'CodeJanitor: API key cleared.');
    })
  );
}
