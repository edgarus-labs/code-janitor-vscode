import * as vscode from 'vscode';
import { DEFAULT_RAZOR_OPTIONS, MAX_INDENT_SIZE, MIN_INDENT_SIZE, RazorFormatOptions, RazorIndentStyle } from './razorOptions';

/** File extensions of Razor components (`.razor`) and views / pages (`.cshtml`). */
const RAZOR_FILE = /\.(?:razor|cshtml)$/i;

export function isRazorFile(uri: vscode.Uri): boolean {
  return RAZOR_FILE.test(uri.fsPath);
}

/**
 * `codeJanitor.cleanup.formatRazorComponents`: the Razor formatter runs as part of the cleanup
 * (Visual Studio's `Cleaning_FormatRazorComponents`, off by default). The `Format Razor` command runs
 * whatever this says.
 */
export function isRazorCleanupEnabled(): boolean {
  return vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.formatRazorComponents', false);
}

/** `codeJanitor.razor.indentSize` and `codeJanitor.razor.indentStyle`; a value outside its range is ignored. */
export function readRazorOptions(): RazorFormatOptions {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const size = config.get<number>('razor.indentSize', DEFAULT_RAZOR_OPTIONS.indentSize);
  const style = config.get<string>('razor.indentStyle', DEFAULT_RAZOR_OPTIONS.indentStyle);

  return {
    indentSize: Number.isInteger(size) && size >= MIN_INDENT_SIZE && size <= MAX_INDENT_SIZE ? size : DEFAULT_RAZOR_OPTIONS.indentSize,
    indentStyle: style === 'space' || style === 'tab' || style === 'auto' ? (style as RazorIndentStyle) : DEFAULT_RAZOR_OPTIONS.indentStyle,
  };
}
