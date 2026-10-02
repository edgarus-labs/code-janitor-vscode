import * as path from 'node:path';
import { resolveEffectiveCleanupSettings } from './effectiveSettings';
import { EditorConfigProperties, hasAnalyzerConfiguration, loadEditorConfigProperties } from './editorconfig';
import { effectiveEditorConfigValue, enforcedOptionValue, isDiagnosticEnforced, unsupportedEditorConfigSettings } from './editorConfigRegistry';
import { SourceTransformationPipeline, delegateTransformation } from './pipeline';
import { ProjectInfo, findProject } from './projectInfo';
import { CleanupSettings, SourceTransformation } from './types';
import { createReorganizeTransformation } from '../reorganize/reorganize';
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
import { createFileScopedNamespaceConverter, createUsingPlacementConverter } from './transformations/namespaceScope';
import { nullCheckPatternMatchingConverter } from './transformations/nullCheckPatternMatching';
import { inlineOutVariableDeclarations, outVarInliningConverter } from './transformations/outVarInlining';
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
import { EditorConfigIssueReporter, describeIssue, indentUnit, lineNumberAt, tabWidth } from './transformations/editorConfigSupport';

/** The `.editorconfig` properties of the file being cleaned. */
export interface EditorConfigRules {
  readonly properties: EditorConfigProperties;
  /** Receives each violation a rule found but could not fix safely. */
  readonly report: EditorConfigIssueReporter;
  /** File name (with extension) of the file being cleaned. */
  readonly fileName?: string;
  /** Full path of the file being cleaned. */
  readonly filePath?: string;
  /** The file's project, when a rule needs it and it is found (see `projectInfo.ts`). */
  readonly project?: ProjectInfo;
}

/**
 * Something about the file's `.editorconfig` that cleanup could not honor: a rule violation it
 * could not fix safely (`unresolved`) or a setting it does not implement (`unsupported`).
 */
export interface EditorConfigIssue {
  readonly kind: 'unresolved' | 'unsupported';
  readonly filePath: string;
  /** What cleanup could not honor, without the file path. */
  readonly detail: string;
  /**
   * An IDE1006 violation of a type or non-private member, which other files may use: the symbol's
   * name. Only the workspace-wide rename of the batch commands can fix it.
   */
  readonly symbol?: string;
}

export type EditorConfigIssueListener = (issue: EditorConfigIssue) => void;

/**
 * Builds and runs the cleanup pipeline for a single C# file, mirroring the converter set, the
 * conditional gating and the order of the source extension's headless cleanup path.
 */
export function runCleanup(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  externalDisqualifiedTypeNames?: ReadonlySet<string>,
  onIssue?: EditorConfigIssueListener
): string {
  if (!source) {
    return source;
  }

  return getCleanupPipeline(source, filePath, settings, externalDisqualifiedTypeNames, onIssue).run(source);
}

/**
 * Loads the `.editorconfig` properties of `filePath` and builds its pipeline. The settings of the
 * `.editorconfig` that cleanup does not support are passed to `onIssue` right away; violations it
 * cannot fix are passed while the pipeline runs.
 */
export function getCleanupPipeline(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  externalDisqualifiedTypeNames?: ReadonlySet<string>,
  onIssue?: EditorConfigIssueListener
): SourceTransformationPipeline {
  const base = loadEditorConfigProperties(filePath);
  for (const message of unsupportedEditorConfigSettings(base)) {
    onIssue?.({ kind: 'unsupported', filePath, detail: message });
  }

  // `.editorconfig` decides over the settings; the enabled Code Style rules it does not enforce are
  // layered over it (analysis only, nothing is written) so the rule engine applies them.
  const effective = resolveEffectiveCleanupSettings(filePath, settings, base);
  for (const message of effective.unresolvedRules) {
    onIssue?.({ kind: 'unresolved', filePath, detail: message });
  }

  const properties = effective.properties;
  const rules: EditorConfigRules = {
    properties,
    report: (message, symbol) => onIssue?.({ kind: 'unresolved', filePath, detail: message, ...(symbol && { symbol }) }),
    fileName: filePath ? path.basename(filePath) : undefined,
    filePath: filePath || undefined,
    // Every rule depends on the project's C# version; some also on its folder or frameworks.
    project: hasAnalyzerConfiguration(properties) || effective.settings.convertToFileScopedNamespace ? findProject(filePath) : undefined,
  };

  return buildPipeline(source, effective.settings, rules, externalDisqualifiedTypeNames);
}

/**
 * The pipeline: the Code Janitor settings' steps, then the `.editorconfig` rules (naming, code
 * style, formatting). A setting the `.editorconfig` also decides - it is set, with a supported
 * value, and enforced where a severity applies - is overridden by the `.editorconfig`: the step of
 * the Code Janitor setting is skipped (or adjusted) and the `.editorconfig` rule applies instead.
 * Settings the `.editorconfig` does not decide keep applying.
 */
