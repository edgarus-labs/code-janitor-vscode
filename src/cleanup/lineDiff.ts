/** Beyond this many inserted and deleted lines, the texts are treated as one changed region. */
const MAX_EDITS = 1000;

/**
 * One run of changed lines of a line diff: lines `[beforeStart, beforeEnd)` of the text before
 * became lines `[afterStart, afterEnd)` of the text after (0-based; an empty range is a pure
 * insertion or deletion at that position).
 */
export interface LineHunk {
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly afterStart: number;
  readonly afterEnd: number;
}

/**
 * The number of separate places where `after` differs from `before`: runs of changed lines of a
 * shortest line diff (Myers). Used to show how many changes a cleanup step makes.
 */
export function countChangedRegions(before: string, after: string): number {
  return diffLineHunks(before, after).length;
}

/**
 * The runs of changed lines of a shortest line diff (Myers) of `before` and `after`, in order.
 * Beyond {@link MAX_EDITS} inserted and deleted lines, the changed middle is one hunk.
 */
export function diffLineHunks(before: string, after: string): LineHunk[] {
  if (before === after) {
    return [];
  }

  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const whole: LineHunk = { beforeStart: start, beforeEnd: endA, afterStart: start, afterEnd: endB };
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length === 0 || y.length === 0) {
    return [whole];
  }

  const max = Math.min(x.length + y.length, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let py = px - k;
      while (px < x.length && py < y.length && x[px] === y[py]) {
        px++;
        py++;
      }

      v[k + offset] = px;
      if (px >= x.length && py >= y.length) {
        return hunksOf(matchedLines(trace, offset, x.length, y.length), x.length, y.length, start);
      }
    }
  }

  return [whole];
}

/** Walks the diff back from the end and lists the pairs of equal lines it keeps, in order. */
function matchedLines(trace: readonly Int32Array[], offset: number, n: number, m: number): [number, number][] {
  const matched: [number, number][] = [];
  let px = n;
  let py = m;

  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = px - py;
    const previousK = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const previousX = v[previousK + offset];
    const previousY = previousX - previousK;
    // The snake after the edit: equal lines back to the point where the edit ends.
    const editEndX = previousX + (previousK === k - 1 ? 1 : 0);
    while (px > editEndX) {
      px--;
      py--;
      matched.push([px, py]);
    }

    px = previousX;
    py = previousY;
  }

  while (px > 0 && py > 0) {
    px--;
    py--;
    matched.push([px, py]);
  }

  return matched.reverse();
}

/** The gaps between consecutive equal lines, shifted by the common prefix. */
function hunksOf(matched: readonly [number, number][], n: number, m: number, shift: number): LineHunk[] {
  const hunks: LineHunk[] = [];
  let lastX = -1;
  let lastY = -1;
  for (const [mx, my] of [...matched, [n, m] as [number, number]]) {
    if (mx > lastX + 1 || my > lastY + 1) {
      hunks.push({ beforeStart: lastX + 1 + shift, beforeEnd: mx + shift, afterStart: lastY + 1 + shift, afterEnd: my + shift });
    }

    lastX = mx;
    lastY = my;
  }

  return hunks;
}

/**
 * `before` with only the chosen hunks of its diff to `after` applied (`hunks` from
 * {@link diffLineHunks}`(before, after)`, in order).
 */
export function applyLineHunks(before: string, after: string, hunks: readonly LineHunk[]): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines: string[] = [];
  let next = 0;
  for (const hunk of hunks) {
    lines.push(...a.slice(next, hunk.beforeStart), ...b.slice(hunk.afterStart, hunk.afterEnd));
    next = hunk.beforeEnd;
  }

  lines.push(...a.slice(next));

  return lines.join('\n');
}
