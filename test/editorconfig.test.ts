import { describe, expect, it } from 'vitest';
import {
  applyText,
  isEnforced,
  loadCSharpOptions,
  loadEditorConfigProperties,
  resolveDiagnosticSeverity,
  resolveEditorConfigProperties,
  splitOptionSeverity,
} from '../src/cleanup/editorconfig';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('applyText', () => {
  it('does nothing for empty or whitespace text', () => {
    const options = {};
    applyText('', '/a.cs', options);
    applyText('  \n  ', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('does nothing for empty filePath', () => {
    const options = {};
    applyText('[*.cs]\nindent_style = space', '', options);

    expect(options).toEqual({});
  });

  it('applies trim_trailing_whitespace = true', () => {
    const options = {};
    applyText('[*.cs]\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: true });
  });

  it('applies trim_trailing_whitespace = false', () => {
    const options = {};
    applyText('[*.cs]\ntrim_trailing_whitespace = false', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: false });
  });

  it('applies insert_final_newline', () => {
    const options = {};
    applyText('[*.cs]\ninsert_final_newline = true', '/a.cs', options);

    expect(options).toEqual({ insertFinalNewline: true });
  });

  it('applies dotnet_sort_system_directives_first', () => {
    const options = {};
    applyText('[*.cs]\ndotnet_sort_system_directives_first = true', '/a.cs', options);

    expect(options).toEqual({ sortSystemDirectivesFirst: true });
  });

  it('applies dotnet_separate_import_directive_groups', () => {
    const options = {};
    applyText('[*.cs]\ndotnet_separate_import_directive_groups = true', '/a.cs', options);

    expect(options).toEqual({ separateImportDirectiveGroups: true });
  });

  it('applies indent_style', () => {
    const options = {};
    applyText('[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options).toEqual({ indentStyle: 'space' });
  });

  it('applies indent_size as number', () => {
    const options = {};
    applyText('[*.cs]\nindent_size = 4', '/a.cs', options);

    expect(options).toEqual({ indentSize: 4 });
  });

  it('applies tab_width as number', () => {
    const options = {};
    applyText('[*.cs]\ntab_width = 8', '/a.cs', options);

    expect(options).toEqual({ tabWidth: 8 });
  });

  it('ignores invalid indent_size', () => {
    const options = {};
    applyText('[*.cs]\nindent_size = notanumber', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('ignores invalid booleans', () => {
    const options = {};
    applyText('[*.cs]\ntrim_trailing_whitespace = maybe', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('skips comment lines', () => {
    const options = {};
    applyText('[*.cs]\n; comment\n# also comment\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: true });
  });

  it('skips lines without =', () => {
    const options = {};
    applyText('[*.cs]\nnoequalsign\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: true });
  });

  it('skips lines with empty key', () => {
    const options = {};
    applyText('[*.cs]\n= novalue', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('applies only C# sections', () => {
    const options = {};
    applyText('[*.md]\nindent_style = tab\n[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('matches the universal section [*]', () => {
    const options = {};
    applyText('[*]\nindent_style = tab', '/a.cs', options);

    expect(options.indentStyle).toBe('tab');
  });

  it('skips sections that do not mention cs', () => {
    const options = {};
    applyText('[*.py]\nindent_style = tab\n[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('skips sections when file is not .cs', () => {
    const options = {};
    applyText('[*.cs]\nindent_style = space', '/a.py', options);

    expect(options).toEqual({});
  });

  it('handles multiple key=value pairs', () => {
    const options = {};
    applyText('[*.cs]\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
    expect(options.indentSize).toBe(2);
    expect(options.trimTrailingWhitespace).toBe(true);
  });

  it('later sections override earlier ones', () => {
    const options = {};
    applyText('[*]\nindent_style = tab\n[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('handles whitespace around keys and values', () => {
    const options = {};
    applyText('[*.cs]\n  indent_style   =   space  ', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('handles unknown keys gracefully', () => {
    const options = {};
    applyText('[*.cs]\nunknown_key = somevalue\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
    expect(Object.keys(options)).toHaveLength(1);
  });
});

describe('loadCSharpOptions', () => {
  it('returns empty for empty path', () => {
    expect(loadCSharpOptions('')).toEqual({});
    expect(loadCSharpOptions('  ')).toEqual({});
  });

  it('reads a real .editorconfig file from a temp directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-editorconfig-'));
    try {
      const csFile = path.join(root, 'Test.cs');
      fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*]\nindent_style = space\n');
      fs.writeFileSync(csFile, 'class C {}\n');

      const options = loadCSharpOptions(csFile);

      expect(options.indentStyle).toBe('space');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops walking up at root = true and lets the nearest file win', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-root-'));
    try {
      const root = path.join(outer, 'Repo');
      const sub = path.join(root, 'Sub');
      fs.mkdirSync(sub, { recursive: true });
      const csFile = path.join(sub, 'Test.cs');

      fs.writeFileSync(path.join(outer, '.editorconfig'), '[*]\nindent_size = 2\n');
      fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n[*]\nindent_style = tab\ntab_width = 8\n');
      fs.writeFileSync(path.join(sub, '.editorconfig'), '[*.cs]\nindent_style = space\n');
      fs.writeFileSync(csFile, 'class C {}\n');

      expect(loadCSharpOptions(csFile)).toEqual({ indentStyle: 'space', tabWidth: 8 });
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it('returns empty when no .editorconfig exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-none-'));
    try {
      const csFile = path.join(root, 'Test.cs');
      fs.writeFileSync(csFile, 'class C {}\n');

      expect(loadCSharpOptions(csFile)).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles unreadable .editorconfig gracefully', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-unreadable-'));
    try {
      const csFile = path.join(root, 'Test.cs');
      fs.writeFileSync(path.join(root, '.editorconfig'), '');
      fs.writeFileSync(csFile, 'class C {}\n');

      // Should not throw.
      const options = loadCSharpOptions(csFile);

      expect(options).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveEditorConfigProperties', () => {
  const resolve = (text: string, filePath: string, directory = '/repo') =>
    resolveEditorConfigProperties([{ directory, text }], filePath);
  const matches = (glob: string, filePath: string) =>
    resolve(`[${glob}]\nhit = yes\n`, filePath).get('hit') === 'yes';

  it('ignores properties in the preamble except root', () => {
    const props = resolve('root = true\nindent_style = tab\n[*]\nindent_size = 4\n', '/repo/a.cs');

    expect(props.get('indent_style')).toBeUndefined();
    expect(props.get('indent_size')).toBe('4');
  });

  it('lower-cases keys, keeps value case and strips comments', () => {
    const props = resolve(
      '# comment\n; comment\n[*.cs]\nDotnet_Naming_Style.Prefix.Required_Prefix = I ; trailing\nkey: value # trailing\n',
      '/repo/a.cs'
    );

    expect(props.get('dotnet_naming_style.prefix.required_prefix')).toBe('I');
    expect(props.get('DOTNET_NAMING_STYLE.PREFIX.REQUIRED_PREFIX')).toBe('I');
    expect(props.get('key')).toBe('value');
  });

  it('lets a later section override an earlier one in the same file', () => {
    const props = resolve('[*.cs]\nindent_size = 2\n[*]\nindent_size = 8\n[*.cs]\nindent_style = space\n', '/repo/a.cs');

    expect(props.get('indent_size')).toBe('8');
    expect(props.get('indent_style')).toBe('space');
  });

  it('lets the nearer file override a farther one and ignores files above root = true', () => {
    const props = resolveEditorConfigProperties(
      [
        { directory: '/', text: '[*]\nfar = 1\nshared = far\n' },
        { directory: '/repo', text: 'root = true\n[*]\nrepo = 1\nshared = repo\n' },
        { directory: '/repo/src', text: '[*.cs]\nshared = src\n' },
      ],
      '/repo/src/a.cs'
    );

    expect(props.get('far')).toBeUndefined();
    expect(props.get('repo')).toBe('1');
    expect(props.get('shared')).toBe('src');
  });

  it('ignores files whose directory does not contain the file', () => {
    const props = resolveEditorConfigProperties([{ directory: '/other', text: '[*]\nx = 1\n' }], '/repo/a.cs');

    expect(props.get('x')).toBeUndefined();
  });

  it('removes a property set to unset', () => {
    const props = resolveEditorConfigProperties(
      [
        { directory: '/repo', text: '[*]\nindent_size = 4\n' },
        { directory: '/repo/src', text: '[*.cs]\nindent_size = unset\n' },
      ],
      '/repo/src/a.cs'
    );

    expect(props.get('indent_size')).toBeUndefined();
    expect(props.entries.has('indent_size')).toBe(false);
  });

  it('matches basename-only globs at any depth', () => {
    expect(matches('*.cs', '/repo/a.cs')).toBe(true);
    expect(matches('*.cs', '/repo/src/deep/a.cs')).toBe(true);
    expect(matches('*.cs', '/repo/a.csproj')).toBe(false);
    expect(matches('a.cs', '/repo/src/a.cs')).toBe(true);
  });

  it('anchors globs containing a slash at the .editorconfig directory', () => {
    expect(matches('src/*.cs', '/repo/src/a.cs')).toBe(true);
    expect(matches('/src/*.cs', '/repo/src/a.cs')).toBe(true);
    expect(matches('src/*.cs', '/repo/lib/src/a.cs')).toBe(false);
    expect(matches('src/*.cs', '/repo/src/deep/a.cs')).toBe(false);
  });

  it('matches ** across directories, including zero directories', () => {
    expect(matches('src/**/*.cs', '/repo/src/a.cs')).toBe(true);
    expect(matches('src/**/*.cs', '/repo/src/x/y/a.cs')).toBe(true);
    expect(matches('**/Tests/*.cs', '/repo/Tests/a.cs')).toBe(true);
    expect(matches('src/**', '/repo/src/x/a.txt')).toBe(true);
    expect(matches('src/**', '/repo/lib/a.txt')).toBe(false);
  });

  it('matches ? and character classes within one path segment', () => {
    expect(matches('?.cs', '/repo/a.cs')).toBe(true);
    expect(matches('?.cs', '/repo/ab.cs')).toBe(false);
    expect(matches('[abc].cs', '/repo/b.cs')).toBe(true);
    expect(matches('[abc].cs', '/repo/d.cs')).toBe(false);
    expect(matches('[!abc].cs', '/repo/d.cs')).toBe(true);
    expect(matches('[!abc].cs', '/repo/a.cs')).toBe(false);
    expect(matches('[a-c].cs', '/repo/b.cs')).toBe(true);
    expect(matches('*.cs', '/repo/src/../a.cs')).toBe(true);
  });

  it('matches brace alternatives, nested alternatives and numeric ranges', () => {
    expect(matches('*.{cs,vb}', '/repo/a.vb')).toBe(true);
    expect(matches('*.{cs,vb}', '/repo/a.fs')).toBe(false);
    expect(matches('{src,test/{unit,e2e}}/*.cs', '/repo/test/e2e/a.cs')).toBe(true);
    expect(matches('{src,test/{unit,e2e}}/*.cs', '/repo/test/other/a.cs')).toBe(false);
    expect(matches('file{1..3}.cs', '/repo/file2.cs')).toBe(true);
    expect(matches('file{1..3}.cs', '/repo/file4.cs')).toBe(false);
    expect(matches('file{-1..1}.cs', '/repo/file-1.cs')).toBe(true);
    expect(matches('{single}.cs', '/repo/{single}.cs')).toBe(true);
    expect(matches('{single}.cs', '/repo/single.cs')).toBe(false);
  });

  it('treats escaped and unbalanced specials literally', () => {
    expect(matches('\\*.cs', '/repo/*.cs')).toBe(true);
    expect(matches('\\*.cs', '/repo/a.cs')).toBe(false);
    expect(matches('a[.cs', '/repo/a[.cs')).toBe(true);
    expect(matches('a{.cs', '/repo/a{.cs')).toBe(true);
    expect(matches('a+(b).cs', '/repo/a+(b).cs')).toBe(true);
  });

  it('matches globs case-sensitively', () => {
    expect(matches('*.CS', '/repo/a.cs')).toBe(false);
  });
});

describe('loadEditorConfigProperties', () => {
  it('folds nested files from disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-props-'));
    try {
      const sub = path.join(root, 'src');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n[*.cs]\na = root\nb = root\n');
      fs.writeFileSync(path.join(sub, '.editorconfig'), '[*.cs]\nb = sub\n');
      const props = loadEditorConfigProperties(path.join(sub, 'A.cs'));

      expect(props.get('a')).toBe('root');
      expect(props.get('b')).toBe('sub');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('severity helpers', () => {
  const props = (text: string) => resolveEditorConfigProperties([{ directory: '/r', text: `[*]\n${text}` }], '/r/a.cs');

  it('splits option values from their severity suffix', () => {
    expect(splitOptionSeverity('true:warning')).toEqual({ value: 'true', severity: 'warning' });
    expect(splitOptionSeverity('when_types_loosely_match : suggestion')).toEqual({
      value: 'when_types_loosely_match',
      severity: 'suggestion',
    });
    expect(splitOptionSeverity('true')).toEqual({ value: 'true' });
    expect(splitOptionSeverity('a:b')).toEqual({ value: 'a:b' });
  });

  it('prefers dotnet_diagnostic, then category, then all analyzers, then the option severity', () => {
    const all = 'dotnet_analyzer_diagnostic.severity = error\n';
    const category = 'dotnet_analyzer_diagnostic.category-Style.severity = suggestion\n';
    const specific = 'dotnet_diagnostic.IDE1006.severity = silent\n';

    expect(resolveDiagnosticSeverity(props(''), 'IDE1006', 'warning')).toBe('warning');
    expect(resolveDiagnosticSeverity(props(all), 'IDE1006', 'warning')).toBe('error');
    expect(resolveDiagnosticSeverity(props(all + category), 'IDE1006', 'warning')).toBe('suggestion');
    expect(resolveDiagnosticSeverity(props(all + category + specific), 'IDE1006', 'warning')).toBe('silent');
    expect(resolveDiagnosticSeverity(props(category), 'IDE1006', 'warning', 'Naming')).toBe('warning');
    expect(resolveDiagnosticSeverity(props('dotnet_diagnostic.IDE1006.severity = default\n' + all), 'IDE1006', 'none')).toBe(
      'none'
    );
    expect(resolveDiagnosticSeverity(props('dotnet_diagnostic.IDE1006.severity = warn\n'), 'IDE1006')).toBe('warning');
    expect(resolveDiagnosticSeverity(props(''), 'IDE1006')).toBeUndefined();
  });

  it('enforces only suggestion, warning and error', () => {
    expect(['none', 'silent', 'suggestion', 'warning', 'error', undefined].map((s) => isEnforced(s as never))).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});
