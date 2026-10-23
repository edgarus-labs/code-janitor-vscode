/** How many texts a memoized function remembers. */
const CAPACITY = 8;

/**
 * Memoizes a pure function of a text for the last few texts it saw: the formatting passes lex and
 * parse the same text again and again, and a pass that changes nothing hands the next one the very
 * same text, so its tokens and tree can be reused.
 *
 * Only for functions whose result depends on the text alone and that callers treat as read-only
 * (syntax trees, token lists).
 */
export function memoizeBySource<T>(compute: (source: string) => T): (source: string) => T {
  const results = new Map<string, T>();

  return (source: string): T => {
    const cached = results.get(source);
    if (cached !== undefined) {
      // Most recently used last, so the oldest entry is evicted first.
      results.delete(source);
      results.set(source, cached);

      return cached;
    }

    const result = compute(source);
    results.set(source, result);
    if (results.size > CAPACITY) {
      results.delete(results.keys().next().value as string);
    }

    return result;
  };
}
