import { EditorConfigProperties, EditorConfigSeverity, isEnforced, resolveDiagnosticSeverity } from '../editorconfig';
import { applyEdits, TextEdit } from '../parser';
import { findApplicableRule, NamingRule, parseNamingRules } from '../naming/namingRules';
import { planRename } from '../naming/renamer';
import { buildSourceModel, DeclaredSymbol, SourceModel } from '../naming/sourceModel';
import { Node } from '../syntax/node';
import { SourceTransformation } from '../types';
import { EditorConfigIssueReporter } from './editorConfigSupport';

const NAMING_DIAGNOSTIC_ID = 'IDE1006';

/** Safety net: every pass that edits fixes at least one violation, so this is not reached in practice. */
const MAX_PASSES = 500;

export interface NamingViolation {
  readonly symbol: DeclaredSymbol;
  readonly rule: NamingRule;
  readonly severity: EditorConfigSeverity;
  readonly newName: string;
}

/**
 * Renames C# symbols that violate the `.editorconfig` naming rules (IDE1006) whose effective
 * severity is `suggestion`, `warning` or `error`, computing the new name exactly as Roslyn's naming
 * code fix does. Only renames that are provably safe within the file are applied: private members,
 * locals, local functions, parameters of private methods, local functions and lambdas, and type
 * parameters. Every violation left in place is passed to `report` with the reason.
 */
export function createEditorConfigNamingConverter(props: EditorConfigProperties, report: EditorConfigIssueReporter): SourceTransformation {
  const rules = parseNamingRules(props);

  return {
    name: 'Apply .editorconfig naming rules',
    diagnosticId: NAMING_DIAGNOSTIC_ID,
    apply: (source) => (rules.length === 0 || !source ? source : applyNamingRules(source, rules, props, report)),
  };
}

function applyNamingRules(
  source: string,
  rules: readonly NamingRule[],
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter
): string {
  let current = source;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const model = buildSourceModel(current);
    const violations = findNamingViolations(model, rules, props);
    if (violations.length === 0) {
      return current;
    }

    const targets = new Map(violations.map((violation) => [violation.symbol, violation.newName]));
    const targetName = (symbol: DeclaredSymbol) => targets.get(symbol);
    // Scopes of the accepted renames, by the old and new names they touch.
    const acceptedScopes = new Map<string, Node[]>();
    const edits: TextEdit[] = [];
    const unresolved: { readonly violation: NamingViolation; readonly reason: string }[] = [];

    for (const violation of violations) {
      const plan = violation.rule.style.isCompliant(violation.newName)
        ? planRename(model, violation.symbol, violation.newName, targetName)
        : { ok: false as const, reason: 'no compliant name can be derived' };
      if (!plan.ok) {
        unresolved.push({ violation, reason: plan.reason });
        continue;
      }

      // Renames with disjoint names or disjoint scopes commute; the rest are retried on the
      // renamed source, where they are checked again against the names already applied.
      const names = [violation.symbol.name, violation.newName];
      const overlaps = names.some((name) =>
        (acceptedScopes.get(name) ?? []).some((x) => plan.scopes.some((y) => x.startIndex < y.endIndex && y.startIndex < x.endIndex))
      );
      if (overlaps) {
        continue;
      }

      for (const name of names) {
        const scopes = acceptedScopes.get(name);
        if (scopes) {
          scopes.push(...plan.scopes);
        } else {
          acceptedScopes.set(name, [...plan.scopes]);
        }
      }

      edits.push(...plan.edits);
    }

    if (edits.length === 0) {
      unresolved.forEach(({ violation, reason }) => reportViolation(report, violation, reason));

      return current;
    }

    current = applyEdits(current, edits);
  }

  for (const violation of findNamingViolations(buildSourceModel(current), rules, props)) {
    reportViolation(report, violation, 'the file needs more renames than one cleanup makes');
  }

  return current;
}

export function findNamingViolations(model: SourceModel, rules: readonly NamingRule[], props: EditorConfigProperties): NamingViolation[] {
  const violations: NamingViolation[] = [];

  for (const symbol of model.symbols) {
    if (!symbol.analyzable || !symbol.name || isDiscardName(symbol.name)) {
      continue;
    }

    const rule = findApplicableRule(rules, symbol);
    if (!rule || rule.severity === 'none') {
      continue;
    }

    const severity = resolveDiagnosticSeverity(props, NAMING_DIAGNOSTIC_ID, rule.severity);
    if (!severity || !isEnforced(severity) || rule.style.isCompliant(symbol.name)) {
      continue;
    }

    violations.push({ symbol, rule, severity, newName: rule.style.makeCompliant(symbol.name) });
  }

  return violations;
}

function reportViolation(report: EditorConfigIssueReporter, violation: NamingViolation, reason: string): void {
  report(describeNamingViolation(violation, reason), isWorkspaceRenameCandidate(violation) ? violation.symbol.name : undefined);
}

/** Types and non-private members: other files may use them, so only a workspace-wide rename fixes them. */
export function isWorkspaceRenameCandidate(violation: NamingViolation): boolean {
  const symbol = violation.symbol;

  return symbol.category === 'type' || (symbol.category === 'member' && symbol.accessibility !== 'private');
}

/** Roslyn `IsSymbolWithSpecialDiscardName`: skips `_`, `_` followed by a uint (`_1`), and any run of `_` (`__`). */
function isDiscardName(name: string): boolean {
  return /^_+$/.test(name) || (/^_\d+$/.test(name) && Number(name.slice(1)) <= 0xffffffff);
}

/** `IDE1006 (naming rule '...', warning) line N: field 'x' should be named 'X'; not renamed because <reason>.` */
export function describeNamingViolation(violation: NamingViolation, reason: string, outcome = 'not renamed'): string {
  const { symbol, rule, severity, newName } = violation;
  const line = symbol.nameNode.startPosition.row + 1;
  const kind = symbol.kind.replace('_', ' ');

  return (
    `${NAMING_DIAGNOSTIC_ID} (naming rule '${rule.title}', ${severity}) line ${line}: ` +
    `${kind} '${symbol.name}' should be named '${newName}'; ${outcome} because ${reason}.`
  );
}
