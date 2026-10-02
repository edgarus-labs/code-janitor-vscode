import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { planOneTypePerFile, readOneTypePerFileRules } from '../src/cleanup/oneTypePerFile';

function props(lines: string) {
  return resolveEditorConfigProperties([{ directory: '/w', text: `root = true\n[*.cs]\n${lines}\n` }], '/w/Foo.cs');
}

function plan(source: string, editorConfig: string, filePath = '/w/Foo.cs', reserved: string[] = []) {
  const rules = readOneTypePerFileRules(props(editorConfig));
  if (!rules) {
    return undefined;
  }

  return planOneTypePerFile(source, filePath, rules, new Set(reserved));
}

const twoClasses = 'namespace Demo;\n\ninternal class Foo\n{\n}\n\ninternal class Bar\n{\n}\n';

describe('readOneTypePerFileRules', () => {
  it('is off unless SA1402, SA1649 or MA0048 is explicitly enforced', () => {
    expect(readOneTypePerFileRules(props('indent_style = space'))).toBeUndefined();
    expect(readOneTypePerFileRules(props('dotnet_diagnostic.SA1402.severity = silent'))).toBeUndefined();
    expect(readOneTypePerFileRules(props('dotnet_diagnostic.MA0048.severity = none'))).toBeUndefined();
    // A bulk severity does not tell whether the analyzer package is installed.
    expect(readOneTypePerFileRules(props('dotnet_analyzer_diagnostic.severity = error'))).toBeUndefined();
    expect(readOneTypePerFileRules(props('dotnet_diagnostic.SA1402.severity = suggestion'))).toBeDefined();
  });
});

