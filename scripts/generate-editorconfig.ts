// Writes the documented-defaults .editorconfig (see scripts/editorConfigTemplate.ts).
// Usage: npx vite-node scripts/generate-editorconfig.ts [output path, default .editorconfig]
import * as fs from 'node:fs';
import { renderEditorConfig } from './editorConfigTemplate';

const target = process.argv[2] ?? '.editorconfig';
fs.writeFileSync(target, renderEditorConfig(), 'utf8');
console.log(`Wrote ${target}.`);
