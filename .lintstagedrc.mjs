import path from 'node:path';

export default {
  '*.{ts,js,mjs,cjs}': ['prettier --write', 'eslint --fix --max-warnings=0'],
  'server/**/*.cs': (files) =>
    `dotnet format whitespace server/CodeJanitor.Server.slnx --include ${files.map((file) => path.relative(process.cwd(), file)).join(' ')}`,
};
