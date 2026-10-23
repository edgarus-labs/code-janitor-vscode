import * as path from 'node:path';

/** The languages cleanup tells apart, mirroring the `CodeLanguage` of the Visual Studio extension (plus Razor). */
export type CodeLanguage =
  | 'csharp'
  | 'vb'
  | 'fsharp'
  | 'cpp'
  | 'css'
  | 'less'
  | 'scss'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'html'
  | 'xaml'
  | 'xml'
  | 'php'
  | 'powershell'
  | 'r'
  | 'razor'
  | 'other';

/** The suffix of a `codeJanitor.cleanup.fileTypes.<key>` setting. */
export type FileTypeKey = Exclude<CodeLanguage, 'csharp' | 'razor' | 'other'> | 'everythingElse';

/**
 * The cleanup step list a language gets (`CodeCleanupManager.FindCodeCleanupMethod`): C-family languages add
 * the brace and comment rules, markup the tag rules, Visual Basic its own text-level rules; the rest the layout rules.
 */
export type LanguageFamily = 'csharp' | 'vb' | 'cFamily' | 'markup' | 'razor' | 'generic';

const EXTENSIONS: Readonly<Record<Exclude<CodeLanguage, 'other'>, readonly string[]>> = {
  csharp: ['cs'],
  vb: ['vb'],
  fsharp: ['fs', 'fsi', 'fsx', 'fsscript'],
  cpp: ['c', 'cc', 'cpp', 'cxx', 'c++', 'h', 'hh', 'hpp', 'hxx', 'h++', 'inl', 'ipp', 'tpp'],
  css: ['css'],
  less: ['less'],
  scss: ['scss'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  json: ['json', 'jsonc'],
  html: ['html', 'htm', 'xhtml'],
  xaml: ['xaml', 'axaml'],
  xml: [
    'xml',
    'config',
    'csproj',
    'vbproj',
    'fsproj',
    'vcxproj',
    'proj',
    'props',
    'targets',
    'resx',
    'nuspec',
    'xsd',
    'xsl',
    'xslt',
    'svg',
    'manifest',
    'ruleset',
    'runsettings',
    'slnx',
    'wsdl',
    'dbml',
    'edmx',
  ],
  php: ['php', 'phtml'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  razor: ['razor', 'cshtml', 'vbhtml'],
};

const BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = Object.fromEntries(
  (Object.entries(EXTENSIONS) as [CodeLanguage, readonly string[]][]).flatMap(([language, extensions]) => extensions.map((extension) => [extension, language]))
);

/** VS Code language identifiers, for a file whose extension says nothing (an untitled document, say). */
const BY_LANGUAGE_ID: Readonly<Record<string, CodeLanguage>> = {
  csharp: 'csharp',
  vb: 'vb',
  fsharp: 'fsharp',
  c: 'cpp',
  cpp: 'cpp',
  'cuda-cpp': 'cpp',
  css: 'css',
  less: 'less',
  scss: 'scss',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  typescript: 'typescript',
  typescriptreact: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  xaml: 'xaml',
  xml: 'xml',
  xsl: 'xml',
  svg: 'xml',
  php: 'php',
  powershell: 'powershell',
  r: 'r',
  razor: 'razor',
  aspnetcorerazor: 'razor',
};

/** The language of a file: by its extension, else by the VS Code language identifier of its document. */
export function detectLanguage(filePath: string, languageId?: string): CodeLanguage {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (Object.hasOwn(BY_EXTENSION, extension)) {
    return BY_EXTENSION[extension];
  }

  return languageId !== undefined && Object.hasOwn(BY_LANGUAGE_ID, languageId) ? BY_LANGUAGE_ID[languageId] : 'other';
}

export function languageFamily(language: CodeLanguage): LanguageFamily {
  switch (language) {
    case 'csharp':
    case 'vb':
    case 'razor':
      return language;
    case 'cpp':
    case 'css':
    case 'javascript':
    case 'json':
    case 'less':
    case 'php':
    case 'powershell':
    case 'r':
    case 'scss':
    case 'typescript':
      return 'cFamily';
    case 'html':
    case 'xaml':
    case 'xml':
      return 'markup';
    default:
      return 'generic';
  }
}

/**
 * The `codeJanitor.cleanup.fileTypes.<key>` setting that selects the language, or undefined for C# (always
 * cleaned). Razor counts as HTML, as in Visual Studio.
 */
export function fileTypeKey(language: CodeLanguage): FileTypeKey | undefined {
  switch (language) {
    case 'csharp':
      return undefined;
    case 'razor':
      return 'html';
    case 'other':
      return 'everythingElse';
    default:
      return language;
  }
}

/** The languages with a `codeJanitor.cleanup.fileTypes.<language>` setting of their own (the rest is `everythingElse`). */
export const FILE_TYPE_LANGUAGES: readonly Exclude<FileTypeKey, 'everythingElse'>[] = [
  'vb',
  'fsharp',
  'cpp',
  'css',
  'less',
  'scss',
  'javascript',
  'typescript',
  'json',
  'html',
  'xaml',
  'xml',
  'php',
  'powershell',
  'r',
];

/** The file extensions (lower case, without the dot) of a language; none for the other languages. */
export function languageExtensions(language: CodeLanguage): readonly string[] {
  return language === 'other' ? [] : EXTENSIONS[language];
}

/**
 * The single-line comment prefix the comment formatter works with (`CodeCommentHelper.GetCommentPrefixForLanguage`),
 * or undefined for a language whose comments it does not format.
 */
export function commentPrefix(language: CodeLanguage): string | undefined {
  switch (language) {
    case 'cpp':
    case 'csharp':
    case 'css':
    case 'fsharp':
    case 'javascript':
    case 'less':
    case 'php':
    case 'scss':
    case 'typescript':
      return '//';
    case 'powershell':
    case 'r':
      return '#';
    case 'vb':
      return "'";
    default:
      return undefined;
  }
}
