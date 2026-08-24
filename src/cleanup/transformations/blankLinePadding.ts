import { Node } from 'web-tree-sitter';
import { CODE, classifyCSharp } from '../csharpScanner';
import { findAll, parseCSharp } from '../parser';
import { CleanupSettings, SourceTransformation } from '../types';

const CASE_STATEMENT = /(^[ \t]*)(break;|return(?:[ \t][^;\r\n]*)?;)\r?\n([ \t]*)(case\b|default\s*:)/gm;
const SINGLE_LINE_COMMENT_PADDING = /(^[ \t]*(?!\/\/)[^ \t\r\n{].*)\r?\n([ \t]*\/\/(?!\/))/gm;

type PaddingSettings = Pick<
  CleanupSettings,
  {
    [K in keyof CleanupSettings]: K extends `insertBlankLinePadding${string}` ? K : never;
  }[keyof CleanupSettings]
>;

/**
 * Inserts blank line padding before and after declarations according to the per-kind settings.
 * The syntax tree is only used to discover line numbers; the insertion itself happens on the line
 * list, the same safe pattern the return/throw padding uses.
 */
export function createBlankLinePaddingConverter(settings: PaddingSettings): SourceTransformation {
  return {
    name: 'Insert blank line padding',
    apply(source: string): string {
      if (!source || !anySettingEnabled(settings)) {
        return source;
      }

      const newline = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
      const lines = source.split(newline);
      const wantBlankBefore = new Set<number>();

      const tree = parseCSharp(source);
      try {
        collectDeclarationPadding(tree.rootNode, lines.length, settings, wantBlankBefore);
        collectUsingBlockPadding(tree.rootNode, settings, wantBlankBefore);
      } finally {
        tree.delete();
      }

      collectRegionDirectivePadding(source, lines, settings, wantBlankBefore);

      for (const index of [...wantBlankBefore].sort((a, b) => b - a)) {
        if (!shouldSkipInsertion(lines, index)) {
          lines.splice(index, 0, '');
        }
      }

      let result = lines.join(newline);

      if (settings.insertBlankLinePaddingBeforeCaseStatements) {
        result = result.replace(CASE_STATEMENT, (_m, indent, statement, caseIndent, caseKeyword) =>
          `${indent}${statement}${newline}${newline}${caseIndent}${caseKeyword}`
        );
      }

      if (settings.insertBlankLinePaddingBeforeSingleLineComments) {
        result = result.replace(SINGLE_LINE_COMMENT_PADDING, (_m, before, comment) =>
          `${before}${newline}${newline}${comment}`
        );
      }

      return result;
    },
  };
}

interface Padding {
  before: boolean;
  after: boolean;
}

function paddingFor(node: Node, settings: PaddingSettings): Padding | undefined {
  const isMultiLine = node.endPosition.row > node.startPosition.row;

  switch (node.type) {
    case 'class_declaration':
    case 'record_declaration':
      return { before: settings.insertBlankLinePaddingBeforeClasses, after: settings.insertBlankLinePaddingAfterClasses };

    case 'delegate_declaration':
      return {
        before: settings.insertBlankLinePaddingBeforeDelegates,
        after: settings.insertBlankLinePaddingAfterDelegates,
      };

    case 'enum_declaration':
      return {
        before: settings.insertBlankLinePaddingBeforeEnumerations,
        after: settings.insertBlankLinePaddingAfterEnumerations,
      };

    case 'event_declaration':
    case 'event_field_declaration':
      return { before: settings.insertBlankLinePaddingBeforeEvents, after: settings.insertBlankLinePaddingAfterEvents };

    case 'field_declaration':
      return isMultiLine
        ? {
            before: settings.insertBlankLinePaddingBeforeFieldsMultiLine,
            after: settings.insertBlankLinePaddingAfterFieldsMultiLine,
          }
        : {
            before: settings.insertBlankLinePaddingBeforeFieldsSingleLine,
            after: settings.insertBlankLinePaddingAfterFieldsSingleLine,
          };

    case 'interface_declaration':
      return {
        before: settings.insertBlankLinePaddingBeforeInterfaces,
        after: settings.insertBlankLinePaddingAfterInterfaces,
      };

    case 'namespace_declaration':
    case 'file_scoped_namespace_declaration':
      return {
        before: settings.insertBlankLinePaddingBeforeNamespaces,
        after: settings.insertBlankLinePaddingAfterNamespaces,
      };

    case 'method_declaration':
    case 'constructor_declaration':
    case 'destructor_declaration':
    case 'operator_declaration':
    case 'conversion_operator_declaration':
      return { before: settings.insertBlankLinePaddingBeforeMethods, after: settings.insertBlankLinePaddingAfterMethods };

    case 'property_declaration':
    case 'indexer_declaration':
      return isMultiLine
        ? {
            before: settings.insertBlankLinePaddingBeforePropertiesMultiLine,
            after: settings.insertBlankLinePaddingAfterPropertiesMultiLine,
          }
        : {
            before: settings.insertBlankLinePaddingBeforePropertiesSingleLine,
            after: settings.insertBlankLinePaddingAfterPropertiesSingleLine,
          };

    case 'struct_declaration':
      return { before: settings.insertBlankLinePaddingBeforeStructs, after: settings.insertBlankLinePaddingAfterStructs };

    default:
      return undefined;
  }
}

function collectDeclarationPadding(
  root: Node,
  lineCount: number,
  settings: PaddingSettings,
  wantBlankBefore: Set<number>
): void {
  for (const node of walkDeclarations(root)) {
    const padding = paddingFor(node, settings);
    if (!padding || (!padding.before && !padding.after)) {
      continue;
    }

    const startLine = paddingStartLine(node);
    const endLine = node.endPosition.row;

    if (padding.before && startLine > 0) {
      wantBlankBefore.add(startLine);
    }

    if (padding.after && endLine + 1 < lineCount) {
      wantBlankBefore.add(endLine + 1);
    }
  }
}

function* walkDeclarations(node: Node): Generator<Node> {
  for (const child of node.namedChildren) {
    if (child) {
      yield child;
      yield* walkDeclarations(child);
    }
  }
}

/**
 * A documentation comment belongs to the member below it, so padding goes above the comment rather
 * than between the comment and the declaration.
 */
function paddingStartLine(node: Node): number {
  let firstDocLine = node.startPosition.row;

  for (let sibling = node.previousNamedSibling; sibling?.type === 'comment'; sibling = sibling.previousNamedSibling) {
    if (sibling.text.startsWith('///') || sibling.text.startsWith('/**')) {
      firstDocLine = sibling.startPosition.row;
    }
  }

  return firstDocLine;
}

function collectRegionDirectivePadding(
  source: string,
  lines: readonly string[],
  settings: PaddingSettings,
  wantBlankBefore: Set<number>
): void {
  const beforeRegion = settings.insertBlankLinePaddingBeforeRegionTags;
  const afterRegion = settings.insertBlankLinePaddingAfterRegionTags;
  const beforeEndRegion = settings.insertBlankLinePaddingBeforeEndRegionTags;
  const afterEndRegion = settings.insertBlankLinePaddingAfterEndRegionTags;

  if (!beforeRegion && !afterRegion && !beforeEndRegion && !afterEndRegion) {
    return;
  }

  const kinds = classifyCSharp(source);
  let offset = 0;

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    const match = /^[ \t]*#(end)?region\b/.exec(text);

    if (match && kinds[offset + text.indexOf('#')] === CODE) {
      const isEnd = Boolean(match[1]);
      if ((isEnd ? beforeEndRegion : beforeRegion) && line > 0) {
        wantBlankBefore.add(line);
      }

      if (isEnd ? afterEndRegion : afterRegion) {
        wantBlankBefore.add(line + 1);
      }
    }

    offset += text.length + 1;
  }
}

