import { EditorConfigProperties, EditorConfigSeverity, isEnforced, resolveDiagnosticSeverity } from '../editorconfig';
import { applyEdits, TextEdit } from '../parser';
import { findApplicableRule, NamingRule, parseNamingRules } from '../naming/namingRules';
import { planRename } from '../naming/renamer';
import { buildSourceModel, DeclaredSymbol, SourceModel } from '../naming/sourceModel';
import { Node } from '../syntax/node';
import { SourceTransformation } from '../types';

const NAMING_DIAGNOSTIC_ID = 'IDE1006';

/** Safety net: every pass that edits fixes at least one violation, so this is not reached in practice. */
const MAX_PASSES = 500;

interface Violation {
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
export function createEditorConfigNamingConverter(
  props: EditorConfigProperties,
  report: (issue: string) => void
): SourceTransformation {
  const rules = parseNamingRules(props);

  return {
    name: 'Apply .editorconfig naming rules',
    apply: (source) => (rules.length === 0 || !source ? source : applyNamingRules(source, rules, props, report)),
  };
}

function applyNamingRules(
  source: string,
  rules: readonly NamingRule[],
  props: EditorConfigProperties,
  report: (issue: string) => void
): string {
  let current = source;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const model = buildSourceModel(current);
    const violations = findViolations(model, rules, props);
    if (violations.length === 0) {
      return current;
    }

    const targets = new Map(violations.map((violation) => [violation.symbol, violation.newName]));
    const targetName = (symbol: DeclaredSymbol) => targets.get(symbol);
    const accepted: Footprint[] = [];
    const edits: TextEdit[] = [];
    const unresolved: string[] = [];

    for (const violation of violations) {
      const plan = violation.rule.style.isCompliant(violation.newName)
        ? planRename(model, violation.symbol, violation.newName, targetName)
        : { ok: false as const, reason: 'no compliant name can be derived' };
      if (!plan.ok) {
        unresolved.push(describe(violation, plan.reason));
        continue;
      }

      // Renames with disjoint names or disjoint scopes commute; the rest are retried on the
      // renamed source, where they are checked again against the names already applied.
      const footprint: Footprint = { names: [violation.symbol.name, violation.newName], scopes: plan.scopes };
      if (accepted.some((other) => conflicts(other, footprint))) {
        continue;
      }

      accepted.push(footprint);
      edits.push(...plan.edits);
    }

    if (edits.length === 0) {
      unresolved.forEach((issue) => report(issue));

      return current;
    }

    current = applyEdits(current, edits);
  }

  for (const violation of findViolations(buildSourceModel(current), rules, props)) {
    report(describe(violation, 'the file needs more renames than one cleanup makes'));
  }

  return current;
}

interface Footprint {
  readonly names: readonly string[];
  readonly scopes: readonly Node[];
}

function conflicts(a: Footprint, b: Footprint): boolean {
  return (
    a.names.some((name) => b.names.includes(name)) &&
    a.scopes.some((x) => b.scopes.some((y) => x.startIndex < y.endIndex && y.startIndex < x.endIndex))
  );
}

function findViolations(model: SourceModel, rules: readonly NamingRule[], props: EditorConfigProperties): Violation[] {
  const violations: Violation[] = [];

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

/** Roslyn skips `_`, `_1`, ... (discards and discard-like names). */
function isDiscardName(name: string): boolean {
  return /^_\d*$/.test(name);
}

function describe(violation: Violation, reason: string): string {
  const { symbol, rule, severity, newName } = violation;
  const line = symbol.nameNode.startPosition.row + 1;
  const kind = symbol.kind.replace('_', ' ');

  return (
    `${NAMING_DIAGNOSTIC_ID} (naming rule '${rule.title}', ${severity}) line ${line}: ` +
    `${kind} '${symbol.name}' should be named '${newName}'; not renamed because ${reason}.`
  );
}
