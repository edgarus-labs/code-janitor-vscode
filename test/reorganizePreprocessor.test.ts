import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { hasPreprocessorConditionals, reorganizeSourceDetailed } from '../src/reorganize/reorganize';
import { createDefaultReorganizeSettings } from '../src/reorganize/settings';
import { reorganize, reorganizeSettings, withoutPadding } from './helpers/reorganize';

// Ported from CodeReorganizationAvailabilityLogic: files with preprocessor conditionals are only
// reorganized when Reorganizing_PerformWhenPreprocessorConditionals is Yes.
const WITH_CONDITIONAL = 'class C\n{\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n    int _f;\n}\n';

describe('reorganize: preprocessor conditionals', () => {
  it('detects the directives the Visual Studio check looks for', () => {
    expect(hasPreprocessorConditionals('  #if X\n')).toBe(true);
    expect(hasPreprocessorConditionals('#else\n')).toBe(true);
    expect(hasPreprocessorConditionals('#elif X\n')).toBe(true);
    expect(hasPreprocessorConditionals('#endif\n')).toBe(true);
    expect(hasPreprocessorConditionals('\t#pragma warning disable CS0169\n')).toBe(true);
    expect(hasPreprocessorConditionals('#region X\n#endregion\n#nullable enable\n// #if not a directive\n')).toBe(false);
  });

  it('detects a directive written with whitespace after the hash', () => {
    const spaced = WITH_CONDITIONAL.replace('#if DEBUG', '# if DEBUG').replace('#endif', '#\tendif');
    const result = reorganizeSourceDetailed(spaced, reorganizeSettings({ performWhenPreprocessorConditionals: 'ask' }), withoutPadding());

    expect(hasPreprocessorConditionals('  # pragma warning disable CS0169\n')).toBe(true);
    expect(result.blockedByPreprocessor).toBe(true);
    expect(result.output).toBe(spaced);
  });

  it.each(['ask', 'no'] as const)('leaves a file with conditionals alone when the policy is %s', (policy) => {
    const result = reorganizeSourceDetailed(WITH_CONDITIONAL, reorganizeSettings({ performWhenPreprocessorConditionals: policy }), withoutPadding());

    expect(result.output).toBe(WITH_CONDITIONAL);
    expect(result.blockedByPreprocessor).toBe(true);
  });

  it('moves a #if block together with its member when the policy is yes', () => {
    expect(reorganize(WITH_CONDITIONAL, { performWhenPreprocessorConditionals: 'yes' })).toBe(
      'class C\n{\n    int _f;\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n}\n'
    );
  });

  it('moves a #if/#else block as one member and sorts it as its first member', () => {
    const source = 'class C\n{\n#if A\n    void Z() { }\n#else\n    void Z(int x) { }\n#endif\n    void B() { }\n    int _f;\n}\n';

    expect(reorganize(source, { performWhenPreprocessorConditionals: 'yes' })).toBe(
      'class C\n{\n    int _f;\n    void B() { }\n#if A\n    void Z() { }\n#else\n    void Z(int x) { }\n#endif\n}\n'
    );
  });

  it('keeps the comment above a #if block with it', () => {
    const source = 'class C\n{\n    // debug only\n#if DEBUG\n    void Debug() { }\n#endif\n    int _f;\n}\n';

    expect(reorganize(source, { performWhenPreprocessorConditionals: 'yes' })).toBe(
      'class C\n{\n    int _f;\n    // debug only\n#if DEBUG\n    void Debug() { }\n#endif\n}\n'
    );
  });

  it('never moves members across a #pragma', () => {
    const source = 'class C\n{\n    void B() { }\n#pragma warning disable CS0169\n    int _unused;\n#pragma warning restore CS0169\n    int _a;\n}\n';

    expect(reorganize(source, { performWhenPreprocessorConditionals: 'yes' })).toBe(source);
  });

  it('never moves a #if block holding a #nullable or #pragma, which changes the context of the members after it', () => {
    const nullable = 'class C\n{\n    string z;\n#if DEBUG\n#nullable enable\n    string a = "";\n#endif\n}\n';
    const pragma = 'class C\n{\n    int _z;\n#if DEBUG\n#pragma warning disable CS0169\n    int _a;\n#endif\n}\n';

    expect(reorganize(nullable, { performWhenPreprocessorConditionals: 'yes' })).toBe(nullable);
    expect(reorganize(pragma, { performWhenPreprocessorConditionals: 'yes' })).toBe(pragma);
  });

  it('sorts the members between two pragmas', () => {
    const source = '#pragma warning disable CS1591\nclass C\n{\n#pragma warning disable CS0169\n    void B() { }\n    int _a;\n#pragma warning restore CS0169\n}\n';

    expect(reorganize(source, { performWhenPreprocessorConditionals: 'yes' })).toBe(
      '#pragma warning disable CS1591\nclass C\n{\n#pragma warning disable CS0169\n    int _a;\n    void B() { }\n#pragma warning restore CS0169\n}\n'
    );
  });

  it('leaves a type alone and reports it when a #if block does not end inside it', () => {
    const source = 'class C\n{\n    void B() { }\n#if A\n    int _f;\n}\n#endif\n';
    const result = reorganizeSourceDetailed(source, reorganizeSettings({ performWhenPreprocessorConditionals: 'yes' }), createDefaultSettings());

    expect(result.output).toBe(source);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('leaves a type alone and reports it when a #if splits a declaration the parser cannot read', () => {
    const source = 'class C\n{\n    void B() { }\n    int Split\n#if A\n        => 1;\n#else\n        => 2;\n#endif\n    int _f;\n}\n';
    const result = reorganizeSourceDetailed(source, reorganizeSettings({ performWhenPreprocessorConditionals: 'yes' }), withoutPadding());

    expect(result.output).toBe(source);
    expect(result.skipped).toContainEqual('C (line 1): skipped because of syntax the parser does not understand');
  });

  it('keeps #if directives inside a member body where they are', () => {
    const source = 'class C\n{\n    int B()\n    {\n#if A\n        return 1;\n#else\n        return 2;\n#endif\n    }\n    int _f;\n}\n';

    expect(reorganize(source, { performWhenPreprocessorConditionals: 'yes' })).toBe(
      'class C\n{\n    int _f;\n    int B()\n    {\n#if A\n        return 1;\n#else\n        return 2;\n#endif\n    }\n}\n'
    );
  });

  it('does not treat regions as conditionals', () => {
    const source = 'class C\n{\n    #region R\n    void B() { }\n    int _f;\n    #endregion\n}\n';

    expect(reorganize(source)).toBe('class C\n{\n    #region R\n    int _f;\n    void B() { }\n    #endregion\n}\n');
    expect(createDefaultReorganizeSettings().performWhenPreprocessorConditionals).toBe('ask');
  });
});
