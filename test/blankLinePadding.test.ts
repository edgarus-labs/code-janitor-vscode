import { beforeAll, describe, expect, it } from 'vitest';
import { initCSharpParser } from '../src/cleanup/parser';
import { createBlankLinePaddingConverter } from '../src/cleanup/transformations/blankLinePadding';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

beforeAll(async () => {
  await initCSharpParser();
});

type PaddingKey = Extract<keyof CleanupSettings, `insertBlankLinePadding${string}`>;

/** Mirrors the C# suite: every padding setting off, then only the ones under test enabled. */
function apply(source: string, ...enabled: PaddingKey[]): string {
  const settings = createDefaultSettings();
  for (const key of Object.keys(settings) as (keyof CleanupSettings)[]) {
    if (key.startsWith('insertBlankLinePadding')) {
      (settings as Record<string, unknown>)[key] = enabled.includes(key as PaddingKey);
    }
  }

  return createBlankLinePaddingConverter(settings).apply(source);
}

describe('blankLinePaddingConverter', () => {
  it('does not separate a documentation comment from its member', () => {
    const source =
      'class C\r\n{\r\n    int _x;\r\n    /// <summary>\r\n    /// Does a thing.\r\n    /// </summary>\r\n    void M() { }\r\n}\r\n';
    const result = apply(source, 'insertBlankLinePaddingBeforeMethods');

    expect(result).not.toContain('/// </summary>\r\n\r\n    void M()');
    expect(result).toContain('int _x;\r\n\r\n    /// <summary>');
  });

  it('returns the source unchanged when every setting is disabled', () => {
    const source = 'public class Foo { public void Bar() { } }';

    expect(apply(source)).toBe(source);
  });

  it('handles an empty source', () => {
    expect(apply('', 'insertBlankLinePaddingBeforeMethods')).toBe('');
  });

  it('inserts a blank line before a method', () => {
    expect(
      apply(
        'public class Foo\r\n{\r\n    private int _x;\r\n    public void Bar() { }\r\n}\r\n',
        'insertBlankLinePaddingBeforeMethods'
      )
    ).toContain('_x;\r\n\r\n    public void Bar()');
  });

  it('does not double an existing blank line', () => {
    expect(
      apply(
        'public class Foo\r\n{\r\n    private int _x;\r\n\r\n    public void Bar() { }\r\n}\r\n',
        'insertBlankLinePaddingBeforeMethods'
      )
    ).not.toContain('_x;\r\n\r\n\r\n    public void Bar()');
  });

  it('inserts a blank line after a method', () => {
    expect(
      apply(
        'public class Foo\r\n{\r\n    public void Bar() { }\r\n    private int _x;\r\n}\r\n',
        'insertBlankLinePaddingAfterMethods'
      )
    ).toContain('{ }\r\n\r\n    private int _x;');
  });

  it('inserts a blank line before a class', () => {
    expect(
      apply(
        'namespace MyNs\r\n{\r\n    public class Foo { }\r\n    public class Bar { }\r\n}\r\n',
        'insertBlankLinePaddingBeforeClasses'
      )
    ).toContain('Foo { }\r\n\r\n    public class Bar');
  });

  it('skips insertion right after an opening brace', () => {
    expect(
      apply('namespace MyNs\r\n{\r\n    public class Foo { }\r\n}\r\n', 'insertBlankLinePaddingBeforeClasses')
    ).not.toContain('{\r\n\r\n    public class Foo');
  });

  it('skips insertion before a method right after an opening brace', () => {
    expect(
      apply('public class Foo\r\n{\r\n    public void Bar() { }\r\n}\r\n', 'insertBlankLinePaddingBeforeMethods')
    ).not.toContain('{\r\n\r\n    public void Bar()');
  });

  it('inserts a blank line before a single-line property', () => {
    expect(
      apply(
        'public class Foo\r\n{\r\n    private int _x;\r\n    public int X { get; set; }\r\n}\r\n',
        'insertBlankLinePaddingBeforePropertiesSingleLine'
      )
    ).toContain('_x;\r\n\r\n    public int X');
  });

  it('inserts a blank line before an enum', () => {
    expect(
      apply('public class Foo { }\r\npublic enum Bar { A, B }\r\n', 'insertBlankLinePaddingBeforeEnumerations')
    ).toContain('{ }\r\n\r\npublic enum Bar');
  });

  it('inserts a blank line before a struct', () => {
    expect(apply('public class Foo { }\r\npublic struct Bar { }\r\n', 'insertBlankLinePaddingBeforeStructs')).toContain(
      '{ }\r\n\r\npublic struct Bar'
    );
  });

  it('inserts a blank line before an interface', () => {
    expect(
      apply('public class Foo { }\r\npublic interface IBar { }\r\n', 'insertBlankLinePaddingBeforeInterfaces')
    ).toContain('{ }\r\n\r\npublic interface IBar');
  });

  it('inserts a blank line before a region tag', () => {
    expect(
      apply(
        'public class Foo\r\n{\r\n    private int _x;\r\n    #region Methods\r\n    public void Bar() { }\r\n    #endregion\r\n}\r\n',
        'insertBlankLinePaddingBeforeRegionTags'
      )
    ).toContain('_x;\r\n\r\n    #region Methods');
  });

  it('inserts a blank line after an endregion tag', () => {
    expect(
      apply(
        'public class Foo\r\n{\r\n    #region Fields\r\n    private int _x;\r\n    #endregion\r\n    public void Bar() { }\r\n}\r\n',
        'insertBlankLinePaddingAfterEndRegionTags'
      )
    ).toContain('#endregion\r\n\r\n    public void Bar()');
  });

  it('preserves the LF newline style', () => {
    expect(
      apply(
        'public class Foo\n{\n    private int _x;\n    public void Bar() { }\n}\n',
        'insertBlankLinePaddingBeforeMethods'
      )
    ).toContain('_x;\n\n    public void Bar()');
  });

  it('inserts a blank line after a using block', () => {
    expect(apply('using System;\nnamespace N\n{\n}\n', 'insertBlankLinePaddingAfterUsingStatementBlocks')).toContain(
      'using System;\n\nnamespace N'
    );
  });

  it('inserts a blank line before a case statement', () => {
    expect(
      apply(
        'class C\n{\n    void M(int x)\n    {\n        switch (x)\n        {\n            case 1:\n                break;\n            case 2:\n                break;\n        }\n    }\n}\n',
        'insertBlankLinePaddingBeforeCaseStatements'
      )
    ).toContain('break;\n\n            case 2:');
  });

  it('is named', () => {
    expect(createBlankLinePaddingConverter(createDefaultSettings()).name).toBe('Insert blank line padding');
  });
});
