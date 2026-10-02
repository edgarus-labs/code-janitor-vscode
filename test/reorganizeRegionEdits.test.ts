import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { insertRegionAroundLines, removeRegionAt, removeRegionsInLines } from '../src/reorganize/regionEdits';
import { withoutPadding } from './helpers/padding';

// Ported from SpadeContextInsertRegionCommand / SpadeContextRemoveRegionCommand / RemoveRegionCommand.
describe('insert region around lines', () => {
  const source = 'class C\n{\n    int _a;\n    void M() { }\n    int _b;\n}\n';

  it('puts #region above and #endregion below the lines, indented like them, named New Region', () => {
    const result = insertRegionAroundLines(source, 2, 3, withoutPadding());

    expect(result.text).toBe('class C\n{\n    #region New Region\n    int _a;\n    void M() { }\n    #endregion New Region\n    int _b;\n}\n');
    expect(result.nameLine).toBe(2);
    expect(result.text.split('\n')[2].slice(result.nameStart, result.nameEnd)).toBe('New Region');
  });

  it('leaves the #endregion unnamed when the cleanup does not name it', () => {
    const result = insertRegionAroundLines(source, 2, 2, { ...withoutPadding(), updateEndRegionDirectives: false });

    expect(result.text).toContain('    #endregion\n');
  });

  it('pads the tags with blank lines per the cleanup settings, except at a brace', () => {
    const result = insertRegionAroundLines(source, 2, 3, createDefaultSettings());

    // After the `{` line no blank line goes before the region; before the `}` none goes after the #endregion.
    expect(result.text).toBe('class C\n{\n    #region New Region\n\n    int _a;\n    void M() { }\n\n    #endregion New Region\n\n    int _b;\n}\n');
    expect(insertRegionAroundLines(source, 3, 4, createDefaultSettings()).text).toBe(
      'class C\n{\n    int _a;\n\n    #region New Region\n\n    void M() { }\n    int _b;\n\n    #endregion New Region\n}\n'
    );
  });

  it('uses the line endings of the file', () => {
    expect(insertRegionAroundLines('{\r\n  a;\r\n}\r\n', 1, 1, withoutPadding()).text).toBe('{\r\n  #region New Region\r\n  a;\r\n  #endregion New Region\r\n}\r\n');
  });

  it('counts every line break of a file with mixed line endings, as the editor does', () => {
    const result = insertRegionAroundLines('class C\r\n{\n    int a;\r\n    int b;\r\n}\r\n', 3, 3, withoutPadding());

    expect(result.text).toBe('class C\r\n{\n    int a;\r\n    #region New Region\r\n    int b;\r\n    #endregion New Region\r\n}\r\n');
    expect(result.nameLine).toBe(3);
  });
});

describe('remove regions', () => {
  const source = 'class C\n{\n    #region A\n    int _a;\n    #endregion\n\n    #region B\n    int _b;\n    #endregion B\n}\n';

  it('removes the region whose directive is on a line, and nothing for a line without a directive', () => {
    const withoutA = 'class C\n{\n    int _a;\n    #region B\n    int _b;\n    #endregion B\n}\n';

    expect(removeRegionAt(source, 2)).toBe(withoutA);
    expect(removeRegionAt(source, 4)).toBe(withoutA);
    expect(removeRegionAt(source, 3)).toBe(source);
    expect(removeRegionAt(source, 8)).toBe('class C\n{\n    #region A\n    int _a;\n    #endregion\n    int _b;\n}\n');
  });

  it('removes only the region whose directive is on the line, not the regions nested in it', () => {
    const nested = '#region Outer\n#region Inner\na;\n#endregion\n#endregion\n';

    expect(removeRegionAt(nested, 0)).toBe('#region Inner\na;\n#endregion\n');
    expect(removeRegionAt(nested, 3)).toBe('#region Outer\na;\n#endregion\n');
  });

  it('removes the directives of the regions inside the lines and the blank lines around them', () => {
    expect(removeRegionsInLines(source, 2, 4)).toBe('class C\n{\n    int _a;\n    #region B\n    int _b;\n    #endregion B\n}\n');
    expect(removeRegionsInLines(source, 0, 9)).toBe('class C\n{\n    int _a;\n    int _b;\n}\n');
  });

  it('removes nothing for a region that is not entirely inside the lines', () => {
    expect(removeRegionsInLines(source, 3, 7)).toBe(source);
  });

  it('removes nested regions and leaves regions outside the lines', () => {
    const nested = '#region Outer\n#region Inner\na;\n#endregion\n#endregion\n#region Other\nb;\n#endregion\n';

    expect(removeRegionsInLines(nested, 0, 4)).toBe('a;\n#region Other\nb;\n#endregion\n');
  });

  it('keeps the line endings', () => {
    expect(removeRegionsInLines('x;\r\n#region A\r\ny;\r\n#endregion\r\nz;\r\n', 0, 4)).toBe('x;\r\ny;\r\nz;\r\n');
  });

  it('counts every line break of a file with mixed line endings, as the editor does', () => {
    expect(removeRegionsInLines('x;\r\ny;\n#region A\r\nz;\r\n#endregion\r\nw;\r\n', 2, 4)).toBe('x;\r\ny;\nz;\r\nw;\r\n');
    expect(removeRegionsInLines('x;\n#region A\r\ny;\r\n#endregion', 1, 3)).toBe('x;\ny;');
  });
});
