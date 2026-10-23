import * as path from 'node:path';
import * as vscode from 'vscode';
import { XmlDocRunOptions } from '../engine/xmlDoc';
import { parseCodeStyleSetting } from '../cleanup/codeStyleRules';
import { applyRepositoryPolicy, readRepositoryPolicy } from '../cleanup/repositoryOverrides';
import { CleanupSettings, HeaderPosition, HeaderUpdateMode, createDefaultCommentFormatOptions, createDefaultSettings } from '../cleanup/types';
import { readReorganizeSettings } from './reorganizeSettings';
import { logInfo } from '../logging';

/**
 * Maps the `codeJanitor.cleanup.*` VS Code settings onto the cleanup pipeline's settings shape, with the
 * repository policy applied over them: a key listed in the nearest `.codejanitor` wins over the user's
 * setting (`.editorconfig` wins over both, per file, when the pipeline is built). The policy is found by
 * walking up from `startDirectory` - the directory of the cleaned file; without one, the first workspace folder.
 */
export function readCleanupSettings(startDirectory?: string): CleanupSettings {
  return applyRepositoryPolicy(readUserCleanupSettings(), readRepositoryPolicy(startDirectory ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, logInfo));
}

/**
 * The settings for one document or file: the repository policy is the nearest `.codejanitor` walking up
 * from the file's folder. A document that is not a file on disk uses the workspace folder it belongs to.
 */
export function readCleanupSettingsForUri(uri: vscode.Uri): CleanupSettings {
  return readCleanupSettings(uri.scheme === 'file' ? path.dirname(uri.fsPath) : vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath);
}

/**
 * The `codeJanitor.cleanup.*` settings as the user configured them, without any repository policy: what the
 * C# engine receives, as it resolves `.codejanitor` and `.editorconfig` per file itself.
 */
