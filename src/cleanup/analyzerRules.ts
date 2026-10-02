/**
 * What the .NET SDK decides about the analyzer rules cleanup implements when no configuration file
 * sets their severity: the code-quality (CA) rules' category and default severity (each rule's
 * page, "Enabled by default in .NET 10"), and the rule sets `AnalysisLevel`/`AnalysisMode` select.
 *
 * The rule sets are copied from the .NET SDK 10.0.112 analysis-level global configs:
 * `sdk/<version>/Sdks/Microsoft.NET.Sdk/analyzers/build/config/analysislevel_<level>_<mode>.globalconfig`
 * for CA rules and `.../codestyle/cs/build/config/analysislevelstyle_<mode>.globalconfig` for IDE
 * rules. https://learn.microsoft.com/dotnet/fundamentals/code-analysis/overview#enable-additional-rules
 */

export type AnalysisMode = 'none' | 'default' | 'minimum' | 'recommended' | 'all';

/** The first and the last analysis level the SDK ships CA rule sets for (the last is `preview`). */
export const FIRST_ANALYSIS_LEVEL = 5;
export const LATEST_ANALYSIS_LEVEL = 10;
export const PREVIEW_ANALYSIS_LEVEL = 11;

export interface QualityRule {
  readonly category: 'Globalization' | 'Maintainability' | 'Performance' | 'Reliability' | 'Usage';
  /** Severity where the .NET analyzers run and nothing configures the rule. */
  readonly defaultSeverity: 'suggestion' | 'none';
  /**
   * The severity each rule set gives the rule, per mode (`none default minimum recommended all`)
   * and analysis level (5 to 11, one character each): `n` none, `w` warning, `-` not set.
   */
  readonly ruleSets: string;
  /** `dotnet_code_quality.*` options the rule reads. */
  readonly options?: readonly string[];
}

const qualityOption = (diagnosticId: string, category: string, option: string): string[] => [
  `dotnet_code_quality.${option}`,
  `dotnet_code_quality.${category}.${option}`,
  `dotnet_code_quality.${diagnosticId}.${option}`,
];

const rule = (category: QualityRule['category'], defaultSeverity: QualityRule['defaultSeverity'], ruleSets: string): QualityRule => ({
  category,
  defaultSeverity,
  ruleSets,
});

