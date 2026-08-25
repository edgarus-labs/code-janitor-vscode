import { describe, expect, it } from 'vitest';
import {
  byteOrderMarkConverter,
  commentFormatConverter,
  createTabToSpaceConverter,
  ensureFinalNewlineConverter,
  normalizeBlankLinesConverter,
  regionDirectiveRemover,
  removeTrailingWhitespaceConverter,
  updateEndRegionDirectivesConverter,
} from '../src/cleanup/transformations/text';

describe('byteOrderMarkConverter', () => {
  it('removes a leading BOM', () => {
    expect(byteOrderMarkConverter.apply('\uFEFFclass C { }')).toBe('class C { }');
  });

  it('leaves sources without a BOM unchanged', () => {
    expect(byteOrderMarkConverter.apply('class C { }')).toBe('class C { }');
  });

  it('only removes the BOM at the start', () => {
    expect(byteOrderMarkConverter.apply('class C\uFEFF { }')).toBe('class C\uFEFF { }');
  });

  it('handles an empty source', () => {
    expect(byteOrderMarkConverter.apply('')).toBe('');
  });

  it('is named', () => {
    expect(byteOrderMarkConverter.name).toBe('Remove Byte Order Mark (BOM)');
  });
});

describe('ensureFinalNewlineConverter', () => {
  it('appends a newline when missing', () => {
    expect(ensureFinalNewlineConverter.apply('class C\n{\n}')).toBe('class C\n{\n}\n');
  });

  it('collapses multiple trailing newlines to one', () => {
    expect(ensureFinalNewlineConverter.apply('class C\n{\n}\n\n\n')).toBe('class C\n{\n}\n');
  });

  it('matches the CRLF style of the file', () => {
    expect(ensureFinalNewlineConverter.apply('class C\r\n{\r\n}')).toBe('class C\r\n{\r\n}\r\n');
  });

  it('leaves an already correct source unchanged', () => {
    expect(ensureFinalNewlineConverter.apply('class C\n{\n}\n')).toBe('class C\n{\n}\n');
  });

  it('handles an empty source', () => {
    expect(ensureFinalNewlineConverter.apply('')).toBe('');
  });

  it('is named', () => {
    expect(ensureFinalNewlineConverter.name).toBe('Ensure final newline');
  });
});

