import * as fs from 'node:fs';
import * as path from 'node:path';
import { EditorConfigCSharpOptions } from './types';

/**
 * Reads `.editorconfig` files from the file's directory upwards (stopping at `root = true`) and
 * folds the settings the cleanup pipeline cares about into a single options object.
 */
export function loadCSharpOptions(filePath: string): EditorConfigCSharpOptions {
  const options: EditorConfigCSharpOptions = {};
  if (!filePath || !filePath.trim()) {
    return options;
  }

  for (const configPath of enumerateEditorConfigFiles(filePath)) {
    try {
      applyText(fs.readFileSync(configPath, 'utf8'), filePath, options);
    } catch {
      // An unreadable .editorconfig must never fail the cleanup.
    }
  }

  return options;
}

export function applyText(editorConfigText: string, filePath: string, options: EditorConfigCSharpOptions): void {
  if (!editorConfigText || !editorConfigText.trim() || !options || !filePath || !filePath.trim()) {
    return;
  }

  let active = true;

  for (const rawLine of editorConfigText.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      active = matchesCSharpSection(trimmed.slice(1, -1).trim(), filePath);
      continue;
    }

    if (!active) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    applySetting(options, trimmed.slice(0, separatorIndex).trim(), trimmed.slice(separatorIndex + 1).trim());
  }
}

/** Nearest-first: parents are applied before children so the closest file wins. */
function enumerateEditorConfigFiles(filePath: string): string[] {
  const found: string[] = [];
  let directory = path.dirname(path.resolve(filePath));

  for (;;) {
    const configPath = path.join(directory, '.editorconfig');
    if (fs.existsSync(configPath)) {
      found.unshift(configPath);

      try {
        if (/root\s*=\s*true/i.test(fs.readFileSync(configPath, 'utf8'))) {
          break;
        }
      } catch {
        break;
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  return found;
}

function matchesCSharpSection(section: string, filePath: string): boolean {
  if (!section) {
    return false;
  }

  const normalized = section.replace(/ /g, '');
  if (normalized === '*') {
    return true;
  }

  if (!normalized.toLowerCase().includes('cs')) {
    return false;
  }

  return path.extname(filePath).toLowerCase() === '.cs';
}

function applySetting(options: EditorConfigCSharpOptions, key: string, value: string): void {
  switch (key) {
    case 'trim_trailing_whitespace':
      options.trimTrailingWhitespace = tryParseBool(value);
      break;

    case 'dotnet_sort_system_directives_first':
      options.sortSystemDirectivesFirst = tryParseBool(value);
      break;

    case 'dotnet_separate_import_directive_groups':
      options.separateImportDirectiveGroups = tryParseBool(value);
      break;

    case 'insert_final_newline':
      options.insertFinalNewline = tryParseBool(value);
      break;

    case 'indent_style':
      options.indentStyle = value;
      break;

    case 'indent_size':
      options.indentSize = tryParseInt(value);
      break;

    case 'tab_width':
      options.tabWidth = tryParseInt(value);
      break;
  }
}

function tryParseBool(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return undefined;
}

function tryParseInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);

  return Number.isNaN(parsed) ? undefined : parsed;
}
