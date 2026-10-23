export const PATCHED_NODE: Readonly<Record<number, string>> = {
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
};

function parse(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function nodeVersionProblem(version: string): string | undefined {
  const parsed = parse(version);
  if (!parsed) {
    return `'${version}' is not a Node.js version.`;
  }

  const [major] = parsed;
  const lines = Object.keys(PATCHED_NODE).map(Number);
  if (major > Math.max(...lines)) {
    return `Node.js ${version} is on a line this check does not know: add the first release of that line that carries the fix of CVE-2026-111497 to PATCHED_NODE.`;
  }

  const patched = PATCHED_NODE[major];
  if (patched === undefined) {
    return `Node.js ${version} is on a line that no longer gets security fixes; use ${lines.map((line) => PATCHED_NODE[line]).join(', ')} or newer.`;
  }

  const floor = parse(patched)!;
  const older = parsed[1] !== floor[1] ? parsed[1] < floor[1] : parsed[2] < floor[2];

  return older ? `Node.js ${version} is older than ${patched}, the patched release of its line (CVE-2026-111497, Brotli decoder).` : undefined;
}
