import { describe, expect, it } from 'vitest';
import {
  isEnforced,
  loadEditorConfigProperties,
  resolveDiagnosticSeverity,
  resolveEditorConfigProperties,
  splitOptionSeverity,
} from '../src/cleanup/editorconfig';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

  it('matches ** as any string, including separators, as Roslyn does', () => {
    expect(matches('src/**/*.cs', '/repo/src/a.cs')).toBe(false);
    expect(matches('src/**/*.cs', '/repo/src/x/a.cs')).toBe(true);
    expect(matches('src/**/*.cs', '/repo/src/x/y/a.cs')).toBe(true);
    expect(matches('**/Tests/*.cs', '/repo/Tests/a.cs')).toBe(false);
    expect(matches('**/Tests/*.cs', '/repo/lib/Tests/a.cs')).toBe(true);
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
    expect(matches('{single}.cs', '/repo/single.cs')).toBe(true);
    expect(matches('{single}.cs', '/repo/{single}.cs')).toBe(false);
    expect(matches('*.{cs}', '/repo/src/a.cs')).toBe(true);
  });

  it('treats escaped and unbalanced specials literally', () => {
    expect(matches('\\*.cs', '/repo/*.cs')).toBe(true);
    expect(matches('\\*.cs', '/repo/a.cs')).toBe(false);
    expect(matches('a[.cs', '/repo/a[.cs')).toBe(true);
    expect(matches('a{.cs', '/repo/a{.cs')).toBe(true);
    expect(matches('a+(b).cs', '/repo/a+(b).cs')).toBe(true);
  });

  it('treats an escaped character inside a character class as that literal character', () => {
    expect(matches('[\\d].cs', '/repo/d.cs')).toBe(true);
    expect(matches('[\\d].cs', '/repo/5.cs')).toBe(false);
    expect(matches('[\\w].cs', '/repo/w.cs')).toBe(true);
    expect(matches('[\\w].cs', '/repo/x.cs')).toBe(false);
    expect(matches('[\\s].cs', '/repo/s.cs')).toBe(true);
    expect(matches('[\\b].cs', '/repo/b.cs')).toBe(true);
    expect(matches('[!\\d].cs', '/repo/5.cs')).toBe(true);
    expect(matches('[!\\d].cs', '/repo/d.cs')).toBe(false);
    expect(matches('[a\\]].cs', '/repo/].cs')).toBe(true);
    expect(matches('[a\\-c].cs', '/repo/-.cs')).toBe(true);
    expect(matches('[a\\-c].cs', '/repo/b.cs')).toBe(false);
  });

  it('matches globs case-sensitively', () => {
    expect(matches('*.CS', '/repo/a.cs')).toBe(false);
  });
});

describe('loadEditorConfigProperties', () => {
  it('returns no properties for an empty path', () => {
    expect(loadEditorConfigProperties('  ').entries.size).toBe(0);
  });

  it('stops walking up at root = true and lets the nearest file win', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-root-'));
    try {
      const root = path.join(outer, 'Repo');
      const sub = path.join(root, 'Sub');
      fs.mkdirSync(sub, { recursive: true });

      fs.writeFileSync(path.join(outer, '.editorconfig'), 'root = true\n[*]\nindent_size = 2\n');
      fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n[*]\nindent_style = tab\ntab_width = 8\n');
      fs.writeFileSync(path.join(sub, '.editorconfig'), '[*.cs]\nindent_style = space\n');

      expect([...loadEditorConfigProperties(path.join(sub, 'Test.cs')).entries]).toEqual([
        ['indent_style', 'space'],
        ['tab_width', '8'],
      ]);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

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
    // `warn` is not a severity Roslyn reads: it is invalid and falls back like any other invalid name.
    expect(resolveDiagnosticSeverity(props('dotnet_diagnostic.IDE1006.severity = warn\n'), 'IDE1006')).toBeUndefined();
    expect(resolveDiagnosticSeverity(props('dotnet_diagnostic.IDE1006.severity = warn\n' + all), 'IDE1006')).toBe('error');
    expect(splitOptionSeverity('true:warn')).toEqual({ value: 'true:warn' });
    expect(resolveDiagnosticSeverity(props(''), 'IDE1006')).toBeUndefined();
  });

  it('lets bulk severities enable CA1852 (bulk-configurable) but not CA1307/CA1867 (disabled by default), as the SDK does', () => {
    const bulk = props('dotnet_analyzer_diagnostic.category-Performance.severity = warning\ndotnet_analyzer_diagnostic.category-Globalization.severity = warning\n');
    const all = props('dotnet_analyzer_diagnostic.severity = warning\n');

    expect(resolveDiagnosticSeverity(bulk, 'CA1852', undefined, 'Performance', false)).toBe('warning');
    expect(resolveDiagnosticSeverity(all, 'CA1852', undefined, 'Performance', false)).toBe('warning');
    for (const [id, category] of [['CA1307', 'Globalization'], ['CA1867', 'Performance']]) {
      expect(resolveDiagnosticSeverity(bulk, id, undefined, category, false), id).toBeUndefined();
      expect(resolveDiagnosticSeverity(all, id, undefined, category, false), id).toBeUndefined();
      expect(resolveDiagnosticSeverity(props(`dotnet_diagnostic.${id}.severity = warning\n`), id, undefined, category, false), id).toBe('warning');
    }
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
