import { describe, expect, it } from 'vitest';
import { buildFiles, dotnetAvailable, formatErrors } from './helpers/dotnetBuild';

describe.skipIf(!dotnetAvailable)('dotnet build helper', () => {
  it('builds valid code', () => {
    const result = buildFiles({ 'A.cs': 'class A { }' });
    expect(result.ok, formatErrors(result)).toBe(true);
  });

  it('reports compiler errors with their codes', () => {
    const result = buildFiles({ 'A.cs': 'class A { int x = "s"; }' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain('CS0029');
  });
});
