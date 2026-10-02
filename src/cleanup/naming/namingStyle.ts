/**
 * Port of Roslyn's `NamingStyle` (Microsoft.CodeAnalysis.NamingStyles): the compliance check behind
 * IDE1006 and the name its code fix proposes. Kept behaviorally identical so a name Code Janitor
 * produces is the name Visual Studio would produce for the same `.editorconfig`.
 */

export type Capitalization = 'pascal_case' | 'camel_case' | 'first_word_upper' | 'all_upper' | 'all_lower';

interface Span {
  readonly start: number;
  readonly end: number;
}

export class NamingStyle {
  constructor(
    readonly prefix: string,
    readonly suffix: string,
    readonly wordSeparator: string,
    readonly capitalization: Capitalization
  ) {}

  /** Roslyn `IsNameCompliant`. */
  isCompliant(name: string): boolean {
    if (!name.startsWith(this.prefix) || !name.endsWith(this.suffix)) {
      return false;
    }

    if (name.length <= this.prefix.length + this.suffix.length) {
      return true;
    }

    const { name: baseName, prefix: extraPrefix } = stripCommonPrefixes(name.slice(this.prefix.length));
    if (extraPrefix) {
      return false;
    }

    const words = this.wordSpans(baseName, { start: 0, end: baseName.length - this.suffix.length });
    switch (this.capitalization) {
      case 'pascal_case':
        return words.every((word) => firstCharIsUpper(baseName, word));
      case 'all_upper':
        return words.every((word) => everyCasedChar(baseName, word, isUpperChar));
      case 'all_lower':
        return words.every((word) => everyCasedChar(baseName, word, isLowerChar));
      case 'camel_case':
        return words.every((word, index) =>
          index === 0 ? firstCharIsLower(baseName, word) : firstCharIsUpper(baseName, word)
        );
      case 'first_word_upper':
        return words.every((word, index) =>
          index === 0 ? firstCharIsUpper(baseName, word) : firstCharIsLower(baseName, word)
        );
    }
  }

  /**
   * The name Roslyn's naming code fix offers first (`MakeCompliant`): strip common `m_`/`s_`/`t_`/`_`
   * prefixes, reuse a partial required prefix/suffix, then re-apply capitalization per word.
   */
  makeCompliant(name: string): string {
    let fixedName = stripCommonPrefixes(name).name;
    fixedName = this.ensurePrefix(fixedName);
    fixedName = this.ensureSuffix(fixedName);

    return this.finishFixingName(fixedName);
  }

  private ensurePrefix(name: string): string {
    const prefix = this.prefix;
    // `InputStream` with a required `I` prefix becomes `IInputStream`, not `InputStream`.
    if (prefix.length === 1 && isUpperChar(prefix) && name.length >= 2 && name[0] === prefix && isLowerChar(name[1])) {
      return prefix + name;
    }

    for (let i = 0; i < prefix.length; i++) {
      if (name.startsWith(prefix.slice(i))) {
        return prefix.slice(0, i) + name;
      }
    }

    return prefix + name;
  }

  private ensureSuffix(name: string): string {
    const suffix = this.suffix;
    for (let i = suffix.length; i > 0; i--) {
      if (name.endsWith(suffix.slice(0, i))) {
        return name + suffix.slice(i);
      }
    }

    return name + suffix;
  }

  private finishFixingName(name: string): string {
    if (this.suffix.length + this.prefix.length >= name.length) {
      return name;
    }

    const baseName = name.slice(this.prefix.length, name.length - this.suffix.length);
    let words = [baseName];

    if (this.wordSeparator) {
      words = baseName.split(this.wordSeparator).filter((word) => word.length > 0);
      if (words.length === 0) {
        return baseName;
      }

      if (words.length === 1) {
        words = breakIntoWordParts(baseName).map((part) => baseName.slice(part.start, part.end));
      }
    }

    return this.prefix + this.applyCapitalization(words).join(this.wordSeparator) + this.suffix;
  }

  private applyCapitalization(words: string[]): string[] {
    switch (this.capitalization) {
      case 'pascal_case':
        return words.map(capitalizeFirstLetter);
      case 'camel_case':
        return words.map((word, index) => (index === 0 ? decapitalizeFirstLetter(word) : capitalizeFirstLetter(word)));
      case 'first_word_upper':
        return words.map((word, index) => (index === 0 ? capitalizeFirstLetter(word) : decapitalizeFirstLetter(word)));
      case 'all_upper':
        return words.map((word) => mapChars(word, toUpperChar));
      case 'all_lower':
        return words.map((word) => mapChars(word, toLowerChar));
    }
  }

