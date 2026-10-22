import { ensureServerBuilt } from '../scripts/engineServer';
import { dotnetAvailable } from './helpers/dotnetBuild';

/**
 * Publishes the C# server once, before any test file runs, so that no hook or test pays for a cold `dotnet publish`
 * (it takes longer than a hook's or a test's timeout on a CI runner, and several workers would wait for each other).
 */
export default function setup(): void {
  if (dotnetAvailable) {
    ensureServerBuilt();
  }
}
