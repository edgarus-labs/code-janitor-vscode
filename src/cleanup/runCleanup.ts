import { EditorConfigCSharpOptions } from './types';
import { loadCSharpOptions } from './editorconfig';
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
import { sealedClassConverter } from './transformations/sealedClass';
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

/**
 * Builds and runs the cleanup pipeline for a single C# file, mirroring the converter set, the
 * conditional gating and the order of the source extension's headless cleanup path.
 */
export function runCleanup(source: string, filePath: string, settings: CleanupSettings): string {
  if (!source) {
    return source;
  }

  const editorConfig = loadCSharpOptions(filePath);

  return buildPipeline(source, settings, editorConfig).run(source);
}

export function buildPipeline(
  source: string,
  settings: CleanupSettings,
  editorConfig: EditorConfigCSharpOptions
): SourceTransformationPipeline {
  const transformations: (SourceTransformation | undefined)[] = [
    settings.removeRegions ? regionDirectiveRemover : undefined,
    settings.removeByteOrderMark ? byteOrderMarkConverter : undefined,
    settings.moveUsingsOutsideNamespace ? moveUsingsOutsideNamespaceConverter : undefined,
    settings.convertToFileScopedNamespace && !hasMultipleNamespaces(source) ? fileScopedNamespaceConverter : undefined,
    settings.convertToVarWhenApparent ? varWhenApparentConverter : undefined,
    settings.makeFieldsReadonlyWhenSafe ? readonlyFieldConverter : undefined,
    settings.sealClassesWhenSafe ? sealedClassConverter : undefined,
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
