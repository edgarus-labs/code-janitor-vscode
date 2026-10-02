import { describe, expect, it } from 'vitest';
import { MEMBER_TYPE_KEYS, createDefaultReorganizeSettings, parseReorganizeSettings } from '../src/reorganize/settings';

// The defaults of Properties/Settings.settings of the Visual Studio extension.
describe('default reorganize settings', () => {
  const defaults = createDefaultReorganizeSettings();

  it('has the Visual Studio flag defaults', () => {
    expect(defaults).toMatchObject({
      alphabetizeMembersOfTheSameGroup: true,
      explicitMembersAtEnd: false,
      keepMembersWithinRegions: true,
      performWhenPreprocessorConditionals: 'ask',
      primaryOrderByAccessLevel: false,
      reverseOrderByAccessLevel: false,
      runAtStartOfCleanup: false,
      regionsIncludeAccessLevel: false,
      regionsIncludeAccessLevelForMethodsOnly: false,
      regionsInsertKeepEvenIfEmpty: false,
      regionsInsertNewRegions: false,
      regionsRemoveExistingRegions: false,
    });
  });

  it('has the Visual Studio member type order and names', () => {
    const byOrder = [...MEMBER_TYPE_KEYS].sort((a, b) => defaults.memberTypes[a].order - defaults.memberTypes[b].order);

    expect(byOrder).toEqual([
      'fields',
      'constructors',
      'destructors',
      'delegates',
      'events',
      'enums',
      'interfaces',
      'properties',
      'indexers',
      'methods',
      'structs',
      'classes',
    ]);
    expect(defaults.memberTypes.fields).toEqual({ order: 1, name: 'Fields' });
    expect(defaults.memberTypes.classes).toEqual({ order: 12, name: 'Classes' });
  });
});

describe('parsing reorganize settings', () => {
  it('falls back to the defaults for missing or malformed values', () => {
    const defaults = createDefaultReorganizeSettings();
    const values: Record<string, unknown> = {
      alphabetizeMembersOfTheSameGroup: 'yes',
      performWhenPreprocessorConditionals: 'maybe',
      fieldsOrder: 'x',
      methodsOrder: 2.5,
      classesOrder: -1,
      propertiesName: '   ',
      structsName: 3,
    };

    expect(parseReorganizeSettings((key) => values[key])).toEqual(defaults);
  });

  it('reads flags, the preprocessor policy and the order and name of each member type', () => {
    const values: Record<string, unknown> = {
      explicitMembersAtEnd: true,
      performWhenPreprocessorConditionals: 'yes',
      regionsInsertNewRegions: true,
      fieldsOrder: 10,
      fieldsName: ' Member Variables ',
      methodsOrder: 1,
    };
    const parsed = parseReorganizeSettings((key) => values[key]);

    expect(parsed.explicitMembersAtEnd).toBe(true);
    expect(parsed.performWhenPreprocessorConditionals).toBe('yes');
    expect(parsed.regionsInsertNewRegions).toBe(true);
    expect(parsed.memberTypes.fields).toEqual({ order: 10, name: 'Member Variables' });
    expect(parsed.memberTypes.methods).toEqual({ order: 1, name: 'Methods' });
    expect(parsed.memberTypes.classes).toEqual({ order: 12, name: 'Classes' });
  });
});
