import { classifyCSharp } from '../csharpScanner';
import { ProjectInfo } from '../projectInfo';
import { lex } from '../syntax/lexer';
import { SourceTransformation } from '../types';
import { Layout, NamespaceItem, analyzeLayout } from '../usings/layout';
import { PlacementDirection, placeUsings } from '../usings/placement';
import { projectContextOf } from '../usings/workspaceIndex';
import { dedentBlock, indentFollowingLines, isBlank, newlineOf } from './editorConfigSupport';

// ---------------------------------------------------------------------------------------------
// Using directive placement (`moveUsingsOutsideNamespace`, `csharp_using_directive_placement`)
// ---------------------------------------------------------------------------------------------

export interface UsingPlacementOptions {
  readonly direction: PlacementDirection;
  /** The file being cleaned: its project tells which namespaces and types a name can mean. */
  readonly filePath?: string;
  /** Receives why the directives were left in place; `offset` is where in the source it concerns. */
  readonly report: (message: string, source: string, offset: number) => void;
  /** One indentation level for directives written into a namespace without anything to copy the indentation from. */
  readonly indent?: (source: string) => string;
  /** Set when `.editorconfig` decides the placement: the step then is the IDE0065 rule. */
  readonly fromEditorConfig?: boolean;
}

/**
 * Moves the using directives between the file and its namespace in the `direction` given, when the
 * project's declarations prove that every name binds as before. A file where that cannot be proven is
 * returned unchanged and the reason is reported (see `usings/placement.ts`).
 */
export function createUsingPlacementConverter(options: UsingPlacementOptions): SourceTransformation {
  const { direction } = options;
  const name = direction === 'outside' ? 'Move using directives outside namespace' : 'Move using directives inside namespace';
  const place = (input: string): string => {
    // A byte order mark is not code: the directives are placed after it.
    const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = input.slice(bom.length);
    if (!source.trim()) {
      return input;
    }

    const leftInPlace = (reason: string, offset = 0): string => {
      options.report(`using directives were not moved ${direction === 'outside' ? 'outside' : 'inside'} the namespace because ${reason}. They were left in place.`, source, offset);

      return input;
    };

    // Nothing to do (and nothing to look up) in a file without directives to move.
    const layout = analyzeLayout(source);
    if (!hasDirectivesToMove(layout, direction)) {
      return input;
    }

    const context = projectContextOf(options.filePath ?? '', source);
    if ('unavailable' in context) {
      return leftInPlace(context.unavailable);
    }

    const result = placeUsings(source, direction, {
      index: context.index,
      externalReferences: context.externalReferences,
      incomplete: context.incomplete,
      indent: options.indent?.(source) ?? '    ',
    });

    if (result.status === 'skipped') {
      return leftInPlace(result.reason, result.at);
    }

    return result.status === 'moved' ? bom + result.text : input;
  };

  return { name, ...(options.fromEditorConfig ? { diagnosticId: 'IDE0065' } : {}), apply: place };
}

function hasDirectivesToMove(layout: Layout, direction: PlacementDirection): boolean {
  return direction === 'outside'
    ? layout.namespaces.some((namespace) => namespace.usings.length > 0)
    : layout.usings.some((item) => !item.isGlobal) && layout.topLevel.length === 1 && !layout.otherTopLevel;
}

// ---------------------------------------------------------------------------------------------
// Namespace declaration style (`convertToFileScopedNamespace`, `csharp_style_namespace_declarations`)
// ---------------------------------------------------------------------------------------------

export interface NamespaceConversionOptions {
  /** One indentation level, for a body that moves into braces. */
  readonly indent: string;
  /** Receives why the namespace was not converted; `offset` is where in the source it concerns. */
  readonly report: (reason: string, offset: number) => void;
}

/** Why a project cannot compile file-scoped namespaces, or `undefined` when it can. An unknown language version counts as unable. */
export function fileScopedNamespacesUnsupported(project: ProjectInfo | undefined): string | undefined {
  if (!project) {
    return 'its project could not be determined, so its C# language version is unknown';
  }

  if (project.languageVersion === undefined) {
    return 'the C# language version of its project is unknown';
  }

  return project.languageVersion < 10 ? `its project uses C# ${project.languageVersion} and file-scoped namespaces need C# 10` : undefined;
}

/**
 * Converts a single top-level block-scoped namespace to a file-scoped one when the project compiles
 * it (C# 10 or newer). The using directives inside it stay there: they are only moved by the using
 * directive placement.
 */
export function createFileScopedNamespaceConverter(options: {
  readonly project: ProjectInfo | undefined;
  readonly report: (message: string, source: string, offset: number) => void;
  readonly indent?: (source: string) => string;
}): SourceTransformation {
  return {
    name: 'File-Scoped Namespace',
    apply: (input) => {
      // A byte order mark is not code (the lexer would read it as a member before the namespace).
      const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
      const source = input.slice(bom.length);
      if (!source.trim()) {
        return input;
      }

      const unsupported = fileScopedNamespacesUnsupported(options.project);
      if (unsupported) {
        // Only a file with a block-scoped namespace to convert is worth a report.
        if (hasBlockScopedNamespace(source)) {
          options.report(`namespace not converted to a file-scoped one: ${unsupported}.`, source, 0);
        }

        return input;
      }

      const converted = convertToFileScoped(source, {
        indent: options.indent?.(source) ?? '    ',
        report: (reason, offset) => options.report(`namespace not converted: ${reason}`, source, offset),
      });

      return converted === source ? input : bom + converted;
    },
  };
}

