import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { XmlDocRunOptions } from '../cleanup/xmlDocumentation';
import { CleanupSettings, HeaderPosition, HeaderUpdateMode, createDefaultSettings } from '../cleanup/types';

const REPOSITORY_CONFIG_NAMES = ['.codejanitor', '.code-janitor.json'];

/** Maps the `codeJanitor.cleanup.*` VS Code settings onto the cleanup pipeline's settings shape. */
export function readCleanupSettings(workspaceRoot?: string): CleanupSettings {
  const cfg = vscode.workspace.getConfiguration('codeJanitor');
  const defaults = createDefaultSettings();
  const repo = readRepoCleanupOverrides(workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const base = { ...defaults, ...repo };

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
  };
}

/** Reads the optional repository policy file. Invalid JSON, unknown keys and wrong value types are ignored. */
export function readRepoCleanupOverrides(workspaceRoot?: string): Partial<CleanupSettings> {
  if (!workspaceRoot) {
    return {};
  }

  try {
    const configPath = REPOSITORY_CONFIG_NAMES.map((name) => path.join(workspaceRoot, name)).find((file) => fs.existsSync(file));
    if (!configPath) {
      return {};
    }

    const file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { cleanup?: Record<string, unknown> };
    const defaults = createDefaultSettings();
    const cleanup = file?.cleanup;
    if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
      return {};
    }

    const overrides: Partial<CleanupSettings> = {};
    applyBooleanAlias(cleanup, overrides, 'insertBlankLinePadding', [
      'insertBlankLinePaddingBeforeClasses',
      'insertBlankLinePaddingAfterClasses',
      'insertBlankLinePaddingBeforeDelegates',
      'insertBlankLinePaddingAfterDelegates',
      'insertBlankLinePaddingBeforeEnumerations',
      'insertBlankLinePaddingAfterEnumerations',
      'insertBlankLinePaddingBeforeEvents',
      'insertBlankLinePaddingAfterEvents',
      'insertBlankLinePaddingBeforeFieldsMultiLine',
      'insertBlankLinePaddingAfterFieldsMultiLine',
      'insertBlankLinePaddingBeforeInterfaces',
      'insertBlankLinePaddingAfterInterfaces',
      'insertBlankLinePaddingBeforeMethods',
      'insertBlankLinePaddingAfterMethods',
      'insertBlankLinePaddingBeforeNamespaces',
      'insertBlankLinePaddingAfterNamespaces',
      'insertBlankLinePaddingBeforePropertiesMultiLine',
      'insertBlankLinePaddingAfterPropertiesMultiLine',
      'insertBlankLinePaddingBeforeStructs',
      'insertBlankLinePaddingAfterStructs',
      'insertBlankLinePaddingBeforeRegionTags',
      'insertBlankLinePaddingAfterRegionTags',
      'insertBlankLinePaddingBeforeEndRegionTags',
      'insertBlankLinePaddingAfterEndRegionTags',
      'insertBlankLinePaddingBeforeUsingStatementBlocks',
      'insertBlankLinePaddingAfterUsingStatementBlocks',
      'insertBlankLinePaddingBeforeCaseStatements',
    ]);
    applyBooleanAlias(cleanup, overrides, 'insertExplicitAccessModifiers', [
      'insertExplicitAccessModifiersOnClasses',
      'insertExplicitAccessModifiersOnDelegates',
      'insertExplicitAccessModifiersOnEnumerations',
      'insertExplicitAccessModifiersOnEvents',
      'insertExplicitAccessModifiersOnFields',
      'insertExplicitAccessModifiersOnInterfaces',
      'insertExplicitAccessModifiersOnMethods',
      'insertExplicitAccessModifiersOnProperties',
      'insertExplicitAccessModifiersOnStructs',
    ]);

    for (const key of Object.keys(defaults) as (keyof CleanupSettings)[]) {
      const value = cleanup[key];
      if (key === 'fileHeaderPosition' || key === 'fileHeaderUpdateMode') {
        const enumValue = value === 'afterUsings' || value === 'replace' ? value : value === 'documentStart' || value === 'insert' ? value : undefined;
        if (enumValue !== undefined) {
          (overrides as Record<string, unknown>)[key] = key === 'fileHeaderPosition'
            ? enumValue === 'afterUsings' ? HeaderPosition.AfterUsings : HeaderPosition.DocumentStart
            : enumValue === 'replace' ? HeaderUpdateMode.Replace : HeaderUpdateMode.Insert;
        }

        continue;
      }

      if (value === undefined || typeof value !== typeof defaults[key]) {
        continue;
      }

      (overrides as Record<string, unknown>)[key] = value;
    }

    return overrides;
  } catch {
    return {};
  }
}

function applyBooleanAlias(
  config: Record<string, unknown>,
  overrides: Partial<CleanupSettings>,
  key: string,
  targetKeys: readonly string[]
): void {
  if (typeof config[key] !== 'boolean') {
    return;
  }

  for (const targetKey of targetKeys) {
    (overrides as Record<string, unknown>)[targetKey] = config[key];
  }
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
