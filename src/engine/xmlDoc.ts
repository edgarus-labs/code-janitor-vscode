import { XmlDocTargetResult } from './protocol';

/**
 * XML documentation generation on the members the C# engine's `xmlDocTargets` query reports: what to ask
 * the model about each member, the deterministic summary that needs no request (or replaces a failed
 * one), and the comment block inserted above the member with its param, returns and exception tags.
 */

export const XML_DOC_SYSTEM_PROMPT =
  'You are a principal .NET software architect and technical writer authoring official Microsoft-standard XML documentation comments (<summary>).\n' +
  'Your task is to write a single-sentence, professional, production-grade summary for the given C# code element.\n' +
  'Rules:\n' +
  '1. Output EXACTLY ONE concise, high-quality summary sentence in plain text. No XML tags, no markdown quotes, no preambles, no reasoning, no thinking steps.\n' +
  "2. Never output generic or vague filler like 'Performs the operation.', 'Represents the class.', 'Executes the method.', or 'Contains data.'.\n" +
  '3. Use standard .NET conventions:\n' +
  "   - Commands (e.g., CreateRecipeCommand): 'Represents a command to create a new recipe with the specified details.'\n" +
  "   - Queries (e.g., GetRecipeByIdQuery): 'Represents a query to retrieve recipe details by identifier.'\n" +
  "   - DTOs / Records / Models: 'Represents the data structure containing {domain} details.'\n" +
  "   - Interfaces: 'Defines a contract for {domain} operations.'\n" +
  "   - Methods: start with third-person singular present tense active verbs ('Creates...', 'Calculates...', 'Asynchronously processes...', 'Handles...').\n" +
  "   - Enums: 'Specifies the available {category} options.'\n" +
  '4. Pay close attention to the element name, base types, interfaces, parameters, and properties to deduce the exact business domain semantics.';

/** The `codeJanitor.ai.xmlDoc.*` filters, sent as the `xmlDocTargets` query's arguments. */
export interface XmlDocRunOptions {
  maxMembersPerFile: number;
  maxInputCharsPerMember: number;
  ignoreGeneratedCode: boolean;
  ignoreObsolete: boolean;
  ignoreTestMethods: boolean;
  ignorePattern: string;
}

/** One member to document: the prompt for the model (AI members) and the deterministic summary. */
export interface XmlDocPlanItem {
  /** The member's index in the query result, which keys its summary. */
  readonly index: number;
  readonly kind: string;
  readonly memberName: string;
  readonly line: number;
  readonly requiresAi: boolean;
  readonly prompt?: string;
  readonly fallbackSummary: string;
}

const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'record', 'interface', 'enum']);

/** Property, field, indexer and event wording is formulaic, so it never costs an AI request. */
function requiresAiSummary(target: XmlDocTargetResult): boolean {
  return target.kind === 'method' || target.kind === 'constructor' || TYPE_KINDS.has(target.kind);
}

export function planXmlDocumentation(targets: readonly XmlDocTargetResult[], options: Pick<XmlDocRunOptions, 'maxInputCharsPerMember'>): XmlDocPlanItem[] {
  return targets.map((target, index) => {
    const requiresAi = requiresAiSummary(target);

    return {
      index,
      kind: target.kind,
      memberName: target.name,
      line: target.insertionLine,
      requiresAi,
      prompt: requiresAi ? buildPrompt(target, options.maxInputCharsPerMember) : undefined,
      fallbackSummary: buildFallbackSummary(target),
    };
  });
}

/**
 * Inserts a documentation block above each target of `source`, with the summary supplied for its index.
 * Members without a summary keep their deterministic text when they never needed AI, and are skipped
 * otherwise.
 */
