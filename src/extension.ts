import * as vscode from 'vscode';
import { registerAiActionCommands } from './commands/aiActionCommands';
import { registerCleanupCommands } from './commands/cleanupCommands';
import { registerEditorCommands } from './commands/editorCommands';
import { registerFormatOnSave } from './commands/formatOnSave';
import { registerGenerateXmlDocCommand } from './commands/generateXmlDoc';
import { registerAiUtilityCommands } from './commands/aiUtilityCommands';
import { registerSettingsUiCommand } from './commands/settingsUi';
import { registerRepositorySettingsCommands } from './commands/repositorySettings';
import { createOutputChannel, logInfo, showOutputChannel } from './logging';

export function activate(context: vscode.ExtensionContext): void {
  createOutputChannel(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.showOutputChannel', () => showOutputChannel())
  );

  registerCleanupCommands(context);
  registerEditorCommands(context);
  registerFormatOnSave(context);
  registerGenerateXmlDocCommand(context);
  registerAiActionCommands(context);
  registerAiUtilityCommands(context);
  registerSettingsUiCommand(context);
  registerRepositorySettingsCommands(context);

  logInfo(`Code Janitor activated (version ${(context.extension.packageJSON as { version: string }).version}).`);
}

export function deactivate(): void {
  // Nothing to release: the parser is pure TypeScript and holds no resources.
}
