import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import categories from './compilerTests.json';

// CI runs the tests that build C# with the .NET SDK in one job per category (see vitest.config.ts and
// .github/workflows/ci.yml) and the rest without them, so a test file missing from test/compilerTests.json
// would run in no job at all.
describe('compiler test categories', () => {
  const listed = Object.values(categories as Record<string, string[]>).flat();
  const testFiles = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.ts') && name !== path.basename(__filename));

  it('list every test file that needs the .NET SDK', () => {
    const needsDotnet = testFiles.filter((name) => fs.readFileSync(path.join(__dirname, name), 'utf8').includes('dotnetAvailable'));

    expect(needsDotnet.map((name) => `test/${name}`).filter((file) => !listed.includes(file))).toEqual([]);
  });

  it('list only existing test files, each in one category', () => {
    expect(listed.filter((file) => !fs.existsSync(path.join(__dirname, '..', file)))).toEqual([]);
    expect(listed.filter((file, index) => listed.indexOf(file) !== index)).toEqual([]);
  });
});