export function insertXmlDocumentation(source: string, targets: readonly XmlDocTargetResult[], summaries: Readonly<Record<number, string>>): string {
  const bom = source.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const lines = splitLines(source.slice(bom.length));
  const fallbackBreak = lines.find((line) => line.lineBreak)?.lineBreak ?? '\n';
  // Bottom-up, so an insertion never moves the lines still to be documented.
  const ordered = targets.map((target, index) => ({ target, index })).sort((a, b) => b.target.insertionLine - a.target.insertionLine);
  for (const { target, index } of ordered) {
    const supplied = summaries[index];
    const summary = supplied?.trim() ? supplied : requiresAiSummary(target) ? undefined : buildFallbackSummary(target);
    if (summary && target.insertionLine >= 0 && target.insertionLine <= lines.length) {
      const lineBreak = lines[target.insertionLine]?.lineBreak || lines[target.insertionLine - 1]?.lineBreak || fallbackBreak;
      lines.splice(target.insertionLine, 0, ...buildXmlCommentBlock(target, normalizeSentence(summary)).map((text) => ({ text, lineBreak })));
    }
  }

  return bom + lines.map((line) => line.text + line.lineBreak).join('');
}

const BYTE_ORDER_MARK = '\uFEFF';

interface SourceLine {
  readonly text: string;
  readonly lineBreak: string;
}

/** The lines of `text` with their own line breaks, split where the server (Roslyn) splits: CRLF, CR, LF, NEL, LS and PS. */
function splitLines(text: string): SourceLine[] {
  const parts = text.split(/(\r\n|[\r\n\u0085\u2028\u2029])/);
  const lines: SourceLine[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index], lineBreak: parts[index + 1] ?? '' });
  }

  return lines;
}

function buildPrompt(target: XmlDocTargetResult, maxInputChars: number): string {
  if (target.kind === 'method') {
    return (
      'Generate a professional C# XML documentation <summary> sentence for the following C# method:\n' +
      `Signature: ${target.signature}\n` +
      `Method body:\n${truncate(target.body, maxInputChars)}\n` +
      `Detected thrown exceptions: ${exceptionList(target)}\n\n` +
      'Guidelines:\n' +
      "- Start with a third-person singular active verb (e.g., 'Asynchronously retrieves...', 'Executes the...', 'Validates and parses...').\n" +
      '- Describe what the method does and any important outcome or side effect.\n' +
      "- Do NOT output vague generic filler like 'Performs the operation.' or 'Executes the action.'\n" +
      '- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).'
    );
  }

  if (target.kind === 'constructor') {
    const { name, kind } = containing(target);

    return (
      `Generate a professional C# XML documentation <summary> sentence for the following C# constructor of ${kind} '${name}':\n` +
      `Signature: ${target.signature}\n` +
      `Constructor body:\n${truncate(target.body, maxInputChars)}\n` +
      `Detected thrown exceptions: ${exceptionList(target)}\n\n` +
      'Guidelines:\n' +
      `- Standard Microsoft style for constructors: 'Initializes a new instance of the ${name} ${kind}.' or 'Initializes a new instance of the ${name} ${kind} with the specified parameters.'\n` +
      '- Describe any validation or initialization done by the constructor.\n' +
      '- Do NOT output vague generic filler.\n' +
      '- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).'
    );
  }

  const members = target.members.length === 0 ? 'none' : target.members.join(', ');

  return (
    `Generate a professional C# XML documentation <summary> sentence for the following C# ${target.kind}:\n` +
    `Declaration: ${target.signature}\n` +
    `Kind: ${target.kind}\n` +
    `Name: ${target.name}\n` +
    `Implemented interfaces / base types: ${target.baseTypes.length > 0 ? target.baseTypes.join(', ') : 'none'}\n` +
    `Parameters / Properties / Members: ${truncate(members, maxInputChars)}\n\n` +
    'Guidelines:\n' +
    "- If this is a Command (e.g. implements ICommand, IRequest, or ends with 'Command'): start with 'Represents a command to {action}...' or 'Defines the command for {action}...' describing what action will be initiated and what data it carries.\n" +
    "- If this is a Query (e.g. implements IQuery, IRequest, or ends with 'Query'): start with 'Represents a query to retrieve {noun}...'.\n" +
    "- If this is a DTO, response, or event (e.g. ends with 'Dto', 'Response', 'Event'): start with 'Represents {noun}...' describing the data it encapsulates.\n" +
    "- If this is an Interface: start with 'Defines a contract for...' or 'Provides an abstraction for...'.\n" +
    '- If this is a marker interface with no members: state that it serves as a marker/indicator contract for type checking or pipeline dispatch.\n' +
    "- If this is a Class/Struct/Record: start with 'Represents...' or 'Provides...' describing its primary responsibility.\n" +
    "- If this is an Enum: start with 'Specifies...' or 'Defines constants for...'.\n" +
    "- Do NOT output vague generic filler like 'Performs the operation.' or 'Represents the object.' Be specific to the domain name and properties.\n" +
    '- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).'
  );
}

