import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { createReorganizeTransformation, reorganizeSourceDetailed } from '../src/reorganize/reorganize';
import { createDefaultReorganizeSettings } from '../src/reorganize/settings';
import { reorganize, withoutPadding } from './helpers/reorganize';

describe('reorganize: ordering members', () => {
  it('orders members by member type and alphabetizes each group', () => {
    const source = [
      'class C',
      '{',
      '    public void Zeta() { }',
      '    private int _b;',
      '    public C() { }',
      '    private int _a;',
      '    public void Alpha() { }',
      '}',
      '',
    ].join('\n');

    expect(reorganize(source)).toBe(
      ['class C', '{', '    private int _a;', '    private int _b;', '    public C() { }', '    public void Alpha() { }', '    public void Zeta() { }', '}', ''].join('\n')
    );
  });

  it('returns a file that is already in order byte for byte', () => {
    const source = 'using System;\r\n\r\nnamespace N\r\n{\r\n\tclass C\r\n\t{\r\n\t\tint _a;   \r\n\r\n\r\n\t\tint _b;\r\n\t\tvoid   A() { }\r\n\t}\r\n}\r\n';

    expect(reorganize(source)).toBe(source);
  });

  it('keeps the member type order of every kind of member', () => {
    const source = [
      'public class C',
      '{',
      '    public class Nested { }',
      '    public struct S { }',
      '    public void M() { }',
      '    public int this[int i] => i;',
      '    public int P { get; set; }',
      '    public interface I { }',
      '    public enum E { A }',
      '    public event System.Action Ev;',
      '    public delegate void D();',
      '    ~C() { }',
      '    public C() { }',
      '    public int F;',
      '}',
      '',
    ].join('\n');

    expect(reorganize(source)).toBe(
      [
        'public class C',
        '{',
        '    public int F;',
        '    public C() { }',
        '    ~C() { }',
        '    public delegate void D();',
        '    public event System.Action Ev;',
        '    public enum E { A }',
        '    public interface I { }',
        '    public int P { get; set; }',
        '    public int this[int i] => i;',
        '    public void M() { }',
        '    public struct S { }',
        '    public class Nested { }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('orders by access level within a member type, and by static before instance', () => {
    const source = [
      'class C',
      '{',
      '    private void A() { }',
      '    public void B() { }',
      '    protected void C2() { }',
      '    internal void D() { }',
      '    protected internal void E() { }',
      '    public static void F() { }',
      '    void G() { }',
      '}',
      '',
    ].join('\n');

    expect(reorganize(source)).toBe(
      [
        'class C',
        '{',
        '    public static void F() { }',
        '    public void B() { }',
        '    internal void D() { }',
        '    protected internal void E() { }',
        '    protected void C2() { }',
        '    private void A() { }',
        '    void G() { }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('treats a member without a modifier as private in a class and public in an interface', () => {
    const source = 'class C\n{\n    void Hidden() { }\n    public void Shown() { }\n}\ninterface I\n{\n    void B();\n    void A();\n}\n';

    expect(reorganize(source)).toBe('interface I\n{\n    void A();\n    void B();\n}\nclass C\n{\n    public void Shown() { }\n    void Hidden() { }\n}\n');
  });

  it('honours the reverse access order and access-first primary order', () => {
    const source = 'class C\n{\n    public void B() { }\n    private int _f;\n    private void A() { }\n    public int F;\n}\n';

    expect(reorganize(source, { reverseOrderByAccessLevel: true })).toBe('class C\n{\n    private int _f;\n    public int F;\n    private void A() { }\n    public void B() { }\n}\n');
    expect(reorganize(source, { primaryOrderByAccessLevel: true })).toBe('class C\n{\n    public int F;\n    public void B() { }\n    private int _f;\n    private void A() { }\n}\n');
  });

  it('keeps the source order inside a group when not alphabetizing', () => {
    const source = 'class C\n{\n    void B() { }\n    int _x;\n    void A() { }\n}\n';

    expect(reorganize(source, { alphabetizeMembersOfTheSameGroup: false })).toBe('class C\n{\n    int _x;\n    void B() { }\n    void A() { }\n}\n');
  });

  it('places explicit interface implementations at the end of their group on request', () => {
    const source = 'class C : I\n{\n    void I.B() { }\n    public void A() { }\n    void I.A2() { }\n    public void C2() { }\n}\n';

    expect(reorganize(source)).toBe('class C : I\n{\n    public void A() { }\n    void I.A2() { }\n    void I.B() { }\n    public void C2() { }\n}\n');
    expect(reorganize(source, { explicitMembersAtEnd: true })).toBe('class C : I\n{\n    public void A() { }\n    public void C2() { }\n    void I.A2() { }\n    void I.B() { }\n}\n');
  });

  it('sorts member types that share an order together, by the weights of the Visual Studio comparer', () => {
    const memberTypes = createDefaultReorganizeSettings().memberTypes;
    memberTypes.methods = { order: 1, name: 'Methods' };
    memberTypes.fields = { order: 2, name: 'Members' };
    memberTypes.properties = { order: 2, name: 'Members' };
    const source = 'class C\n{\n    private int C2;\n    private int B { get; set; }\n    private void Z() { }\n    private int A;\n}\n';

    expect(reorganize(source, { memberTypes })).toBe('class C\n{\n    private void Z() { }\n    private int B { get; set; }\n    private int A;\n    private int C2;\n}\n');
  });

  it('reorders fields: constants, static read-only, static, instance read-only, instance', () => {
    const source = 'class C\n{\n    int Instance;\n    readonly int InstanceReadOnly;\n    static int StaticField;\n    static readonly int StaticReadOnly;\n    const int Constant = 1;\n}\n';

    expect(reorganize(source)).toBe(
      'class C\n{\n    const int Constant = 1;\n    static readonly int StaticReadOnly;\n    static int StaticField;\n    readonly int InstanceReadOnly;\n    int Instance;\n}\n'
    );
  });

  it('orders the types of a namespace and recurses into nested types', () => {
    const source = [
      'namespace N',
      '{',
      '    public class B',
      '    {',
      '        public void Y() { }',
      '        public int X;',
      '    }',
      '',
      '    public enum E { Z, A }',
      '    public interface I { }',
      '}',
      '',
    ].join('\n');

    expect(reorganize(source)).toBe(
      [
        'namespace N',
        '{',
        '    public enum E { Z, A }',
        '    public interface I { }',
        '    public class B',
        '    {',
        '        public int X;',
        '        public void Y() { }',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });
});

describe('reorganize: what travels with a member', () => {
  it('moves the comments above a member, its attributes, XML documentation and trailing comment with it', () => {
    const source = [
      'class C',
      '{',
      '    // about Run',
      '    public void Run() { }',
      '',
      '    /// <summary>The field.</summary>',
      '    [Obsolete]',
      '    private int _f; // trailing',
      '',
      '    private int _g;',
      '}',
      '',
    ].join('\n');

    expect(reorganize(source)).toBe(
      [
        'class C',
        '{',
        '    /// <summary>The field.</summary>',
        '    [Obsolete]',
        '    private int _f; // trailing',
        '',
        '    private int _g;',
        '    // about Run',
        '    public void Run() { }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('leaves a comment separated from the next member by a blank line where it is', () => {
    const source = 'class C\n{\n    // ---- helpers ----\n\n    void B() { }\n    void A() { }\n}\n';

    expect(reorganize(source)).toBe('class C\n{\n    // ---- helpers ----\n\n    void A() { }\n    void B() { }\n}\n');
  });

  it('keeps block comments directly above a member with it', () => {
    const source = 'class C\n{\n    /* B does b */\n    void B() { }\n    void A() { }\n}\n';

    expect(reorganize(source)).toBe('class C\n{\n    void A() { }\n    /* B does b */\n    void B() { }\n}\n');
  });

  it('moves a member with a stray semicolon after it as one', () => {
    const source = 'class C\n{\n    void B() { };\n    void A() { }\n}\n';

    expect(reorganize(source)).toBe('class C\n{\n    void A() { }\n    void B() { };\n}\n');
  });

  it('keeps the line endings of the file', () => {
    const source = 'class C\r\n{\r\n    void B() { }\r\n\r\n    int _a;\r\n}\r\n';

    expect(reorganize(source)).toBe('class C\r\n{\r\n    int _a;\r\n    void B() { }\r\n}\r\n');
  });

  it('keeps tabs and the original indentation of each member', () => {
    const source = 'namespace N\n{\n\tclass C\n\t{\n\t\tvoid B()\n\t\t{\n\t\t\tint x;\n\t\t}\n\t\tint _a;\n\t}\n}\n';

    expect(reorganize(source)).toBe('namespace N\n{\n\tclass C\n\t{\n\t\tint _a;\n\t\tvoid B()\n\t\t{\n\t\t\tint x;\n\t\t}\n\t}\n}\n');
  });
});

describe('reorganize: blank lines', () => {
  it('keeps the blank line a member had before it when it moves', () => {
    const source = 'class C\n{\n    void B() { }\n\n    void A() { }\n\n    int _f;\n}\n';

    // B had none before it (it was first), A and _f had one.
    expect(reorganize(source)).toBe('class C\n{\n    int _f;\n\n    void A() { }\n    void B() { }\n}\n');
  });

  it('pads moved members with the blank lines the cleanup padding settings ask for', () => {
    const source = 'class C\n{\n    void B() { }\n    void A() { }\n    int _f;\n    int _g;\n}\n';

    expect(reorganize(source, {}, createDefaultSettings())).toBe('class C\n{\n    int _f;\n    int _g;\n\n    void A() { }\n\n    void B() { }\n}\n');
  });

  it('does not touch the blank lines between members that stay next to each other', () => {
    const source = 'class C\n{\n    int _a;\n\n\n    int _b;\n    void Z() { }\n    void B() { }\n}\n';

    expect(reorganize(source, {}, createDefaultSettings())).toBe('class C\n{\n    int _a;\n\n\n    int _b;\n\n    void B() { }\n\n    void Z() { }\n}\n');
  });
});

describe('reorganize: types and places left alone', () => {
  it('does not reorder the members of an enum', () => {
    expect(reorganize('enum E\n{\n    Z,\n    A,\n}\n')).toBe('enum E\n{\n    Z,\n    A,\n}\n');
  });

  it('does not reorder the members of a type with StructLayout or ComImport', () => {
    const layout = '[StructLayout(LayoutKind.Sequential)]\nstruct S\n{\n    public void M() { }\n    public int A;\n}\n';
    const com = '[System.Runtime.InteropServices.ComImport]\ninterface I\n{\n    void B();\n    void A();\n}\n';

    expect(reorganize(layout)).toBe(layout);
    expect(reorganize(com)).toBe(com);
  });

  it('does not reorder the members of a type whose layout attribute is global::-qualified', () => {
    const layout =
      '[global::System.Runtime.InteropServices.StructLayout(global::System.Runtime.InteropServices.LayoutKind.Sequential)]\nstruct POINT\n{\n    public int y;\n    public int x;\n}\n';
    const com = '[global::System.Runtime.InteropServices.ComImport]\ninterface I\n{\n    void B();\n    void A();\n}\n';

    expect(reorganize(layout)).toBe(layout);
    expect(reorganize(com)).toBe(com);
  });

  it('does not reorder the members of a COM interface, whose order is its vtable', () => {
    const generated = '[GeneratedComInterface]\n[Guid("00000000-0000-0000-0000-000000000001")]\ninterface I\n{\n    void B();\n    void A();\n}\n';
    const typed = '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\ninterface J\n{\n    void B();\n    void A();\n}\n';

    expect(reorganize(generated)).toBe(generated);
    expect(reorganize(typed)).toBe(typed);
  });

  it('does not descend into a type with a fixed layout', () => {
    const source = '[StructLayout(LayoutKind.Explicit)]\nstruct S\n{\n    struct Inner\n    {\n        public void M() { }\n        public int A;\n    }\n}\n';

    expect(reorganize(source)).toBe(source);
  });

  it('reorganizes structs, interfaces, records and partial classes', () => {
    const source = [
      'partial class P { void B() { } }',
      'struct S',
      '{',
      '    public void B() { }',
      '    public int A;',
      '}',
      'record R(int X)',
      '{',
      '    public void B() { }',
      '    public int A;',
      '}',
      'record struct RS(int X)',
      '{',
      '    public void B() { }',
      '    public int A;',
      '}',
      '',
    ].join('\n');
    const result = reorganize(source);

    expect(result).toContain('struct S\n{\n    public int A;\n    public void B() { }\n}');
    expect(result).toContain('record R(int X)\n{\n    public int A;\n    public void B() { }\n}');
    expect(result).toContain('record struct RS(int X)\n{\n    public int A;\n    public void B() { }\n}');
  });

  it('orders the types of a file-scoped namespace', () => {
    const source = 'namespace N;\n\npublic class B { }\n\npublic enum A { X }\n';

    expect(reorganize(source)).toBe('namespace N;\n\npublic enum A { X }\npublic class B { }\n');
  });

  it('leaves a body whose members share a line alone and reports it', () => {
    const source = 'class C { void B() { } int A; }\nclass D\n{\n    void B() { }\n    int A;\n}\n';
    const result = reorganizeSourceDetailed(source, createDefaultReorganizeSettings(), createDefaultSettings());

    expect(result.output).toBe('class C { void B() { } int A; }\nclass D\n{\n    int A;\n\n    void B() { }\n}\n');
    expect(result.skipped).toEqual([expect.stringContaining('C (line 1): skipped because of more than one member on a line')]);
  });

  it('leaves top-level statements in place and still orders the types', () => {
    const source = 'using System;\nConsole.WriteLine(1);\nclass B { }\nclass A\n{\n    void Z() { }\n    int F;\n}\n';

    expect(reorganize(source)).toBe('using System;\nConsole.WriteLine(1);\nclass B { }\nclass A\n{\n    int F;\n    void Z() { }\n}\n');
    // Top-level statements are nothing to report: the types of such a file are not ordered, and that is all.
    expect(reorganizeSourceDetailed(source, createDefaultReorganizeSettings(), createDefaultSettings()).skipped).toEqual([]);
  });

  it('reorganizes a file that starts with a byte order mark and keeps the mark', () => {
    const inNamespace = '\uFEFFnamespace N\n{\n    class Zed\n    {\n        void B() { }\n        void A() { }\n    }\n}\n';
    const atTop = '\uFEFFclass Zed\n{\n    void B() { }\n    void A() { }\n}\n';
    const documented = '\uFEFF/// <summary>Doc.</summary>\nclass Zed\n{\n    void B() { }\n    void A() { }\n}\n';

    expect(reorganize(inNamespace)).toBe('\uFEFFnamespace N\n{\n    class Zed\n    {\n        void A() { }\n        void B() { }\n    }\n}\n');
    expect(reorganize(atTop)).toBe('\uFEFFclass Zed\n{\n    void A() { }\n    void B() { }\n}\n');
    expect(reorganize(documented)).toBe('\uFEFF/// <summary>Doc.</summary>\nclass Zed\n{\n    void A() { }\n    void B() { }\n}\n');
  });

  it('orders members that are explicit implementations of interface events and indexers', () => {
    const source = 'class C : I\n{\n    event System.Action I.E { add { } remove { } }\n    int I.this[int i] { get => 0; }\n    void I.B() { }\n    int I.A { get; set; }\n}\n';

    expect(reorganize(source)).toBe(
      'class C : I\n{\n    event System.Action I.E { add { } remove { } }\n    int I.A { get; set; }\n    int I.this[int i] { get => 0; }\n    void I.B() { }\n}\n'
    );
  });
});

describe('reorganize: pipeline transformation', () => {
  it('is a cleanup pipeline step that applies the reorganizer with the given settings', () => {
    const transformation = createReorganizeTransformation(createDefaultReorganizeSettings(), withoutPadding());

    expect(transformation.name).toBe('Reorganize members');
    expect(transformation.apply('class C\n{\n    void B() { }\n    int _a;\n}\n')).toBe('class C\n{\n    int _a;\n    void B() { }\n}\n');
    expect(transformation.apply('')).toBe('');
  });

  it('leaves a file with preprocessor conditionals alone unless the policy is yes, as a step cannot ask', () => {
    const source = 'class C\n{\n    void B() { }\n#if X\n    int _a;\n#endif\n}\n';

    expect(createReorganizeTransformation(createDefaultReorganizeSettings()).apply(source)).toBe(source);
    expect(createReorganizeTransformation({ ...createDefaultReorganizeSettings(), performWhenPreprocessorConditionals: 'yes' }).apply(source)).not.toBe(source);
  });
});

describe('reorganize: edge cases', () => {
  it('orders the namespaces of a file after its using directives', () => {
    const source = 'using System;\nnamespace B\n{\n    class X { }\n}\nnamespace A\n{\n    class Y { }\n}\n';

    expect(reorganize(source)).toBe('using System;\nnamespace A\n{\n    class Y { }\n}\nnamespace B\n{\n    class X { }\n}\n');
  });

  it('never moves a declaration that carries an assembly attribute, which must precede all declarations', () => {
    const source = 'using System;\n[assembly: CLSCompliant(true)]\nnamespace B\n{\n    class X { }\n}\nnamespace A\n{\n    class Y { }\n}\n';

    expect(reorganize(source)).toBe(source);
  });

  it('has nothing to report for a file of assembly attributes only', () => {
    const source = 'using System.Reflection;\n\n[assembly: AssemblyTitle("T")]\n[assembly: AssemblyCompany("C")]\n';
    const result = reorganizeSourceDetailed(source, createDefaultReorganizeSettings(), createDefaultSettings());

    expect(result.output).toBe(source);
    expect(result.skipped).toEqual([]);
  });

  it('keeps an extern alias and the usings after it in front of the types of a namespace', () => {
    const source = 'namespace N\n{\n    extern alias V1;\n    using V1::Ext;\n\n    class B { }\n    class A { }\n}\n';

    expect(reorganize(source)).toBe('namespace N\n{\n    extern alias V1;\n    using V1::Ext;\n\n    class A { }\n    class B { }\n}\n');
  });

  it('keeps the usings of a namespace before its types', () => {
    const source = 'namespace N\n{\n    using System;\n\n    class B { }\n    class A { }\n}\n';

    expect(reorganize(source)).toBe('namespace N\n{\n    using System;\n\n    class A { }\n    class B { }\n}\n');
  });

  it('reorganizes the nested types of a type it leaves alone', () => {
    const source = 'class Outer\n{\n    void Z() { } int _shared;\n    class Inner\n    {\n        void B() { }\n        int _a;\n    }\n}\n';
    const result = reorganizeSourceDetailed(source, createDefaultReorganizeSettings(), createDefaultSettings());

    expect(result.output).toContain('class Inner\n    {\n        int _a;\n\n        void B() { }\n    }');
    expect(result.skipped).toEqual([expect.stringContaining('Outer (line 1): skipped because of more than one member on a line')]);
  });

  it('keeps a region only if it still holds members of its name after sorting across regions', () => {
    const source = 'class C\n{\n    #region Fields\n    int _b;\n    void B() { }\n    #endregion\n    #region Methods\n    int _a;\n    void A() { }\n    #endregion\n}\n';
    const once = reorganize(source, { keepMembersWithinRegions: false, regionsRemoveExistingRegions: true });

    // Sorted across the regions: _a, _b, A, B. Fields then holds fields and Methods holds methods only.
    expect(once).toBe('class C\n{\n    #region Fields\n    int _a;\n    int _b;\n    #endregion\n    #region Methods\n    void A() { }\n    void B() { }\n    #endregion\n}\n');
  });

  it('names the regions of a private protected member after its access level', () => {
    const source = 'class C\n{\n    private protected void M() { }\n}\n';

    expect(reorganize(source, { regionsInsertNewRegions: true, regionsIncludeAccessLevel: true })).toContain('#region Private Protected Methods');
  });

  it('places a comment that trails the opening brace with the brace', () => {
    const source = 'class C\n{ // the body\n    void B() { }\n    int _a;\n}\n';

    expect(reorganize(source)).toBe('class C\n{ // the body\n    int _a;\n    void B() { }\n}\n');
  });

  it('indents the regions it inserts like the members of a body that is indented with tabs', () => {
    const source = 'namespace N\n{\n\tclass C\n\t{\n\t\tvoid B() { }\n\t\tint _a;\n\t}\n}\n';

    expect(reorganize(source, { regionsInsertNewRegions: true })).toContain('\t\t#region Fields\n\t\tint _a;\n\t\t#endregion Fields\n\t\t#region Methods\n');
  });

  it('keeps the indentation of a #region inserted around a #if block', () => {
    const source = 'class C\n{\n#if X\n    int _a;\n#endif\n    void M() { }\n}\n';

    expect(reorganize(source, { regionsInsertNewRegions: true, performWhenPreprocessorConditionals: 'yes' })).toContain('    #region Fields\n#if X\n    int _a;\n#endif\n    #endregion Fields');
  });
});