/** True when the file declares a block-scoped namespace at top level: the conversion to a file-scoped one concerns it. */
export function hasBlockScopedNamespace(source: string): boolean {
  return analyzeLayout(source).topLevel.some((namespace) => namespace.kind === 'block');
}

/**
 * Converts the file's only (block-scoped) namespace to a file-scoped one, keeping any using
 * directives inside it and any global attributes (`[assembly: ...]`) before it. Like Roslyn, files
 * with other top-level members, nested namespaces or several namespaces are not candidates (and are
 * left unchanged without a report).
 */
export function convertToFileScoped(source: string, options: NamespaceConversionOptions): string {
  const layout = analyzeLayout(source);
  const [namespace] = layout.topLevel;
  if (layout.topLevel.length !== 1 || namespace.kind !== 'block' || namespace.nested.length > 0 || !layout.ok) {
    return source;
  }

  if (layout.otherTopLevel && !onlyGlobalAttributesBefore(source, layout, namespace)) {
    return source;
  }

  const fail = (reason: string): string => {
    options.report(reason, namespace.keywordStart);

    return source;
  };
  const close = namespace.close;
  if (!close) {
    return fail('the namespace could not be fully parsed.');
  }

  if (!isBlank(source.slice(namespace.nameEnd, namespace.open.start)) || !isBlank(source.slice(close.end))) {
    return fail('comments or code surround the namespace braces.');
  }

  if (directivesStraddle(source, namespace.keywordStart, close.end)) {
    return fail('an #if or #region block starts outside the namespace and ends inside it, or the reverse.');
  }

  const kinds = classifyCSharp(source);
  const newline = newlineOf(source);
  const body = dedentBlock(source, kinds, namespace.open.end, close.start);
  const header = source.slice(0, namespace.keywordStart);

  return `${header}namespace ${source.slice(namespace.nameStart, namespace.nameEnd)};${body ? newline + newline + body : ''}${newline}`;
}

/**
 * True when the file level holds nothing besides its directives, global attribute lists before the
 * namespace and the namespace itself, so a file-scoped namespace can follow the attributes.
 */
function onlyGlobalAttributesBefore(source: string, layout: Layout, namespace: NamespaceItem): boolean {
  const directivesEnd = Math.max(0, ...layout.externs.map((item) => item.end), ...layout.usings.map((item) => item.end));
  const end = namespace.close?.end ?? source.length;
  let depth = 0;
  for (let i = 0; i < layout.tokens.length; i++) {
    const token = layout.tokens[i];
    if (token.start < directivesEnd || (token.start >= namespace.keywordStart && token.start < end)) {
      continue;
    }

    // Every list at file level opens with `[assembly:` or `[module:` and closes before the namespace.
    if (token.start >= end) {
      return false;
    }

    const target = layout.tokens[i + 1];
    if (depth === 0 && !(token.type === '[' && target?.type === 'identifier' && /^(?:assembly|module)$/.test(source.slice(target.start, target.end)) && layout.tokens[i + 2]?.type === ':')) {
      return false;
    }

    depth += token.type === '[' ? 1 : token.type === ']' ? -1 : 0;
  }

  return depth === 0;
}

/** Converts a file-scoped namespace to a block-scoped one, indenting everything after it by one level. */
export function convertToBlockScoped(source: string, options: NamespaceConversionOptions): string {
  const layout = analyzeLayout(source);
  const [namespace] = layout.topLevel;
  if (layout.topLevel.length !== 1 || layout.namespaces.length !== 1 || namespace.kind !== 'file' || !layout.ok) {
    return source;
  }

  if (directivesStraddle(source, namespace.keywordStart, source.length)) {
    options.report('an #if or #region block starts before the namespace and ends after it.', namespace.keywordStart);

    return source;
  }

  const kinds = classifyCSharp(source);
  const newline = newlineOf(source);
  const rest = source.slice(namespace.open.end);
  // The rest of the namespace line loses its leading spaces; the blank lines after it are dropped.
  const leadingBlank = /^[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*)?/.exec(rest)?.[0].length ?? 0;
  const content = rest.slice(leadingBlank).trimEnd();
  const body = content ? `${options.indent}${indentFollowingLines(content, options.indent, kinds, namespace.open.end + leadingBlank)}${newline}` : '';

  return `${source.slice(0, namespace.keywordStart)}namespace ${source.slice(namespace.nameStart, namespace.nameEnd)}${newline}{${newline}${body}}${newline}`;
}

/**
 * True when a conditional (`#if` ... `#endif`) or region has a directive inside `[from, to)` and another
 * one outside it: the braces of the converted namespace would then cut through the block.
 */
function directivesStraddle(source: string, from: number, to: number): boolean {
  const groups: number[][] = [];
  for (const directive of lex(source).trivia) {
    const at = directive.start;
    switch (directive.type) {
      case 'preproc_if':
      case 'preproc_region':
        groups.push([at]);
        break;
      case 'preproc_elif':
      case 'preproc_else':
        groups[groups.length - 1]?.push(at);
        break;
      case 'preproc_endif':
      case 'preproc_endregion': {
        const group = groups.pop();
        if (group) {
          group.push(at);
          const inside = group.filter((position) => position >= from && position < to).length;
          if (inside > 0 && inside < group.length) {
            return true;
          }
        }

        break;
      }
    }
  }

  // A block left open runs to the end of the file.
  return groups.some((group) => group.some((position) => position >= from && position < to) && group.some((position) => position < from));
}
