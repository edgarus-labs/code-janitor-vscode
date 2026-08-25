/**
 * A single composable source-text transformation - a "block" in the cleanup pipeline. Each block
 * takes C# source text and returns transformed source, returning its input unchanged when it does
 * not apply. Blocks are pure and unit-testable, so any subset of them can be composed in any order.
 */
export interface SourceTransformation {
  readonly name: string;
  apply(source: string): string;
}

/** Options read from `.editorconfig` that influence the cleanup pipeline. */
export interface EditorConfigCSharpOptions {
  sortSystemDirectivesFirst?: boolean;
  separateImportDirectiveGroups?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  indentStyle?: string;
  indentSize?: number;
  tabWidth?: number;
}

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
 * The VS Code settings are mapped onto this shape before the pipeline is built.
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

  updateEndRegionDirectives: boolean;
  updateSingleLineMethods: boolean;
  updateAccessorsToBothBeSingleLineOrMultiLine: boolean;

  formatComments: boolean;

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

  fileHeaderCSharp: string;
  fileHeaderPosition: HeaderPosition;
  fileHeaderUpdateMode: HeaderUpdateMode;
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

    updateEndRegionDirectives: true,
    updateSingleLineMethods: true,
    updateAccessorsToBothBeSingleLineOrMultiLine: false,

    formatComments: false,

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

    fileHeaderCSharp: '',
    fileHeaderPosition: HeaderPosition.DocumentStart,
    fileHeaderUpdateMode: HeaderUpdateMode.Insert,
  };
}
