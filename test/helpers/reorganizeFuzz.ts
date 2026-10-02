import { CleanupSettings, createDefaultSettings } from '../../src/cleanup/types';
import { MEMBER_TYPE_KEYS, ReorganizeSettings, createDefaultReorganizeSettings } from '../../src/reorganize/settings';
import { withoutPadding } from './padding';

/** A small deterministic generator, so a failing case can be reproduced from its seed. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', '_zeta', '_eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu'];
const ACCESS = ['public', 'private', 'protected', 'internal', 'protected internal', 'private protected', ''];

interface GeneratedFile {
  source: string;
  /** Whether it has preprocessor conditionals or pragmas (the file is then only reorganized on 'yes'). */
  hasDirectives: boolean;
}

/** A class (or struct/interface) with a random mix of members, comments, blank lines, regions and directives. */
export function generateFile(random: Random, allowDirectives: boolean): GeneratedFile {
  let hasDirectives = false;
  const newline = random.chance(0.3) ? '\r\n' : '\n';
  const indent = random.chance(0.2) ? '\t' : '    ';
  const used = new Set<string>();

  const name = (): string => {
    const base = random.pick(NAMES);
    // Overloads are fine for methods, but keep other names unique so the file compiles.
    let candidate = base;
    for (let i = 2; used.has(candidate); i++) {
      candidate = `${base}${i}`;
    }
    used.add(candidate);

    return candidate;
  };

  const initializer = (): string =>
    random.pick(['', '', ' = 1', ' = 2', ' = Compute()', ' = new System.Collections.Generic.List<int>()', ` = ${random.pick(NAMES)}X + 1`]);

  const member = (level: number): string[] => {
    const pad = indent.repeat(level);
    const access = random.pick(ACCESS);
    const prefix = access ? `${access} ` : '';
    const isStatic = random.chance(0.3) ? 'static ' : '';
    const lines: string[] = [];

    if (random.chance(0.25)) {
      lines.push(`${pad}/// <summary>Documents it.</summary>`);
    }
    if (random.chance(0.1)) {
      lines.push(`${pad}// a note`);
    }
    if (random.chance(0.1)) {
      lines.push(`${pad}[System.Obsolete]`);
    }

    const n = name();
    switch (random.int(9)) {
      case 0:
        lines.push(`${pad}${prefix}${isStatic}${random.chance(0.3) ? 'readonly ' : ''}int ${n}X${initializer()};`);
        break;
      case 1:
        lines.push(`${pad}${prefix}${isStatic}void ${n}() { }`);
        break;
      case 2:
        lines.push(`${pad}${prefix}${isStatic}int ${n}()`, `${pad}{`, `${pad}${indent}return 1;`, `${pad}}`);
        break;
      case 3:
        lines.push(`${pad}${prefix}${isStatic}int ${n} { get; set; }${random.chance(0.2) ? ' = 5;' : ''}`);
        break;
      case 4:
        lines.push(`${pad}${prefix}${isStatic}int ${n}`, `${pad}{`, `${pad}${indent}get { return 1; }`, `${pad}}`);
        break;
      case 5:
        lines.push(`${pad}${prefix}${isStatic}event System.Action ${n};`);
        break;
      case 6:
        if (random.chance(0.5) && level < 3) {
          lines.push(`${pad}${prefix}${random.pick(['class', 'struct', 'interface'])} ${n}Nested`, `${pad}{`);
          block(level + 1, 1);
          lines.push(`${pad}}`);
        } else {
          lines.push(`${pad}${prefix}class ${n}Nested`, `${pad}{`, `${pad}${indent}void Z() { }`, `${pad}${indent}int _a;`, `${pad}}`);
        }
        break;
      case 7:
        lines.push(`${pad}${prefix}${isStatic}const int ${n}K = 1;`);
        break;
      default:
        lines.push(`${pad}${prefix}enum ${n}E { B, A }`);
    }

    if (random.chance(0.15)) {
      lines[lines.length - 1] += ' // trailing';
    }

    return lines;
  };

  const lines: string[] = [];
  const blank = (): void => {
    const count = random.pick([0, 0, 0, 1, 1, 2]);
    for (let i = 0; i < count; i++) {
      lines.push('');
    }
  };

  const block = (level: number, depth: number): void => {
    const count = 1 + random.int(6);
    for (let i = 0; i < count; i++) {
      blank();
      const roll = random.next();
      if (roll < 0.12 && depth < 2) {
        const pad = indent.repeat(level);
        lines.push(`${pad}#region ${random.pick(['Fields', 'Methods', 'Helpers', 'Stuff', 'Private Methods'])}`);
        block(level, depth + 1);
        lines.push(`${pad}#endregion${random.chance(0.5) ? ' X' : ''}`);
      } else if (roll < 0.2 && allowDirectives) {
        hasDirectives = true;
        lines.push('#if FLAG', ...member(level), ...(random.chance(0.3) ? ['#else', ...member(level)] : []), '#endif');
      } else if (roll < 0.25 && allowDirectives) {
        hasDirectives = true;
        lines.push(`${indent.repeat(level)}#pragma warning disable CS0169`, ...member(level));
      } else if (roll < 0.3) {
        lines.push(`${indent.repeat(level)}// ---- a floating comment ----`, '');
      } else {
        lines.push(...member(level));
      }
    }
  };

  const shape = random.pick(['type', 'type', 'namespace', 'fileScoped']);
  const typeAt = (level: number): void => {
    const pad = indent.repeat(level);
    if (random.chance(0.15)) {
      lines.push('', `${pad}public delegate void ${name()}D();`);
    } else if (random.chance(0.15)) {
      lines.push('', `${pad}public enum ${name()}E { B, A }`);
    } else {
      lines.push('', `${pad}${random.pick(['public ', 'internal ', ''])}${random.pick(['class', 'class', 'struct', 'interface'])} ${name()}T`, `${pad}{`);
      block(level + 1, 0);
      lines.push(`${pad}}`);
    }
  };

  if (shape === 'type') {
    lines.push(`${random.pick(['class', 'class', 'struct'])} C`, '{');
    block(1, 0);
    lines.push('}');
  } else if (shape === 'namespace') {
    lines.push('namespace N', '{');
    for (let i = 0, count = 1 + random.int(4); i < count; i++) {
      typeAt(1);
    }
    lines.push('}');
  } else {
    lines.push('namespace N;');
    for (let i = 0, count = 1 + random.int(4); i < count; i++) {
      typeAt(0);
    }
  }

  return { source: lines.join(newline) + newline, hasDirectives };
}