export function readUserCleanupSettings(): CleanupSettings {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const base = createDefaultSettings();

  // Two VS Code toggles deliberately fan out to all per-kind flags of the original extension; a per-kind
  // padding setting the user set explicitly (in any scope) wins over its group toggle.
  const insertExplicit = cfg.get<boolean>('cleanup.insertExplicitAccessModifiers', base.insertExplicitAccessModifiersOnClasses);
  const insertPadding = cfg.get<boolean>('cleanup.insertBlankLinePadding', base.insertBlankLinePaddingBeforeClasses);
  const padding = (key: PaddingKey, grouped = true): boolean => {
    const inspected = cfg.inspect<boolean>(`cleanup.${key}`);
    const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;

    return explicit ?? (grouped ? insertPadding : base[key]);
  };
  const comment = createDefaultCommentFormatOptions();

  return {
    ...base,

    insertBlankLinePaddingBeforeClasses: padding('insertBlankLinePaddingBeforeClasses'),
    insertBlankLinePaddingAfterClasses: padding('insertBlankLinePaddingAfterClasses'),
    insertBlankLinePaddingBeforeDelegates: padding('insertBlankLinePaddingBeforeDelegates'),
    insertBlankLinePaddingAfterDelegates: padding('insertBlankLinePaddingAfterDelegates'),
    insertBlankLinePaddingBeforeEnumerations: padding('insertBlankLinePaddingBeforeEnumerations'),
    insertBlankLinePaddingAfterEnumerations: padding('insertBlankLinePaddingAfterEnumerations'),
    insertBlankLinePaddingBeforeEvents: padding('insertBlankLinePaddingBeforeEvents'),
    insertBlankLinePaddingAfterEvents: padding('insertBlankLinePaddingAfterEvents'),
    insertBlankLinePaddingBeforeFieldsMultiLine: padding('insertBlankLinePaddingBeforeFieldsMultiLine'),
    insertBlankLinePaddingAfterFieldsMultiLine: padding('insertBlankLinePaddingAfterFieldsMultiLine'),
    insertBlankLinePaddingBeforeFieldsSingleLine: padding('insertBlankLinePaddingBeforeFieldsSingleLine', false),
    insertBlankLinePaddingAfterFieldsSingleLine: padding('insertBlankLinePaddingAfterFieldsSingleLine', false),
    insertBlankLinePaddingBeforeInterfaces: padding('insertBlankLinePaddingBeforeInterfaces'),
    insertBlankLinePaddingAfterInterfaces: padding('insertBlankLinePaddingAfterInterfaces'),
    insertBlankLinePaddingBeforeMethods: padding('insertBlankLinePaddingBeforeMethods'),
    insertBlankLinePaddingAfterMethods: padding('insertBlankLinePaddingAfterMethods'),
    insertBlankLinePaddingBeforeNamespaces: padding('insertBlankLinePaddingBeforeNamespaces'),
    insertBlankLinePaddingAfterNamespaces: padding('insertBlankLinePaddingAfterNamespaces'),
    insertBlankLinePaddingBeforePropertiesMultiLine: padding('insertBlankLinePaddingBeforePropertiesMultiLine'),
    insertBlankLinePaddingAfterPropertiesMultiLine: padding('insertBlankLinePaddingAfterPropertiesMultiLine'),
    insertBlankLinePaddingBeforePropertiesSingleLine: padding('insertBlankLinePaddingBeforePropertiesSingleLine', false),
    insertBlankLinePaddingAfterPropertiesSingleLine: padding('insertBlankLinePaddingAfterPropertiesSingleLine', false),
    insertBlankLinePaddingBeforeStructs: padding('insertBlankLinePaddingBeforeStructs'),
    insertBlankLinePaddingAfterStructs: padding('insertBlankLinePaddingAfterStructs'),
    insertBlankLinePaddingBeforeRegionTags: padding('insertBlankLinePaddingBeforeRegionTags'),
    insertBlankLinePaddingAfterRegionTags: padding('insertBlankLinePaddingAfterRegionTags'),
    insertBlankLinePaddingBeforeEndRegionTags: padding('insertBlankLinePaddingBeforeEndRegionTags'),
    insertBlankLinePaddingAfterEndRegionTags: padding('insertBlankLinePaddingAfterEndRegionTags'),
    insertBlankLinePaddingBeforeUsingStatementBlocks: padding('insertBlankLinePaddingBeforeUsingStatementBlocks'),
    insertBlankLinePaddingAfterUsingStatementBlocks: padding('insertBlankLinePaddingAfterUsingStatementBlocks'),
    insertBlankLinePaddingBeforeCaseStatements: padding('insertBlankLinePaddingBeforeCaseStatements'),
    insertBlankLinePaddingBeforeSingleLineComments: padding('insertBlankLinePaddingBeforeSingleLineComments', false),
    insertBlankLinePaddingBetweenPropertiesMultiLineAccessors: padding('insertBlankLinePaddingBetweenPropertiesMultiLineAccessors', false),

    insertExplicitAccessModifiersOnClasses: insertExplicit,
    insertExplicitAccessModifiersOnDelegates: insertExplicit,
    insertExplicitAccessModifiersOnEnumerations: insertExplicit,
    insertExplicitAccessModifiersOnEvents: insertExplicit,
    insertExplicitAccessModifiersOnFields: insertExplicit,
    insertExplicitAccessModifiersOnInterfaces: insertExplicit,
    insertExplicitAccessModifiersOnMethods: insertExplicit,
    insertExplicitAccessModifiersOnProperties: insertExplicit,
    insertExplicitAccessModifiersOnStructs: insertExplicit,

    moveUsingsOutsideNamespace: cfg.get('cleanup.moveUsingsOutsideNamespace', base.moveUsingsOutsideNamespace),
    organizeUsings: cfg.get('cleanup.organizeUsings', base.organizeUsings),
    usingStatementsToReinsertWhenRemoved: cfg.get<string[]>('cleanup.usingStatementsToReinsertWhenRemoved', [...base.usingStatementsToReinsertWhenRemoved]),
    convertToFileScopedNamespace: cfg.get('cleanup.convertToFileScopedNamespace', base.convertToFileScopedNamespace),
    convertToVarWhenApparent: cfg.get('cleanup.convertToVarWhenApparent', base.convertToVarWhenApparent),
    makeFieldsReadonlyWhenSafe: cfg.get('cleanup.makeFieldsReadonlyWhenSafe', base.makeFieldsReadonlyWhenSafe),
    sealClassesWhenSafe: cfg.get('cleanup.sealClassesWhenSafe', base.sealClassesWhenSafe),
    renamePublicSymbolsAcrossWorkspace: cfg.get('cleanup.renamePublicSymbolsAcrossWorkspace', base.renamePublicSymbolsAcrossWorkspace),
    onlyChangedLines: cfg.get('cleanup.onlyChangedLines', base.onlyChangedLines),
    convertToCollectionExpressions: cfg.get('cleanup.convertToCollectionExpressions', base.convertToCollectionExpressions),
    reuseJsonSerializerOptionsForCA1869: cfg.get('cleanup.reuseJsonSerializerOptionsForCA1869', base.reuseJsonSerializerOptionsForCA1869),
    simplifySingleStatementLambdas: cfg.get('cleanup.simplifySingleStatementLambdas', base.simplifySingleStatementLambdas),
    insertBlankLineBeforeReturnAndThrowStatements: cfg.get('cleanup.insertBlankLineBeforeReturnAndThrow', base.insertBlankLineBeforeReturnAndThrowStatements),
    convertToPatternMatchingNullChecks: cfg.get('cleanup.convertToPatternMatchingNullChecks', base.convertToPatternMatchingNullChecks),
    convertStringFormatToInterpolation: cfg.get('cleanup.convertStringFormatToInterpolation', base.convertStringFormatToInterpolation),
    convertToStringNameOf: cfg.get('cleanup.convertToStringNameOf', base.convertToStringNameOf),
    inlineOutVariableDeclarations: cfg.get('cleanup.inlineOutVariableDeclarations', base.inlineOutVariableDeclarations),

    updateEndRegionDirectives: cfg.get('cleanup.updateEndRegionDirectives', base.updateEndRegionDirectives),
    updateSingleLineMethods: cfg.get('cleanup.updateSingleLineMethods', base.updateSingleLineMethods),
    updateAccessorsToBothBeSingleLineOrMultiLine: cfg.get(
      'cleanup.updateAccessorsToBothBeSingleLineOrMultiLine',
      base.updateAccessorsToBothBeSingleLineOrMultiLine
    ),
    formatComments: cfg.get('cleanup.formatComments', base.formatComments),
    commentFormat: {
      wrapColumn: cfg.get('formatting.commentWrapColumn', comment.wrapColumn),
      skipWrapOnLastWord: cfg.get('formatting.commentSkipWrapOnLastWord', comment.skipWrapOnLastWord),
      ignoreLinesStartingWith: cfg.get<string[]>('formatting.commentIgnoreLinesStartingWith', [...comment.ignoreLinesStartingWith]),
      xmlAlignParamTags: cfg.get('formatting.commentXmlAlignParamTags', comment.xmlAlignParamTags),
      xmlKeepTagsTogether: cfg.get('formatting.commentXmlKeepTagsTogether', comment.xmlKeepTagsTogether),
      xmlSpaceSingleTags: cfg.get('formatting.commentXmlSpaceSingleTags', comment.xmlSpaceSingleTags),
      xmlSpaceTags: cfg.get('formatting.commentXmlSpaceTags', comment.xmlSpaceTags),
      xmlSplitAllTags: cfg.get('formatting.commentXmlSplitAllTags', comment.xmlSplitAllTags),
      xmlSplitSummaryTagToMultipleLines: cfg.get('formatting.commentXmlSplitSummaryTagToMultipleLines', comment.xmlSplitSummaryTagToMultipleLines),
      xmlTagsToLowerCase: cfg.get('formatting.commentXmlTagsToLowerCase', comment.xmlTagsToLowerCase),
      xmlValueIndent: cfg.get('formatting.commentXmlValueIndent', comment.xmlValueIndent),
    },
    reorganize: readReorganizeSettings(),

    removeRegions: cfg.get('cleanup.removeRegions', base.removeRegions),
    removeByteOrderMark: cfg.get('cleanup.removeByteOrderMark', base.removeByteOrderMark),
    removeEndOfLineWhitespace: cfg.get('cleanup.removeEndOfLineWhitespace', base.removeEndOfLineWhitespace),
    removeBlankLinesAtTop: cfg.get('cleanup.removeBlankLinesAtTop', base.removeBlankLinesAtTop),
    removeBlankLinesAtBottom: cfg.get('cleanup.removeBlankLinesAtBottom', base.removeBlankLinesAtBottom),
    removeBlankLinesAfterAttributes: cfg.get('cleanup.removeBlankLinesAfterAttributes', base.removeBlankLinesAfterAttributes),
    removeBlankLinesAfterOpeningBrace: cfg.get('cleanup.removeBlankLinesAfterOpeningBrace', base.removeBlankLinesAfterOpeningBrace),
    removeBlankLinesBeforeClosingBrace: cfg.get('cleanup.removeBlankLinesBeforeClosingBrace', base.removeBlankLinesBeforeClosingBrace),
    removeBlankLinesBetweenChainedStatements: cfg.get('cleanup.removeBlankLinesBetweenChainedStatements', base.removeBlankLinesBetweenChainedStatements),
    removeMultipleConsecutiveBlankLines: cfg.get('cleanup.removeMultipleConsecutiveBlankLines', base.removeMultipleConsecutiveBlankLines),
    removeBlankLinesBeforeClosingTags: cfg.get('cleanup.removeBlankLinesBeforeClosingTags', base.removeBlankLinesBeforeClosingTags),
    removeBlankSpacesBeforeClosingAngleBrackets: cfg.get(
      'cleanup.removeBlankSpacesBeforeClosingAngleBrackets',
      base.removeBlankSpacesBeforeClosingAngleBrackets
    ),
    insertBlankSpaceBeforeSelfClosingAngleBrackets: cfg.get(
      'cleanup.insertBlankSpaceBeforeSelfClosingAngleBrackets',
      base.insertBlankSpaceBeforeSelfClosingAngleBrackets
    ),

    fileHeaderCSharp: cfg.get('cleanup.fileHeaderCSharp', base.fileHeaderCSharp),
    fileHeaderVB: cfg.get('cleanup.fileHeaderVB', base.fileHeaderVB),
    fileHeaderFSharp: cfg.get('cleanup.fileHeaderFSharp', base.fileHeaderFSharp),
    fileHeaderCPlusPlus: cfg.get('cleanup.fileHeaderCPlusPlus', base.fileHeaderCPlusPlus),
    fileHeaderCSS: cfg.get('cleanup.fileHeaderCSS', base.fileHeaderCSS),
    fileHeaderLESS: cfg.get('cleanup.fileHeaderLESS', base.fileHeaderLESS),
    fileHeaderSCSS: cfg.get('cleanup.fileHeaderSCSS', base.fileHeaderSCSS),
    fileHeaderJavaScript: cfg.get('cleanup.fileHeaderJavaScript', base.fileHeaderJavaScript),
    fileHeaderTypeScript: cfg.get('cleanup.fileHeaderTypeScript', base.fileHeaderTypeScript),
    fileHeaderJSON: cfg.get('cleanup.fileHeaderJSON', base.fileHeaderJSON),
    fileHeaderHTML: cfg.get('cleanup.fileHeaderHTML', base.fileHeaderHTML),
    fileHeaderXAML: cfg.get('cleanup.fileHeaderXAML', base.fileHeaderXAML),
    fileHeaderXML: cfg.get('cleanup.fileHeaderXML', base.fileHeaderXML),
    fileHeaderPHP: cfg.get('cleanup.fileHeaderPHP', base.fileHeaderPHP),
    fileHeaderPowerShell: cfg.get('cleanup.fileHeaderPowerShell', base.fileHeaderPowerShell),
    fileHeaderR: cfg.get('cleanup.fileHeaderR', base.fileHeaderR),
    fileHeaderPosition:
      cfg.get<string>('cleanup.fileHeaderPosition', base.fileHeaderPosition === HeaderPosition.AfterUsings ? 'afterUsings' : 'documentStart') === 'afterUsings'
        ? HeaderPosition.AfterUsings
        : HeaderPosition.DocumentStart,
    fileHeaderUpdateMode:
      cfg.get<string>('cleanup.fileHeaderUpdateMode', base.fileHeaderUpdateMode === HeaderUpdateMode.Replace ? 'replace' : 'insert') === 'replace'
        ? HeaderUpdateMode.Replace
        : HeaderUpdateMode.Insert,

    codeStyleRules: parseCodeStyleSetting(cfg.get('cleanup.codeStyleRules', {})),
  };
}

/** The per-kind blank line padding flags of the cleanup settings. */
type PaddingKey = Extract<keyof CleanupSettings, `insertBlankLinePadding${string}`>;

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
