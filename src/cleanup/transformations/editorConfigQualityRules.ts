import type { Rule } from './editorConfigCodeStyle';
import {
  applyArrayEmpty,
  applyCountPreferences,
  applyDefaultInitializers,
  applyNameOf,
  applyStringBuilderChar,
  applyStringCharOverloads,
  applyStringContains,
  applyUnnecessaryCasts,
  applyUnnecessaryUsings,
} from './editorConfigQualityRulesExpressions';
import { applyMarkMembersAsStatic, applyRemoveUnusedPrivateMembers, reportUnreadPrivateMembers } from './editorConfigQualityRulesMembers';
import { applySealInternalTypes } from './editorConfigQualityRulesSealing';

/**
 * The code-quality (CA) rules and the IDE rules without a code-style option that cleanup applies
 * while `dotnet_diagnostic.<ID>.severity` (else the category or global bulk severity) enforces
 * them. They run in the `.editorconfig` code-style stage (see `editorConfigCodeStyle.ts`). Each
 * rewrites only what the syntax proves and reports every violation it leaves.
 */
export const QUALITY_RULES: readonly Rule[] = [
  { option: 'IDE0005', apply: applyUnnecessaryUsings },
  { option: 'IDE0004', apply: applyUnnecessaryCasts },
  { option: 'CA1805', apply: applyDefaultInitializers },
  { option: 'CA1825', apply: applyArrayEmpty },
  { option: 'CA1827/CA1828/CA1829/CA1860', apply: applyCountPreferences },
  { option: 'CA1507', apply: applyNameOf },
  { option: 'CA1834', apply: applyStringBuilderChar },
  { option: 'CA1847/CA1865/CA1866/CA1867', apply: applyStringCharOverloads },
  { option: 'CA2249', apply: applyStringContains },
  // Unused members go first so that CA1822 does not change members about to be removed.
  { option: 'IDE0051', apply: applyRemoveUnusedPrivateMembers },
  { option: 'IDE0052', apply: reportUnreadPrivateMembers },
  { option: 'CA1822', apply: applyMarkMembersAsStatic },
  { option: 'CA1852', apply: applySealInternalTypes },
];

