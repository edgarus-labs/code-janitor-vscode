/**
 * The JSON-RPC protocol between the extension and the Roslyn server (`server/src/CodeJanitor.Server`).
 * Lines and columns: `UnresolvedDiagnostic` is 1-based, `EngineDiagnostic` 0-based; `changedLines` are
 * 1-based inclusive ranges.
 */

export const Methods = {
  initialize: 'initialize',
  cleanup: 'cleanup',
  analyze: 'analyze',
  query: 'query',
  fixRule: 'fixRule',
  command: 'command',
  overrideNotes: 'overrideNotes',
  formatCommentText: 'formatCommentText',
  shutdown: 'shutdown',
  fileChanged: 'fileChanged',
} as const;

/** The cleanup settings as the server reads them: `CleanupSettings` with the header enums as strings. */
export type EngineSettings = Readonly<Record<string, unknown>>;

export interface DocumentText {
  readonly path: string;
  readonly text: string;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface InitializeParams {
  readonly workspaceFolders: readonly string[];
}

export interface InitializeResult {
  readonly serverVersion: string;
  readonly roslynVersion: string;
}

export interface DocumentParams {
  readonly filePath: string;
  readonly text: string;
  readonly settings: EngineSettings;
  /** The unsaved editor text of other files; it overlays the disk for this request only. */
  readonly unsavedDocuments?: readonly DocumentText[];
}

export interface CleanupParams extends DocumentParams {
  readonly excludedRules?: readonly string[];
  /** With `onlyChangedLines`: the lines changed since HEAD; `null` means every line. */
  readonly changedLines?: readonly LineRange[] | null;
  /**
   * Cleanup on save: no other file is changed or created (types are reported, not moved; renames stay in the
   * file), and with `skipOrganizeUsingsDuringCleanupOnSave` in `settings` the using directives are left alone.
   */
  readonly onSave?: boolean;
  /** A partial cleanup of a file outside the workspace folders: like `onSave`, and the using directives are always left alone. */
  readonly partial?: boolean;
}

export interface QueryParams extends DocumentParams {
  readonly query: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface FixRuleParams extends DocumentParams {
  readonly ruleId: string;
  /** 0-based; only the occurrence on this line is fixed. */
  readonly line?: number;
}

export interface CommandParams extends DocumentParams {
  readonly command: EngineCommand;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export type EngineCommand =
  'reorganize' | 'splitTopLevelTypes' | 'fixNamespace' | 'removeXmlDocumentation' | 'removeRegions' | 'formatComments' | 'moveMember' | 'deleteMember';

export interface OverrideNotesParams {
  readonly directory: string;
  readonly settings: EngineSettings;
}

export interface RuleResult {
  readonly id: string;
  readonly name: string;
  readonly changes: number;
  readonly included: boolean;
}

export interface UnresolvedDiagnostic {
  readonly id: string;
  readonly message: string;
  readonly severity: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly reason: string;
}

export interface CleanupResult {
  /** The new text of `filePath`. */
  readonly text: string;
  /** The changed texts of other existing files (renames, namespace fixes). */
  readonly otherFiles: readonly DocumentText[];
  /** Files the solution gained (type splits). */
  readonly newFiles: readonly DocumentText[];
  readonly rules: readonly RuleResult[];
  readonly unresolved: readonly UnresolvedDiagnostic[];
  readonly issues: readonly string[];
  /** Steps that failed and were undone; the text holds what the other steps did. */
  readonly failures: readonly string[];
  /** Why the file was not cleaned in its own project (the project failed to load, the .NET SDK is missing). */
  readonly warnings: readonly string[];
}

/** A diagnostic for the Problems panel; positions are 0-based. */
export interface EngineDiagnostic {
  readonly id: string;
  readonly message: string;
  readonly severity: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly fixable: boolean;
  readonly helpLink?: string | null;
}

export interface AnalyzeResult {
  readonly diagnostics: readonly EngineDiagnostic[];
}

export interface OverrideNotesResult {
  readonly notes: Readonly<Record<string, string>>;
}

/**
 * `formatCommentText`: formats the comments written with `commentPrefix` (`'`, `//`, `#`) in the text of a file that
 * is not C#, on the 0-based lines `startLine`..`endLine` (all when absent), with the `commentFormat` of `settings`.
 */
export interface FormatCommentTextParams {
  readonly text: string;
  readonly commentPrefix: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly settings: EngineSettings;
}

export interface FormatCommentTextResult {
  readonly text: string;
}

/** The `memberAtPosition` query: the innermost member or type around a 0-based position. */
export interface MemberAtPosition {
  readonly name: string;
  readonly kind: string;
  /** 0-based. */
  readonly startLine: number;
  /** 0-based, inclusive. */
  readonly endLine: number;
  readonly text: string;
  readonly signature: string;
}

/** The kinds of members the `xmlDocTargets` query reports. */
export type XmlDocMemberKind = 'method' | 'constructor' | 'class' | 'struct' | 'record' | 'interface' | 'enum' | 'property' | 'field' | 'indexer' | 'event';

/** One member the `xmlDocTargets` query found without XML documentation, in declaration order. */
export interface XmlDocTargetResult {
  readonly name: string;
  readonly kind: XmlDocMemberKind;
  /** The member's text, truncated to `maxInputCharsPerMember`. */
  readonly text: string;
  /** 0-based line of the member's first token (its attributes included): the block is inserted before it. */
  readonly insertionLine: number;
  /** The leading whitespace of that line. */
  readonly indent: string;
  /** The declaration up to its body, whitespace collapsed. */
  readonly signature: string;
  /** The body or expression body, trimmed; empty without one. */
  readonly body: string;
  readonly parameters: readonly { readonly name: string; readonly type: string }[];
  readonly typeParameters: readonly string[];
  /** A method's return type (`void` included); null for other members. */
  readonly returnType: string | null;
  readonly containingType: { readonly name: string; readonly kind: string } | null;
  /** The exception types the member throws. */
  readonly exceptions: readonly string[];
  /** A property's accessors (`init` counts as `set`; an expression body as `get`). */
  readonly accessors: { readonly get: boolean; readonly set: boolean } | null;
  /** A type's base list entries. */
  readonly baseTypes: readonly string[];
  /** A type's members, as `Name (Type)` for properties, `Name()` for methods, the name otherwise. */
  readonly members: readonly string[];
  /** A type's modifiers. */
  readonly modifiers: readonly string[];
}
