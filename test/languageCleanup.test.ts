import { describe, expect, it, vi } from 'vitest';
import { commentPrefix, detectLanguage, fileTypeKey, languageFamily } from '../src/cleanup/languages/codeLanguage';
import { runLanguageCleanup, runLayoutCleanup } from '../src/cleanup/layoutCleanup';
import { CleanupSettings, HeaderUpdateMode, createDefaultSettings } from '../src/cleanup/types';

/** Every boolean setting off, then `overrides`: each test sees only the rules it turns on (and the final newline). */
function only(overrides: Partial<CleanupSettings> = {}): CleanupSettings {
  const settings = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      settings[key] = false;
    }
  }

  return { ...(settings as unknown as CleanupSettings), ...overrides };
}

describe('detectLanguage', () => {
  it.each([
    ['Module1.vb', 'vb'],
    ['Lib.fs', 'fsharp'],
    ['Script.fsx', 'fsharp'],
    ['main.c', 'cpp'],
    ['main.cpp', 'cpp'],
    ['main.h', 'cpp'],
    ['site.css', 'css'],
    ['site.less', 'less'],
    ['site.scss', 'scss'],
    ['app.js', 'javascript'],
    ['app.mjs', 'javascript'],
    ['App.jsx', 'javascript'],
    ['app.ts', 'typescript'],
    ['App.tsx', 'typescript'],
    ['package.json', 'json'],
    ['settings.jsonc', 'json'],
    ['index.html', 'html'],
    ['index.HTM', 'html'],
    ['MainWindow.xaml', 'xaml'],
    ['App.axaml', 'xaml'],
    ['data.xml', 'xml'],
    ['App.csproj', 'xml'],
    ['web.config', 'xml'],
    ['Strings.resx', 'xml'],
    ['index.php', 'php'],
    ['build.ps1', 'powershell'],
    ['Module.psm1', 'powershell'],
    ['analysis.R', 'r'],
    ['Page.razor', 'razor'],
    ['Index.cshtml', 'razor'],
    ['Program.cs', 'csharp'],
    ['notes.txt', 'other'],
    ['README.md', 'other'],
    ['Makefile', 'other'],
  ])('%s is %s', (file, language) => {
    expect(detectLanguage(`/w/${file}`)).toBe(language);
  });

  it('falls back to the VS Code language identifier when the extension says nothing', () => {
    expect(detectLanguage('Untitled-1', 'vb')).toBe('vb');
    expect(detectLanguage('Untitled-1', 'typescriptreact')).toBe('typescript');
    expect(detectLanguage('Untitled-1', 'jsonc')).toBe('json');
    expect(detectLanguage('Untitled-1', 'plaintext')).toBe('other');
    expect(detectLanguage('Untitled-1', 'constructor')).toBe('other');
  });

  it('trusts a known extension over the language identifier', () => {
    expect(detectLanguage('/w/a.vb', 'plaintext')).toBe('vb');
  });

  it('groups the languages as Visual Studio does', () => {
    expect(['cpp', 'css', 'javascript', 'json', 'less', 'php', 'powershell', 'r', 'scss', 'typescript'].map((l) => languageFamily(l as never))).toEqual(
      Array(10).fill('cFamily')
    );
    expect(['html', 'xaml', 'xml'].map((l) => languageFamily(l as never))).toEqual(['markup', 'markup', 'markup']);
    expect(languageFamily('vb')).toBe('vb');
    expect(languageFamily('fsharp')).toBe('generic');
    expect(languageFamily('other')).toBe('generic');
  });

  it('maps each language to its fileTypes setting', () => {
    expect(fileTypeKey('csharp')).toBeUndefined();
    expect(fileTypeKey('vb')).toBe('vb');
    expect(fileTypeKey('razor')).toBe('html');
    expect(fileTypeKey('other')).toBe('everythingElse');
  });

  it('knows the comment prefix of the languages whose comments are formatted', () => {
    expect(commentPrefix('vb')).toBe("'");
    expect(commentPrefix('typescript')).toBe('//');
    expect(commentPrefix('powershell')).toBe('#');
    expect(commentPrefix('xml')).toBeUndefined();
    expect(commentPrefix('json')).toBeUndefined();
    expect(commentPrefix('other')).toBeUndefined();
  });
});

