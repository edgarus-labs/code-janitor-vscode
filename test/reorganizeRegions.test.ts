import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { createDefaultReorganizeSettings } from '../src/reorganize/settings';
import { reorganize, withoutPadding } from './helpers/reorganize';

const REGIONS = [
  'class C',
  '{',
  '    #region Methods',
  '    public void B() { }',
  '    public void A() { }',
  '    #endregion',
  '',
  '    #region Fields',
  '    private int _b;',
  '    private int _a;',
  '    #endregion',
  '}',
  '',
].join('\n');

describe('reorganize: members and existing regions', () => {
  it('sorts the members inside each region and leaves the regions where they are', () => {
    expect(reorganize(REGIONS)).toBe(
      [
        'class C',
        '{',
        '    #region Methods',
        '    public void A() { }',
        '    public void B() { }',
        '    #endregion',
        '',
        '    #region Fields',
        '    private int _a;',
        '    private int _b;',
        '    #endregion',
        '}',
        '',
      ].join('\n')
    );
  });

  it('sorts the members that are outside of regions among themselves', () => {
    const source = 'class C\n{\n    void B() { }\n    #region R\n    int _b;\n    int _a;\n    #endregion\n    int _c;\n}\n';

    expect(reorganize(source)).toBe('class C\n{\n    int _c;\n    #region R\n    int _a;\n    int _b;\n    #endregion\n    void B() { }\n}\n');
  });

  it('sorts members across regions, leaving the directives in place, when not keeping members within regions', () => {
    expect(reorganize(REGIONS, { keepMembersWithinRegions: false })).toBe(
      [
        'class C',
        '{',
        '    #region Methods',
        '    private int _a;',
        '    private int _b;',
        '    #endregion',
        '',
        '    #region Fields',
        '    public void A() { }',
        '    public void B() { }',
        '    #endregion',
        '}',
        '',
      ].join('\n')
    );
  });

  it('sorts inside nested regions', () => {
    const source = 'class C\n{\n    #region Outer\n    #region Inner\n    void B() { }\n    void A() { }\n    #endregion\n    #endregion\n}\n';

    expect(reorganize(source)).toBe('class C\n{\n    #region Outer\n    #region Inner\n    void A() { }\n    void B() { }\n    #endregion\n    #endregion\n}\n');
  });

  it('leaves a file whose regions are already in order byte for byte', () => {
    const source = 'class C\r\n{\r\n\r\n    #region Fields\r\n\r\n    int _a;\r\n\r\n    #endregion Fields\r\n\r\n}\r\n';

    expect(reorganize(source)).toBe(source);
  });
});

describe('reorganize: removing existing regions', () => {
  const source = [
    'class C',
    '{',
    '    #region Helpers',
    '    void B() { }',
    '    void A() { }',
    '    #endregion',
    '',
    '    #region Fields',
    '    int _b;',
    '    int _a;',
    '    #endregion',
    '}',
    '',
  ].join('\n');

  it('removes the regions whose name is not the name of a group of their members, keeping the others', () => {
    expect(reorganize(source, { regionsRemoveExistingRegions: true })).toBe(
      ['class C', '{', '    void A() { }', '    void B() { }', '', '    #region Fields', '    int _a;', '    int _b;', '    #endregion', '}', ''].join('\n')
    );
  });

  it('removes the nested regions of a removed region too', () => {
    const nested = 'class C\n{\n    #region Outer\n    #region Inner\n    void B() { }\n    void A() { }\n    #endregion\n    #endregion\n}\n';

    expect(reorganize(nested, { regionsRemoveExistingRegions: true })).toBe('class C\n{\n    void A() { }\n    void B() { }\n}\n');
  });

  it('keeps the regions of every standard name when empty regions are kept', () => {
    const empty = 'class C\n{\n    #region Constructors\n    #endregion\n    #region Mine\n    #endregion\n}\n';

    expect(reorganize(empty, { regionsRemoveExistingRegions: true, regionsInsertKeepEvenIfEmpty: true })).toBe(
      'class C\n{\n    #region Constructors\n    #endregion\n}\n'
    );
  });
});

