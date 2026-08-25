import { defineConfig } from '@vscode/test-cli';

// Runs the compiled test/e2e/**/*.test.ts files inside a real, isolated VS Code instance
// (its own user-data-dir and extensions-dir, downloaded once and cached under .vscode-test/).
// Unlike the vitest suite, this exercises the real `vscode` module: real command registration,
// real activation, real Settings schema - not the hand-written mock in test/helpers/vscodeMock.ts.
export default defineConfig({
  label: 'e2e',
  files: 'out/e2e/**/*.test.js',
  workspaceFolder: 'test/e2e/fixtures/workspace',
  mocha: {
    timeout: 30000,
  },
});
