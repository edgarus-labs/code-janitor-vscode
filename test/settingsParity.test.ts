import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultCommentFormatOptions, createDefaultSettings } from '../src/cleanup/types';
import { toEngineSettings } from '../src/engine/settings';

const ROOT = path.resolve(__dirname, '..');
const engineDefaults = toEngineSettings(createDefaultSettings()) as unknown as Record<string, unknown>;

function serverDefaults(): Record<string, unknown> {
  const source = fs.readFileSync(path.join(ROOT, 'server/src/CodeJanitor.Engine/Settings/CleanupSettingsDefaults.cs'), 'utf8');
  const json = /"""\s*([\s\S]*?)\s*"""/.exec(source);
  if (!json) {
    throw new Error('CleanupSettingsDefaults.cs has no raw string literal with the defaults.');
  }

  return JSON.parse(json[1]) as Record<string, unknown>;
}

function manifestSettings(): Record<string, { default?: unknown; scope?: string; minimum?: number; maximum?: number }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, never> }[] };
  };

  return Object.assign({}, ...manifest.contributes.configuration.map((section) => section.properties));
}

/** `codeJanitor.cleanup.*` settings that are read under another name, or fan out to several engine settings. */
const RENAMED: Record<string, string[]> = {
  insertBlankLineBeforeReturnAndThrow: ['insertBlankLineBeforeReturnAndThrowStatements'],
  insertExplicitAccessModifiers: Object.keys(engineDefaults).filter((key) => key.startsWith('insertExplicitAccessModifiersOn')),
};

/** `codeJanitor.cleanup.*` settings that are not engine settings: they select files, trigger cleanup or the group toggle of the padding flags. */
const NOT_ENGINE_SETTINGS =
  /^(onSave|exclude|include|showOptionsDialog|includeOtherFileTypes|fileTypes\..+|excludeT4GeneratedCode|performPartialCleanupOnExternal|skipOrganizeUsingsDuringCleanupOnSave|insertBlankLinePadding|formatRazorComponents|runFormatDocument)$/;

describe('default settings parity', () => {
  it('the server defaults (CleanupSettingsDefaults.cs) are the TypeScript defaults, key for key', () => {
    expect(serverDefaults()).toEqual(JSON.parse(JSON.stringify(engineDefaults)));
  });

  it('every codeJanitor.cleanup.* setting of package.json is either a known non-engine setting or has the default the engine uses', () => {
    const unmatched: string[] = [];
    for (const [key, setting] of Object.entries(manifestSettings())) {
      const name = key.replace(/^codeJanitor\.cleanup\./, '');
      if (name === key || NOT_ENGINE_SETTINGS.test(name)) {
        continue;
      }

      const targets = RENAMED[name] ?? [name];
      for (const target of targets) {
        if (!(target in engineDefaults)) {
          unmatched.push(`${key}: no engine setting ${target}`);
        } else if (JSON.stringify(setting.default) !== JSON.stringify(engineDefaults[target])) {
          unmatched.push(`${key}: package.json default ${JSON.stringify(setting.default)}, engine default ${JSON.stringify(engineDefaults[target])}`);
        }
      }
    }

    expect(unmatched).toEqual([]);
  });

  it('the per-kind padding flags that the group toggle does not drive default to what package.json declares', () => {
    const settings = manifestSettings();
    const paddingKeys = Object.keys(engineDefaults).filter((key) => key.startsWith('insertBlankLinePadding'));

    expect(
      paddingKeys.filter((key) => settings[`codeJanitor.cleanup.${key}`] && settings[`codeJanitor.cleanup.${key}`].default !== engineDefaults[key])
    ).toEqual([]);
  });

  it('the comment format settings of package.json default to the comment format of the engine', () => {
    const settings = manifestSettings();
    const defaults = createDefaultCommentFormatOptions() as unknown as Record<string, unknown>;
    const mismatched = Object.entries(defaults).filter(([name, value]) => {
      const declared = settings[`codeJanitor.formatting.comment${name[0].toUpperCase()}${name.slice(1)}`];

      return !declared || JSON.stringify(declared.default) !== JSON.stringify(value);
    });

    expect(mismatched.map(([name]) => name)).toEqual([]);
    expect(engineDefaults.commentFormat).toEqual(defaults);
  });
});

describe('manifest settings', () => {
  it('keep the AI provider and endpoint settings out of the workspace scope', () => {
    const settings = manifestSettings();
    const unscoped = Object.entries(settings)
      .filter(([key]) => /^codeJanitor\.ai\.(provider|copilotModel|customEndpointUrl|customApiKeyHeader|customModel|xmlDoc\.runDuringCleanup)$/.test(key))
      .filter(([, setting]) => setting.scope !== 'application' && setting.scope !== 'machine')
      .map(([key]) => key);

    expect(unscoped).toEqual([]);
  });

  it('do not let a workspace choose the dotnet executable', () => {
    expect(manifestSettings()['codeJanitor.dotnetPath'].scope).toBe('machine');
  });

  it('do not let a workspace choose the commands cleanup executes', () => {
    expect(manifestSettings()['codeJanitor.thirdParty.otherCleaningCommands'].scope).toBe('application');
  });

  it('declare for the coverage target the minimum the command enforces', () => {
    expect(manifestSettings()['codeJanitor.ai.tests.targetCoveragePercentage']).toMatchObject({ minimum: 10, maximum: 100 });
  });
});
