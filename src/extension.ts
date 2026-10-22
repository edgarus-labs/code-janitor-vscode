import * as vscode from 'vscode';
import { registerAiActionCommands } from './commands/aiActionCommands';
import { registerCleanupCommands } from './commands/cleanupCommands';
import { registerCleanupDiagnostics } from './commands/diagnostics';
import { registerEditorCommands } from './commands/editorCommands';
import { registerFormatOnSave } from './commands/formatOnSave';
import { registerGenerateXmlDocCommand } from './commands/generateXmlDoc';
import { registerAiUtilityCommands } from './commands/aiUtilityCommands';
import { registerSettingsUiCommand } from './commands/settingsUi';
import { registerRepositorySettingsCommands } from './commands/repositorySettings';
import { registerNavigationCommands } from './commands/navigation';
import { registerRazorCommands } from './commands/razorCommands';
import { registerReorganizeCommands } from './commands/reorganizeCommands';
import { createOutputChannel, logInfo, showOutputChannel } from './logging';
import { activateEngine, deactivateEngine } from './engine/vscodeEngine';
import { registerSpade } from './spade/spadeView';

export function activate(context: vscode.ExtensionContext): void {
  createOutputChannel(context);

  context.subscriptions.push(vscode.commands.registerCommand('codeJanitor.showOutputChannel', () => showOutputChannel()));
  // The C# engine (the Roslyn server) starts on the first C# request.
  activateEngine(context);

  registerCleanupCommands(context);
  registerCleanupDiagnostics(context);
  registerEditorCommands(context);
  registerFormatOnSave(context);
  registerGenerateXmlDocCommand(context);
  registerAiActionCommands(context);
  registerAiUtilityCommands(context);
  registerSettingsUiCommand(context);
  registerRepositorySettingsCommands(context);
  registerNavigationCommands(context);
  registerRazorCommands(context);
  registerReorganizeCommands(context);
  registerSpade(context);

  logInfo(`Code Janitor activated (version ${(context.extension.packageJSON as { version: string }).version}).`);
}

export function deactivate(): Promise<void> {
  return deactivateEngine();
}
