import * as vscode from 'vscode';
import { XmlDocRunOptions } from '../cleanup/xmlDocumentation';
import { CleanupSettings, HeaderPosition, HeaderUpdateMode, createDefaultSettings } from '../cleanup/types';

/** Maps the `codeJanitor.cleanup.*` VS Code settings onto the cleanup pipeline's settings shape. */
export function readCleanupSettings(): CleanupSettings {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const defaults = createDefaultSettings();

  // Two VS Code toggles deliberately fan out to all per-kind flags of the original extension.
  const insertExplicit = cfg.get<boolean>('cleanup.insertExplicitAccessModifiers', true);
  const insertPadding = cfg.get<boolean>('cleanup.insertBlankLinePadding', true);

  return {
    ...defaults,

    insertBlankLinePaddingBeforeClasses: insertPadding,
    insertBlankLinePaddingAfterClasses: insertPadding,
    insertBlankLinePaddingBeforeDelegates: insertPadding,
    insertBlankLinePaddingAfterDelegates: insertPadding,
    insertBlankLinePaddingBeforeEnumerations: insertPadding,
    insertBlankLinePaddingAfterEnumerations: insertPadding,
    insertBlankLinePaddingBeforeEvents: insertPadding,
    insertBlankLinePaddingAfterEvents: insertPadding,
    insertBlankLinePaddingBeforeFieldsMultiLine: insertPadding,
    insertBlankLinePaddingAfterFieldsMultiLine: insertPadding,
    insertBlankLinePaddingBeforeInterfaces: insertPadding,
    insertBlankLinePaddingAfterInterfaces: insertPadding,
    insertBlankLinePaddingBeforeMethods: insertPadding,
    insertBlankLinePaddingAfterMethods: insertPadding,
    insertBlankLinePaddingBeforeNamespaces: insertPadding,
    insertBlankLinePaddingAfterNamespaces: insertPadding,
    insertBlankLinePaddingBeforePropertiesMultiLine: insertPadding,
    insertBlankLinePaddingAfterPropertiesMultiLine: insertPadding,
    insertBlankLinePaddingBeforeStructs: insertPadding,
    insertBlankLinePaddingAfterStructs: insertPadding,
    insertBlankLinePaddingBeforeRegionTags: insertPadding,
    insertBlankLinePaddingAfterRegionTags: insertPadding,
    insertBlankLinePaddingBeforeEndRegionTags: insertPadding,
    insertBlankLinePaddingAfterEndRegionTags: insertPadding,
    insertBlankLinePaddingBeforeUsingStatementBlocks: insertPadding,
    insertBlankLinePaddingAfterUsingStatementBlocks: insertPadding,
    insertBlankLinePaddingBeforeCaseStatements: insertPadding,

    insertExplicitAccessModifiersOnClasses: insertExplicit,
    insertExplicitAccessModifiersOnDelegates: insertExplicit,
    insertExplicitAccessModifiersOnEnumerations: insertExplicit,
    insertExplicitAccessModifiersOnEvents: insertExplicit,
    insertExplicitAccessModifiersOnFields: insertExplicit,
    insertExplicitAccessModifiersOnInterfaces: insertExplicit,
    insertExplicitAccessModifiersOnMethods: insertExplicit,
    insertExplicitAccessModifiersOnProperties: insertExplicit,
    insertExplicitAccessModifiersOnStructs: insertExplicit,

    moveUsingsOutsideNamespace: cfg.get('cleanup.moveUsingsOutsideNamespace', true),
    organizeUsings: cfg.get('cleanup.organizeUsings', false),
    convertToFileScopedNamespace: cfg.get('cleanup.convertToFileScopedNamespace', false),
    convertToVarWhenApparent: cfg.get('cleanup.convertToVarWhenApparent', false),
    makeFieldsReadonlyWhenSafe: cfg.get('cleanup.makeFieldsReadonlyWhenSafe', false),
    sealClassesWhenSafe: cfg.get('cleanup.sealClassesWhenSafe', false),
    convertToCollectionExpressions: cfg.get('cleanup.convertToCollectionExpressions', false),
    reuseJsonSerializerOptionsForCA1869: cfg.get('cleanup.reuseJsonSerializerOptionsForCA1869', false),
    simplifySingleStatementLambdas: cfg.get('cleanup.simplifySingleStatementLambdas', false),
    insertBlankLineBeforeReturnAndThrowStatements: cfg.get('cleanup.insertBlankLineBeforeReturnAndThrow', false),
    convertToPatternMatchingNullChecks: cfg.get('cleanup.convertToPatternMatchingNullChecks', true),
    convertStringFormatToInterpolation: cfg.get('cleanup.convertStringFormatToInterpolation', true),
    convertToStringNameOf: cfg.get('cleanup.convertToStringNameOf', true),
    inlineOutVariableDeclarations: cfg.get('cleanup.inlineOutVariableDeclarations', true),

    updateEndRegionDirectives: cfg.get('cleanup.updateEndRegionDirectives', true),
    updateSingleLineMethods: cfg.get('cleanup.updateSingleLineMethods', true),
    updateAccessorsToBothBeSingleLineOrMultiLine: cfg.get('cleanup.updateAccessorsToBothBeSingleLineOrMultiLine', false),
    formatComments: cfg.get('cleanup.formatComments', false),

    removeRegions: cfg.get('cleanup.removeRegions', true),
    removeByteOrderMark: cfg.get('cleanup.removeByteOrderMark', true),
    removeEndOfLineWhitespace: cfg.get('cleanup.removeEndOfLineWhitespace', true),
    removeBlankLinesAtTop: cfg.get('cleanup.removeBlankLinesAtTop', true),
    removeBlankLinesAtBottom: cfg.get('cleanup.removeBlankLinesAtBottom', true),
    removeBlankLinesAfterAttributes: cfg.get('cleanup.removeBlankLinesAfterAttributes', true),
    removeBlankLinesAfterOpeningBrace: cfg.get('cleanup.removeBlankLinesAfterOpeningBrace', true),
    removeBlankLinesBeforeClosingBrace: cfg.get('cleanup.removeBlankLinesBeforeClosingBrace', true),
    removeBlankLinesBetweenChainedStatements: cfg.get('cleanup.removeBlankLinesBetweenChainedStatements', true),
    removeMultipleConsecutiveBlankLines: cfg.get('cleanup.removeMultipleConsecutiveBlankLines', true),

    fileHeaderCSharp: cfg.get('cleanup.fileHeaderCSharp', ''),
    fileHeaderPosition:
      cfg.get<string>('cleanup.fileHeaderPosition', 'documentStart') === 'afterUsings'
        ? HeaderPosition.AfterUsings
        : HeaderPosition.DocumentStart,
    fileHeaderUpdateMode:
      cfg.get<string>('cleanup.fileHeaderUpdateMode', 'insert') === 'replace'
        ? HeaderUpdateMode.Replace
        : HeaderUpdateMode.Insert,
  };
}

/** Maps the `codeJanitor.ai.xmlDoc.*` settings onto the documentation planner's options. */
export function readXmlDocOptions(): XmlDocRunOptions {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');

  return {
    maxMembersPerFile: cfg.get('ai.xmlDoc.maxMembersPerFile', 25),
    maxInputCharsPerMember: cfg.get('ai.xmlDoc.maxInputCharsPerMember', 2500),
    ignoreGeneratedCode: cfg.get('ai.xmlDoc.ignoreGeneratedCode', true),
    ignoreObsolete: cfg.get('ai.xmlDoc.ignoreObsolete', true),
    ignoreTestMethods: cfg.get('ai.xmlDoc.ignoreTestMethods', true),
    ignorePattern: cfg.get('ai.xmlDoc.ignorePattern', ''),
  };
}
