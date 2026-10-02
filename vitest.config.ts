import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import compilerTests from './test/compilerTests.json';

// The tests that build C# with the .NET SDK, by category (test/compilerTests.json). CI runs each category in
// its own job and everything else in the `unit` one; without CODE_JANITOR_TEST_CATEGORY every test runs.
const categories: Readonly<Record<string, readonly string[]>> = compilerTests;
const category = process.env.CODE_JANITOR_TEST_CATEGORY;
if (category !== undefined && category !== 'unit' && !(category in categories)) {
  throw new Error(`Unknown CODE_JANITOR_TEST_CATEGORY '${category}': use 'unit' or one of ${Object.keys(categories).join(', ')}.`);
}

const allTests = ['test/**/*.test.ts'];

export default defineConfig({
  test: {
    include: category === undefined || category === 'unit' ? allTests : [...categories[category]],
    // test/e2e runs separately, inside a real VS Code host, via `npm run test:e2e`.
    exclude: ['test/e2e/**', 'node_modules/**', ...(category === 'unit' ? Object.values(categories).flat() : [])],
    environment: 'node',
    // Vitest's default of 5 s is too short for the tests that run `dotnet build`: a cold SDK on a CI runner
    // takes about 9 s for the first build alone.
    testTimeout: 60_000,
    alias: {
      // The command layer imports `vscode`, which only exists inside the extension host.
      vscode: fileURLToPath(new URL('./test/helpers/vscodeMock.ts', import.meta.url)),
    },
  },
});
