import * as path from 'node:path';
import { findDefiningEditorConfigPath } from './editorconfig';
import { RULE_SET_KEY, resolveEffectiveCleanupSettings } from './effectiveSettings';
import { CleanupSettings } from './types';

/**
 * Which cleanup settings the open workspace's `.editorconfig` overrides, for the settings panel (port of
 * `EditorConfigOverrideNotes.cs` of the Visual Studio extension). Settings are global, so the notes describe
 * a C# file in the workspace folder: `.editorconfig` files nested below it are not considered, and a key
 * that is not enforced (or has an unrecognized value) gives no note. An option with a note has no effect for
 * the workspace, because `.editorconfig` decides it. Without a workspace there are no notes.
 */

/** The file the notes are evaluated for: it never has to exist. */
const PROBE_FILE_NAME = 'CodeJanitorOptionsProbe.cs';

/** Finds the `.editorconfig` file that defines an option for a file; injectable for tests. */
export type DefiningConfigFinder = (filePath: string, key: string) => string | undefined;

/**
 * The note for each overridden setting, keyed by the `CleanupSettings` key (or the option name of a Code Style
 * rule): `Overridden by .editorconfig: <key> in <path>`, or `Overridden by the project's AnalysisLevel/AnalysisMode`
 * when the SDK rule set of those project properties decides it. The file is looked up once per `.editorconfig` key,
 * however many settings it decides.
 */
export function editorConfigOverrideNotes(
  workspaceRoot: string | undefined,
  settings: CleanupSettings,
  findDefiningConfigPath: DefiningConfigFinder = findDefiningEditorConfigPath
): ReadonlyMap<string, string> {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return new Map();
  }

  const probePath = path.join(path.resolve(workspaceRoot), PROBE_FILE_NAME);
  // Setting names and Code Style rule keys (.editorconfig option names) never collide.
  const effective = resolveEffectiveCleanupSettings(probePath, settings);
  const keys = new Map([...effective.editorConfigKeys, ...effective.codeStyleEditorConfigKeys]);

  const noteByKey = new Map<string, string>();
  for (const key of new Set(keys.values())) {
    if (key === RULE_SET_KEY) {
      noteByKey.set(key, `Overridden by the project's ${key}`);
      continue;
    }

    const definingPath = findDefiningConfigPath(probePath, key);
    noteByKey.set(key, definingPath ? `Overridden by .editorconfig: ${key} in ${definingPath}` : `Overridden by .editorconfig: ${key}`);
  }

  return new Map([...keys].map(([name, key]) => [name, noteByKey.get(key)!]));
}