describe('the file header of every language', () => {
  it.each([
    ['a.vb', 'fileHeaderVB', "' Copyright", 'Module M\nEnd Module\n'],
    ['a.fs', 'fileHeaderFSharp', '// Copyright', 'let x = 1\n'],
    ['a.cpp', 'fileHeaderCPlusPlus', '// Copyright', 'int x;\n'],
    ['a.css', 'fileHeaderCSS', '/* Copyright */', 'a { }\n'],
    ['a.less', 'fileHeaderLESS', '// Copyright', 'a { }\n'],
    ['a.scss', 'fileHeaderSCSS', '// Copyright', 'a { }\n'],
    ['a.js', 'fileHeaderJavaScript', '// Copyright', 'let x;\n'],
    ['a.ts', 'fileHeaderTypeScript', '// Copyright', 'let x;\n'],
    ['a.json', 'fileHeaderJSON', '// Copyright', '{}\n'],
    ['a.html', 'fileHeaderHTML', '<!-- Copyright -->', '<p></p>\n'],
    ['a.xaml', 'fileHeaderXAML', '<!-- Copyright -->', '<Grid />\n'],
    ['a.xml', 'fileHeaderXML', '<!-- Copyright -->', '<root />\n'],
    ['a.php', 'fileHeaderPHP', '// Copyright', 'echo 1;\n'],
    ['a.ps1', 'fileHeaderPowerShell', '# Copyright', 'Write-Host 1\n'],
    ['a.r', 'fileHeaderR', '# Copyright', 'x <- 1\n'],
  ])('%s gets %s', (file, key, header, body) => {
    const settings = only({ [key]: header } as Partial<CleanupSettings>);
    const output = runLayoutCleanup(body, `/w/${file}`, settings);

    expect(output).toBe(`${header}\n${body}`);
    expect(runLayoutCleanup(output, `/w/${file}`, settings)).toBe(output);
  });

  it('uses only the header of the file language', () => {
    expect(runLayoutCleanup('let x;\n', '/w/a.js', only({ fileHeaderTypeScript: '// TS' }))).toBe('let x;\n');
    expect(runLayoutCleanup('text\n', '/w/a.txt', only({ fileHeaderJavaScript: '// JS' }))).toBe('text\n');
  });

  it('goes below a shebang line', () => {
    expect(runLayoutCleanup('#!/usr/bin/env node\nrun();\n', '/w/a.js', only({ fileHeaderJavaScript: '// H' }))).toBe('#!/usr/bin/env node\n// H\nrun();\n');
    expect(runLayoutCleanup('#!/usr/bin/env pwsh', '/w/a.ps1', only({ fileHeaderPowerShell: '# H' }))).toBe('#!/usr/bin/env pwsh\n# H\n');
  });

  it('goes below an XML declaration, even one over several lines', () => {
    expect(runLayoutCleanup('<?xml version="1.0"?>\n<root />\n', '/w/a.xml', only({ fileHeaderXML: '<!-- H -->' }))).toBe(
      '<?xml version="1.0"?>\n<!-- H -->\n<root />\n'
    );
    expect(runLayoutCleanup('<?xml version="1.0"\n  encoding="utf-8"?>\n<root />\n', '/w/a.xml', only({ fileHeaderXML: '<!-- H -->' }))).toBe(
      '<?xml version="1.0"\n  encoding="utf-8"?>\n<!-- H -->\n<root />\n'
    );
  });

  it('goes below the PHP opening tag', () => {
    expect(runLayoutCleanup('<?php\necho 1;\n', '/w/a.php', only({ fileHeaderPHP: '// H' }))).toBe('<?php\n// H\necho 1;\n');
  });

  it('keeps the line endings of the file', () => {
    expect(runLayoutCleanup('Module M\r\nEnd Module\r\n', '/w/a.vb', only({ fileHeaderVB: "' A\n' B" }))).toBe("' A\r\n' B\r\nModule M\r\nEnd Module\r\n");
  });

  it('replaces the existing header in replace mode, with the syntax of the language', () => {
    const replace = { fileHeaderUpdateMode: HeaderUpdateMode.Replace };
    expect(runLayoutCleanup("' old\n' older\nModule M\nEnd Module\n", '/w/a.vb', only({ ...replace, fileHeaderVB: "' new" }))).toBe(
      "' new\nModule M\nEnd Module\n"
    );
    expect(runLayoutCleanup('<?xml version="1.0"?>\n<!-- old\n  more -->\n<root />\n', '/w/a.xml', only({ ...replace, fileHeaderXML: '<!-- new -->' }))).toBe(
      '<?xml version="1.0"?>\n<!-- new -->\n<root />\n'
    );
    expect(runLayoutCleanup('/* old */\na { }\n', '/w/a.css', only({ ...replace, fileHeaderCSS: '/* new */' }))).toBe('/* new */\na { }\n');
    expect(runLayoutCleanup('<# old\n#>\nWrite-Host 1\n', '/w/a.ps1', only({ ...replace, fileHeaderPowerShell: '# new' }))).toBe('# new\nWrite-Host 1\n');
    expect(runLayoutCleanup('(* old *)\nlet x = 1\n', '/w/a.fs', only({ ...replace, fileHeaderFSharp: '// new' }))).toBe('// new\nlet x = 1\n');
    expect(runLayoutCleanup('<?php\n# old\necho 1;\n', '/w/a.php', only({ ...replace, fileHeaderPHP: '// new' }))).toBe('<?php\n// new\necho 1;\n');
  });

  it('inserts the header above another comment in insert mode', () => {
    expect(runLayoutCleanup('// other\nlet x;\n', '/w/a.js', only({ fileHeaderJavaScript: '// H' }))).toBe('// H\n// other\nlet x;\n');
  });

  it('leaves a header that is already there alone in replace mode', () => {
    const settings = only({ fileHeaderUpdateMode: HeaderUpdateMode.Replace, fileHeaderJavaScript: '// H' });

    expect(runLayoutCleanup('// H\nlet x;\n', '/w/a.js', settings)).toBe('// H\nlet x;\n');
  });
});

