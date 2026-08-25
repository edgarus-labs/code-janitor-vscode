/**
 * Syntax tree nodes. The shape mirrors the small slice of the tree-sitter node API the cleanup
 * transformations rely on (fields, named/anonymous children, byte offsets and row/column
 * positions), so the transformations stayed unchanged when the WebAssembly parser was replaced by
 * this native one.
 */

export interface Point {
  readonly row: number;
  readonly column: number;
}

/** Shared per-parse state: the source text and a lazily built line index for positions. */
export class SyntaxDocument {
  private lineStarts?: number[];

  constructor(readonly source: string) {}

  pointAt(index: number): Point {
    const starts = (this.lineStarts ??= buildLineStarts(this.source));

    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return { row: low, column: index - starts[low] };
  }
}

function buildLineStarts(source: string): number[] {
  const starts = [0];

  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      starts.push(i + 1);
    }
  }

  return starts;
}

let nextNodeId = 1;

export class Node {
  readonly id = nextNodeId++;

  parent: Node | null = null;

  /** Position within `parent.children`; maintained by {@link linkTree}. */
  private indexInParent = 0;

  private namedCache?: Node[];

  constructor(
    private readonly document: SyntaxDocument,
    readonly type: string,
    readonly isNamed: boolean,
    public startIndex: number,
    public endIndex: number,
    readonly children: Node[] = [],
    readonly fields?: ReadonlyMap<string, Node>
  ) {}

  get text(): string {
    return this.document.source.slice(this.startIndex, this.endIndex);
  }

  get startPosition(): Point {
    return this.document.pointAt(this.startIndex);
  }

  get endPosition(): Point {
    return this.document.pointAt(this.endIndex);
  }

  get childCount(): number {
    return this.children.length;
  }

  get namedChildren(): Node[] {
    return (this.namedCache ??= this.children.filter((child) => child.isNamed));
  }

  get namedChildCount(): number {
    return this.namedChildren.length;
  }

  child(index: number): Node | null {
    return this.children[index] ?? null;
  }

  namedChild(index: number): Node | null {
    return this.namedChildren[index] ?? null;
  }

  childForFieldName(name: string): Node | null {
    return this.fields?.get(name) ?? null;
  }

  get previousNamedSibling(): Node | null {
    const siblings = this.parent?.children;
    if (!siblings) {
      return null;
    }

    for (let i = this.indexInParent - 1; i >= 0; i--) {
      if (siblings[i].isNamed) {
        return siblings[i];
      }
    }

    return null;
  }

  get nextNamedSibling(): Node | null {
    const siblings = this.parent?.children;
    if (!siblings) {
      return null;
    }

    for (let i = this.indexInParent + 1; i < siblings.length; i++) {
      if (siblings[i].isNamed) {
        return siblings[i];
      }
    }

    return null;
  }

  descendantsOfType(type: string | readonly string[]): Node[] {
    const types = typeof type === 'string' ? [type] : type;
    const matches: Node[] = [];

    const visit = (node: Node): void => {
      if (types.includes(node.type)) {
        matches.push(node);
      }

      for (const child of node.children) {
        visit(child);
      }
    };

    visit(this);

    return matches;
  }

  /** @internal */
  setIndexInParent(index: number): void {
    this.indexInParent = index;
  }

  /** @internal - invalidates the named-children cache after trivia has been merged in. */
  resetNamedCache(): void {
    this.namedCache = undefined;
  }
}

export class Tree {
  constructor(readonly rootNode: Node) {}

  /** Kept for API compatibility with the previous WebAssembly parser; nothing to release. */
  delete(): void {
    // No native resources are held.
  }
}

/** Assigns parents and sibling indices across the whole tree. */
export function linkTree(root: Node): void {
  const stack: Node[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    node.resetNamedCache();

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      child.parent = node;
      child.setIndexInParent(i);
      stack.push(child);
    }
  }
}
