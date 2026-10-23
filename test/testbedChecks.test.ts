import { describe, expect, it } from 'vitest';
import { Check, failure, selectScenarios } from './helpers/testbedChecks';

describe('testbed scenario checks', () => {
  it('fails a check whose type it does not know instead of treating it as satisfied', () => {
    const typo = { t: 'contain', s: 'class Clean' } as unknown as Check;

    expect(failure(typo, 'class Clean {}\n', [])).toBe('unknown check type "contain"');
  });
});

describe('testbed scenario selection (CODE_JANITOR_TESTBED_SCENARIOS)', () => {
  const scenarios = [
    { id: 'CsharpPreferBraces', settings: {}, codeStyle: { csharp_prefer_braces: 'true' } },
    { id: 'RemoveRegions', settings: { removeRegions: true }, codeStyle: {} },
    { id: 'ReorganizeExplicitMembersAtEnd', settings: { reorganize: { explicitMembersAtEnd: true } }, codeStyle: {} },
    { id: 'TrapPreprocessorBlocks', settings: { removeRegions: true, convertToVarWhenApparent: true }, codeStyle: {} },
  ];
  const ids = (filter: string | undefined): string[] => selectScenarios(scenarios, filter).map((scenario) => scenario.id);

  it('selects every scenario without a filter', () => {
    expect(ids(undefined)).toEqual(scenarios.map((scenario) => scenario.id));
    expect(ids(' ')).toEqual(scenarios.map((scenario) => scenario.id));
  });

  it('selects scenarios by id and by the option they turn on, Code Style and Reorganize options included', () => {
    expect(ids('CsharpPreferBraces')).toEqual(['CsharpPreferBraces']);
    expect(ids('removeRegions')).toEqual(['RemoveRegions', 'TrapPreprocessorBlocks']);
    expect(ids('csharp_prefer_braces, explicitMembersAtEnd')).toEqual(['CsharpPreferBraces', 'ReorganizeExplicitMembersAtEnd']);
  });

  it('fails on a name no scenario has instead of running nothing', () => {
    expect(() => selectScenarios(scenarios, 'CsharpPreferBraces,NoSuchOption')).toThrow(/NoSuchOption/);
  });
});
