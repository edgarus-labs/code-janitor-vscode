import * as path from 'node:path';
import * as vscode from 'vscode';
import { initCSharpParser } from './cleanup/parser';
import { registerCleanupCommands } from './commands/cleanupCommands';
import { registerFormatOnSave } from './commands/formatOnSave';
import { registerGenerateXmlDocCommand } from './commands/generateXmlDoc';
import { registerAiUtilityCommands } from './commands/aiUtilityCommands';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerCleanupCommands(context);
  registerFormatOnSave(context);
  registerGenerateXmlDocCommand(context);
  registerAiUtilityCommands(context);

  // The C# grammar is WebAssembly, so the same artifact loads on every OS and CPU architecture.
  await initCSharpParser({ wasmDirectory: path.join(context.extensionUri.fsPath, 'dist') });
}

export function deactivate(): void {
  // Nothing to release: the parser lives for the lifetime of the extension host.
}
