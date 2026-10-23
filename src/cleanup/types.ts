import { ReorganizeSettings, createDefaultReorganizeSettings } from './reorganizeSettings';

export const enum HeaderPosition {
  DocumentStart = 0,
  AfterUsings = 1,
}

export const enum HeaderUpdateMode {
  Insert = 0,
  Replace = 1,
}

/**
 * Cleanup flags, mirroring the `Cleaning_*` / `Formatting_*` settings of the source extension.
 * The VS Code settings are mapped onto this shape and sent to the C# engine.
 */
export interface CleanupSettings {
  insertBlankLinePaddingBeforeClasses: boolean;
  insertBlankLinePaddingAfterClasses: boolean;
  insertBlankLinePaddingBeforeDelegates: boolean;
  insertBlankLinePaddingAfterDelegates: boolean;
  insertBlankLinePaddingBeforeEnumerations: boolean;
  insertBlankLinePaddingAfterEnumerations: boolean;
  insertBlankLinePaddingBeforeEvents: boolean;
  insertBlankLinePaddingAfterEvents: boolean;
  insertBlankLinePaddingBeforeFieldsMultiLine: boolean;
  insertBlankLinePaddingAfterFieldsMultiLine: boolean;
  insertBlankLinePaddingBeforeFieldsSingleLine: boolean;
  insertBlankLinePaddingAfterFieldsSingleLine: boolean;
  insertBlankLinePaddingBeforeInterfaces: boolean;
  insertBlankLinePaddingAfterInterfaces: boolean;
  insertBlankLinePaddingBeforeMethods: boolean;
  insertBlankLinePaddingAfterMethods: boolean;
  insertBlankLinePaddingBeforeNamespaces: boolean;
  insertBlankLinePaddingAfterNamespaces: boolean;
  insertBlankLinePaddingBeforePropertiesMultiLine: boolean;
  insertBlankLinePaddingAfterPropertiesMultiLine: boolean;
  insertBlankLinePaddingBeforePropertiesSingleLine: boolean;
  insertBlankLinePaddingAfterPropertiesSingleLine: boolean;
  insertBlankLinePaddingBeforeStructs: boolean;
  insertBlankLinePaddingAfterStructs: boolean;
  insertBlankLinePaddingBeforeRegionTags: boolean;
  insertBlankLinePaddingAfterRegionTags: boolean;
  insertBlankLinePaddingBeforeEndRegionTags: boolean;
  insertBlankLinePaddingAfterEndRegionTags: boolean;
  insertBlankLinePaddingBeforeUsingStatementBlocks: boolean;
  insertBlankLinePaddingAfterUsingStatementBlocks: boolean;
  insertBlankLinePaddingBeforeCaseStatements: boolean;
  insertBlankLinePaddingBeforeSingleLineComments: boolean;
  insertBlankLinePaddingBetweenPropertiesMultiLineAccessors: boolean;

  insertExplicitAccessModifiersOnClasses: boolean;
  insertExplicitAccessModifiersOnDelegates: boolean;
  insertExplicitAccessModifiersOnEnumerations: boolean;
  insertExplicitAccessModifiersOnEvents: boolean;
  insertExplicitAccessModifiersOnFields: boolean;
  insertExplicitAccessModifiersOnInterfaces: boolean;
  insertExplicitAccessModifiersOnMethods: boolean;
  insertExplicitAccessModifiersOnProperties: boolean;
  insertExplicitAccessModifiersOnStructs: boolean;

  convertToFileScopedNamespace: boolean;
  convertToVarWhenApparent: boolean;
  makeFieldsReadonlyWhenSafe: boolean;
  sealClassesWhenSafe: boolean;
  /**
   * Batch cleanup only: rename non-private symbols that violate the `.editorconfig` naming rules in
   * every file of their project and of the projects referencing it, after a preview.
   */
  renamePublicSymbolsAcrossWorkspace: boolean;
  /**
   * Cleanup on save and Cleanup Changed Files only: keep the changes on lines changed since the
   * last commit (HEAD); renames and type splits are not made.
   */
  onlyChangedLines: boolean;
  insertBlankLineBeforeReturnAndThrowStatements: boolean;
  convertToCollectionExpressions: boolean;
  reuseJsonSerializerOptionsForCA1869: boolean;
  simplifySingleStatementLambdas: boolean;
  convertToPatternMatchingNullChecks: boolean;
  convertStringFormatToInterpolation: boolean;
  convertToStringNameOf: boolean;
  inlineOutVariableDeclarations: boolean;

  moveUsingsOutsideNamespace: boolean;
  organizeUsings: boolean;
  /**
   * Using directives (e.g. `using System.Linq;`) that cleanup puts back when it removed them as
   * unused (IDE0005), mirroring `Cleaning_UsingStatementsToReinsertWhenRemovedExpression`.
   */
  usingStatementsToReinsertWhenRemoved: readonly string[];

