import { describe, expect, it } from 'vitest';
import { isEnforced, resolveDiagnosticSeverity, resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { editorConfigCatalog, effectiveEditorConfigValue, unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { renderEditorConfig } from '../scripts/editorConfigTemplate';

/**
 * Supported settings the generated file leaves out on purpose: the documentation defines no value
 * for them (`charset`, `trim_trailing_whitespace`) or documents `unset` (`file_header_template`).
 */
const UNDOCUMENTED_SETTINGS = ['charset', 'trim_trailing_whitespace', 'file_header_template'];

/** MA0048 (Meziantou) duplicates SA1402 + SA1649, which the generated file enables instead. */
const DUPLICATE_DIAGNOSTICS = ['MA0048'];

describe('generated .editorconfig (scripts/generate-editorconfig.ts)', () => {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: renderEditorConfig() }], '/repo/src/Sample.cs');
  const catalog = editorConfigCatalog();

  it('makes every setting cleanup supports take effect', () => {
    const ignored = catalog.settings.filter(
      (key) => !UNDOCUMENTED_SETTINGS.includes(key) && effectiveEditorConfigValue(props, key) === undefined
    );

    expect(ignored).toEqual([]);
  });

  it('enforces every diagnostic cleanup honors', () => {
    const notEnforced = [...catalog.diagnostics].filter(
      (id) => !DUPLICATE_DIAGNOSTICS.includes(id) && !isEnforced(resolveDiagnosticSeverity(props, id))
    );

    expect(notEnforced).toEqual([]);
  });

  it('writes only values cleanup accepts for the settings it supports', () => {
    expect(unsupportedEditorConfigSettings(props).filter((message) => message.includes('has an unsupported value'))).toEqual([]);
  });

  it('keeps rules cleanup does not apply at suggestion, so they are offered but never break a build', () => {
    expect(resolveDiagnosticSeverity(props, 'IDE0010')).toBe('suggestion');
    expect(resolveDiagnosticSeverity(props, 'IDE0055')).toBe('warning');
  });
});