describe('the C-family rules', () => {
  it('removes the blank lines after an opening brace and before a closing brace', () => {
    expect(
      runLayoutCleanup(
        'function f() {\n\n\n  return 1;\n\n}\n',
        '/w/a.js',
        only({ removeBlankLinesAfterOpeningBrace: true, removeBlankLinesBeforeClosingBrace: true })
      )
    ).toBe('function f() {\n  return 1;\n}\n');
    expect(
      runLayoutCleanup('.a {\n\n  color: red;\n\n}\n', '/w/a.css', only({ removeBlankLinesAfterOpeningBrace: true, removeBlankLinesBeforeClosingBrace: true }))
    ).toBe('.a {\n  color: red;\n}\n');
  });

  it('keeps a trailing comment after the opening brace', () => {
    expect(runLayoutCleanup('if (a) { // why\n\n  b();\n}\n', '/w/a.ts', only({ removeBlankLinesAfterOpeningBrace: true }))).toBe(
      'if (a) { // why\n  b();\n}\n'
    );
  });

  it('keeps the blank lines at braces when the options are off', () => {
    expect(runLayoutCleanup('f() {\n\n  x;\n\n}\n', '/w/a.cpp', only())).toBe('f() {\n\n  x;\n\n}\n');
  });

  it('pads a single-line comment that follows code', () => {
    const settings = only({ insertBlankLinePaddingBeforeSingleLineComments: true });

    expect(runLayoutCleanup('const a = 1;\n// b\n// c\nconst b = 2;\n', '/w/a.ts', settings)).toBe('const a = 1;\n\n// b\n// c\nconst b = 2;\n');
    expect(runLayoutCleanup('if (a) {\n  // first\n  b();\n}\n', '/w/a.ts', settings)).toBe('if (a) {\n  // first\n  b();\n}\n');
    expect(runLayoutCleanup('a(); // trailing\n// next\n', '/w/a.ts', settings)).toBe('a(); // trailing\n// next\n');
    expect(runLayoutCleanup('a();\n/// doc\n', '/w/a.ts', settings)).toBe('a();\n/// doc\n');
  });

  it('does not run on F#, the generic languages or Visual Basic', () => {
    const settings = only({ removeBlankLinesAfterOpeningBrace: true, insertBlankLinePaddingBeforeSingleLineComments: true });

    expect(runLayoutCleanup('let r = {\n\n  X = 1 }\nlet y = 2\n// c\n', '/w/a.fs', settings)).toBe('let r = {\n\n  X = 1 }\nlet y = 2\n// c\n');
    expect(runLayoutCleanup('a {\n\nb\n', '/w/a.txt', settings)).toBe('a {\n\nb\n');
  });
});