  updateEndRegionDirectives: boolean;
  updateSingleLineMethods: boolean;
  updateAccessorsToBothBeSingleLineOrMultiLine: boolean;

  formatComments: boolean;
  /** How `formatComments` and the Format Comments command lay comments out (the `Formatting_Comment*` settings). */
  commentFormat: CommentFormatOptions;

  /** Member reorganization (the `Reorganizing_*` settings); it runs first when `runAtStartOfCleanup` is on. */
  reorganize: ReorganizeSettings;

  removeRegions: boolean;
  removeByteOrderMark: boolean;
  removeEndOfLineWhitespace: boolean;
  removeBlankLinesAtTop: boolean;
  removeBlankLinesAtBottom: boolean;
  removeBlankLinesAfterAttributes: boolean;
  removeBlankLinesAfterOpeningBrace: boolean;
  removeBlankLinesBeforeClosingBrace: boolean;
  removeBlankLinesBetweenChainedStatements: boolean;
  removeMultipleConsecutiveBlankLines: boolean;

  /** Markup files (XML, XAML, HTML): blank lines before a closing tag are removed. */
  removeBlankLinesBeforeClosingTags: boolean;
  /** Markup files: `<a >` becomes `<a>`. */
  removeBlankSpacesBeforeClosingAngleBrackets: boolean;
  /** Markup files: `<a/>` becomes `<a />`. */
  insertBlankSpaceBeforeSelfClosingAngleBrackets: boolean;

  fileHeaderCSharp: string;
  fileHeaderVB: string;
  fileHeaderFSharp: string;
  fileHeaderCPlusPlus: string;
  fileHeaderCSS: string;
  fileHeaderLESS: string;
  fileHeaderSCSS: string;
  fileHeaderJavaScript: string;
  fileHeaderTypeScript: string;
  fileHeaderJSON: string;
  fileHeaderHTML: string;
  fileHeaderXAML: string;
  fileHeaderXML: string;
  fileHeaderPHP: string;
  fileHeaderPowerShell: string;
  fileHeaderR: string;
  fileHeaderPosition: HeaderPosition;
  fileHeaderUpdateMode: HeaderUpdateMode;

  /**
   * The enabled Code Style rules (see `codeStyleRules.ts`): the value of each, keyed by `.editorconfig`
   * option name, from the repository policy or the user setting (none by default). A rule the file's
   * `.editorconfig` enforces keeps its `.editorconfig` value; the rest apply as `suggestion`.
   */
  codeStyleRules: Readonly<Record<string, string>>;
}

/** Comment formatting options, mirroring the `Formatting_Comment*` settings of the source extension. */
export interface CommentFormatOptions {
  /** The column comments are wrapped at. */
  wrapColumn: number;
  /** A comment whose last word alone crosses the wrap column is not wrapped. */
  skipWrapOnLastWord: boolean;
  /** Comment lines starting with one of these (after the comment prefix) are left as they are. */
  ignoreLinesStartingWith: readonly string[];
  xmlAlignParamTags: boolean;
  xmlKeepTagsTogether: boolean;
  xmlSpaceSingleTags: boolean;
  xmlSpaceTags: boolean;
  xmlSplitAllTags: boolean;
  xmlSplitSummaryTagToMultipleLines: boolean;
  xmlTagsToLowerCase: boolean;
  /** Extra indentation of the content of XML tags, in spaces. */
  xmlValueIndent: number;
}

export function createDefaultCommentFormatOptions(): CommentFormatOptions {
  return {
    wrapColumn: 100,
    skipWrapOnLastWord: true,
    ignoreLinesStartingWith: ['ReSharper disable ', 'ReSharper enable '],
    xmlAlignParamTags: false,
    xmlKeepTagsTogether: false,
    xmlSpaceSingleTags: false,
    xmlSpaceTags: false,
    xmlSplitAllTags: false,
    xmlSplitSummaryTagToMultipleLines: true,
    xmlTagsToLowerCase: false,
    xmlValueIndent: 0,
  };
}

