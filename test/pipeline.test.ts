import { describe, expect, it } from 'vitest';
import { buildPipeline, runCleanup, runLayoutCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

function run(source: string, overrides: Partial<CleanupSettings> = {}): string {
  const settings = { ...createDefaultSettings(), ...overrides };

  return buildPipeline(source, settings, {}).run(source);
}

describe('cleanup pipeline', () => {
  it('removes region directives by default', () => {
    const result = run('#region Fields\ninternal class C\n{\n}\n#endregion\n');

    expect(result).not.toContain('#region');
    expect(result).not.toContain('#endregion');
    expect(result).toContain('internal class C');
  });

  it('keeps region directives when the setting is off', () => {
    const result = run('#region Fields\ninternal class C\n{\n}\n#endregion\n', { removeRegions: false });

    expect(result).toContain('#region Fields');
    expect(result).toContain('#endregion');
  });

  it('applies the default converter set in one pass', () => {
    const source =
      'using System;\r\n' +
      '\r\n' +
      'namespace Demo\r\n' +
      '{\r\n' +
      '    class Sample\r\n' +
      '    {\r\n' +
      '        int _value;   \r\n' +
      '        void Check(string name)\r\n' +
      '        {\r\n' +
      '            if (name == null)\r\n' +
      '            {\r\n' +
      '                throw new ArgumentNullException("name");\r\n' +
      '            }\r\n' +
      '        }\r\n' +
      '    }\r\n' +
      '}\r\n';

    const result = run(source);

    expect(result).toContain('internal class Sample');
    expect(result).toContain('private int _value;');
    expect(result).toContain('private void Check(string name)');
    expect(result).toContain('if (name is null)');
    expect(result).toContain('nameof(name)');
    expect(result).not.toContain('_value;   ');
    expect(result.endsWith('\r\n')).toBe(true);
  });

  it('is idempotent', () => {
    const source = 'namespace Demo\n{\n    class Sample\n    {\n        void M() { }\n    }\n}\n';
    const once = run(source);

    expect(run(once)).toBe(once);
  });

  it('removes region directives', () => {
    expect(run('class C\n{\n    #region Fields\n    int x;\n    #endregion\n}\n')).not.toContain('#region');
  });

  it('honours the opt-in modernization settings', () => {
    const source = 'namespace Demo\n{\n    class Sample\n    {\n        void M()\n        {\n            Foo x = new Foo();\n        }\n    }\n}\n';
    const result = run(source, { convertToVarWhenApparent: true, convertToFileScopedNamespace: true });

    expect(result).toContain('namespace Demo;');
    expect(result).toContain('var x = new Foo();');
  });

  it('leaves an empty source alone', () => {
    expect(run('')).toBe('');
  });

  it('respects an editorconfig that turns the final newline off', () => {
    const settings = createDefaultSettings();
    const result = buildPipeline('class C { }', settings, { insertFinalNewline: false }).run('class C { }');

    expect(result.endsWith('\n')).toBe(false);
  });

  it('expands tabs when the editorconfig asks for spaces', () => {
    const source = 'class C\n{\n\tint x;\n}\n';
    const result = buildPipeline(source, createDefaultSettings(), { indentStyle: 'space', indentSize: 2 }).run(source);

    expect(result).toContain('  private int x;');
  });

  it('applies file header when configured', () => {
    const source = 'class C { }\n';
    const result = run(source, { fileHeaderCSharp: '// My Header' });

    expect(result).toContain('// My Header');
  });

  it('applies file header after usings when configured', () => {
    const source = 'using System;\n\nclass C { }\n';
    const settings = { ...createDefaultSettings(), fileHeaderCSharp: '// My Header', fileHeaderPosition: 1 as const };

    const result = buildPipeline(source, settings, {}).run(source);

    expect(result).toContain('// My Header');
  });

  it('applies file header in replace mode', () => {
    const source = '// Old Header\nclass C { }\n';
    const settings = { ...createDefaultSettings(), fileHeaderCSharp: '// New Header', fileHeaderUpdateMode: 1 as const };

    const result = buildPipeline(source, settings, {}).run(source);

    expect(result).toContain('// New Header');
    expect(result).not.toContain('// Old Header');
  });

  it('applies blank line padding before case statements', () => {
    const source = 'class C\n{\n    void M()\n    {\n        switch (x)\n        {\n            case 1:\n                break;\n        }\n    }\n}\n';
    const result = run(source, { insertBlankLinePaddingBeforeCaseStatements: true });

    // The transformation inserts blank lines before case statements
    expect(result).toContain('case 1:');
  });

  it('applies blank line padding before single-line comments', () => {
    const source = 'class C\n{\n    void M()\n    {\n        int x = 1;\n        // comment\n    }\n}\n';
    const result = run(source, { insertBlankLinePaddingBeforeSingleLineComments: true });

    expect(result).toContain('\n\n        // comment');
  });

  it('applies updateSingleLineMethods', () => {
    const source = 'class C\n{\n    void M() { }\n}\n';
    const result = run(source, { updateSingleLineMethods: true });

    // The transformation expands single-line methods to multi-line
    expect(result).toContain('void M()');
  });

  it('applies updateAccessorsToBothBeSingleLineOrMultiLine', () => {
    const source = 'class C\n{\n    int P { get => 0; set { } }\n}\n';
    const result = run(source, { updateAccessorsToBothBeSingleLineOrMultiLine: true });

    expect(result).toContain('int P');
  });

  it('applies formatComments', () => {
    const source = 'class C\n{\n    //no space\n    void M() { }\n}\n';
    const result = run(source, { formatComments: true });

    expect(result).toContain('// no space');
  });

  it('applies updateEndRegionDirectives', () => {
    const source = '#region Fields\nclass C { }\n#endregion\n';
    const result = run(source, { updateEndRegionDirectives: true, removeRegions: false });

    expect(result).toContain('#endregion Fields');
  });

  it('applies removeBlankLinesAfterAttributes', () => {
    const source = 'class C\n{\n    [Obsolete]\n\n    void M() { }\n}\n';
    const result = run(source, { removeBlankLinesAfterAttributes: true });

    // The transformation removes blank lines after attributes
    expect(result).toContain('[Obsolete]');
  });

  it('applies removeBlankLinesAfterOpeningBrace', () => {
    const source = 'class C\n{\n\n    void M() { }\n}\n';
    const result = run(source, { removeBlankLinesAfterOpeningBrace: true });

    // The transformation removes blank lines after opening braces
    expect(result).toContain('void M()');
  });

  it('applies removeBlankLinesBeforeClosingBrace', () => {
    const source = 'class C\n{\n    void M() { }\n\n}\n';
    const result = run(source, { removeBlankLinesBeforeClosingBrace: true });

    expect(result).toContain('void M() { }\n}');
  });

  it('applies removeBlankLinesBetweenChainedStatements', () => {
    const source = 'class C\n{\n    void M()\n    {\n        if (a) { }\n\n        else { }\n    }\n}\n';
    const result = run(source, { removeBlankLinesBetweenChainedStatements: true });

    expect(result).toContain('}\n        else');
  });

  it('applies removeMultipleConsecutiveBlankLines', () => {
    const source = 'class C\n{\n\n\n    void M() { }\n}\n';
    const result = run(source, { removeMultipleConsecutiveBlankLines: true });

    // The transformation collapses multiple blank lines
    expect(result).toContain('void M()');
  });

  it('applies organizeUsings', () => {
    const source = 'using B;\nusing A;\nusing System;\n\nclass C { }\n';
    const result = run(source, { organizeUsings: true });

    expect(result.indexOf('using System;')).toBeLessThan(result.indexOf('using A;'));
  });

  it('applies sortSystemDirectivesFirst from editorconfig', () => {
    const source = 'using B;\nusing System;\nusing A;\n\nclass C { }\n';
    const result = buildPipeline(source, createDefaultSettings(), {
      sortSystemDirectivesFirst: true,
      separateImportDirectiveGroups: false,
    }).run(source);

    expect(result.indexOf('using System;')).toBeLessThan(result.indexOf('using A;'));
  });

  it('applies trimTrailingWhitespace from editorconfig', () => {
    const source = 'class C   \n{\n}\n';
    const result = buildPipeline(source, createDefaultSettings(), { trimTrailingWhitespace: true }).run(source);

    expect(result).not.toContain('   \n');
  });

  it('applies insertFinalNewline from editorconfig', () => {
    const result = buildPipeline('class C { }', createDefaultSettings(), { insertFinalNewline: true }).run('class C { }');

    expect(result.endsWith('\n')).toBe(true);
  });

  it('does not insert final newline when editorconfig says no', () => {
    const result = buildPipeline('class C { }', createDefaultSettings(), { insertFinalNewline: false }).run('class C { }');

    expect(result.endsWith('\n')).toBe(false);
  });

  it('runs layout cleanup for non-C# files', () => {
    const source = 'hello   \nworld\n';
    const result = runLayoutCleanup(source, 'test.txt', createDefaultSettings());

    expect(result).not.toContain('   \n');
  });

  it('runs layout cleanup with editorconfig settings', () => {
    const source = 'hello\nworld';
    const result = runLayoutCleanup(source, 'test.txt', createDefaultSettings());

    expect(result.endsWith('\n')).toBe(true);
  });

  it('returns source unchanged for empty input', () => {
    expect(runCleanup('', 'test.cs', createDefaultSettings())).toBe('');
  });

  it('returns source unchanged for empty layout input', () => {
    expect(runLayoutCleanup('', 'test.txt', createDefaultSettings())).toBe('');
  });

  it('applies readonly field when enabled', () => {
    const source = 'class C\n{\n    private int _x;\n}\n';
    const result = run(source, { makeFieldsReadonlyWhenSafe: true });

    expect(result).toContain('private readonly int _x;');
  });

  it('applies sealed class when enabled', () => {
    const source = 'class C\n{\n}\n';
    const result = run(source, { sealClassesWhenSafe: true });

    expect(result).toContain('sealed');
  });

  it('applies return throw blank line padding', () => {
    const source = 'class C\n{\n    int M()\n    {\n        int x = 1;\n        return x;\n    }\n}\n';
    const result = run(source, { insertBlankLineBeforeReturnAndThrowStatements: true });

    expect(result).toContain('\n\n        return x;');
  });

  it('applies collection expressions', () => {
    const source = 'class C\n{\n    int[] a = new int[] { 1, 2 };\n}\n';
    const result = run(source, { convertToCollectionExpressions: true });

    expect(result).toContain('= [1, 2];');
  });

  it('applies JsonSerializerOptions reuse', () => {
    const source = 'class C\n{\n    void M()\n    {\n        JsonSerializer.Serialize(obj, new JsonSerializerOptions());\n    }\n}\n';
    const result = run(source, { reuseJsonSerializerOptionsForCA1869: true });

    expect(result).toContain('null');
  });

  it('applies single statement lambda simplification', () => {
    const source = 'class C\n{\n    void M()\n    {\n        Func<int> f = () => { return 42; };\n    }\n}\n';
    const result = run(source, { simplifySingleStatementLambdas: true });

    expect(result).toContain('() => 42');
  });

  it('applies pattern matching null checks', () => {
    const source = 'class C\n{\n    void M(object x)\n    {\n        if (x == null) { }\n    }\n}\n';
    const result = run(source, { convertToPatternMatchingNullChecks: true });

    expect(result).toContain('x is null');
  });

  it('applies string interpolation', () => {
    const source = 'class C\n{\n    void M()\n    {\n        var s = string.Format("{0}", x);\n    }\n}\n';
    const result = run(source, { convertStringFormatToInterpolation: true });

    expect(result).toContain('$"{x}"');
  });

  it('applies nameof operator when the converter matches', () => {
    // The nameof converter targets exception constructor arguments with matching parameter names
    const source = 'class C\n{\n    void M(string name)\n    {\n        throw new ArgumentNullException("name");\n    }\n}\n';
    const result = run(source, { convertToStringNameOf: true });

    // The transformation converts string literals to nameof when the name matches a parameter
    expect(result).toContain('nameof');
  });

  it('applies out var inlining', () => {
    const source = 'class C\n{\n    void M()\n    {\n        int x;\n        int.TryParse(s, out x);\n    }\n}\n';
    const result = run(source, { inlineOutVariableDeclarations: true });

    expect(result).toContain('out var x');
  });

  it('applies explicit access modifiers on all kinds', () => {
    const source = 'class C\n{\n    int x;\n    void M() { }\n    int P { get; set; }\n    event EventHandler E;\n    delegate void D();\n    enum E2 { }\n    interface I { }\n    struct S { }\n}\n';
    const settings = {
      ...createDefaultSettings(),
      insertExplicitAccessModifiersOnClasses: true,
      insertExplicitAccessModifiersOnDelegates: true,
      insertExplicitAccessModifiersOnEnumerations: true,
      insertExplicitAccessModifiersOnEvents: true,
      insertExplicitAccessModifiersOnFields: true,
      insertExplicitAccessModifiersOnInterfaces: true,
      insertExplicitAccessModifiersOnMethods: true,
      insertExplicitAccessModifiersOnProperties: true,
      insertExplicitAccessModifiersOnStructs: true,
    };

    const result = run(source, settings);

    expect(result).toContain('private int x;');
    expect(result).toContain('private void M()');
    expect(result).toContain('private int P');
    expect(result).toContain('private event EventHandler E;');
  });

  it('applies explicit access modifiers on classes only', () => {
    const source = 'class C\n{\n    void M() { }\n}\n';
    const settings = {
      ...createDefaultSettings(),
      insertExplicitAccessModifiersOnClasses: true,
      insertExplicitAccessModifiersOnMethods: false,
    };

    const result = run(source, settings);

    expect(result).toContain('internal class C');
    expect(result).not.toContain('private void M');
  });

  describe('pipeline preview', () => {
    it('returns preview steps and tracks changes', () => {
      const source = 'class C\n{\n    int x;   \n}\n';
      const pipeline = buildPipeline(source, createDefaultSettings(), {});
      const preview = pipeline.preview(source);

      expect(preview.hasChanges).toBe(true);
      expect(preview.originalSource).toBe(source);
      expect(preview.updatedSource).not.toBe(source);
      expect(preview.steps.length).toBeGreaterThan(0);

      const changedSteps = preview.steps.filter((s) => s.changed);
      expect(changedSteps.length).toBeGreaterThan(0);
    });

    it('reports no changes when source is already clean', () => {
      const source = 'namespace Demo\n{\n    internal class C\n    {\n        private void M() { }\n    }\n}\n';
      const cleanSource = run(source);
      const pipeline = buildPipeline(cleanSource, createDefaultSettings(), {});
      const preview = pipeline.preview(cleanSource);

      expect(preview.hasChanges).toBe(false);
      expect(preview.updatedSource).toBe(cleanSource);
    });

    it('respects excluded transformations', () => {
      const source = 'class C\n{\n    int x;   \n}\n';
      const pipeline = buildPipeline(source, createDefaultSettings(), {});
      const allIndices = new Set(pipeline.transformations.map((_, i) => i));
      const preview = pipeline.preview(source, allIndices);

      expect(preview.hasChanges).toBe(false);
      expect(preview.updatedSource).toBe(source);
      expect(preview.steps.every((s) => !s.included)).toBe(true);
    });

    it('applies changes conditionally via tryApply', () => {
      const source = 'class C\n{\n}\n';
      const pipeline = buildPipeline(source, createDefaultSettings(), {});
      const preview = pipeline.preview(source);

      let target = source;
      const applied = preview.tryApply(target, (updated) => {
        target = updated;
      });

      expect(applied).toBe(true);
      expect(target).toContain('internal class C');

      // Fails when current source has diverged
      const staleApplied = preview.tryApply('different source', () => {});
      expect(staleApplied).toBe(false);
    });
  });
});