export function randomReorganizeSettings(random: Random): ReorganizeSettings {
  const settings = createDefaultReorganizeSettings();
  settings.alphabetizeMembersOfTheSameGroup = random.chance(0.7);
  settings.explicitMembersAtEnd = random.chance(0.3);
  settings.keepMembersWithinRegions = random.chance(0.6);
  settings.primaryOrderByAccessLevel = random.chance(0.3);
  settings.reverseOrderByAccessLevel = random.chance(0.3);
  settings.regionsIncludeAccessLevel = random.chance(0.3);
  settings.regionsIncludeAccessLevelForMethodsOnly = random.chance(0.3);
  settings.regionsInsertKeepEvenIfEmpty = random.chance(0.2);
  settings.regionsInsertNewRegions = random.chance(0.4);
  settings.regionsRemoveExistingRegions = random.chance(0.4);
  settings.performWhenPreprocessorConditionals = 'yes';

  if (random.chance(0.5)) {
    const orders = MEMBER_TYPE_KEYS.map((_, index) => index + 1);
    for (let i = orders.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [orders[i], orders[j]] = [orders[j], orders[i]];
    }
    MEMBER_TYPE_KEYS.forEach((key, index) => {
      // Sometimes two member types share an order (they then form one group).
      settings.memberTypes[key] = { order: random.chance(0.1) ? 1 : orders[index], name: settings.memberTypes[key].name };
    });
  }

  return settings;
}

export function randomCleanupSettings(random: Random): CleanupSettings {
  const settings = random.chance(0.5) ? createDefaultSettings() : withoutPadding();
  settings.updateEndRegionDirectives = random.chance(0.5);

  return settings;
}
