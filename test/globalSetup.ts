import { ensureServerBuilt } from '../scripts/engineServer';
import { dotnetAvailable } from './helpers/dotnetBuild';

export default function setup(): void {
  if (dotnetAvailable) {
    ensureServerBuilt();
  }
}
