import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { parseErrorCount } from '../src/cleanup/transformations/editorConfigSupport';
import { reorganizeSourceDetailed } from '../src/reorganize/reorganize';
import { reorganizeSettings, withoutPadding } from './helpers/reorganize';

const fixtures = path.join(__dirname, 'fixtures', 'reorganize');

function read(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

function run(name: string, policy: 'yes' | 'ask' = 'yes') {
  const settings = reorganizeSettings({ performWhenPreprocessorConditionals: policy });
  const source = read(name);
  const result = reorganizeSourceDetailed(source, settings, withoutPadding());

  expect(parseErrorCount(result.output)).toBeLessThanOrEqual(parseErrorCount(source));
  expect(reorganizeSourceDetailed(result.output, settings, withoutPadding()).output).toBe(result.output);

  return result;
}

// Files that are not meant to compile: the reorganizer must leave what it cannot understand alone.
describe('reorganize: fixtures that are not well-formed', () => {
  it('leaves the types alone whose #if directives are not balanced inside them, and says so', () => {
    const result = run('Unbalanced.cs');

    expect(result.output).toBe(read('Unbalanced.cs'));
    expect(result.skipped).toContainEqual('Unbalanced (line 3): skipped because of an #if without an #endif');
  });

  it('leaves a file alone when a syntax error swallows the rest of it', () => {
    const result = run('Broken.cs');

    expect(result.output).toBe(read('Broken.cs'));
  });

  it('does not swap two types that an #if and its #endif are split between', () => {
    // Other sorts before Unbalanced, but the #if in Unbalanced is closed in Other.
    const result = run('Unbalanced.cs');

    expect(result.output.indexOf('class Unbalanced')).toBeLessThan(result.output.indexOf('class Other'));
    expect(result.skipped.join('\n')).toContain('safety check');
  });

  it('sorts multi-line bodies and skips a body with several members on one line', () => {
    const result = run('OneLiners.cs');

    expect(result.output).toContain('public struct Pair { public int Second; public int First; }');
    expect(result.output).toContain('public class Mixed\n    {\n        public int Alpha;\n        public void Zulu() { }\n    }');
    expect(result.skipped).toEqual([expect.stringContaining('Pair (line 3): skipped because of more than one member on a line')]);
  });

  it('orders the types after top-level statements without touching the statements', () => {
    const result = run('TopLevel.cs');

    expect(result.output).toContain('Console.WriteLine(Helper.Name);');
    expect(result.output).toContain('class Another\n{\n    public int Alpha;\n    public void Zulu() { }\n}');
    expect(result.output).toContain('static class Helper\n{\n    public static string Name = "n";\n    public static void Run() { }\n}');
  });

  it('keeps a byte order mark and the header before the first line of code', () => {
    const result = run('Bom.cs');

    expect(result.output.startsWith('\uFEFF// header\n\nusing System;')).toBe(true);
    expect(result.output).toContain('public int Alpha;\n        public void Zulu() { }');
  });

  it('does nothing to an empty or blank file, or to one without types', () => {
    for (const source of ['', '\n', '   \r\n\r\n', '// just a comment\n', 'using System;\n']) {
      expect(reorganizeSourceDetailed(source, reorganizeSettings(), createDefaultSettings()).output).toBe(source);
    }
  });
});
