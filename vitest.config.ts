import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // test/e2e runs separately, inside a real VS Code host, via `npm run test:e2e`.
    exclude: ['test/e2e/**', 'node_modules/**'],
    environment: 'node',
    alias: {
      // The command layer imports `vscode`, which only exists inside the extension host.
      vscode: fileURLToPath(new URL('./test/helpers/vscodeMock.ts', import.meta.url)),
    },
  },
});