function exceptionList(target: XmlDocTargetResult): string {
  return target.exceptions.length > 0 ? target.exceptions.join(', ') : 'none detected';
}

function containing(target: XmlDocTargetResult): { name: string; kind: string } {
  return target.containingType ?? { name: 'Unknown', kind: 'type' };
}

/** The deterministic summary used when no AI request is made, or when the model call failed. */
function buildFallbackSummary(target: XmlDocTargetResult): string {
  const split = splitIdentifier(target.name).toLowerCase();
  if (TYPE_KINDS.has(target.kind)) {
    if (target.kind === 'interface') {
      return `Defines a contract for ${split}.`;
    }

    if (/command$/i.test(target.name)) {
      return `Represents a command to ${splitIdentifier(target.name.slice(0, -'Command'.length)).toLowerCase() || 'execute the operation'}.`;
    }

    if (/query$/i.test(target.name)) {
      return `Represents a query to retrieve ${splitIdentifier(target.name.slice(0, -'Query'.length)).toLowerCase() || 'the requested data'}.`;
    }

    return /(dto|response|request)$/i.test(target.name) ? `Represents the data structure for ${split}.` : `Represents ${split}.`;
  }

  switch (target.kind) {
    case 'property':
      return buildPropertySummary(target, split);
    case 'field':
      return `The ${split}.`;
    case 'indexer':
      return 'Gets or sets the element at the specified index.';
    case 'event':
      return `Occurs when ${split}.`;
    case 'constructor': {
      const { name, kind } = containing(target);

      return target.parameters.length > 0
        ? `Initializes a new instance of the ${name} ${kind} with the specified parameters.`
        : `Initializes a new instance of the ${name} ${kind}.`;
    }
    default:
      return `Executes ${split || 'the method'}.`;
  }
}

function buildPropertySummary(target: XmlDocTargetResult, split: string): string {
  const hasSet = target.accessors?.set === true;
  const hasGet = target.accessors?.get !== false || !hasSet;
  const type =
    target.signature
      .replace(/\s+\S+$/, '')
      .split(/\s+/)
      .pop() ?? '';
  if (/^(bool|Boolean)$/i.test(type)) {
    return hasGet && hasSet
      ? `Gets or sets a value indicating whether ${split}.`
      : hasSet
        ? `Sets a value indicating whether ${split}.`
        : `Gets a value indicating whether ${split}.`;
  }

  const verb = hasGet && hasSet ? 'Gets or sets' : hasSet ? 'Sets' : 'Gets';

  return /^(List|IList|IReadOnlyList|IEnumerable|ICollection)</.test(type) || type.endsWith('[]')
    ? `${verb} the collection of ${split}.`
    : `${verb} the ${split}.`;
}

function buildXmlCommentBlock(target: XmlDocTargetResult, summary: string): string[] {
  const indent = target.indent;
  const block = [`${indent}/// <summary>`, `${indent}/// ${xmlEscape(summary)}`, `${indent}/// </summary>`];
  if (target.kind === 'method' || target.kind === 'constructor' || target.kind === 'record') {
    for (const parameter of target.parameters) {
      block.push(`${indent}/// <param name="${parameter.name}">${xmlEscape(buildParameterDescription(parameter.name, parameter.type))}</param>`);
    }
  }

  if (target.kind === 'method' && target.returnType && target.returnType.toLowerCase() !== 'void') {
    block.push(`${indent}/// <returns>${xmlEscape(buildReturnDescription(target.returnType, target.name))}</returns>`);
  }

  if (target.kind === 'method' || target.kind === 'constructor') {
    for (const exception of [...target.exceptions].sort()) {
      block.push(`${indent}/// <exception cref="${xmlEscape(exception)}">${xmlEscape('Thrown when an error occurs during execution.')}</exception>`);
    }
  }

  return block;
}