describe('planOneTypePerFile', () => {
  it('splits extra classes out for SA1402 and keeps other kinds, which SA1402 allows by default', () => {
    const source = 'namespace Demo;\n\ninternal class Foo\n{\n}\n\ninternal interface IBar\n{\n}\n\ninternal class Baz\n{\n}\n';
    const outcome = plan(source, 'dotnet_diagnostic.SA1402.severity = warning')!;

    expect(outcome.issues).toEqual([]);
    expect(outcome.plan.updatedSource).toContain('internal class Foo\n{\n}\n\ninternal interface IBar\n{\n}\n');
    expect(outcome.plan.updatedSource).not.toContain('Baz');
    expect(outcome.plan.newFiles.map((file) => file.filePath)).toEqual(['/w/Baz.cs']);
    expect(outcome.plan.newFiles[0].content).toContain('internal class Baz');
    expect(outcome.plan.newFiles[0].content).not.toContain('IBar');
  });

  it('splits every type not named like the file for MA0048', () => {
    const source = 'namespace Demo;\n\ninternal interface IBar\n{\n}\n\ninternal class Foo\n{\n}\n\ninternal delegate void Handler();\n';
    const outcome = plan(source, 'dotnet_diagnostic.MA0048.severity = error')!;

    expect(outcome.issues).toEqual([]);
    expect(outcome.plan.updatedSource).toContain('class Foo');
    expect(outcome.plan.updatedSource).not.toContain('IBar');
    expect(outcome.plan.newFiles.map((file) => file.filePath).sort()).toEqual(['/w/Handler.cs', '/w/IBar.cs']);
  });

  it('does nothing when the file already follows the rules', () => {
    const outcome = plan('internal class Foo\n{\n}\n', 'dotnet_diagnostic.SA1402.severity = warning\ndotnet_diagnostic.SA1649.severity = warning')!;

    expect(outcome.plan.hasChanges).toBe(false);
    expect(outcome.issues).toEqual([]);
  });

  it('does not split for SA1649 alone, but reports a first type that does not match the file name', () => {
    const outcome = plan(twoClasses, 'dotnet_diagnostic.SA1649.severity = warning', '/w/Other.cs')!;

    expect(outcome.plan.hasChanges).toBe(false);
    expect(outcome.issues).toEqual([
      "SA1649 (warning) line 3: the file name does not match type 'Foo' (expected 'Foo.cs'); files are not renamed.",
    ]);
  });

  it('accepts generic file names in both the StyleCop and the metadata convention', () => {
    const rules = 'dotnet_diagnostic.SA1649.severity = warning\ndotnet_diagnostic.MA0048.severity = warning';
    const source = 'internal class Box<T>\n{\n}\n';

    expect(plan(source, rules, '/w/Box{T}.cs')!.issues).toEqual([]);
    expect(plan(source, rules, '/w/Box`1.cs')!.issues).toEqual([]);
    expect(plan(source, rules, '/w/Box.cs')!.issues).toEqual([]);
    expect(plan(source, rules, '/w/Crate.cs')!.issues).toHaveLength(2);
    expect(plan('internal partial class Box\n{\n}\n', rules, '/w/Box.Designer.cs')!.issues).toEqual([]);
  });

  it('refuses to split, and reports, when a target file already exists', () => {
    const outcome = plan(twoClasses, 'dotnet_diagnostic.SA1402.severity = warning', '/w/Foo.cs', ['Foo.cs', 'bar.cs'])!;

    expect(outcome.plan.hasChanges).toBe(false);
    expect(outcome.issues).toEqual([
      "SA1402 (warning) line 7: type 'Bar' was not moved to its own file because 'Bar.cs' already exists.",
    ]);
  });

  it('reports types it cannot move: partial types and files with unsupported structure', () => {
    const partial = 'internal class Foo\n{\n}\n\ninternal partial class Bar\n{\n}\n';
    const conditional = '#if DEBUG\ninternal class Foo\n{\n}\n#endif\n\ninternal class Bar\n{\n}\n';

    expect(plan(partial, 'dotnet_diagnostic.SA1402.severity = warning')!.issues).toEqual([
      "SA1402 (warning) line 5: type 'Bar' was not moved to its own file because it is partial.",
    ]);
    const outcome = plan(conditional, 'dotnet_diagnostic.SA1402.severity = warning')!;
    expect(outcome.plan.hasChanges).toBe(false);
    expect(outcome.issues).toEqual([
      "SA1402 (warning) line 7: type 'Bar' was not moved to its own file because the file uses preprocessor directives, assembly attributes or several namespaces.",
    ]);
  });

  it('reports a struct MA0048 wants moved, since structs are never split', () => {
    const outcome = plan('internal class Foo\n{\n}\n\ninternal struct Point\n{\n}\n', 'dotnet_diagnostic.MA0048.severity = warning')!;

    expect(outcome.plan.hasChanges).toBe(false);
    expect(outcome.issues).toEqual([
      "MA0048 (warning) line 5: type 'Point' was not moved to its own file because structs are not split.",
    ]);
  });

  it('keeps the type named like the file stem, as in View.xaml.cs', () => {
    const outcome = plan('namespace Demo;\n\ninternal class Helper\n{\n}\n\ninternal class View\n{\n}\n', 'dotnet_diagnostic.MA0048.severity = warning', '/w/View.xaml.cs')!;

    expect(outcome.issues).toEqual([]);
    expect(outcome.plan.updatedSource).toContain('class View');
    expect(outcome.plan.updatedSource).not.toContain('Helper');
    expect(outcome.plan.newFiles.map((file) => file.filePath)).toEqual(['/w/Helper.cs']);
  });

  it('keeps a matching type that cannot move and moves every other movable type', () => {
    const partial = plan(
      'namespace Demo;\n\ninternal partial class Foo\n{\n}\n\ninternal class Bar\n{\n}\n\ninternal class Baz\n{\n}\n',
      'dotnet_diagnostic.SA1402.severity = warning'
    )!;
    expect(partial.issues).toEqual([]);
    expect(partial.plan.updatedSource).toContain('partial class Foo');
    expect(partial.plan.newFiles.map((file) => file.filePath)).toEqual(['/w/Bar.cs', '/w/Baz.cs']);

    const single = plan('internal partial class Foo\n{\n}\n\ninternal class Bar\n{\n}\n', 'dotnet_diagnostic.MA0048.severity = warning')!;
    expect(single.issues).toEqual([]);
    expect(single.plan.newFiles.map((file) => file.filePath)).toEqual(['/w/Bar.cs']);

    const struct = plan('internal struct Foo\n{\n}\n\ninternal class A\n{\n}\n\ninternal class B\n{\n}\n', 'dotnet_diagnostic.SA1402.severity = warning')!;
    expect(struct.issues).toEqual([]);
    expect(struct.plan.newFiles.map((file) => file.filePath)).toEqual(['/w/A.cs', '/w/B.cs']);
  });

  it('without moving (cleanup on save) reports every class but the one named like the file stem', () => {
    const rules = readOneTypePerFileRules(props('dotnet_diagnostic.SA1402.severity = warning'))!;
    const outcome = planOneTypePerFile('internal class Helper\n{\n}\n\ninternal class View\n{\n}\n', '/w/View.xaml.cs', rules, new Set(), false);

    expect(outcome.issues).toEqual([expect.stringMatching(/^SA1402 \(warning\) line 1: type 'Helper' was not moved .*cleanup on save/)]);
  });
});
