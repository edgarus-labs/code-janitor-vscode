import * as vscode from 'vscode';
import { ReorganizeSettings, parseReorganizeSettings } from '../reorganize/settings';

/** Maps the `codeJanitor.reorganize.*` settings onto the reorganizer's settings. */
export function readReorganizeSettings(): ReorganizeSettings {
  const config = vscode.workspace.getConfiguration('codeJanitor');

  return parseReorganizeSettings((key) => config.get(`reorganize.${key}`));
}
