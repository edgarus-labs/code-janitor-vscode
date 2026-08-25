import { describe, expect, it } from 'vitest';
import { buildPipeline } from '../src/cleanup/runCleanup';
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
});
