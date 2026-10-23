import { describe, expect, it } from 'vitest';
import { CODE_STYLE_RULES } from '../src/cleanup/codeStyleRules';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ENFORCED_DIAGNOSTIC_IDS, renderEditorConfig } from '../scripts/editorConfigTemplate';

describe('generated .editorconfig (scripts/generate-editorconfig.ts)', () => {
  const text = renderEditorConfig();
  const props = resolveEditorConfigProperties([{ directory: '/repo', text }], '/repo/src/Sample.cs');

  it('enforces every documented style rule, so that the Roslyn engine applies each one it can fix', () => {
    expect(props.get('dotnet_diagnostic.IDE0010.severity')).toBe('warning');
    expect(props.get('dotnet_diagnostic.IDE0055.severity')).toBe('warning');
    expect(text).not.toMatch(/severity = suggestion/);
  });

  it('enforces every diagnostic it lists, once', () => {
    expect(ENFORCED_DIAGNOSTIC_IDS.filter((id) => props.get(`dotnet_diagnostic.${id}.severity`) !== 'warning')).toEqual([]);
    expect(new Set(ENFORCED_DIAGNOSTIC_IDS).size).toBe(ENFORCED_DIAGNOSTIC_IDS.length);
  });

  it('sets the option of every Code Style rule of the catalog', () => {
    expect(CODE_STYLE_RULES.filter((rule) => props.get(rule.key) === undefined).map((rule) => rule.key)).toEqual([]);
  });
});