function buildParameterDescription(name: string, type: string): string {
  if (!name.trim()) {
    return 'The parameter value.';
  }

  if (name.toLowerCase() === 'cancellationtoken' || type.toLowerCase() === 'cancellationtoken') {
    return 'The cancellation token to monitor for cancellation requests.';
  }

  if (name.toLowerCase() === 'id') {
    return 'The unique identifier.';
  }

  if (/id$/i.test(name) && name.length > 2) {
    return `The unique identifier of the ${splitIdentifier(name.slice(0, -2)).toLowerCase()}.`;
  }

  if (/(dto|request|command)$/i.test(name)) {
    return `The ${splitIdentifier(name).toLowerCase()} containing the operation data.`;
  }

  const split = splitIdentifier(name).toLowerCase();

  return /^(List|IList|IEnumerable|IReadOnlyList)</.test(type) || type.endsWith('[]') ? `The collection of ${split}.` : `The ${split}.`;
}

function buildReturnDescription(returnType: string, methodName: string): string {
  if (/^(bool|Boolean)$/i.test(returnType)) {
    return /^(is|has|can|try)/i.test(methodName) ? 'true if the condition is met; otherwise, false.' : 'true if the operation succeeded; otherwise, false.';
  }

  if (/^task$/i.test(returnType)) {
    return 'A task representing the asynchronous operation.';
  }

  if (/^valuetask$/i.test(returnType)) {
    return 'A value task representing the asynchronous operation.';
  }

  if (/^task</i.test(returnType) && returnType.endsWith('>')) {
    const inner = returnType.slice(5, -1).trim();

    return /^bool$/i.test(inner)
      ? 'A task representing the asynchronous operation. The task result is true if successful; otherwise, false.'
      : `A task representing the asynchronous operation. The task result contains the ${cleanGenericTypeName(inner)}.`;
  }

  if (/^valuetask</i.test(returnType) && returnType.endsWith('>')) {
    return `A value task representing the asynchronous operation. The task result contains the ${cleanGenericTypeName(returnType.slice(10, -1).trim())}.`;
  }

  if (/^(IEnumerable|IReadOnlyList|List)</.test(returnType) || returnType.endsWith('[]')) {
    return `A collection of ${cleanGenericTypeName(returnType)} items.`;
  }

  return `The ${cleanGenericTypeName(returnType)} result.`;
}

function cleanGenericTypeName(typeName: string): string {
  if (!typeName.trim()) {
    return 'result';
  }

  const index = typeName.indexOf('<');

  return splitIdentifier((index > 0 ? typeName.slice(0, index) : typeName).replace(/\[\]/g, '')).toLowerCase();
}

function splitIdentifier(identifier: string): string {
  if (!identifier.trim()) {
    return 'the operation';
  }

  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

/** Strips thinking process, chain-of-thought blocks, markdown fences and preambles from a model completion. */
export function sanitizeAiCompletion(text: string): string {
  if (!text || !text.trim()) {
    return '';
  }

  let cleaned = text.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');

  if (/^(?:\*{0,2})Thinking Process(?:\*{0,2})\s*:/i.test(cleaned)) {
    const drafts = [...cleaned.matchAll(/(?:Draft\s*\d+|Final Draft|Summary)\s*(?:\([^)]*\))?\s*:\s*\*?\*?([^\n\r*]+)/gi)];
    const candidate = drafts.length > 0 ? drafts[drafts.length - 1][1].trim() : '';
    cleaned = candidate.length > 5 ? candidate : '';
  }

  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '');
  cleaned = cleaned.replace(/\s*```$/, '');
  cleaned = cleaned.replace(/^(?:Here is (?:the|a) (?:concise )?summary(?:\s+sentence)?:\s*|Summary:\s*|Description:\s*)/i, '');
  cleaned = cleaned.replace(/^(?:\s*\/\/\/\s*(?:<summary>)?\s*)+/i, '');
  cleaned = cleaned.replace(/(?:\s*\/\/\/\s*<\/summary>\s*)+$/i, '');

  return cleaned.trim();
}

/** Collapses whitespace, trims quotes and guarantees terminating punctuation. */
export function normalizeSentence(text: string): string {
  const compact = sanitizeAiCompletion(text)
    .replace(/[\s\u0085\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  if (!compact) {
    return 'Performs the operation.';
  }

  const trimmed = compact.replace(/^["'`*]+/, '').replace(/["'`*]+$/, '');

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function xmlEscape(text: string): string {
  return (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function truncate(text: string, maxLength: number): string {
  return !text || text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}
