import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { insertRegionAroundLines } from '../src/text/regionEdits';
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
    expect(insertRegionAroundLines('{\r\n  a;\r\n}\r\n', 1, 1, withoutPadding()).text).toBe(
      '{\r\n  #region New Region\r\n  a;\r\n  #endregion New Region\r\n}\r\n'
    );
  });

  it('counts every line break of a file with mixed line endings, as the editor does', () => {
    const result = insertRegionAroundLines('class C\r\n{\n    int a;\r\n    int b;\r\n}\r\n', 3, 3, withoutPadding());

    expect(result.text).toBe('class C\r\n{\n    int a;\r\n    #region New Region\r\n    int b;\r\n    #endregion New Region\r\n}\r\n');
    expect(result.nameLine).toBe(3);
  });
});
