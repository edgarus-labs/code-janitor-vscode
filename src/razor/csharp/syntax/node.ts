/**
 * Syntax tree nodes: the type, the named and anonymous children, the fields and the offsets of each
 * piece of syntax, as the C# formatting of Razor code reads them.
 */

/** Shared per-parse state: the source text. */
export class SyntaxDocument {
  constructor(readonly source: string) {}
}

export class Node {
  parent: Node | null = null;

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

  get namedChildren(): Node[] {
    return (this.namedCache ??= this.children.filter((child) => child.isNamed));
  }

  childForFieldName(name: string): Node | null {
    return this.fields?.get(name) ?? null;
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

/** Assigns the parents across the whole tree. */
export function linkTree(root: Node): void {
  const stack: Node[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    node.resetNamedCache();

    for (const child of node.children) {
      child.parent = node;
      stack.push(child);
    }
  }
}