  /** Roslyn's `WordSpanEnumerator`: without a separator the whole base name is a single word. */
  private wordSpans(name: string, nameSpan: Span): Span[] {
    if (nameSpan.end <= nameSpan.start) {
      return [];
    }

    if (!this.wordSeparator) {
      return [nameSpan];
    }

    const separator = this.wordSeparator;
    const spans: Span[] = [];
    let current: Span = { start: nameSpan.start, end: nameSpan.start };

    for (;;) {
      let nextSeparator = name.indexOf(separator, current.end);
      if (nextSeparator === current.end) {
        current = { start: current.end + separator.length, end: current.end + separator.length };
        continue;
      }

      if (nextSeparator < 0) {
        nextSeparator = nameSpan.end;
      }

      if (current.end > nameSpan.end) {
        return spans;
      }

      current = { start: current.end, end: Math.min(nameSpan.end, nextSeparator) };
      if (current.end <= current.start || current.end > nameSpan.end) {
        return spans;
      }

      spans.push(current);
    }
  }
}

/** Roslyn `NamingStyle.StripCommonPrefixes`: removes leading `m_`, `s_`, `t_` and `_` runs. */
export function stripCommonPrefixes(name: string): { name: string; prefix: string } {
  let index = 0;
  while (index + 1 < name.length) {
    const ch = name[index].toLowerCase();
    if ((ch === 'm' || ch === 's' || ch === 't') && index + 2 < name.length && name[index + 1] === '_') {
      index++;
      continue;
    }

    if (ch === '_' && !isDigitChar(name[index + 1])) {
      index++;
      continue;
    }

    break;
  }

  return { name: name.slice(index), prefix: name.slice(0, index) };
}

/** Roslyn `StringBreaker.AddParts(identifier, word: true)`. */
function breakIntoWordParts(text: string): Span[] {
  const parts: Span[] = [];
  let start = 0;

  while (start < text.length) {
    const span = generateWordSpan(text, start);
    if (span.end <= span.start) {
      break;
    }

    parts.push(span);
    start = span.end;
  }

  return parts;
}

function generateWordSpan(text: string, from: number): Span {
  let wordStart = from;
  while (wordStart < text.length && text[wordStart] !== '_' && /\p{P}/u.test(text[wordStart])) {
    wordStart++;
  }

  if (wordStart >= text.length) {
    return { start: 0, end: 0 };
  }

  const first = text[wordStart];
  if (isUpperChar(first)) {
    if (wordStart + 1 === text.length) {
      return { start: wordStart, end: wordStart + 1 };
    }

    const next = text[wordStart + 1];
    if (isUpperChar(next)) {
      let current = wordStart + 2;
      while (current < text.length && isUpperChar(text[current])) {
        current++;
      }

      // `XMLDocument` yields `XML` and `Document`.
      return current < text.length && isLowerChar(text[current])
        ? { start: wordStart, end: current - 1 }
        : { start: wordStart, end: current };
    }

    return isLowerChar(next) ? scanLowerCaseRun(text, wordStart) : { start: wordStart, end: wordStart + 1 };
  }

  if (isLowerChar(first)) {
    return scanLowerCaseRun(text, wordStart);
  }

  if (first === '_') {
    return { start: wordStart, end: wordStart + 1 };
  }

  if (isDigitChar(first)) {
    let current = wordStart + 1;
    while (current < text.length && isDigitChar(text[current])) {
      current++;
    }

    return { start: wordStart, end: current };
  }

  return { start: 0, end: 0 };
}

function scanLowerCaseRun(text: string, wordStart: number): Span {
  let current = wordStart + 1;
  while (current < text.length && isLowerChar(text[current])) {
    current++;
  }

  return { start: wordStart, end: current };
}

function firstCharIsUpper(name: string, word: Span): boolean {
  const ch = name[word.start];

  return !hasCasing(ch) || isUpperChar(ch);
}

function firstCharIsLower(name: string, word: Span): boolean {
  const ch = name[word.start];

  return !hasCasing(ch) || isLowerChar(ch);
}

/** True when every cased character of the word satisfies `predicate` (`all_upper`/`all_lower`). */
function everyCasedChar(name: string, word: Span, predicate: (ch: string) => boolean): boolean {
  for (let i = word.start; i < word.end; i++) {
    if (hasCasing(name[i]) && !predicate(name[i])) {
      return false;
    }
  }

  return true;
}

function capitalizeFirstLetter(word: string): string {
  return word.length === 0 || isUpperChar(word[0]) ? word : toUpperChar(word[0]) + word.slice(1);
}

function decapitalizeFirstLetter(word: string): string {
  return word.length === 0 || isLowerChar(word[0]) ? word : toLowerChar(word[0]) + word.slice(1);
}

function mapChars(word: string, map: (ch: string) => string): string {
  let result = '';
  for (const ch of word) {
    result += map(ch);
  }

  return result;
}

// .NET `char.ToUpper`/`char.ToLower` never change the length of a string; `toUpperCase` can (`ß`).
function toUpperChar(ch: string): string {
  const upper = ch.toUpperCase();

  return upper.length === ch.length ? upper : ch;
}

function toLowerChar(ch: string): string {
  const lower = ch.toLowerCase();

  return lower.length === ch.length ? lower : ch;
}

function hasCasing(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

function isUpperChar(ch: string): boolean {
  return /\p{Lu}/u.test(ch);
}

function isLowerChar(ch: string): boolean {
  return /\p{Ll}/u.test(ch);
}

function isDigitChar(ch: string | undefined): boolean {
  return ch !== undefined && /\p{Nd}/u.test(ch);
}