describe('the markup rules', () => {
  const all = only({
    removeBlankLinesBeforeClosingTags: true,
    removeBlankSpacesBeforeClosingAngleBrackets: true,
    insertBlankSpaceBeforeSelfClosingAngleBrackets: true,
  });

  it('removes the blank lines before a closing tag', () => {
    expect(runLayoutCleanup('<a>\n  <b></b>\n\n\n</a>\n', '/w/a.xml', only({ removeBlankLinesBeforeClosingTags: true }))).toBe('<a>\n  <b></b>\n</a>\n');
  });

  it('removes the spaces before a closing angle bracket', () => {
    expect(runLayoutCleanup('<a  >\n<b x="1"\n   >\n</b >\n</a>\n', '/w/a.xml', only({ removeBlankSpacesBeforeClosingAngleBrackets: true }))).toBe(
      '<a>\n<b x="1">\n</b>\n</a>\n'
    );
  });

  it('puts one space before a self-closing angle bracket', () => {
    expect(runLayoutCleanup('<a><b/><c x="1"/><d   /></a>\n', '/w/a.xaml', only({ insertBlankSpaceBeforeSelfClosingAngleBrackets: true }))).toBe(
      '<a><b /><c x="1" /><d   /></a>\n'
    );
    expect(runLayoutCleanup('<a><b/><d   /><e\n   x="1"\n   /></a>\n', '/w/a.xaml', all)).toBe('<a><b /><d /><e\n   x="1" /></a>\n');
  });

  it('removes the space before a self-closing angle bracket when no space is to be inserted', () => {
    expect(runLayoutCleanup('<a><b /><c  /></a>\n', '/w/a.xml', only({ removeBlankSpacesBeforeClosingAngleBrackets: true }))).toBe('<a><b/><c/></a>\n');
  });

  it('never touches comments, CDATA, processing instructions or attribute values', () => {
    const input = [
      '<?xml version="1.0" ?>',
      '<root a="x/> y >" b=\'<c/>\'>',
      '  <!-- <d/> <e >',
      '',
      '',
      '  </f> -->',
      '  <![CDATA[ <g/> <h >',
      '',
      '  </i> ]]>',
      '  <?pi <j/> ?>',
      '</root>',
      '',
    ].join('\n');

    expect(runLayoutCleanup(input, '/w/a.xml', all)).toBe(input);
  });

  it('never touches the content of an HTML script, style, pre or textarea element', () => {
    const input = '<script>\nif (a <b && c > d) { x = "<e/>"; }\n\n</script>\n<pre>\n  keep\n\n</pre>\n<br/>\n';

    expect(runLayoutCleanup(input, '/w/a.html', all)).toBe(input.replace('<br/>', '<br />'));
  });

  it('applies to HTML, XAML and XML only', () => {
    expect(runLayoutCleanup('<a/>\n', '/w/a.txt', all)).toBe('<a/>\n');
    expect(runLayoutCleanup('const a = <b/>;\n', '/w/a.tsx', all)).toBe('const a = <b/>;\n');
  });

  it('leaves text that is not a tag alone', () => {
    const input = '<p>a < b and c > d</p>\n';

    expect(runLayoutCleanup(input, '/w/a.html', all)).toBe(input);
  });
});

