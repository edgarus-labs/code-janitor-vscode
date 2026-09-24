import * as path from 'node:path';
import { EditorConfigCSharpOptions } from './types';
import { EditorConfigProperties, loadCSharpOptions, loadEditorConfigProperties } from './editorconfig';
import { SourceTransformationPipeline, delegateTransformation } from './pipeline';
import { CleanupSettings, SourceTransformation } from './types';
import { updateAccessorsToBothBeSingleLineOrMultiLineConverter } from './transformations/accessorFormat';
import { createBlankLinePaddingConverter } from './transformations/blankLinePadding';
import { createExplicitAccessModifierConverter } from './transformations/explicitAccessModifier';
import {
  applyConfiguredCSharpFileHeader,
  removeBlankLinesAfterAttributes,
  removeBlankLinesAfterOpeningBrace,
  removeBlankLinesAtBottom,
  removeBlankLinesAtTop,
  removeBlankLinesBeforeClosingBrace,
  removeBlankLinesBetweenChainedStatements,
} from './transformations/fileHeaderAndBlankLines';
import {
  collectionExpressionConverter,
  stringInterpolationConverter,
} from './transformations/formatAndCollections';
import {
  jsonSerializerOptionsReuseConverter,
  singleStatementLambdaConverter,
} from './transformations/lambdaAndJson';
import { nameOfOperatorConverter } from './transformations/namespaceAndNameOf';
import {
  fileScopedNamespaceConverter,
  hasMultipleNamespaces,
  moveUsingsOutsideNamespaceConverter,
} from './transformations/namespaceScope';
import { nullCheckPatternMatchingConverter } from './transformations/nullCheckPatternMatching';
import { outVarInliningConverter } from './transformations/outVarInlining';
import {
  readonlyFieldConverter,
  updateSingleLineMethodsConverter,
} from './transformations/readonlyFieldAndSingleLineMethods';
import { returnThrowBlankLinePaddingConverter } from './transformations/returnThrowBlankLinePadding';
import { createSealedClassConverter } from './transformations/sealedClass';
import {
  byteOrderMarkConverter,
  commentFormatConverter,
  createTabToSpaceConverter,
  ensureFinalNewlineConverter,
  normalizeBlankLinesConverter,
  regionDirectiveRemover,
  removeTrailingWhitespaceConverter,
  updateEndRegionDirectivesConverter,
} from './transformations/text';
import { usingDirectiveOrganizer } from './transformations/usingDirectiveOrganizer';
import { varWhenApparentConverter } from './transformations/varWhenApparent';
import { createEditorConfigNamingConverter } from './transformations/editorConfigNaming';
import { createEditorConfigCodeStyleConverter } from './transformations/editorConfigCodeStyle';
import { createEditorConfigFormattingConverter } from './transformations/editorConfigFormatting';
import { EditorConfigIssueReporter } from './transformations/editorConfigSupport';

/** The `.editorconfig` properties of the file being cleaned, for the `.editorconfig`-driven categories. */
export interface EditorConfigRules {
  readonly properties: EditorConfigProperties;
  /** Receives each violation a category found but could not fix safely. */
  readonly report: EditorConfigIssueReporter;
  /** File name (with extension) of the file being cleaned. */
  readonly fileName?: string;
}

/**
 * Builds and runs the cleanup pipeline for a single C# file, mirroring the converter set, the
 * conditional gating and the order of the source extension's headless cleanup path.
 */
export function runCleanup(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  externalDisqualifiedTypeNames?: ReadonlySet<string>,
  report?: EditorConfigIssueReporter
): string {
  if (!source) {
    return source;
  }

  return getCleanupPipeline(source, filePath, settings, externalDisqualifiedTypeNames, report).run(source);
}

/**
 * `report` receives the violations the `.editorconfig` categories could not fix, each prefixed
 * with `filePath`.
 */
export function getCleanupPipeline(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  externalDisqualifiedTypeNames?: ReadonlySet<string>,
  report?: EditorConfigIssueReporter
): SourceTransformationPipeline {
  const editorConfig = loadCSharpOptions(filePath);
  const usesEditorConfigRules =
    settings.applyEditorConfigNaming || settings.applyEditorConfigCodeStyle || settings.applyEditorConfigFormatting;
  const rules: EditorConfigRules | undefined = usesEditorConfigRules
    ? {
        properties: loadEditorConfigProperties(filePath),
        report: (issue) => report?.(`${filePath}: ${issue}`),
        fileName: filePath ? path.basename(filePath) : undefined,
      }
    : undefined;

  return buildPipeline(source, settings, editorConfig, externalDisqualifiedTypeNames, rules);
}