export const QUALITY_RULES_METADATA: Readonly<Record<string, QualityRule>> = {
  CA1305: rule('Globalization', 'none', 'nnnnnnn ------- ------- wwwwwww wwwwwww'),
  CA1307: rule('Globalization', 'none', '------- ------- ------- ------- wwwwwww'),
  CA1310: rule('Globalization', 'none', 'nnnnnnn ------- ------- wwwwwww wwwwwww'),
  CA1507: rule('Maintainability', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1805: rule('Performance', 'none', 'nnnnnnn ------- ------- wwwwwww wwwwwww'),
  CA1822: {
    ...rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
    options: qualityOption('CA1822', 'Performance', 'api_surface'),
  },
  CA1825: rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1827: rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1828: rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1829: rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1834: rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1836: rule('Performance', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA1841: rule('Performance', 'suggestion', 'nnnnnnn n------ nwwwwww nwwwwww nwwwwww'),
  CA1847: rule('Performance', 'suggestion', 'nnnnnnn n------ nwwwwww nwwwwww nwwwwww'),
  CA1852: {
    ...rule('Performance', 'none', 'nnnnnnn nn----- nn----- nnwwwww nnwwwww'),
    options: qualityOption('CA1852', 'Performance', 'ignore_internalsvisibleto'),
  },
  CA1854: rule('Performance', 'suggestion', 'nnnnnnn nn----- nnwwwww nnwwwww nnwwwww'),
  CA1858: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1860: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1861: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1862: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1864: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1865: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1866: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1867: rule('Performance', 'none', '------- ------- ------- ------- ---wwww'),
  CA1868: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA1869: rule('Performance', 'suggestion', 'nnnnnnn nnn---- nnnwwww nnnwwww nnnwwww'),
  CA2016: rule('Reliability', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA2249: rule('Usage', 'suggestion', 'nnnnnnn ------- wwwwwww wwwwwww wwwwwww'),
  CA2263: rule('Usage', 'suggestion', 'nnnnnnn nnnn--- nnnnwww nnnnwww nnnnwww'),
};

const MODES: readonly AnalysisMode[] = ['none', 'default', 'minimum', 'recommended', 'all'];

/** The severity the SDK's CA rule set of `level` and `mode` gives the rule, if it sets one. */
export function qualityRuleSetSeverity(rule: QualityRule, level: number, mode: AnalysisMode): 'none' | 'warning' | undefined {
  if (level < FIRST_ANALYSIS_LEVEL || level > PREVIEW_ANALYSIS_LEVEL) {
    return undefined;
  }

  const flag = rule.ruleSets.split(' ')[MODES.indexOf(mode)]?.[level - FIRST_ANALYSIS_LEVEL];

  return flag === 'n' ? 'none' : flag === 'w' ? 'warning' : undefined;
}

const ideList = (numbers: string): ReadonlySet<string> => new Set(numbers.split(' ').map((number) => `IDE${number}`));

/** IDE rules the code-style rule sets make warnings (`Minimum`, `Recommended`, `All`). */
const STYLE_WARNINGS: Readonly<Record<'minimum' | 'recommended' | 'all', ReadonlySet<string>>> = {
  minimum: ideList('0005 0007 0008 0011 0036 0040 0043 0044 0051 0052 0055 0059 0060 0073 0076 0077 0080 0160 0161 0180'),
  recommended: ideList(
    '0005 0007 0008 0011 0016 0017 0018 0019 0020 0021 0022 0023 0024 0025 0026 0027 0028 0029 0030 0031 0032 0033 0034 0036 0039 0040 0042 0043 0044 0045 0046 0047 0051 0052 0053 0054 0055 0056 0057 0059 0060 0061 0062 0063 0065 0070 0071 0073 0074 0075 0076 0077 0078 0080 0082 0083 0090 0100 0110 0130 0160 0161 0170 0180 0200 0240 0241 0250 0251 0260 0270 0280 0290 0300 0301 0302 0303 0304 0305 0306 0320 0330 0340 0350 0360 1005 1006'
  ),
  all: ideList(
    '0004 0005 0007 0008 0010 0011 0016 0017 0018 0019 0020 0021 0022 0023 0024 0025 0026 0027 0028 0029 0030 0031 0032 0033 0034 0036 0037 0039 0040 0041 0042 0043 0044 0045 0046 0047 0048 0051 0052 0053 0054 0055 0056 0057 0058 0059 0060 0061 0062 0063 0064 0065 0066 0070 0071 0072 0073 0074 0075 0076 0077 0078 0080 0082 0083 0090 0100 0110 0120 0121 0130 0150 0160 0161 0170 0180 0200 0210 0211 0220 0230 0240 0241 0250 0251 0260 0270 0280 0290 0300 0301 0302 0303 0304 0305 0306 0320 0330 0340 0350 0360 1005 1006 2000 2001 2002 2003 2004 2005 2006'
  ),
};

/** IDE rules the `None` code-style rule set turns off, besides those of `All`. */
const STYLE_NONE_EXTRA = ideList('0009 0035');

/** The severity the SDK's code-style rule set of `mode` gives an IDE rule, if it sets one. */
export function styleRuleSetSeverity(diagnosticId: string, mode: AnalysisMode): 'none' | 'warning' | undefined {
  if (mode === 'none') {
    return STYLE_WARNINGS.all.has(diagnosticId) || STYLE_NONE_EXTRA.has(diagnosticId) ? 'none' : undefined;
  }

  return mode !== 'default' && STYLE_WARNINGS[mode].has(diagnosticId) ? 'warning' : undefined;
}
