import * as vscode from 'vscode';
import { registerCleanupCommands } from './commands/cleanupCommands';
import { registerFormatOnSave } from './commands/formatOnSave';
import { registerGenerateXmlDocCommand } from './commands/generateXmlDoc';
import { registerAiUtilityCommands } from './commands/aiUtilityCommands';

export function activate(context: vscode.ExtensionContext): void {
  registerCleanupCommands(context);
  registerFormatOnSave(context);
  registerGenerateXmlDocCommand(context);
  registerAiUtilityCommands(context);
}

export function deactivate(): void {
  // No global resources to release; child engine processes are per-request and self-terminate.
}
