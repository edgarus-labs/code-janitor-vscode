import * as vscode from 'vscode';

/**
 * Maps the `codeJanitor.cleanup.*` VS Code settings onto the flat "settingName": value shape
 * the CodeJanitor.Engine CLI expects (field names matching the ported `Settings` shim class).
 */
export function buildEngineSettings(): Record<string, boolean | number | string | null> {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');

  const headerPosition = cfg.get<string>('cleanup.fileHeaderPosition', 'documentStart');
  const headerUpdateMode = cfg.get<string>('cleanup.fileHeaderUpdateMode', 'insert');

  const insertExplicit = cfg.get<boolean>('cleanup.insertExplicitAccessModifiers', true);
  const insertPadding = cfg.get<boolean>('cleanup.insertBlankLinePadding', true);

  return {
    Cleaning_MoveUsingsOutsideNamespace: cfg.get<boolean>('cleanup.moveUsingsOutsideNamespace', true),
    Cleaning_OrganizeUsings: cfg.get<boolean>('cleanup.organizeUsings', false),
    Cleaning_ConvertToFileScopedNamespace: cfg.get<boolean>('cleanup.convertToFileScopedNamespace', false),
    Cleaning_ConvertToVarWhenApparent: cfg.get<boolean>('cleanup.convertToVarWhenApparent', false),
    Cleaning_MakeFieldsReadonlyWhenSafe: cfg.get<boolean>('cleanup.makeFieldsReadonlyWhenSafe', false),
    Cleaning_SealClassesWhenSafe: cfg.get<boolean>('cleanup.sealClassesWhenSafe', false),
    Cleaning_ConvertToCollectionExpressions: cfg.get<boolean>('cleanup.convertToCollectionExpressions', false),
    Cleaning_ReuseJsonSerializerOptionsForCA1869: cfg.get<boolean>('cleanup.reuseJsonSerializerOptionsForCA1869', false),
    Cleaning_SimplifySingleStatementLambdas: cfg.get<boolean>('cleanup.simplifySingleStatementLambdas', false),
    Cleaning_InsertBlankLineBeforeReturnAndThrowStatements: cfg.get<boolean>('cleanup.insertBlankLineBeforeReturnAndThrow', false),
    Cleaning_ConvertToPatternMatchingNullChecks: cfg.get<boolean>('cleanup.convertToPatternMatchingNullChecks', true),
    Cleaning_ConvertStringFormatToInterpolation: cfg.get<boolean>('cleanup.convertStringFormatToInterpolation', true),
    Cleaning_ConvertToStringNameOf: cfg.get<boolean>('cleanup.convertToStringNameOf', true),
    Cleaning_InlineOutVariableDeclarations: cfg.get<boolean>('cleanup.inlineOutVariableDeclarations', true),

    // A single VS Code toggle fans out to all per-kind explicit-access-modifier flags.
    Cleaning_InsertExplicitAccessModifiersOnClasses: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnDelegates: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnEnumerations: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnEvents: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnFields: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnInterfaces: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnMethods: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnProperties: insertExplicit,
    Cleaning_InsertExplicitAccessModifiersOnStructs: insertExplicit,

    // A single VS Code toggle fans out to all before/after blank-line-padding flags.
    Cleaning_InsertBlankLinePaddingBeforeClasses: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterClasses: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeDelegates: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterDelegates: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeEnumerations: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterEnumerations: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeEvents: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterEvents: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeInterfaces: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterInterfaces: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeMethods: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterMethods: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeNamespaces: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterNamespaces: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeStructs: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterStructs: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeRegionTags: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterRegionTags: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeEndRegionTags: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterEndRegionTags: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks: insertPadding,
    Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks: insertPadding,
    Cleaning_InsertBlankLinePaddingBeforeCaseStatements: insertPadding,

    Cleaning_UpdateEndRegionDirectives: cfg.get<boolean>('cleanup.updateEndRegionDirectives', true),
    Cleaning_UpdateSingleLineMethods: cfg.get<boolean>('cleanup.updateSingleLineMethods', true),
    Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine: cfg.get<boolean>('cleanup.updateAccessorsToBothBeSingleLineOrMultiLine', false),
    Formatting_CommentRunDuringCleanup: cfg.get<boolean>('cleanup.formatComments', false),

    Cleaning_RemoveByteOrderMark: cfg.get<boolean>('cleanup.removeByteOrderMark', true),
    Cleaning_RemoveEndOfLineWhitespace: cfg.get<boolean>('cleanup.removeEndOfLineWhitespace', true),
    Cleaning_RemoveBlankLinesAtTop: cfg.get<boolean>('cleanup.removeBlankLinesAtTop', true),
    Cleaning_RemoveBlankLinesAtBottom: cfg.get<boolean>('cleanup.removeBlankLinesAtBottom', true),
    Cleaning_RemoveBlankLinesAfterAttributes: cfg.get<boolean>('cleanup.removeBlankLinesAfterAttributes', true),
    Cleaning_RemoveBlankLinesAfterOpeningBrace: cfg.get<boolean>('cleanup.removeBlankLinesAfterOpeningBrace', true),
    Cleaning_RemoveBlankLinesBeforeClosingBrace: cfg.get<boolean>('cleanup.removeBlankLinesBeforeClosingBrace', true),
    Cleaning_RemoveBlankLinesBetweenChainedStatements: cfg.get<boolean>('cleanup.removeBlankLinesBetweenChainedStatements', true),
    Cleaning_RemoveMultipleConsecutiveBlankLines: cfg.get<boolean>('cleanup.removeMultipleConsecutiveBlankLines', true),

    Cleaning_UpdateFileHeaderCSharp: cfg.get<string>('cleanup.fileHeaderCSharp', ''),
    Cleaning_UpdateFileHeader_HeaderPosition: headerPosition === 'afterUsings' ? 1 : 0,
    Cleaning_UpdateFileHeader_HeaderUpdateMode: headerUpdateMode === 'replace' ? 1 : 0,
  };
}

export function getDotnetPath(): string {
  return vscode.workspace.getConfiguration('codeJanitor').get<string>('engine.dotnetPath', 'dotnet');
}

/**
 * Maps the `codeJanitor.ai.xmlDoc.*` settings onto the engine's `Cleaning_AiXmlDocumentation*`
 * fields, which drive which members the Roslyn planner selects for documentation.
 */
export function buildXmlDocEngineSettings(): Record<string, boolean | number | string | null> {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');

  return {
    Cleaning_AiXmlDocumentationMaxMethodsPerFile: cfg.get<number>('ai.xmlDoc.maxMembersPerFile', 25),
    Cleaning_AiXmlDocumentationMaxInputCharsPerMethod: cfg.get<number>('ai.xmlDoc.maxInputCharsPerMember', 2500),
    Cleaning_AiXmlDocumentationIgnoreGeneratedCode: cfg.get<boolean>('ai.xmlDoc.ignoreGeneratedCode', true),
    Cleaning_AiXmlDocumentationIgnoreObsolete: cfg.get<boolean>('ai.xmlDoc.ignoreObsolete', true),
    Cleaning_AiXmlDocumentationIgnoreTestMethods: cfg.get<boolean>('ai.xmlDoc.ignoreTestMethods', true),
    Cleaning_AiXmlDocumentationIgnorePattern: cfg.get<string>('ai.xmlDoc.ignorePattern', ''),
  };
}