describe('normalizeBlankLinesConverter', () => {
  it('collapses two blank lines to one', () => {
    expect(normalizeBlankLinesConverter.apply('a\n\n\nb')).toBe('a\n\nb');
  });

  it('collapses many blank lines to one', () => {
    expect(normalizeBlankLinesConverter.apply('a\n\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('treats whitespace-only lines as blank', () => {
    expect(normalizeBlankLinesConverter.apply('a\n\n   \n\t\n\nb')).toBe('a\n\nb');
  });

  it('keeps a single blank line', () => {
    expect(normalizeBlankLinesConverter.apply('a\n\nb')).toBe('a\n\nb');
  });

  it('preserves CRLF endings', () => {
    expect(normalizeBlankLinesConverter.apply('a\r\n\r\n\r\nb')).toBe('a\r\n\r\nb');
  });

  it('handles an empty source', () => {
    expect(normalizeBlankLinesConverter.apply('')).toBe('');
  });
});

describe('regionDirectiveRemover', () => {
  it('removes region and endregion lines', () => {
    const source = 'class C\n{\n    #region Fields\n    int x;\n    #endregion\n}\n';

    expect(regionDirectiveRemover.apply(source)).toBe('class C\n{\n    int x;\n}\n');
  });

  it('preserves other preprocessor directives', () => {
    const source = '#if DEBUG\n#region A\nint x;\n#endregion\n#endif\n';

    expect(regionDirectiveRemover.apply(source)).toBe('#if DEBUG\nint x;\n#endif\n');
  });

  it('is named', () => {
    expect(regionDirectiveRemover.name).toBe('Remove region directives');
  });
});

describe('removeTrailingWhitespaceConverter', () => {
  const convert = (source: string) => removeTrailingWhitespaceConverter.apply(source);

  it('removes trailing spaces after code', () => {
    expect(convert('class C\n{\n    int x;   \n}\n')).toBe('class C\n{\n    int x;\n}\n');
  });

  it('removes trailing tabs after code', () => {
    expect(convert('class C\n{\n    int x;\t\t\n}\n')).toBe('class C\n{\n    int x;\n}\n');
  });

  it('empties whitespace-only lines', () => {
    expect(convert('class C\n{\n   \n}\n')).toBe('class C\n{\n\n}\n');
  });

  it('preserves indentation', () => {
    const input = 'class C\n{\n    int x;\n}\n';

    expect(convert(input)).toBe(input);
  });

  it('preserves trailing whitespace inside a verbatim string', () => {
    const input = 'class C\n{\n    string s = @"a   \nb";\n}\n';

    expect(convert(input)).toBe(input);
  });

  it('preserves trailing whitespace inside comment text', () => {
    const input = 'class C\n{\n    // comment   \n    int x;   \n}\n';

    expect(convert(input)).toBe('class C\n{\n    // comment   \n    int x;\n}\n');
  });

  it('removes trailing whitespace at end of file without a newline', () => {
    expect(convert('class C { }   ')).toBe('class C { }');
  });

  it('handles CRLF endings', () => {
    expect(convert('class C\r\n{\r\n    int x;   \r\n}\r\n')).toBe('class C\r\n{\r\n    int x;\r\n}\r\n');
  });

  it('leaves clean sources unchanged', () => {
    const input = 'using System;\n\nclass C\n{\n}\n';

    expect(convert(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(convert('')).toBe('');
  });

  it('is named', () => {
    expect(removeTrailingWhitespaceConverter.name).toBe('Remove trailing whitespace');
  });
});

describe('tabToSpaceConverter', () => {
  it('expands an indentation tab to four spaces by default', () => {
    expect(createTabToSpaceConverter().apply('class C\n{\n\tint x;\n}\n')).toBe('class C\n{\n    int x;\n}\n');
  });

  it('expands to a custom tab size', () => {
    expect(createTabToSpaceConverter(2).apply('class C\n{\n\tint x;\n}\n')).toBe('class C\n{\n  int x;\n}\n');
  });

  it('preserves a tab inside a string literal', () => {
    const input = 'class C\n{\n\tstring s = "a\tb";\n}\n';

    expect(createTabToSpaceConverter().apply(input)).toBe('class C\n{\n    string s = "a\tb";\n}\n');
  });

  it('preserves a tab inside a verbatim string', () => {
    const input = 'class C\n{\n\tstring s = @"a\tb";\n}\n';

    expect(createTabToSpaceConverter().apply(input)).toBe('class C\n{\n    string s = @"a\tb";\n}\n');
  });

  it('preserves a tab inside comment text', () => {
    const input = 'class C\n{\n\t// a\tb\n}\n';

    expect(createTabToSpaceConverter().apply(input)).toBe('class C\n{\n    // a\tb\n}\n');
  });

  it('leaves tab-free sources unchanged', () => {
    const input = 'class C\n{\n    int x;\n}\n';

    expect(createTabToSpaceConverter().apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(createTabToSpaceConverter().apply('')).toBe('');
  });

  it('rejects a tab size below one', () => {
    expect(() => createTabToSpaceConverter(0)).toThrow(RangeError);
  });

  it('is named', () => {
    expect(createTabToSpaceConverter().name).toBe('Convert tabs to spaces');
  });
});

describe('updateEndRegionDirectivesConverter', () => {
  const apply = (source: string) => updateEndRegionDirectivesConverter.apply(source);

  it('leaves an empty source unchanged', () => {
    expect(apply('')).toBe('');
  });

  it('leaves sources without regions unchanged', () => {
    const source = 'public class MyClass\r\n{\r\n}\r\n';

    expect(apply(source)).toBe(source);
  });

  it('keeps a bare endregion for an unnamed region', () => {
    const source =
      'public class MyClass\r\n{\r\n    #region\r\n    public void MyMethod() { }\r\n    #endregion\r\n}\r\n';

    expect(apply(source)).toContain('#endregion\r\n');
  });

  it('renames the endregion to match its region', () => {
    const source =
      'public class MyClass\r\n{\r\n    #region MyRegion\r\n    public void MyMethod() { }\r\n    #endregion WrongName\r\n}\r\n';

    expect(apply(source)).toContain('#endregion MyRegion');
  });

  it('updates every endregion', () => {
    const source =
      'public class MyClass\r\n{\r\n    #region Fields\r\n    private int _field;\r\n    #endregion\r\n\r\n    #region Methods\r\n    public void MyMethod() { }\r\n    #endregion\r\n}\r\n';
    const result = apply(source);

    expect(result).toContain('#endregion Fields');
    expect(result).toContain('#endregion Methods');
  });

  it('matches nested regions through the stack', () => {
    const source = '#region Outer\r\n#region Inner\r\npublic class MyClass { }\r\n#endregion\r\n#endregion\r\n';
    const result = apply(source);

    expect(result).toContain('#endregion Inner');
    expect(result).toContain('#endregion Outer');
  });

  it('normalizes whitespace around the region name', () => {
    const source = '#region   MyRegion   \r\ncode\r\n#endregion\r\n';

    expect(apply(source)).toContain('#endregion MyRegion');
  });

  it('preserves indentation', () => {
    const source =
      'public class MyClass\r\n{\r\n        #region Fields\r\n        private int _field;\r\n        #endregion OldName\r\n}\r\n';

    expect(apply(source)).toContain('        #endregion Fields');
  });

  it('keeps mismatched endregions as-is', () => {
    const source = '#region Fields\r\n#endregion WrongName1\r\n#endregion WrongName2\r\n';
    const result = apply(source);

    expect(result).toContain('#endregion Fields');
    expect(result).toContain('#endregion WrongName2');
  });

  it('preserves the original line endings', () => {
    const source = '#region A\nx\n#endregion\n';

    expect(apply(source)).toBe('#region A\nx\n#endregion A\n');
  });
});

describe('commentFormatConverter', () => {
  const apply = (source: string) => commentFormatConverter.apply(source);

  it('leaves an empty source unchanged', () => {
    expect(apply('')).toBe('');
  });

  it('leaves comment-free sources unchanged', () => {
    expect(apply('public class MyClass { }')).toBe('public class MyClass { }');
  });

  it('normalizes extra spacing after the slashes', () => {
    expect(apply('//  comment with extra spaces\r\npublic class MyClass { }')).toContain(
      '// comment with extra spaces'
    );
  });

  it('adds a missing space after the slashes', () => {
    expect(apply('//comment\r\npublic class MyClass { }')).toContain('// comment');
  });

  it('preserves indentation', () => {
    expect(apply('    // indented comment\r\npublic class MyClass { }')).toContain('    // indented comment');
  });

  it('normalizes an empty comment', () => {
    expect(apply('//\r\npublic class MyClass { }')).toContain('//');
  });

  it('preserves a single-line block comment', () => {
    expect(apply('/* comment */\r\npublic class MyClass { }')).toContain('/* comment */');
  });

  it('formats every comment', () => {
    const result = apply('//  comment1\r\n//  comment2\r\npublic class MyClass { }');

    expect(result).toContain('// comment1');
    expect(result).toContain('// comment2');
  });

  it('preserves the LF newline style', () => {
    const result = apply('// comment\n// another');

    expect(result).toContain('\n');
    expect(result).not.toContain('\r\n');
  });

  it('realigns continuation lines of a block comment', () => {
    const result = apply('    /* first\n*  second\n    */\nclass C { }');

    expect(result).toContain('     *  second');
  });

  it('does not split XML documentation comments into "// /"', () => {
    expect(apply('/// <summary>Doc.</summary>\nclass C { }')).toContain('/// <summary>Doc.</summary>');
  });

  it('adds a missing space after the slashes of an XML documentation comment', () => {
    expect(apply('///<summary>Doc.</summary>')).toBe('/// <summary>Doc.</summary>');
  });

  it('normalizes extra spacing after XML documentation comment slashes', () => {
    expect(apply('///   <summary>Doc.</summary>')).toBe('/// <summary>Doc.</summary>');
  });

  it('preserves indentation of an XML documentation comment', () => {
    expect(apply('    /// <summary>Doc.</summary>')).toBe('    /// <summary>Doc.</summary>');
  });

  it('leaves a commented-out-code marker (four slashes) intact', () => {
    expect(apply('////oldCode();')).toBe('//// oldCode();');
  });
});
