import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { insertRegionAroundLines, regionLinesAt, removeRegionsInLines } from '../src/reorganize/regionEdits';
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
});

describe('remove regions', () => {
  const source = 'class C\n{\n    #region A\n    int _a;\n    #endregion\n\n    #region B\n    int _b;\n    #endregion B\n}\n';

  it('finds the region whose directive is on a line', () => {
    expect(regionLinesAt(source, 2)).toEqual({ startLine: 2, endLine: 4 });
    expect(regionLinesAt(source, 4)).toEqual({ startLine: 2, endLine: 4 });
    expect(regionLinesAt(source, 3)).toBeUndefined();
    expect(regionLinesAt(source, 8)).toEqual({ startLine: 6, endLine: 8 });
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
});
