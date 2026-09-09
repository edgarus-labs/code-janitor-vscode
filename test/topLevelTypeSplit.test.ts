import { describe, expect, it } from 'vitest';
import { createTopLevelTypeSplitPlan, TopLevelTypeSplitSkipReason } from '../src/cleanup/topLevelTypeSplit';

describe('createTopLevelTypeSplitPlan', () => {
  it('reports EmptySource for empty input', () => {
    const plan = createTopLevelTypeSplitPlan('', '/w/Foo.cs');

    expect(plan.hasChanges).toBe(false);
    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.EmptySource);
  });

  it('reports NotMultipleEligibleTypes for a single type', () => {
    const source = 'internal class Foo\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.hasChanges).toBe(false);
    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
    expect(plan.updatedSource).toBe(source);
  });

  it('splits two compilation-unit-level classes, keeping the one matching the file name', () => {
    const source = 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.hasChanges).toBe(true);
    expect(plan.updatedSource).toContain('class Foo');
    expect(plan.updatedSource).not.toContain('class Bar');
    expect(plan.newFiles).toHaveLength(1);
    expect(plan.newFiles[0].filePath.replace(/\\/g, '/')).toBe('/w/Bar.cs');
    expect(plan.newFiles[0].content).toContain('class Bar');
    expect(plan.newFiles[0].content).not.toContain('class Foo');
  });

  it('keeps the first eligible type when none matches the file name', () => {
    const source = 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Other.cs');

    expect(plan.updatedSource).toContain('class Foo');
    expect(plan.newFiles[0].content).toContain('class Bar');
  });

  it('preserves using directives and a block-scoped namespace in both the original and the new file', () => {
    const source =
      'using System;\r\n' +
      '\r\n' +
      'namespace Demo\r\n' +
      '{\r\n' +
      '    internal class Foo\r\n' +
      '    {\r\n' +
      '    }\r\n' +
      '\r\n' +
      '    internal class Bar\r\n' +
      '    {\r\n' +
      '    }\r\n' +
      '}\r\n';

    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.updatedSource).toContain('using System;');
    expect(plan.updatedSource).toContain('namespace Demo');
    expect(plan.updatedSource).toContain('class Foo');
    expect(plan.updatedSource).not.toContain('class Bar');

    expect(plan.newFiles[0].content).toContain('using System;');
    expect(plan.newFiles[0].content).toContain('namespace Demo');
    expect(plan.newFiles[0].content).toContain('class Bar');
    expect(plan.newFiles[0].content).not.toContain('class Foo');
  });

  it('preserves a file-scoped namespace in both the original and the new file', () => {
    const source = 'namespace Demo;\n\ninternal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.updatedSource).toContain('namespace Demo;');
    expect(plan.updatedSource).toContain('class Foo');
    expect(plan.newFiles[0].content).toContain('namespace Demo;');
    expect(plan.newFiles[0].content).toContain('class Bar');
  });

  it('moves a leading doc comment together with its type', () => {
    const source = 'internal class Foo\n{\n}\n\n/// <summary>Bar.</summary>\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.updatedSource).not.toContain('Bar.');
    expect(plan.newFiles[0].content).toContain('/// <summary>Bar.</summary>');
    expect(plan.newFiles[0].content).toContain('class Bar');
  });

  it('builds a generic file name for a generic type', () => {
    const source = 'internal class Foo\n{\n}\n\ninternal class Result<T>\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.newFiles[0].filePath.replace(/\\/g, '/')).toBe('/w/Result{T}.cs');
  });

  it('splits an eligible delegate out into its own file', () => {
    const source = 'internal class Foo\n{\n}\n\ninternal delegate void Handler();\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.newFiles).toHaveLength(1);
    expect(plan.newFiles[0].filePath.replace(/\\/g, '/')).toBe('/w/Handler.cs');
    expect(plan.newFiles[0].content).toContain('delegate void Handler();');
  });

  it('avoids a file name collision using a reserved set', () => {
    const source = 'internal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs', new Set(['Bar.cs']));

    expect(plan.newFiles[0].filePath.replace(/\\/g, '/')).toBe('/w/Bar~1.cs');
  });

  it('skips partial classes, leaving them in the original file untouched', () => {
    const source = 'internal partial class Foo\n{\n}\n\ninternal class Bar\n{\n}\n\ninternal class Baz\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.updatedSource).toContain('partial class Foo');
    expect(plan.newFiles.map((file) => file.content).join('')).not.toContain('Foo');
  });

  it('reports NotMultipleEligibleTypes when only one type is not partial', () => {
    const source = 'internal partial class Foo\n{\n}\n\ninternal partial class Foo2\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.hasChanges).toBe(false);
    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
  });

  it('does not treat a struct as an eligible top-level type', () => {
    const source = 'internal class Foo\n{\n}\n\ninternal struct Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.hasChanges).toBe(false);
    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
  });

  it('reports UnsupportedStructure for multiple namespaces', () => {
    const source = 'namespace A\n{\n    internal class Foo\n{\n}\n}\n\nnamespace B\n{\n    internal class Bar\n{\n}\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.UnsupportedStructure);
  });

  it('reports UnsupportedStructure for a namespace alongside another top-level type', () => {
    const source = 'namespace A\n{\n    internal class Foo\n{\n}\n}\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.UnsupportedStructure);
  });

  it('reports UnsupportedStructure for a non-region preprocessor directive', () => {
    const source = '#if DEBUG\ninternal class Foo\n{\n}\n#endif\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.UnsupportedStructure);
  });

  it('reports UnsupportedStructure for an assembly-level attribute', () => {
    const source = '[assembly: System.CLSCompliant(true)]\n\ninternal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.UnsupportedStructure);
  });

  it('tolerates #region/#endregion directives', () => {
    const source = '#region Types\ninternal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n#endregion\n';
    const plan = createTopLevelTypeSplitPlan(source, '/w/Foo.cs');

    expect(plan.hasChanges).toBe(true);
  });

  it('reports EmptySource for an empty file path', () => {
    const plan = createTopLevelTypeSplitPlan('internal class Foo\n{\n}\n', '');

    expect(plan.skipReason).toBe(TopLevelTypeSplitSkipReason.EmptySource);
  });
});
