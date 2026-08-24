import { beforeAll, describe, expect, it } from 'vitest';
import { initCSharpParser } from '../src/cleanup/parser';
import { runLayoutCleanup } from '../src/cleanup/runCleanup';
import {
  hasXmlDocumentation,
  removeXmlDocumentationConverter,
} from '../src/cleanup/transformations/removeXmlDocumentation';
import { createDefaultSettings } from '../src/cleanup/types';

beforeAll(async () => {
  await initCSharpParser();
});

describe('removeXmlDocumentationConverter', () => {
  const apply = (source: string) => removeXmlDocumentationConverter.apply(source);

  it('removes a documentation block with its indentation and line break', () => {
    const source =
      'class C\n{\n    /// <summary>\n    /// Does a thing.\n    /// </summary>\n    void M() { }\n}\n';

    expect(apply(source)).toBe('class C\n{\n    void M() { }\n}\n');
  });

  it('removes a multi-line documentation comment', () => {
    const source = 'class C\n{\n    /** Does a thing. */\n    void M() { }\n}\n';

    expect(apply(source)).toBe('class C\n{\n    void M() { }\n}\n');
  });

  it('keeps regular comments', () => {
    const source = 'class C\n{\n    // keep me\n    /// remove me\n    void M() { }\n}\n';

    expect(apply(source)).toBe('class C\n{\n    // keep me\n    void M() { }\n}\n');
  });

  it('leaves a file without documentation unchanged', () => {
    const source = 'class C\n{\n    void M() { }\n}\n';

    expect(apply(source)).toBe(source);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('detects documentation comments', () => {
    expect(hasXmlDocumentation('/// <summary>x</summary>\nclass C { }')).toBe(true);
    expect(hasXmlDocumentation('// plain\nclass C { }')).toBe(false);
  });

  it('is named', () => {
    expect(removeXmlDocumentationConverter.name).toBe('Remove XML documentation comments');
  });
});

describe('runLayoutCleanup', () => {
  const settings = createDefaultSettings();

  it('trims trailing whitespace and normalizes blank lines in any language', () => {
    const source = 'const a = 1;   \n\n\n\nconst b = 2;\t\n';

    expect(runLayoutCleanup(source, 'sample.ts', settings)).toBe('const a = 1;\n\nconst b = 2;\n');
  });

  it('removes a BOM and adds the final newline', () => {
    expect(runLayoutCleanup('\uFEFFbody { }', 'sample.css', settings)).toBe('body { }\n');
  });

  it('does not need the C# parser', () => {
    expect(runLayoutCleanup('# heading   \n', 'notes.md', settings)).toBe('# heading\n');
  });

  it('handles an empty source', () => {
    expect(runLayoutCleanup('', 'sample.ts', settings)).toBe('');
  });
});
