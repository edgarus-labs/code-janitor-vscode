import { expect } from 'vitest';
import { CleanupSettings } from '../../src/cleanup/types';
import { reorganizeSource } from '../../src/reorganize/reorganize';
import { ReorganizeSettings, createDefaultReorganizeSettings } from '../../src/reorganize/settings';
import { withoutPadding } from './padding';

export { withoutPadding };

export function reorganizeSettings(overrides: Partial<ReorganizeSettings> = {}): ReorganizeSettings {
  return { ...createDefaultReorganizeSettings(), ...overrides };
}

/**
 * Reorganizes `source` and proves a second run changes nothing (the reorganizer must be idempotent
 * for every input and setting combination).
 */
export function reorganize(source: string, overrides: Partial<ReorganizeSettings> = {}, cleanup: CleanupSettings = withoutPadding()): string {
  const settings = reorganizeSettings(overrides);
  const output = reorganizeSource(source, settings, cleanup);

  expect(reorganizeSource(output, settings, cleanup), 'a second run must not change the output').toBe(output);

  return output;
}
