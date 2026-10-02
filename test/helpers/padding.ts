import { CleanupSettings, createDefaultSettings } from '../../src/cleanup/types';

/** Every blank line padding setting off: blank lines then come only from the source. */
export function withoutPadding(): CleanupSettings {
  const settings = createDefaultSettings();
  for (const key of Object.keys(settings) as (keyof CleanupSettings)[]) {
    if (key.startsWith('insertBlankLinePadding')) {
      (settings as unknown as Record<string, unknown>)[key] = false;
    }
  }

  return settings;
}