export function buildPipeline(
  source: string,
  settings: CleanupSettings,
  editorConfig: EditorConfigCSharpOptions,
  externalDisqualifiedTypeNames?: ReadonlySet<string>,
  rules?: EditorConfigRules
): SourceTransformationPipeline {
  // `.editorconfig` is the source of truth: with `charset = utf-8-bom` a byte order mark the file
  // had is restored after the other steps (which need it removed to parse the code).
  const restoreByteOrderMark =
    settings.applyEditorConfigFormatting &&
    source.startsWith('\uFEFF') &&
    rules?.properties.get('charset')?.toLowerCase() === 'utf-8-bom';

  const transformations: (SourceTransformation | undefined)[] = [
    settings.removeRegions ? regionDirectiveRemover : undefined,
    settings.removeByteOrderMark ? byteOrderMarkConverter : undefined,
    settings.moveUsingsOutsideNamespace ? moveUsingsOutsideNamespaceConverter : undefined,
    settings.convertToFileScopedNamespace && !hasMultipleNamespaces(source) ? fileScopedNamespaceConverter : undefined,
    settings.convertToVarWhenApparent ? varWhenApparentConverter : undefined,
    settings.makeFieldsReadonlyWhenSafe ? readonlyFieldConverter : undefined,
    settings.sealClassesWhenSafe ? createSealedClassConverter(externalDisqualifiedTypeNames) : undefined,
    settings.insertBlankLineBeforeReturnAndThrowStatements ? returnThrowBlankLinePaddingConverter : undefined,
    settings.convertToCollectionExpressions ? collectionExpressionConverter : undefined,
    settings.reuseJsonSerializerOptionsForCA1869 ? jsonSerializerOptionsReuseConverter : undefined,
    settings.simplifySingleStatementLambdas ? singleStatementLambdaConverter : undefined,
    settings.convertToPatternMatchingNullChecks ? nullCheckPatternMatchingConverter : undefined,
    settings.convertStringFormatToInterpolation ? stringInterpolationConverter : undefined,
    settings.convertToStringNameOf ? nameOfOperatorConverter : undefined,
    settings.inlineOutVariableDeclarations ? outVarInliningConverter : undefined,
    anyExplicitAccessModifierEnabled(settings) ? createExplicitAccessModifierConverter(settings) : undefined,
    createBlankLinePaddingConverter(settings),
    settings.updateEndRegionDirectives ? updateEndRegionDirectivesConverter : undefined,
    settings.updateSingleLineMethods ? updateSingleLineMethodsConverter : undefined,
    settings.updateAccessorsToBothBeSingleLineOrMultiLine
      ? updateAccessorsToBothBeSingleLineOrMultiLineConverter
      : undefined,
    settings.formatComments ? commentFormatConverter : undefined,
    settings.fileHeaderCSharp.trim()
      ? delegateTransformation('Update C# file header', (text) =>
          applyConfiguredCSharpFileHeader(text, {
            header: settings.fileHeaderCSharp,
            position: settings.fileHeaderPosition,
            updateMode: settings.fileHeaderUpdateMode,
          })
        )
      : undefined,
    editorConfig.indentStyle?.toLowerCase() === 'space'
      ? createTabToSpaceConverter(editorConfig.tabWidth ?? editorConfig.indentSize ?? 4)
      : undefined,
    settings.organizeUsings ||
    (editorConfig.sortSystemDirectivesFirst === true && editorConfig.separateImportDirectiveGroups !== true)
      ? usingDirectiveOrganizer
      : undefined,
    settings.removeEndOfLineWhitespace || editorConfig.trimTrailingWhitespace === true
      ? removeTrailingWhitespaceConverter
      : undefined,
    settings.removeBlankLinesAtTop
      ? delegateTransformation('Remove blank lines at top', removeBlankLinesAtTop)
      : undefined,
    settings.removeBlankLinesAtBottom
      ? delegateTransformation('Remove blank lines at bottom', removeBlankLinesAtBottom)
      : undefined,
    settings.removeBlankLinesAfterAttributes
      ? delegateTransformation('Remove blank lines after attributes', removeBlankLinesAfterAttributes)
      : undefined,
    settings.removeBlankLinesAfterOpeningBrace
      ? delegateTransformation('Remove blank lines after opening brace', removeBlankLinesAfterOpeningBrace)
      : undefined,
    settings.removeBlankLinesBeforeClosingBrace
      ? delegateTransformation('Remove blank lines before closing brace', removeBlankLinesBeforeClosingBrace)
      : undefined,
    settings.removeBlankLinesBetweenChainedStatements
      ? delegateTransformation('Remove blank lines between chained statements', removeBlankLinesBetweenChainedStatements)
      : undefined,
    settings.removeMultipleConsecutiveBlankLines ? normalizeBlankLinesConverter : undefined,
    editorConfig.insertFinalNewline !== false ? ensureFinalNewlineConverter : undefined,
    // The `.editorconfig` categories run after every other step, in this order: naming, code
    // style, formatting (last, so it formats code the other categories created).
    settings.applyEditorConfigNaming && rules
      ? createEditorConfigNamingConverter(rules.properties, rules.report)
      : undefined,
    settings.applyEditorConfigCodeStyle && rules
      ? createEditorConfigCodeStyleConverter(rules.properties, rules.report, { fileName: rules.fileName })
      : undefined,
    settings.applyEditorConfigFormatting && rules
      ? createEditorConfigFormattingConverter(rules.properties, rules.report)
      : undefined,
    restoreByteOrderMark
      ? delegateTransformation('Keep byte order mark (charset = utf-8-bom)', (text) =>
          text.startsWith('\uFEFF') ? text : `\uFEFF${text}`
        )
      : undefined,
  ];

  return new SourceTransformationPipeline(transformations);
}