describe('reorganize: inserting regions', () => {
  const members = 'class C\n{\n    int _b;\n    void B() { }\n    int _a;\n    void A() { }\n}\n';

  it('puts a region around each group of members, with the #endregion named like the #region', () => {
    expect(reorganize(members, { regionsInsertNewRegions: true }, withoutPadding())).toBe(
      [
        'class C',
        '{',
        '    #region Fields',
        '    int _a;',
        '    int _b;',
        '    #endregion Fields',
        '    #region Methods',
        '    void A() { }',
        '    void B() { }',
        '    #endregion Methods',
        '}',
        '',
      ].join('\n')
    );
  });

  it('leaves the #endregion unnamed when the cleanup does not name it', () => {
    const cleanup = { ...withoutPadding(), updateEndRegionDirectives: false };

    expect(reorganize(members, { regionsInsertNewRegions: true }, cleanup)).toContain('    #endregion\n');
  });

  it('pads the region tags the way the cleanup padding settings ask', () => {
    expect(reorganize(members, { regionsInsertNewRegions: true }, createDefaultSettings())).toBe(
      [
        'class C',
        '{',
        '    #region Fields',
        '',
        '    int _a;',
        '    int _b;',
        '',
        '    #endregion Fields',
        '',
        '    #region Methods',
        '',
        '    void A() { }',
        '',
        '    void B() { }',
        '',
        '    #endregion Methods',
        '}',
        '',
      ].join('\n')
    );
  });

  it('replaces the existing regions when inserting and removing', () => {
    const existing = 'class C\n{\n    #region Stuff\n    int _b;\n    void B() { }\n    #endregion\n    int _a;\n}\n';

    expect(reorganize(existing, { regionsInsertNewRegions: true, regionsRemoveExistingRegions: true }, withoutPadding())).toBe(
      ['class C', '{', '    #region Fields', '    int _a;', '    int _b;', '    #endregion Fields', '    #region Methods', '    void B() { }', '    #endregion Methods', '}', ''].join('\n')
    );
  });

  it('keeps an existing region of the same name and sorts inside it', () => {
    const existing = 'class C\n{\n    #region Fields\n    int _b;\n    int _a;\n    #endregion\n    void B() { }\n}\n';

    expect(reorganize(existing, { regionsInsertNewRegions: true }, withoutPadding())).toBe(
      ['class C', '{', '    #region Fields', '    int _a;', '    int _b;', '    #endregion', '    #region Methods', '    void B() { }', '    #endregion Methods', '}', ''].join('\n')
    );
  });

  it('includes the access level in the region names', () => {
    const source = 'class C\n{\n    private void B() { }\n    public void A() { }\n    private int _f;\n}\n';

    expect(reorganize(source, { regionsInsertNewRegions: true, regionsIncludeAccessLevel: true }, withoutPadding())).toBe(
      [
        'class C',
        '{',
        '    #region Private Fields',
        '    private int _f;',
        '    #endregion Private Fields',
        '    #region Public Methods',
        '    public void A() { }',
        '    #endregion Public Methods',
        '    #region Private Methods',
        '    private void B() { }',
        '    #endregion Private Methods',
        '}',
        '',
      ].join('\n')
    );
  });

  it('includes the access level for methods only', () => {
    const source = 'class C\n{\n    private void B() { }\n    private int _f;\n}\n';
    const result = reorganize(source, { regionsInsertNewRegions: true, regionsIncludeAccessLevel: true, regionsIncludeAccessLevelForMethodsOnly: true }, withoutPadding());

    expect(result).toContain('#region Fields');
    expect(result).toContain('#region Private Methods');
  });

  it('inserts the regions that are kept even when empty, in the order of the groups', () => {
    const source = 'class C\n{\n    void B() { }\n    int _f;\n}\n';
    const result = reorganize(source, { regionsInsertNewRegions: true, regionsInsertKeepEvenIfEmpty: true }, withoutPadding());
    const names = [...result.matchAll(/#region (.*)/g)].map((match) => match[1]);

    expect(names).toEqual(['Fields', 'Constructors', 'Destructors', 'Delegates', 'Events', 'Enums', 'Interfaces', 'Properties', 'Indexers', 'Methods', 'Structs', 'Classes']);
    expect(result).toContain('    #region Constructors\n    #endregion Constructors\n');
  });

  it('inserts empty regions into a type without members', () => {
    const result = reorganize('class C\n{\n}\n', { regionsInsertNewRegions: true, regionsInsertKeepEvenIfEmpty: true }, withoutPadding());

    expect(result.startsWith('class C\n{\n    #region Fields\n    #endregion Fields\n    #region Constructors\n')).toBe(true);
    expect(result.endsWith('    #endregion Classes\n}\n')).toBe(true);
  });

  it('names the regions of a configured group after the first member type of the group', () => {
    const memberTypes = createDefaultReorganizeSettings().memberTypes;
    memberTypes.properties = { order: 1, name: 'Data' };
    memberTypes.fields = { order: 1, name: 'Data' };
    const source = 'class C\n{\n    int P { get; set; }\n    int _f;\n}\n';

    expect(reorganize(source, { memberTypes, regionsInsertNewRegions: true }, withoutPadding())).toContain('#region Data');
  });

  it('does not insert regions around the types of a namespace', () => {
    const source = 'namespace N\n{\n    class B { }\n    struct S { }\n}\n';

    expect(reorganize(source, { regionsInsertNewRegions: true })).not.toContain('#region');
  });

  it('inserts regions in structs and interfaces and keeps the line endings', () => {
    const source = 'interface I\r\n{\r\n    void B();\r\n    int P { get; }\r\n}\r\n';
    const result = reorganize(source, { regionsInsertNewRegions: true }, withoutPadding());

    expect(result).toBe('interface I\r\n{\r\n    #region Properties\r\n    int P { get; }\r\n    #endregion Properties\r\n    #region Methods\r\n    void B();\r\n    #endregion Methods\r\n}\r\n');
  });
});
