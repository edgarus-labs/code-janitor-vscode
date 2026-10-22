import { CleanupSettings, HeaderUpdateMode } from '../types';
import { CodeLanguage } from './codeLanguage';

type HeaderSettingKey = Exclude<Extract<keyof CleanupSettings, `fileHeader${string}`>, 'fileHeaderPosition' | 'fileHeaderUpdateMode'>;

const HEADER_SETTING: Partial<Readonly<Record<CodeLanguage, HeaderSettingKey>>> = {
  vb: 'fileHeaderVB',
  fsharp: 'fileHeaderFSharp',
  cpp: 'fileHeaderCPlusPlus',
  css: 'fileHeaderCSS',
  less: 'fileHeaderLESS',
  scss: 'fileHeaderSCSS',
  javascript: 'fileHeaderJavaScript',
  typescript: 'fileHeaderTypeScript',
  json: 'fileHeaderJSON',
  html: 'fileHeaderHTML',
  xaml: 'fileHeaderXAML',
  xml: 'fileHeaderXML',
  php: 'fileHeaderPHP',
  powershell: 'fileHeaderPowerShell',
  r: 'fileHeaderR',
};

interface CommentSyntax {
  readonly line: readonly string[];
  readonly block: readonly (readonly [string, string])[];
}

/** The comments a header is written with, per language (`FileHeaderHelper.GetHeaderLength`). */
const HEADER_SYNTAX: Partial<Readonly<Record<CodeLanguage, CommentSyntax>>> = {
  vb: { line: ["'"], block: [] },
  fsharp: { line: ['//'], block: [['(*', '*)']] },
  cpp: { line: ['//'], block: [['/*', '*/']] },
  javascript: { line: ['//'], block: [['/*', '*/']] },
  json: { line: ['//'], block: [['/*', '*/']] },
  less: { line: ['//'], block: [['/*', '*/']] },
  scss: { line: ['//'], block: [['/*', '*/']] },
  typescript: { line: ['//'], block: [['/*', '*/']] },
  css: { line: [], block: [['/*', '*/']] },
  html: { line: [], block: [['<!--', '-->']] },
  xaml: { line: [], block: [['<!--', '-->']] },
  xml: { line: [], block: [['<!--', '-->']] },
  php: { line: ['//', '#'], block: [['/*', '*/']] },
  powershell: { line: ['#'], block: [['<#', '#>']] },
  r: { line: ['#'], block: [] },
};

/**
 * Applies the `fileHeader<Language>` setting of the language (`FileHeaderLogic.UpdateFileHeader`): the header goes
 * at the document start, below a shebang line, an XML declaration or a PHP opening tag (the header position
 * setting is about C# using directives). In insert mode it is added unless the text already starts with it; in
 * replace mode it replaces the leading comment written with the comment syntax of the language.
 */
export function applyFileHeader(source: string, language: CodeLanguage, settings: CleanupSettings): string {
  const key = HEADER_SETTING[language];
  const configured = key === undefined ? '' : settings[key];
  if (!configured.trim()) {
    return source;
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let header = configured.replace(/\r\n?/g, '\n').replace(/\n/g, newline);
  if (!header.endsWith(newline)) {
    header += newline;
  }

  const trimmed = header.trim();
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  let prolog = text.slice(0, prologLength(text, language));
  if (prolog && !prolog.endsWith('\n')) {
    prolog += newline;
  }

  const body = text.slice(prolog.length);
  if (settings.fileHeaderUpdateMode === HeaderUpdateMode.Replace) {
    const length = currentHeaderLength(body, HEADER_SYNTAX[language]);

    return body.slice(0, length).trim() === trimmed ? source : bom + prolog + header + body.slice(length);
  }

  return body.startsWith(trimmed) ? source : bom + prolog + header + body;
}

/** The length of the shebang line, XML declaration or PHP opening tag the header goes below (`GetPrologLength`). */
function prologLength(text: string, language: CodeLanguage): number {
  let length = 0;
  const shebang = /^#![^\n]*(?:\n|$)/.exec(text);
  if (shebang) {
    length = shebang[0].length;
  }

  const rest = text.slice(length);
  if (language === 'xml' || language === 'xaml' || language === 'html') {
    const declaration = /^[ \t]*<\?xml[\s\S]*?\?>[^\n]*(?:\n|$)/.exec(rest);

    return declaration ? length + declaration[0].length : length;
  }

  if (language === 'php') {
    const opening = /^[ \t]*<\?(?:php)?[ \t]*\r?(?:\n|$)/.exec(rest);

    return opening ? length + opening[0].length : length;
  }

  return length;
}

/**
 * The length of the header at the start of `body`: its leading blank lines, then a run of lines starting with a
 * line-comment prefix or one block comment, with the line break after it.
 */
function currentHeaderLength(body: string, syntax: CommentSyntax | undefined): number {
  if (!syntax) {
    return 0;
  }

  const blank = /^(?:[ \t]*\r?\n)*/.exec(body)![0].length;
  const start = body.slice(blank);
  for (const [open, close] of syntax.block) {
    if (start.trimStart().startsWith(open)) {
      const end = start.indexOf(close, start.indexOf(open) + open.length);
      if (end < 0) {
        return 0;
      }

      const lineEnd = /^[^\n]*(?:\n|$)/.exec(start.slice(end + close.length))![0].length;

      return blank + end + close.length + lineEnd;
    }
  }

  let length = 0;
  for (const line of start.split(/(?<=\n)/)) {
    if (!syntax.line.some((prefix) => line.startsWith(prefix))) {
      break;
    }

    length += line.length;
  }

  return length === 0 ? 0 : blank + length;
}
