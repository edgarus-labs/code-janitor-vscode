import * as fs from 'node:fs';
import * as path from 'node:path';
import { Language, Node, Parser, Tree } from 'web-tree-sitter';

/**
 * Tree-sitter runtime for the syntax-aware transformations. The grammar is a WebAssembly module,
 * so it is byte-identical on every OS and CPU architecture - no native binaries, no external
 * runtime. Initialization is asynchronous and happens once; every transformation afterwards parses
 * synchronously.
 */

let parser: Parser | undefined;
let initPromise: Promise<void> | undefined;

export interface ParserInitOptions {
  /** Directory holding `tree-sitter.wasm` and `tree-sitter-c_sharp.wasm`. */
  wasmDirectory?: string;
}

export function initCSharpParser(options: ParserInitOptions = {}): Promise<void> {
  initPromise ??= createParser(options);

  return initPromise;
}

async function createParser(options: ParserInitOptions): Promise<void> {
  const runtimeWasm = resolveWasm('tree-sitter.wasm', options.wasmDirectory);
  const grammarWasm = resolveWasm('tree-sitter-c_sharp.wasm', options.wasmDirectory);

  await Parser.init({
    locateFile: (fileName: string) => (fileName === 'tree-sitter.wasm' ? runtimeWasm : fileName),
  });

  const language = await Language.load(grammarWasm);
  const created = new Parser();
  created.setLanguage(language);
  parser = created;
}

export function isParserReady(): boolean {
  return parser !== undefined;
}

/** Parses C# source. Requires {@link initCSharpParser} to have completed. */
export function parseCSharp(source: string): Tree {
  if (!parser) {
    throw new Error('CodeJanitor: the C# parser has not been initialized yet.');
  }

  const tree = parser.parse(source);
  if (!tree) {
    throw new Error('CodeJanitor: failed to parse the C# source.');
  }

  return tree;
}

const WASM_SEARCH_PATHS = [
  // Packaged extension: the build copies both modules next to the bundle.
  (fileName: string) => path.join(__dirname, fileName),
  (fileName: string) => path.join(__dirname, '..', 'dist', fileName),
  // Development / test run straight from the repository.
  (fileName: string) =>
    fileName === 'tree-sitter.wasm'
      ? path.join(process.cwd(), 'node_modules', 'web-tree-sitter', fileName)
      : path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', fileName),
];

function resolveWasm(fileName: string, wasmDirectory?: string): string {
  if (wasmDirectory) {
    const explicit = path.join(wasmDirectory, fileName);
    if (fs.existsSync(explicit)) {
      return explicit;
    }
  }

  for (const candidate of WASM_SEARCH_PATHS) {
    const resolved = candidate(fileName);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error(`CodeJanitor: could not locate ${fileName}. Reinstall the extension or run "npm install".`);
}

/** Depth-first walk over every node of the tree. */
export function* walk(node: Node): Generator<Node> {
  yield node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      yield* walk(child);
    }
  }
}

/** Depth-first walk including anonymous nodes (punctuation, keywords). */
export function* walkAll(node: Node): Generator<Node> {
  yield node;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      yield* walkAll(child);
    }
  }
}

export function findAll(root: Node, type: string | readonly string[]): Node[] {
  const types = typeof type === 'string' ? [type] : type;
  const matches: Node[] = [];

  for (const node of walk(root)) {
    if (types.includes(node.type)) {
      matches.push(node);
    }
  }

  return matches;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits to the source, right to left so offsets stay valid. */
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) {
    return source;
  }

  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  let previousStart = Number.POSITIVE_INFINITY;

  for (const edit of ordered) {
    if (edit.end > previousStart) {
      continue;
    }

    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    previousStart = edit.start;
  }

  return result;
}
