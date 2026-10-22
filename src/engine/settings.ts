import { CleanupSettings, HeaderPosition, HeaderUpdateMode } from '../cleanup/types';
import { EngineSettings } from './protocol';

/** `settings` as the server reads them: the header enums as their protocol strings. */
export function toEngineSettings(settings: CleanupSettings): EngineSettings {
  return {
    ...settings,
    fileHeaderPosition: settings.fileHeaderPosition === HeaderPosition.AfterUsings ? 'afterUsings' : 'documentStart',
    fileHeaderUpdateMode: settings.fileHeaderUpdateMode === HeaderUpdateMode.Replace ? 'replace' : 'insert',
  };
}
