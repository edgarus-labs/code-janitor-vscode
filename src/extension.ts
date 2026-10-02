import * as vscode from 'vscode';
import { registerAiActionCommands } from './commands/aiActionCommands';
import { registerCleanupCommands } from './commands/cleanupCommands';
import { unsavedCSharpSources } from './commands/cleanupCore';
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
import { setUnsavedSourcesProvider } from './cleanup/projectInfo';

export function activate(context: vscode.ExtensionContext): void {
  createOutputChannel(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.showOutputChannel', () => showOutputChannel()),
    // Rules reading the project's other files see their unsaved editor text, as the compiler does.
    setUnsavedSourcesProvider(unsavedCSharpSources)
  );

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

  logInfo(`Code Janitor activated (version ${(context.extension.packageJSON as { version: string }).version}).`);
}

export function deactivate(): void {
  // Nothing to release: the parser is pure TypeScript and holds no resources.
}