/** Defaults mirroring `Settings.settings` of the source extension. */
export function createDefaultSettings(): CleanupSettings {
  return {
    insertBlankLinePaddingBeforeClasses: true,
    insertBlankLinePaddingAfterClasses: true,
    insertBlankLinePaddingBeforeDelegates: true,
    insertBlankLinePaddingAfterDelegates: true,
    insertBlankLinePaddingBeforeEnumerations: true,
    insertBlankLinePaddingAfterEnumerations: true,
    insertBlankLinePaddingBeforeEvents: true,
    insertBlankLinePaddingAfterEvents: true,
    insertBlankLinePaddingBeforeFieldsMultiLine: true,
    insertBlankLinePaddingAfterFieldsMultiLine: true,
    insertBlankLinePaddingBeforeFieldsSingleLine: false,
    insertBlankLinePaddingAfterFieldsSingleLine: false,
    insertBlankLinePaddingBeforeInterfaces: true,
    insertBlankLinePaddingAfterInterfaces: true,
    insertBlankLinePaddingBeforeMethods: true,
    insertBlankLinePaddingAfterMethods: true,
    insertBlankLinePaddingBeforeNamespaces: true,
    insertBlankLinePaddingAfterNamespaces: true,
    insertBlankLinePaddingBeforePropertiesMultiLine: true,
    insertBlankLinePaddingAfterPropertiesMultiLine: true,
    insertBlankLinePaddingBeforePropertiesSingleLine: false,
    insertBlankLinePaddingAfterPropertiesSingleLine: false,
    insertBlankLinePaddingBeforeStructs: true,
    insertBlankLinePaddingAfterStructs: true,
    insertBlankLinePaddingBeforeRegionTags: true,
    insertBlankLinePaddingAfterRegionTags: true,
    insertBlankLinePaddingBeforeEndRegionTags: true,
    insertBlankLinePaddingAfterEndRegionTags: true,
    insertBlankLinePaddingBeforeUsingStatementBlocks: true,
    insertBlankLinePaddingAfterUsingStatementBlocks: true,
    insertBlankLinePaddingBeforeCaseStatements: true,
    insertBlankLinePaddingBeforeSingleLineComments: false,
    insertBlankLinePaddingBetweenPropertiesMultiLineAccessors: false,

    insertExplicitAccessModifiersOnClasses: true,
    insertExplicitAccessModifiersOnDelegates: true,
    insertExplicitAccessModifiersOnEnumerations: true,
    insertExplicitAccessModifiersOnEvents: true,
    insertExplicitAccessModifiersOnFields: true,
    insertExplicitAccessModifiersOnInterfaces: true,
    insertExplicitAccessModifiersOnMethods: true,
    insertExplicitAccessModifiersOnProperties: true,
    insertExplicitAccessModifiersOnStructs: true,

    convertToFileScopedNamespace: false,
    convertToVarWhenApparent: false,
    makeFieldsReadonlyWhenSafe: false,
    sealClassesWhenSafe: false,
    renamePublicSymbolsAcrossWorkspace: false,
    onlyChangedLines: false,
    insertBlankLineBeforeReturnAndThrowStatements: false,
    convertToCollectionExpressions: false,
    reuseJsonSerializerOptionsForCA1869: false,
    simplifySingleStatementLambdas: false,
    convertToPatternMatchingNullChecks: true,
    convertStringFormatToInterpolation: true,
    convertToStringNameOf: true,
    inlineOutVariableDeclarations: true,

    moveUsingsOutsideNamespace: true,
    organizeUsings: false,
    usingStatementsToReinsertWhenRemoved: [],

    updateEndRegionDirectives: true,
    updateSingleLineMethods: true,
    updateAccessorsToBothBeSingleLineOrMultiLine: false,

    formatComments: false,
    commentFormat: createDefaultCommentFormatOptions(),
    reorganize: createDefaultReorganizeSettings(),

    removeRegions: true,
    removeByteOrderMark: true,
    removeEndOfLineWhitespace: true,
    removeBlankLinesAtTop: true,
    removeBlankLinesAtBottom: true,
    removeBlankLinesAfterAttributes: true,
    removeBlankLinesAfterOpeningBrace: true,
    removeBlankLinesBeforeClosingBrace: true,
    removeBlankLinesBetweenChainedStatements: true,
    removeMultipleConsecutiveBlankLines: true,

    removeBlankLinesBeforeClosingTags: true,
    removeBlankSpacesBeforeClosingAngleBrackets: true,
    insertBlankSpaceBeforeSelfClosingAngleBrackets: true,

    fileHeaderCSharp: '',
    fileHeaderVB: '',
    fileHeaderFSharp: '',
    fileHeaderCPlusPlus: '',
    fileHeaderCSS: '',
    fileHeaderLESS: '',
    fileHeaderSCSS: '',
    fileHeaderJavaScript: '',
    fileHeaderTypeScript: '',
    fileHeaderJSON: '',
    fileHeaderHTML: '',
    fileHeaderXAML: '',
    fileHeaderXML: '',
    fileHeaderPHP: '',
    fileHeaderPowerShell: '',
    fileHeaderR: '',
    fileHeaderPosition: HeaderPosition.DocumentStart,
    fileHeaderUpdateMode: HeaderUpdateMode.Insert,

    codeStyleRules: {},
  };
}
