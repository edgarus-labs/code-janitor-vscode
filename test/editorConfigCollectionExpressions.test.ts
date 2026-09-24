import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function members(...body: string[]): string {
  return lines('using System;', 'using System.Collections.Generic;', 'using System.Collections.Immutable;', 'using System.Linq;', '', 'class C', '{', ...body.map((line) => `    ${line}`), '}');
}

const NET8: ProjectInfo = { directory: '/repo', targetFrameworks: ['net8.0'], languageVersion: 12, modernRuntime: true };

function codeStyle(source: string, rules: string, project: ProjectInfo | undefined = NET8): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project }).apply(source);

  return { output, issues };
}

const ENFORCED = 'dotnet_style_prefer_collection_expression = true:warning';

describe('collection expressions (IDE0300 - IDE0306)', () => {
  it('support the option and every diagnostic id', () => {
    const props = resolveEditorConfigProperties(
      [{ directory: '/repo', text: `root = true\n[*.cs]\n${ENFORCED}\ndotnet_diagnostic.IDE0305.severity = warning\n` }],
      '/repo/Sample.cs'
    );

    expect(unsupportedEditorConfigSettings(props)).toEqual([]);
  });

  it('IDE0300 / IDE0301 use [...] for arrays whose type is written in the declaration', () => {
    const before = members(
      'int[] _a = new int[] { 1, 2 };',
      'int[] _b = { 3 };',
      'string[] _c = new[] { "x" };',
      'object[] _d = new[] { "covariant" };',
      'int[] _e = Array.Empty<int>();',
      'int[] _f = new int[0];',
      'int[,] _g = new int[,] { { 1 } };',
      'IEnumerable<int> _h = new int[] { 1 };',
      'int[] Numbers() => new int[] { 4 };',
      'void M() { var v = new int[] { 5 }; int[] w = new int[] { 6 }; }'
    );
    const after = members(
      'int[] _a = [1, 2];',
      'int[] _b = [3];',
      'string[] _c = ["x"];',
      'object[] _d = new[] { "covariant" };',
      'int[] _e = [];',
      'int[] _f = [];',
      'int[,] _g = new int[,] { { 1 } };',
      'IEnumerable<int> _h = new int[] { 1 };',
      'int[] Numbers() => [4];',
      'void M() { var v = new int[] { 5 }; int[] w = [6]; }'
    );

    expect(codeStyle(before, ENFORCED).output).toBe(after);
    expect(codeStyle(before, `${ENFORCED}\ndotnet_diagnostic.IDE0300.severity = none\ndotnet_diagnostic.IDE0301.severity = none`).output).toBe(before);
    expect(codeStyle(before, 'dotnet_style_prefer_collection_expression = false:warning').output).toBe(before);
  });

  it('IDE0302 uses [...] for stackalloc with elements assigned to a span', () => {
    const before = members('void M() { Span<int> s = stackalloc int[] { 1, 2 }; Span<int> t = stackalloc int[4]; }');

    expect(codeStyle(before, ENFORCED).output).toBe(members('void M() { Span<int> s = [1, 2]; Span<int> t = stackalloc int[4]; }'));
  });

  it('IDE0303 uses [...] for ImmutableArray.Create on .NET 8 or later, but not with a single argument', () => {
    const before = members('ImmutableArray<int> _a = ImmutableArray.Create(1, 2);', 'ImmutableArray<int> _b = ImmutableArray.Create(Other());', 'static int[] Other() => null;');
    const after = members('ImmutableArray<int> _a = [1, 2];', 'ImmutableArray<int> _b = ImmutableArray.Create(Other());', 'static int[] Other() => null;');

    expect(codeStyle(before, ENFORCED).output).toBe(after);
    expect(codeStyle(before, ENFORCED, { ...NET8, targetFrameworks: ['net6.0'] }).output).toBe(before);
  });

  it('IDE0305 uses [...] for ToList/ToArray of a new collection, and reports other receivers, which may be null', () => {
    const before = members('List<int> _a = new[] { 1, 2 }.ToList();', 'int[] _b = new List<int> { 3 }.ToArray();', 'List<int> Copy(IEnumerable<int> xs) => xs.ToList();');
    const { output, issues } = codeStyle(before, ENFORCED);

    expect(output).toBe(members('List<int> _a = [1, 2];', 'int[] _b = [.. new List<int> { 3 }];', 'List<int> Copy(IEnumerable<int> xs) => xs.ToList();'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0305 .*line 10: 'xs\.ToList\(\)' was not changed/)]);
  });

  it('IDE0306 uses [...] for new List/HashSet without constructor arguments', () => {
    const before = members(
      'List<int> _a = new List<int>();',
      'List<int> _b = new List<int> { 1, 2 };',
      'HashSet<string> _c = new HashSet<string> { "a" };',
      'List<int> _d = new List<int>(10);',
      'IList<int> _e = new List<int>();',
      'Dictionary<int, int> _f = new Dictionary<int, int> { { 1, 2 } };'
    );
    const after = members(
      'List<int> _a = [];',
      'List<int> _b = [1, 2];',
      'HashSet<string> _c = ["a"];',
      'List<int> _d = new List<int>(10);',
      'IList<int> _e = new List<int>();',
      'Dictionary<int, int> _f = new Dictionary<int, int> { { 1, 2 } };'
    );

    expect(codeStyle(before, ENFORCED).output).toBe(after);
  });

  it('need C# 12', () => {
    const source = members('int[] _a = new int[] { 1 };');
    const { output, issues } = codeStyle(source, ENFORCED, { ...NET8, languageVersion: 11 });

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/dotnet_style_prefer_collection_expression: not applied, the project uses C# 11/)]);
  });
});
