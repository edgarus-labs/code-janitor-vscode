import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectSettingSections } from '../src/commands/settingsUi';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

describe('collectSettingSections', () => {
  const sections = collectSettingSections(manifest);

  it('builds one group per configuration section, in declared order', () => {
    expect(sections.map((section) => section.title)).toEqual([
      'General',
      'Cleaning: File Types',
      'Cleaning: Usings and Namespaces',
      'Cleaning: Insert',
      'Cleaning: Remove',
      'Cleaning: Update',
      'Cleaning: Modern C#',
      'Cleaning: File Header',
      'Formatting',
      'AI: Provider',
      'AI: XML Documentation',
      'AI: Unit Tests',
    ]);
  });

  it('covers every declared setting exactly once', () => {
    const declared = manifest.contributes.configuration.flatMap((section: { properties: object }) =>
      Object.keys(section.properties)
    );
    const collected = sections.flatMap((section) => section.settings.map((setting) => setting.key));

    expect([...collected].sort()).toEqual([...declared].sort());
  });

  it('maps each JSON type onto an editor kind', () => {
    const byKey = new Map(sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting]));

    expect(byKey.get('codeJanitor.cleanup.onSave')?.kind).toBe('boolean');
    expect(byKey.get('codeJanitor.cleanup.fileHeaderCSharp')?.kind).toBe('string');
    expect(byKey.get('codeJanitor.ai.customTimeoutSeconds')?.kind).toBe('number');
    expect(byKey.get('codeJanitor.cleanup.exclude')?.kind).toBe('stringArray');
    expect(byKey.get('codeJanitor.ai.provider')?.kind).toBe('enum');
  });

  it('carries the enum choices and their descriptions', () => {
    const provider = sections
      .flatMap((section) => section.settings)
      .find((setting) => setting.key === 'codeJanitor.ai.provider');

    expect(provider?.options?.map((option) => option.value)).toEqual(['copilot', 'custom']);
    expect(provider?.options?.[0].description).toContain('Copilot');
  });

  it('keeps the declared defaults', () => {
    const byKey = new Map(sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting]));

    expect(byKey.get('codeJanitor.cleanup.removeRegions')?.defaultValue).toBe(true);
    expect(byKey.get('codeJanitor.cleanup.onSave')?.defaultValue).toBe(false);
    expect(byKey.get('codeJanitor.ai.xmlDoc.maxMembersPerFile')?.defaultValue).toBe(25);
    expect(byKey.get('codeJanitor.cleanup.exclude')?.defaultValue).toEqual([]);
  });

  it('derives readable labels from the setting keys', () => {
    const byKey = new Map(sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting]));

    expect(byKey.get('codeJanitor.cleanup.removeBlankLinesAtTop')?.label).toBe('Remove blank lines at top');
    expect(byKey.get('codeJanitor.ai.xmlDoc.maxMembersPerFile')?.label).toBe('Max members per file');
  });

  it('strips markdown markers from descriptions', () => {
    const removeRegions = sections
      .flatMap((section) => section.settings)
      .find((setting) => setting.key === 'codeJanitor.cleanup.removeRegions');

    expect(removeRegions?.description).toContain('#region');
    expect(removeRegions?.description).not.toContain('`');
  });

  it('accepts the legacy single-object configuration shape', () => {
    const sectionsFromObject = collectSettingSections({
      contributes: {
        configuration: {
          title: 'Legacy',
          properties: { 'codeJanitor.demo': { type: 'boolean', default: true, description: 'Demo.' } },
        },
      },
    });

    expect(sectionsFromObject).toHaveLength(1);
    expect(sectionsFromObject[0].settings[0].key).toBe('codeJanitor.demo');
  });

  it('returns nothing when there is no configuration', () => {
    expect(collectSettingSections({})).toEqual([]);
    expect(collectSettingSections(undefined)).toEqual([]);
  });
});
