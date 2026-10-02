import * as path from 'node:path';
import * as vscode from 'vscode';
import { XmlDocRunOptions } from '../cleanup/xmlDocumentation';
import { parseCodeStyleSetting } from '../cleanup/codeStyleRules';
import { applyRepositoryPolicy, readRepositoryPolicy } from '../cleanup/repositoryOverrides';
import { CleanupSettings, HeaderPosition, HeaderUpdateMode, createDefaultSettings } from '../cleanup/types';
import { readReorganizeSettings } from './reorganizeSettings';
import { logInfo } from '../logging';

/**
 * Maps the `codeJanitor.cleanup.*` VS Code settings onto the cleanup pipeline's settings shape, with the
 * repository policy applied over them: a key listed in the nearest `.codejanitor` wins over the user's
 * setting (`.editorconfig` wins over both, per file, when the pipeline is built). The policy is found by
 * walking up from `startDirectory` - the directory of the cleaned file; without one, the first workspace folder.
 */
export function readCleanupSettings(startDirectory?: string): CleanupSettings {
  return applyRepositoryPolicy(
    readUserCleanupSettings(),
    readRepositoryPolicy(startDirectory ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, logInfo)
  );
}

/**
 * The settings for one document or file: the repository policy is the nearest `.codejanitor` walking up
 * from the file's folder. A document that is not a file on disk uses the workspace folder it belongs to.
 */
export function readCleanupSettingsForUri(uri: vscode.Uri): CleanupSettings {
  return readCleanupSettings(uri.scheme === 'file' ? path.dirname(uri.fsPath) : vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath);
}

/** The `codeJanitor.cleanup.*` settings as the user configured them, without any repository policy. */
function readUserCleanupSettings(): CleanupSettings {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const base = createDefaultSettings();

  // Two VS Code toggles deliberately fan out to all per-kind flags of the original extension.
  const insertExplicit = cfg.get<boolean>('cleanup.insertExplicitAccessModifiers', base.insertExplicitAccessModifiersOnClasses);
  const insertPadding = cfg.get<boolean>('cleanup.insertBlankLinePadding', base.insertBlankLinePaddingBeforeClasses);

  return {
    ...base,

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

    moveUsingsOutsideNamespace: cfg.get('cleanup.moveUsingsOutsideNamespace', base.moveUsingsOutsideNamespace),
    organizeUsings: cfg.get('cleanup.organizeUsings', base.organizeUsings),
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
    updateAccessorsToBothBeSingleLineOrMultiLine: cfg.get('cleanup.updateAccessorsToBothBeSingleLineOrMultiLine', base.updateAccessorsToBothBeSingleLineOrMultiLine),
    formatComments: cfg.get('cleanup.formatComments', base.formatComments),
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

    fileHeaderCSharp: cfg.get('cleanup.fileHeaderCSharp', base.fileHeaderCSharp),
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
