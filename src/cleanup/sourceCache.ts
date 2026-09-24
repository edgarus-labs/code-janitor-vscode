/**
 * Memoizes a pure function of a file's text for the last few texts it saw. Cleanup runs dozens of
 * rules over the same text, and each one used to lex, parse and model it again; a rule that
 * changes nothing hands the next one the very same text, so its analysis can be reused.
 *
 * Only for functions whose result depends on the text alone and that callers treat as read-only
 * (syntax trees, token lists, source models).
 */
export function memoizeBySource<T>(compute: (source: string) => T, capacity = 8): (source: string) => T {
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
    if (results.size > capacity) {
      results.delete(results.keys().next().value as string);
    }

    return result;
  };
}
