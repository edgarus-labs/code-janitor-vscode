import { CODE, STRING, classifyCSharp } from '../csharpScanner';
import { ProjectInfo } from '../projectInfo';
import { lex } from '../syntax/lexer';
import { SourceTransformation } from '../types';
import { Layout, analyzeLayout } from '../usings/layout';
import { PlacementDirection, placeUsings } from '../usings/placement';
import { projectContextOf } from '../usings/workspaceIndex';
import { indentFollowingLines, isBlank, lineIndentAt, lineStartAt, newlineOf } from './editorConfigSupport';

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
    : layout.usings.some((item) => !item.isGlobal) && layout.topLevel.length === 1 && !layout.otherTopLevel && !layout.hasGlobalAttributes;
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
    apply: (source) => {
      if (!source.trim()) {
        return source;
      }

      const unsupported = fileScopedNamespacesUnsupported(options.project);
      if (unsupported) {
        // Only a file with a block-scoped namespace to convert is worth a report.
        const candidate = analyzeLayout(source).topLevel.some((namespace) => namespace.kind === 'block');
        if (candidate) {
          options.report(`namespace not converted to a file-scoped one: ${unsupported}.`, source, 0);
        }

        return source;
      }

      return convertToFileScoped(source, {
        indent: options.indent?.(source) ?? '    ',
        report: (reason, offset) => options.report(`namespace not converted: ${reason}`, source, offset),
      });
    },
  };
}

/**
 * Converts the file's only (block-scoped) namespace to a file-scoped one, keeping any using
 * directives inside it. Like Roslyn, files with other top-level members, nested namespaces or
 * several namespaces are not candidates (and are left unchanged without a report).
 */
export function convertToFileScoped(source: string, options: NamespaceConversionOptions): string {
  const layout = analyzeLayout(source);
  const [namespace] = layout.topLevel;
  if (layout.topLevel.length !== 1 || layout.otherTopLevel || namespace.kind !== 'block' || namespace.nested.length > 0 || !layout.ok) {
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

/**
 * The text between `start` and `end` without its surrounding blank lines and with the indentation
 * of its first line removed from every line that starts in code. Lines that continue a string
 * literal (verbatim, raw, multi-line interpolated) and every line break stay as they are.
 */
function dedentBlock(source: string, kinds: Uint8Array, start: number, end: number): string {
  const text = source.slice(start, end);
  const firstContent = text.search(/\S/);
  if (firstContent < 0) {
    return '';
  }

  // Text on the line of the `{` (a trailing comment, or code) has no indentation of its own: the body
  // starts at that text, and the unit comes from the lines below it.
  const onBraceLine = !text.slice(0, firstContent).includes('\n');
  const bodyStart = onBraceLine ? firstContent : lineStartAt(text, firstContent);
  const unit = memberIndent(text, kinds, start, onBraceLine ? firstContent : bodyStart) ?? (onBraceLine ? '' : lineIndentAt(text, firstContent));
  const body = text.slice(bodyStart).trimEnd();
  const offset = start + bodyStart;
  let result = '';
  let lineStart = 0;
  while (lineStart < body.length) {
    const next = body.indexOf('\n', lineStart);
    const lineEnd = next < 0 ? body.length : next + 1;
    const line = body.slice(lineStart, lineEnd);
    const startsInString = lineStart > 0 && kinds[offset + lineStart - 1] === STRING;
    const content = line.replace(/\r?\n$/, '');
    result += startsInString ? line : isBlank(content) ? line.slice(content.length) : line.startsWith(unit) ? line.slice(unit.length) : line;
    lineStart = lineEnd;
  }

  return result;
}

/**
 * Indentation of the first line in `text` from `from` on that starts a namespace member: a line of
 * code at brace depth 0, or the line whose leading `}` returns to it. Directives (column 0 whatever
 * the code's indentation), lines continuing a comment or string, and lines nested in a block opened
 * on the `{` line set no unit. `from` inside a line (text on the `{` line) only counts its braces.
 * `undefined` when no line qualifies.
 */
function memberIndent(text: string, kinds: Uint8Array, offset: number, from: number): string | undefined {
  const isCode = (index: number) => kinds[offset + index] === CODE;
  let depth = 0;
  let lineStart = from;
  while (lineStart < text.length) {
    const next = text.indexOf('\n', lineStart);
    const lineEnd = next < 0 ? text.length : next;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEnd))![0];
    const first = lineStart + indent.length;
    const startsLine = lineStart > 0 && text[lineStart - 1] === '\n';
    if (startsLine && first < lineEnd && isCode(first - 1) && text[first] !== '#' && text[first] !== '\r') {
      let closers = 0;
      while (text[first + closers] === '}' && isCode(first + closers)) {
        closers++;
      }

      if (depth - closers <= 0) {
        return indent;
      }
    }

    for (let index = lineStart; index < lineEnd; index++) {
      if (isCode(index)) {
        depth += text[index] === '{' ? 1 : text[index] === '}' ? -1 : 0;
      }
    }

    lineStart = lineEnd + 1;
  }

  return undefined;
}
