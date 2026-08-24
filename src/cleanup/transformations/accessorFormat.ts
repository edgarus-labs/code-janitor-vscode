import { Node } from 'web-tree-sitter';
import { TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

/**
 * Makes the accessors of a property or event consistently single-line or multi-line. The first
 * accessor's format wins; accessors that disagree are rewritten to match it.
 */
export const updateAccessorsToBothBeSingleLineOrMultiLineConverter: SourceTransformation = {
  name: 'Update accessors to both be single line or multi-line',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const edits: TextEdit[] = [];

      for (const declaration of findAll(tree.rootNode, ['property_declaration', 'event_declaration'])) {
        collectAccessorEdits(source, declaration, newline, edits);
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function collectAccessorEdits(source: string, declaration: Node, newline: string, edits: TextEdit[]): void {
  const accessorList = declaration.childForFieldName('accessors');
  if (!accessorList || accessorList.type !== 'accessor_list') {
    return;
  }

  const accessors = accessorList.namedChildren.filter(
    (child): child is Node => child?.type === 'accessor_declaration'
  );

  if (accessors.length < 2) {
    return;
  }

  const bodies = accessors.map(accessorBody);
  if (!bodies[0] || !bodies[1]) {
    return;
  }

  const firstIsSingleLine = isSingleLine(source, bodies[0]);
  if (firstIsSingleLine === isSingleLine(source, bodies[1])) {
    return;
  }

  for (let i = 0; i < accessors.length; i++) {
    const body = bodies[i];
    if (!body || isSingleLine(source, body) === firstIsSingleLine) {
      continue;
    }

    const formatted = formatBody(body, !firstIsSingleLine, newline);
    if (formatted !== undefined) {
      edits.push({ start: body.startIndex, end: body.endIndex, text: formatted });
    }
  }
}

function accessorBody(accessor: Node): Node | undefined {
  const body = accessor.childForFieldName('body');

  return body?.type === 'block' ? body : undefined;
}

/** Matches the original rule: the body plus its trailing line break must span at most two lines. */
function isSingleLine(source: string, body: Node): boolean {
  let newlines = 0;
  for (let i = body.startIndex; i < body.endIndex; i++) {
    if (source[i] === '\n') {
      newlines++;
    }
  }

  for (let i = body.endIndex; i < source.length; i++) {
    if (source[i] === '\n') {
      newlines++;
      break;
    }

    if (source[i] !== ' ' && source[i] !== '\t' && source[i] !== '\r') {
      break;
    }
  }

  return newlines <= 1;
}

function formatBody(body: Node, makeMultiLine: boolean, newline: string): string | undefined {
  const statements = body.namedChildren.filter(
    (child): child is Node => Boolean(child) && !child!.type.startsWith('preproc')
  );

  if (makeMultiLine) {
    return ['{', ...statements.map((statement) => `    ${statement.text.trim()}`), '}'].join(newline);
  }

  return statements.length === 1 ? `{ ${statements[0].text.trim()} }` : undefined;
}