function anyExplicitAccessModifierEnabled(settings: CleanupSettings): boolean {
  return (
    settings.insertExplicitAccessModifiersOnClasses ||
    settings.insertExplicitAccessModifiersOnDelegates ||
    settings.insertExplicitAccessModifiersOnEnumerations ||
    settings.insertExplicitAccessModifiersOnEvents ||
    settings.insertExplicitAccessModifiersOnFields ||
    settings.insertExplicitAccessModifiersOnInterfaces ||
    settings.insertExplicitAccessModifiersOnMethods ||
    settings.insertExplicitAccessModifiersOnProperties ||
    settings.insertExplicitAccessModifiersOnStructs
  );
}

/**
 * The subset of the pipeline that only touches layout and therefore needs no C# parser. Used for
 * files in other languages, where the syntax-aware rules would not apply.
 */
export function runLayoutCleanup(source: string, filePath: string, settings: CleanupSettings): string {
  if (!source) {
    return source;
  }

  const editorConfig = loadCSharpOptions(filePath);

  const transformations: (SourceTransformation | undefined)[] = [
    settings.removeByteOrderMark ? byteOrderMarkConverter : undefined,
    editorConfig.indentStyle?.toLowerCase() === 'space'
      ? createTabToSpaceConverter(editorConfig.tabWidth ?? editorConfig.indentSize ?? 4)
      : undefined,
    settings.removeEndOfLineWhitespace || editorConfig.trimTrailingWhitespace === true
      ? delegateTransformation('Remove trailing whitespace', removeTrailingWhitespaceFromAnyText)
      : undefined,
    settings.removeBlankLinesAtTop
      ? delegateTransformation('Remove blank lines at top', removeBlankLinesAtTop)
      : undefined,
    settings.removeBlankLinesAtBottom
      ? delegateTransformation('Remove blank lines at bottom', removeBlankLinesAtBottom)
      : undefined,
    settings.removeMultipleConsecutiveBlankLines ? normalizeBlankLinesConverter : undefined,
    editorConfig.insertFinalNewline !== false ? ensureFinalNewlineConverter : undefined,
  ];

  return new SourceTransformationPipeline(transformations).run(source);
}

/** Outside C# there is no lexer to consult, so every end-of-line run of spaces/tabs is trimmed. */
function removeTrailingWhitespaceFromAnyText(source: string): string {
  return source.replace(/[ \t]+(?=\r?\n)/g, '').replace(/[ \t]+$/, '');
}
