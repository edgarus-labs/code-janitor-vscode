import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE_STYLE_GROUPS,
  CODE_STYLE_RULES,
  codeStyleSettingProperties,
  formatCodeStyleSetting,
  getCodeStyleRule,
  parseCodeStyleSetting,
} from '../src/cleanup/codeStyleRules';
import { editorConfigCatalog } from '../src/cleanup/editorConfigRegistry';

describe('Code Style rules catalog', () => {
  it('lists the 53 rules of the Visual Studio catalog, each key once', () => {
    const keys = CODE_STYLE_RULES.map((rule) => rule.key);

    expect(keys).toHaveLength(53);
    expect(new Set(keys).size).toBe(53);
  });

  it('groups every rule under one of the Visual Studio groups, in group order', () => {
    expect(CODE_STYLE_GROUPS).toEqual([
      'Modifiers',
      'Blocks',
      'Expression-bodied members',
      'Pattern matching',
      'Null checking',
      'Modern expressions',
      "'this.' qualification",
      'Language keywords vs. framework type names',
      'Parentheses',
    ]);
    expect(CODE_STYLE_RULES.every((rule) => CODE_STYLE_GROUPS.includes(rule.group))).toBe(true);
    const order = CODE_STYLE_RULES.map((rule) => CODE_STYLE_GROUPS.indexOf(rule.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('proposes a valid value for every rule and names its diagnostics', () => {
    for (const rule of CODE_STYLE_RULES) {
      expect(rule.isValidValue(rule.defaultValue), rule.key).toBe(true);
      expect(rule.diagnosticIds.length, rule.key).toBeGreaterThan(0);
      expect(rule.diagnosticIds.every((id) => /^IDE\d{4}$/.test(id)), rule.key).toBe(true);
    }
  });

  it('has an implementation in the rule engine for every rule option', () => {
    const implemented = new Set(editorConfigCatalog().settings);

    expect(CODE_STYLE_RULES.filter((rule) => !implemented.has(rule.key)).map((rule) => rule.key)).toEqual([]);
  });

  it('validates csharp_preferred_modifier_order as distinct known modifiers', () => {
    const order = getCodeStyleRule('csharp_preferred_modifier_order')!;

    expect(order.isValidValue('public,static,readonly')).toBe(true);
    expect(order.isValidValue('public, static')).toBe(true);
    expect(order.isValidValue('public,loud')).toBe(false);
    expect(order.isValidValue('public,public')).toBe(false);
    expect(order.isValidValue('')).toBe(false);
  });
});

describe('Code Style setting', () => {
  it('accepts values ignoring case and normalizes them', () => {
    const values = parseCodeStyleSetting({
      csharp_prefer_braces: 'False',
      dotnet_style_null_propagation: 'sometimes',
      csharp_style_expression_bodied_methods: 'When_On_Single_Line',
    });

    expect(values).toEqual({ csharp_prefer_braces: 'false', csharp_style_expression_bodied_methods: 'when_on_single_line' });
    expect(formatCodeStyleSetting({ csharp_prefer_braces: 'FALSE' })).toEqual({ csharp_prefer_braces: 'false' });
  });

  it('ignores unknown keys, invalid values, JSON booleans and anything that is not an object', () => {
    expect(
      parseCodeStyleSetting({ unknown_key: 'true', csharp_prefer_braces: true, csharp_preferred_modifier_order: 'public,loud', dotnet_style_null_propagation: null })
    ).toEqual({});
    expect(parseCodeStyleSetting(undefined)).toEqual({});
    expect(parseCodeStyleSetting(['csharp_prefer_braces'])).toEqual({});
    expect(parseCodeStyleSetting('csharp_prefer_braces=true')).toEqual({});
  });

  it('formats the enabled rules in catalog order', () => {
    expect(Object.keys(formatCodeStyleSetting({ dotnet_style_null_propagation: 'true', csharp_prefer_braces: 'true', unknown: 'true' }))).toEqual([
      'csharp_prefer_braces',
      'dotnet_style_null_propagation',
    ]);
  });

  it('is declared in package.json with one property per rule, all off by default', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; properties?: unknown; additionalProperties?: unknown }> }[] };
    };
    const declared = manifest.contributes.configuration.flatMap((section) => Object.entries(section.properties)).find(([key]) => key === 'codeJanitor.cleanup.codeStyleRules');

    expect(declared, 'codeJanitor.cleanup.codeStyleRules is declared in package.json').toBeDefined();
    expect(declared![1].default).toEqual({});
    expect(declared![1].additionalProperties).toBe(false);
    expect(declared![1].properties).toEqual(JSON.parse(JSON.stringify(codeStyleSettingProperties())));
  });

  it('accepts null per rule, so a Workspace value can turn off a rule the User settings enable', () => {
    for (const property of Object.values(codeStyleSettingProperties())) {
      expect(property.type).toEqual(['string', 'null']);
      // A JSON Schema enum admits only what it lists, whatever `type` says.
      expect(property.enum === undefined || property.enum.includes(null)).toBe(true);
    }
    // VS Code merges the object across scopes: the Workspace null wins over the User value and reads as off.
    expect(parseCodeStyleSetting({ ...{ csharp_prefer_braces: 'true' }, ...{ csharp_prefer_braces: null } })).toEqual({});
  });
});