function collectUsingBlockPadding(root: Node, settings: PaddingSettings, wantBlankBefore: Set<number>): void {
  const padBefore = settings.insertBlankLinePaddingBeforeUsingStatementBlocks;
  const padAfter = settings.insertBlankLinePaddingAfterUsingStatementBlocks;

  if (!padBefore && !padAfter) {
    return;
  }

  const groups = new Map<number, Node[]>();
  for (const directive of findAll(root, 'using_directive')) {
    const parentId = directive.parent?.id ?? -1;
    const group = groups.get(parentId);
    if (group) {
      group.push(directive);
    } else {
      groups.set(parentId, [directive]);
    }
  }

  for (const group of groups.values()) {
    const usings = [...group].sort((a, b) => a.startIndex - b.startIndex);
    let run: Node[] = [usings[0]];

    const flush = () => {
      const first = run[0];
      const last = run[run.length - 1];

      if (padBefore && first.startPosition.row > 0) {
        wantBlankBefore.add(first.startPosition.row);
      }

      if (padAfter) {
        wantBlankBefore.add(last.endPosition.row + 1);
      }
    };

    for (let i = 1; i < usings.length; i++) {
      if (usings[i].startPosition.row <= usings[i - 1].endPosition.row + 1) {
        run.push(usings[i]);
        continue;
      }

      flush();
      run = [usings[i]];
    }

    flush();
  }
}

function shouldSkipInsertion(lines: readonly string[], index: number): boolean {
  if (index <= 0 || index >= lines.length) {
    return true;
  }

  if (!lines[index - 1].trim()) {
    return true;
  }

  if (lines[index - 1].trim().endsWith('{')) {
    return true;
  }

  return lines[index].trim().startsWith('}');
}

function anySettingEnabled(settings: PaddingSettings): boolean {
  return Object.values(settings).some(Boolean);
}