export function buildPipeline(
  source: string,
  settings: CleanupSettings,
  rules?: EditorConfigRules,
  externalDisqualifiedTypeNames?: ReadonlySet<string>
): SourceTransformationPipeline {
  const props = rules?.properties;
  const decides = (key: string): boolean => props !== undefined && effectiveEditorConfigValue(props, key) !== undefined;
  const enforced = (key: string): string | undefined => props && enforcedOptionValue(props, key);

  const varStyleKeys = ['csharp_style_var_for_built_in_types', 'csharp_style_var_when_type_is_apparent', 'csharp_style_var_elsewhere'];
  const explicitTypesPreferred = props !== undefined && varStyleKeys.some((key) => effectiveEditorConfigValue(props, key) === 'false');
  const collectionExpressions = enforced('dotnet_style_prefer_collection_expression');
  const expressionBodiedLambdas = enforced('csharp_style_expression_bodied_lambdas');

  // With `charset` set, the byte order mark is decided by the `.editorconfig` rules: the steps work
  // on the text without it, and it is put back for the formatting rules, which apply `charset`.
  const charsetDecides = decides('charset');
  const restoreByteOrderMark = charsetDecides && source.startsWith('\uFEFF');

  const hasEditorConfig = props !== undefined && hasAnalyzerConfiguration(props);
  // The final newline is ensured by a later step (unless `insert_final_newline = false`): removing
  // the blank lines at the bottom keeps it, rather than dropping it to have it added back.
  const keepFinalNewline = !decides('insert_final_newline') || effectiveEditorConfigValue(props!, 'insert_final_newline') === 'true';
  const trimTrailingWhitespace = props && effectiveEditorConfigValue(props, 'trim_trailing_whitespace');

  // Where the using directives go: what `.editorconfig` enforces, else the `moveUsingsOutsideNamespace` setting.
  const placementValue = props && effectiveEditorConfigValue(props, 'csharp_using_directive_placement');
  const placement =
    placementValue === 'inside_namespace' ? 'inside' : placementValue === 'outside_namespace' ? 'outside' : settings.moveUsingsOutsideNamespace ? 'outside' : undefined;
  const indentOf = (text: string): string => (props ? indentUnit(props, text) : '    ');

  const transformations: (SourceTransformation | undefined)[] = [
    settings.reorganize.runAtStartOfCleanup ? createReorganizeTransformation(settings.reorganize, settings) : undefined,
    settings.removeRegions ? regionDirectiveRemover : undefined,
    settings.removeByteOrderMark || charsetDecides ? byteOrderMarkConverter : undefined,
    placement
      ? createUsingPlacementConverter({
          direction: placement,
          filePath: rules?.filePath,
          fromEditorConfig: decides('csharp_using_directive_placement'),
          indent: indentOf,
          report: (message, text, offset) =>
            rules?.report(
              decides('csharp_using_directive_placement')
                ? describeIssue('IDE0065', 'csharp_using_directive_placement', text, offset, message)
                : `${message.charAt(0).toUpperCase()}${message.slice(1)}`
            ),
        })
      : undefined,
    settings.convertToFileScopedNamespace && !decides('csharp_style_namespace_declarations')
      ? createFileScopedNamespaceConverter({
          project: rules?.project,
          indent: indentOf,
          report: (message, text, offset) => rules?.report(`Line ${lineNumberAt(text, offset)}: ${message}`),
        })
      : undefined,
    settings.convertToVarWhenApparent && !varStyleKeys.some(decides) ? varWhenApparentConverter : undefined,
    settings.makeFieldsReadonlyWhenSafe && !decides('dotnet_style_readonly_field') ? readonlyFieldConverter : undefined,
    // While CA1852 is enforced, the `.editorconfig` rule alone decides what is sealed.
    settings.sealClassesWhenSafe && !(props && isDiagnosticEnforced(props, 'CA1852'))
      ? createSealedClassConverter(externalDisqualifiedTypeNames)
      : undefined,
    settings.insertBlankLineBeforeReturnAndThrowStatements ? returnThrowBlankLinePaddingConverter : undefined,
    settings.convertToCollectionExpressions && collectionExpressions !== 'false' && collectionExpressions !== 'never'
      ? collectionExpressionConverter
      : undefined,
    settings.reuseJsonSerializerOptionsForCA1869 ? jsonSerializerOptionsReuseConverter : undefined,
    settings.simplifySingleStatementLambdas && (expressionBodiedLambdas === undefined || expressionBodiedLambdas === 'true')
      ? singleStatementLambdaConverter
      : undefined,
    settings.convertToPatternMatchingNullChecks ? nullCheckPatternMatchingConverter : undefined,
    settings.convertStringFormatToInterpolation ? stringInterpolationConverter : undefined,
    settings.convertToStringNameOf ? nameOfOperatorConverter : undefined,
    settings.inlineOutVariableDeclarations && !decides('csharp_style_inlined_variable_declaration')
      ? explicitTypesPreferred
        ? delegateTransformation('Inline out Variable Declarations', (text) =>
            inlineOutVariableDeclarations(text, { keepDeclaredType: true })
          )
        : outVarInliningConverter
      : undefined,
    anyExplicitAccessModifierEnabled(settings) && !decides('dotnet_style_require_accessibility_modifiers')
      ? createExplicitAccessModifierConverter(settings)
      : undefined,
    createBlankLinePaddingConverter(settings),
    settings.updateEndRegionDirectives ? updateEndRegionDirectivesConverter : undefined,
    settings.updateSingleLineMethods ? updateSingleLineMethodsConverter : undefined,
    settings.updateAccessorsToBothBeSingleLineOrMultiLine
      ? updateAccessorsToBothBeSingleLineOrMultiLineConverter
      : undefined,
    settings.formatComments ? commentFormatConverter : undefined,
    settings.fileHeaderCSharp.trim() && !decides('file_header_template')
      ? delegateTransformation('Update C# file header', (text) =>
          applyConfiguredCSharpFileHeader(text, {
            header: settings.fileHeaderCSharp,
            position: settings.fileHeaderPosition,
            updateMode: settings.fileHeaderUpdateMode,
          })
        )
      : undefined,
    // With `dotnet_sort_system_directives_first` set, the `.editorconfig` formatting sorts the usings.
    settings.organizeUsings && !decides('dotnet_sort_system_directives_first') ? usingDirectiveOrganizer : undefined,
    // Trimmed here (not only by the formatting rules) so the blank-line steps below see empty lines.
    (trimTrailingWhitespace === undefined ? settings.removeEndOfLineWhitespace : trimTrailingWhitespace === 'true')
      ? removeTrailingWhitespaceConverter
      : undefined,
    settings.removeBlankLinesAtTop
      ? delegateTransformation('Remove blank lines at top', removeBlankLinesAtTop)
      : undefined,
    settings.removeBlankLinesAtBottom
      ? delegateTransformation('Remove blank lines at bottom', (text) => removeBlankLinesAtBottom(text, keepFinalNewline))
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
    decides('insert_final_newline') ? undefined : ensureFinalNewlineConverter,

    // The `.editorconfig` rules run after every other step: code style, naming (after code style,
    // so the names code-style rewrites introduce follow the naming rules too), then formatting
    // (last, so it formats code the other rules created).
    hasEditorConfig && rules
      ? createEditorConfigCodeStyleConverter(rules.properties, rules.report, {
          fileName: rules.fileName,
          filePath: rules.filePath,
          project: rules.project,
        })
      : undefined,
    hasEditorConfig && rules ? createEditorConfigNamingConverter(rules.properties, rules.report) : undefined,
    restoreByteOrderMark
      ? delegateTransformation('Restore byte order mark for charset', (text) => `\uFEFF${text}`)
      : undefined,
    hasEditorConfig && rules ? createEditorConfigFormattingConverter(rules.properties, rules.report) : undefined,
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
 * files in other languages, where the syntax-aware rules would not apply. The `.editorconfig`
 * core properties it knows override the corresponding settings.
 */
export function runLayoutCleanup(source: string, filePath: string, settings: CleanupSettings): string {
  if (!source) {
    return source;
  }

  const props = loadEditorConfigProperties(filePath);
  const charset = effectiveEditorConfigValue(props, 'charset');
  const trim = effectiveEditorConfigValue(props, 'trim_trailing_whitespace');
  const finalNewline = effectiveEditorConfigValue(props, 'insert_final_newline') !== 'false';

  const transformations: (SourceTransformation | undefined)[] = [
    (charset === undefined ? settings.removeByteOrderMark : charset === 'utf-8') ? byteOrderMarkConverter : undefined,
    effectiveEditorConfigValue(props, 'indent_style') === 'space' ? createTabToSpaceConverter(tabWidth(props)) : undefined,
    (trim === undefined ? settings.removeEndOfLineWhitespace : trim === 'true')
      ? delegateTransformation('Remove trailing whitespace', removeTrailingWhitespaceFromAnyText)
      : undefined,
    settings.removeBlankLinesAtTop
      ? delegateTransformation('Remove blank lines at top', removeBlankLinesAtTop)
      : undefined,
    settings.removeBlankLinesAtBottom
      ? delegateTransformation('Remove blank lines at bottom', (text) => removeBlankLinesAtBottom(text, finalNewline))
      : undefined,
    settings.removeMultipleConsecutiveBlankLines ? normalizeBlankLinesConverter : undefined,
    finalNewline ? ensureFinalNewlineConverter : undefined,
  ];

  return new SourceTransformationPipeline(transformations).run(source);
}

/** Outside C# there is no lexer to consult, so every end-of-line run of spaces/tabs is trimmed. */
function removeTrailingWhitespaceFromAnyText(source: string): string {
  return source.replace(/[ \t]+(?=\r?\n)/g, '').replace(/[ \t]+$/, '');
}