describe('the Visual Basic rules', () => {
  it('removes the region directives', () => {
    expect(
      runLayoutCleanup('Class C\n    #Region "Fields"\n    Private x As Integer\n    #End Region\nEnd Class\n', '/w/a.vb', only({ removeRegions: true }))
    ).toBe('Class C\n    Private x As Integer\nEnd Class\n');
  });

  it('pads the region directives when they stay', () => {
    const settings = only({
      insertBlankLinePaddingBeforeRegionTags: true,
      insertBlankLinePaddingAfterRegionTags: true,
      insertBlankLinePaddingBeforeEndRegionTags: true,
      insertBlankLinePaddingAfterEndRegionTags: true,
    });

    expect(
      runLayoutCleanup(
        'Class C\n    Dim a As Integer\n    #Region "R"\n    Dim x As Integer\n    #End Region\n    Dim b As Integer\nEnd Class\n',
        '/w/a.vb',
        settings
      )
    ).toBe('Class C\n    Dim a As Integer\n\n    #Region "R"\n\n    Dim x As Integer\n\n    #End Region\n\n    Dim b As Integer\nEnd Class\n');
  });

  it('removes the blank lines after an attribute, but not after an assembly attribute', () => {
    const settings = only({ removeBlankLinesAfterAttributes: true });

    expect(runLayoutCleanup('<Serializable>\n\nPublic Class C\nEnd Class\n', '/w/a.vb', settings)).toBe('<Serializable>\nPublic Class C\nEnd Class\n');
    expect(runLayoutCleanup('<Assembly: CLSCompliant(True)>\n\nModule M\nEnd Module\n', '/w/a.vb', settings)).toBe(
      '<Assembly: CLSCompliant(True)>\n\nModule M\nEnd Module\n'
    );
  });

  it('removes the blank lines after a documentation comment', () => {
    expect(runLayoutCleanup("''' <summary>S</summary>\n\nSub M()\nEnd Sub\n", '/w/a.vb', only())).toBe("''' <summary>S</summary>\nSub M()\nEnd Sub\n");
  });

  it('removes the blank lines between chained statements', () => {
    expect(
      runLayoutCleanup(
        'If a Then\n    b()\n\nElseIf c Then\n    d()\n\nElse\n    e()\nEnd If\nTry\n    f()\n\nCatch ex As Exception\n\nFinally\nEnd Try\n',
        '/w/a.vb',
        only({ removeBlankLinesBetweenChainedStatements: true })
      )
    ).toBe('If a Then\n    b()\nElseIf c Then\n    d()\nElse\n    e()\nEnd If\nTry\n    f()\nCatch ex As Exception\nFinally\nEnd Try\n');
  });

  it('pads a Case that follows the statements of the previous Case', () => {
    expect(
      runLayoutCleanup(
        'Select Case x\n    Case 1\n        a()\n    Case 2, 3\n        b()\n    Case Else\n        c()\nEnd Select\n',
        '/w/a.vb',
        only({ insertBlankLinePaddingBeforeCaseStatements: true })
      )
    ).toBe('Select Case x\n    Case 1\n        a()\n\n    Case 2, 3\n        b()\n\n    Case Else\n        c()\nEnd Select\n');
  });

  it("pads a ' comment that follows code", () => {
    const settings = only({ insertBlankLinePaddingBeforeSingleLineComments: true });

    expect(runLayoutCleanup("Dim a = 1\n' b\n' c\nDim d = 2\n", '/w/a.vb', settings)).toBe("Dim a = 1\n\n' b\n' c\nDim d = 2\n");
    expect(runLayoutCleanup("Sub M()\n    ' first\nEnd Sub\n", '/w/a.vb', settings)).toBe("Sub M()\n    ' first\nEnd Sub\n");
    expect(runLayoutCleanup("Dim a = \"it's\" ' why\n' next\n", '/w/a.vb', settings)).toBe("Dim a = \"it's\" ' why\n' next\n");
    expect(runLayoutCleanup('Dim a = "it\'s"\n\' next\n', '/w/a.vb', settings)).toBe('Dim a = "it\'s"\n\n\' next\n');
    expect(runLayoutCleanup("Dim a = 1\n''' <summary>doc</summary>\n", '/w/a.vb', settings)).toBe("Dim a = 1\n''' <summary>doc</summary>\n");
  });

  it('does not apply the brace rules', () => {
    expect(runLayoutCleanup('Dim a = {\n\n1}\n', '/w/a.vb', only({ removeBlankLinesAfterOpeningBrace: true }))).toBe('Dim a = {\n\n1}\n');
  });
});

describe('runLanguageCleanup', () => {
  it('formats the comments of a Visual Basic file through the comment formatter when formatComments is on', async () => {
    const format = vi.fn(async (text: string) => text.replace("'bad", "' bad"));

    expect(await runLanguageCleanup("'bad\nModule M\nEnd Module\n", '/w/a.vb', only({ formatComments: true }), { formatComments: format })).toBe(
      "' bad\nModule M\nEnd Module\n"
    );
    expect(format).toHaveBeenCalledWith("'bad\nModule M\nEnd Module\n", "'");
  });

  it('does not format comments when formatComments is off, nor in other languages', async () => {
    const format = vi.fn(async (text: string) => `${text}changed`);

    expect(await runLanguageCleanup("'bad\n", '/w/a.vb', only(), { formatComments: format })).toBe("'bad\n");
    expect(await runLanguageCleanup('//bad\n', '/w/a.ts', only({ formatComments: true }), { formatComments: format })).toBe('//bad\n');
    expect(format).not.toHaveBeenCalled();
  });

  it('uses the language identifier of an untitled document', async () => {
    expect(
      await runLanguageCleanup('<a/>\n', 'Untitled-1', only({ insertBlankSpaceBeforeSelfClosingAngleBrackets: true }), {
        languageId: 'xml',
        formatComments: async (text) => text,
      })
    ).toBe('<a />\n');
  });
});
