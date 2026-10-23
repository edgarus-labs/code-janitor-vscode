import { describe, expect, it } from 'vitest';
import { createDefaultReorganizeSettings } from '../src/cleanup/reorganizeSettings';
import {
  SpadeDisplayOptions,
  SpadeNode,
  SpadeTreeOptions,
  Structure,
  StructureItem,
  buildSpadeTree,
  describeSpadeNode,
  dropPlan,
  memberParent,
  spadeNodeAtLine,
} from '../src/spade/spadeModel';

function item(kind: string, name: string, startLine: number, endLine: number, extra: Partial<StructureItem> = {}): StructureItem {
  return {
    kind,
    name,
    access: 'public',
    modifiers: [],
    returnType: null,
    parameters: [],
    typeParameters: [],
    baseTypes: [],
    startLine,
    endLine,
    complexity: null,
    accessors: [],
    children: [],
    ...extra,
  };
}

/**
 * namespace N { public class Sample : IDisposable { #region Fields  private static readonly int count;  #endregion
 * public Sample() { }  public int Zed(int x, int y) { }  public string Name { get; }  private static void Clear() { }
 * public int Add(int x, int y) => x + y; public string this[int index] => ""; } }
 */
const STRUCTURE: Structure = {
  items: [
    item('namespace', 'N', 0, 32, {
      access: null,
      children: [
        item('class', 'Sample', 2, 31, {
          baseTypes: ['IDisposable'],
          children: [
            item('field', 'count', 6, 6, { access: 'private', modifiers: ['private', 'static', 'readonly'], returnType: 'int' }),
            item('constructor', 'Sample', 10, 12, { modifiers: ['public'], complexity: 1 }),
            item('method', 'Zed', 14, 17, {
              modifiers: ['public', 'virtual'],
              returnType: 'int',
              parameters: [
                { name: 'x', type: 'int' },
                { name: 'y', type: 'int' },
              ],
              complexity: 12,
            }),
            item('property', 'Name', 19, 19, { modifiers: ['public'], returnType: 'string', complexity: 1 }),
            item('method', 'Clear', 21, 22, { access: 'private', modifiers: ['private', 'static'], returnType: 'void', complexity: 16 }),
            item('method', 'Add', 24, 24, { modifiers: ['public'], returnType: 'int', complexity: 1 }),
            item('indexer', 'this[]', 26, 26, { modifiers: ['public'], returnType: 'string', parameters: [{ name: 'index', type: 'int' }], complexity: 1 }),
          ],
        }),
      ],
    }),
  ],
  regions: [{ name: 'Fields', startLine: 4, endLine: 8, children: [] }],
};

function options(overrides: Partial<SpadeTreeOptions> = {}): SpadeTreeOptions {
  const reorganize = createDefaultReorganizeSettings();

  return {
    sortOrder: 'file',
    secondarySortTypeByName: false,
    memberTypes: reorganize.memberTypes,
    primaryOrderByAccessLevel: reorganize.primaryOrderByAccessLevel,
    reverseOrderByAccessLevel: reorganize.reverseOrderByAccessLevel,
    filter: '',
    ...overrides,
  };
}

const DISPLAY: SpadeDisplayOptions = {
  showItemMetadata: true,
  showItemTypes: true,
  showMethodParameters: true,
  showItemComplexity: true,
  complexityWarningThreshold: 10,
  complexityAlertThreshold: 15,
};

function names(nodes: readonly SpadeNode[]): string[] {
  return nodes.map((node) => node.name);
}

function sample(roots: readonly SpadeNode[]): SpadeNode {
  return roots[0].children[0];
}

describe('buildSpadeTree', () => {
  it('nests the members in file order, with the regions around the members they hold', () => {
    const roots = buildSpadeTree(STRUCTURE, options());

    expect(names(roots)).toEqual(['N']);
    expect(roots[0].contextValue).toBe('namespace');
    expect(sample(roots).contextValue).toBe('type');
    expect(names(sample(roots).children)).toEqual(['Fields', 'Sample', 'Zed', 'Name', 'Clear', 'Add', 'this[]']);
    const region = sample(roots).children[0];
    expect(region.contextValue).toBe('region');
    expect([region.startLine, region.endLine]).toEqual([4, 8]);
    expect(names(region.children)).toEqual(['count']);
    expect(region.children[0].contextValue).toBe('member');
    expect(region.children[0].parent).toBe(region);
  });

  it('drops the regions inside a member, and closes an unclosed region at the end of its parent', () => {
    const structure: Structure = {
      items: [item('class', 'C', 0, 10, { children: [item('method', 'M', 2, 7), item('field', 'f', 9, 9)] })],
      regions: [
        { name: 'Inside', startLine: 4, endLine: 6, children: [] },
        { name: 'Open', startLine: 8, endLine: null, children: [] },
      ],
    };

    const roots = buildSpadeTree(structure, options());

    expect(names(roots[0].children)).toEqual(['M', 'Open']);
    expect(names(roots[0].children[1].children)).toEqual(['f']);
  });

  it('gives siblings of the same name distinct, stable ids', () => {
    const structure: Structure = {
      items: [item('class', 'C', 0, 5, { children: [item('method', 'M', 1, 1), item('method', 'M', 2, 2)] })],
      regions: [],
    };

    const [first, second] = buildSpadeTree(structure, options())[0].children;

    expect(first.id).not.toBe(second.id);
    expect(buildSpadeTree(structure, options())[0].children[1].id).toBe(second.id);
  });

  it('sorts by type: the Reorganize kind order, then access level, in pseudo-groups named after the member types', () => {
    const roots = buildSpadeTree(STRUCTURE, options({ sortOrder: 'type' }));
    const type = sample(roots).children[0];

    expect(names(roots[0].children)).toEqual(['Classes']);
    expect(names(type.children)).toEqual(['Fields', 'Constructors', 'Properties', 'Indexers', 'Methods']);
    expect(type.children.map((group) => group.contextValue)).toEqual(['group', 'group', 'group', 'group', 'group']);
    expect(names(type.children[4].children)).toEqual(['Zed', 'Add', 'Clear']);
    expect(type.children[4].children[0].parent).toBe(type.children[4]);
  });

  it('sorts by type then by name with secondarySortTypeByName', () => {
    const type = sample(buildSpadeTree(STRUCTURE, options({ sortOrder: 'type', secondarySortTypeByName: true }))).children[0];

    expect(names(type.children[4].children)).toEqual(['Add', 'Zed', 'Clear']);
  });

  it('sorts by type with the access level first when the Reorganize settings say so', () => {
    const type = sample(buildSpadeTree(STRUCTURE, options({ sortOrder: 'type', primaryOrderByAccessLevel: true }))).children[0];

    expect(names(type.children)).toEqual(['Constructors', 'Properties', 'Indexers', 'Methods', 'Fields', 'Methods']);
  });

  it('sorts alphabetically, ignoring case, without regions', () => {
    const alphabetical = sample(buildSpadeTree(STRUCTURE, options({ sortOrder: 'alphabetical' })));

    expect(names(alphabetical.children)).toEqual(['Add', 'Clear', 'count', 'Name', 'Sample', 'this[]', 'Zed']);
  });

  it('keeps the items whose name holds the filter, ignoring case, and their parents', () => {
    const roots = buildSpadeTree(STRUCTURE, options({ filter: 'AD' }));

    expect(names(roots)).toEqual(['N']);
    expect(names(sample(roots).children)).toEqual(['Add']);
    expect(buildSpadeTree(STRUCTURE, options({ filter: 'nothing like it' }))).toEqual([]);
  });
});

describe('describeSpadeNode', () => {
  const roots = buildSpadeTree(STRUCTURE, options());
  const byName = (name: string) => sample(roots).children.find((node) => node.name === name)!;

  it('shows the parameters and the type in the label, the metadata and the complexity in the description', () => {
    const zed = describeSpadeNode(byName('Zed'), DISPLAY);

    expect(zed.label).toBe('Zed(int x, int y) : int');
    expect(zed.description).toBe('v  12');
    expect(zed.complexity).toBe('warning');
    expect(zed.icon).toBe('symbol-method');
    expect(zed.tooltip).toContain('public virtual int Zed(int x, int y)');
    expect(zed.tooltip).toContain('Complexity: 12');
    expect(describeSpadeNode(byName('Clear'), DISPLAY).complexity).toBe('alert');
    expect(describeSpadeNode(byName('Add'), DISPLAY).complexity).toBe('none');
  });

  it('follows the show settings', () => {
    const zed = byName('Zed');

    expect(describeSpadeNode(zed, { ...DISPLAY, showMethodParameters: false }).label).toBe('Zed : int');
    expect(describeSpadeNode(zed, { ...DISPLAY, showItemTypes: false }).label).toBe('Zed(int x, int y)');
    expect(describeSpadeNode(zed, { ...DISPLAY, showItemMetadata: false }).description).toBe('12');
    expect(describeSpadeNode(zed, { ...DISPLAY, showItemComplexity: false }).description).toBe('v');
    expect(describeSpadeNode(zed, { ...DISPLAY, showItemComplexity: false }).complexity).toBe('none');
  });

  it('labels indexers with brackets, types with their base types and fields with static and read-only', () => {
    expect(describeSpadeNode(byName('this[]'), DISPLAY).label).toBe('this[int index] : string');
    expect(describeSpadeNode(sample(roots), DISPLAY).label).toBe('Sample : IDisposable');
    expect(describeSpadeNode(sample(roots).children[0].children[0], DISPLAY).description).toBe('s, ro');
    expect(describeSpadeNode(sample(roots).children[0], DISPLAY).icon).toBe('folder');
  });
});

describe('spadeNodeAtLine', () => {
  const roots = buildSpadeTree(STRUCTURE, options());

  it('finds the innermost node holding a line', () => {
    expect(spadeNodeAtLine(roots, 15)?.name).toBe('Zed');
    expect(spadeNodeAtLine(roots, 6)?.name).toBe('count');
    expect(spadeNodeAtLine(roots, 3)?.name).toBe('Sample');
    expect(spadeNodeAtLine(roots, 40)).toBeUndefined();
  });

  it('finds the member under a line inside the pseudo-groups of the sort by type, never a group', () => {
    const grouped = buildSpadeTree(STRUCTURE, options({ sortOrder: 'type' }));

    expect(spadeNodeAtLine(grouped, 15)?.name).toBe('Zed');
    expect(spadeNodeAtLine(grouped, 21)?.name).toBe('Clear');
    expect(spadeNodeAtLine(grouped, 24)?.name).toBe('Add');
    expect(spadeNodeAtLine(grouped, 6)?.name).toBe('count');
    expect(spadeNodeAtLine(grouped, 5)).toMatchObject({ name: 'Sample', contextValue: 'type' });
  });
});

describe('dropPlan', () => {
  const roots = buildSpadeTree(STRUCTURE, options());
  const type = sample(roots);
  const count = type.children[0].children[0];
  const zed = type.children[2];

  it('moves a member after a later sibling and before an earlier one, whatever region it is in', () => {
    expect(memberParent(count)).toBe(type);
    expect(dropPlan(count, zed)).toEqual({ line: 6, name: 'count', targetLine: 14, targetName: 'Zed', position: 'after' });
    expect(dropPlan(zed, count)).toEqual({ line: 14, name: 'Zed', targetLine: 6, targetName: 'count', position: 'before' });
  });

  it('refuses members of different parents, regions and the member itself', () => {
    expect(dropPlan(zed, type)).toBe("'Zed' can only be moved among the members of 'Sample'.");
    expect(dropPlan(zed, type.children[0])).toBe("'Zed' can only be dropped on a member.");
    expect(dropPlan(zed, zed)).toBeUndefined();
  });
});

describe('dropPlan in the type sort order', () => {
  const twoClasses: Structure = {
    items: [
      item('class', 'A', 1, 9, { children: [item('method', 'One', 3, 4), item('method', 'Two', 6, 7)] }),
      item('class', 'B', 11, 19, { children: [item('method', 'Three', 13, 14)] }),
    ],
    regions: [],
  };
  const roots = buildSpadeTree(twoClasses, options({ sortOrder: 'type' }));
  const [classA, classB] = roots;
  const find = (type: SpadeNode, name: string): SpadeNode => type.children.flatMap((group) => group.children).find((node) => node.name === name)!;

  it('resolves the owning type past the pseudo-groups', () => {
    expect(memberParent(find(classA, 'One'))).toBe(classA);
    expect(memberParent(find(classB, 'Three'))).toBe(classB);
  });

  it('refuses a drop between members of different types and allows one within a type', () => {
    expect(dropPlan(find(classA, 'One'), find(classB, 'Three'))).toBe("'One' can only be moved among the members of 'A'.");
    expect(dropPlan(find(classA, 'One'), find(classA, 'Two'))).toMatchObject({ name: 'One', targetName: 'Two' });
  });

  it('refuses a drop between types of different namespaces', () => {
    const namespaces = buildSpadeTree(
      {
        items: [
          item('namespace', 'N1', 0, 9, { access: null, children: [item('class', 'A', 1, 8)] }),
          item('namespace', 'N2', 10, 19, { access: null, children: [item('class', 'B', 11, 18)] }),
        ],
        regions: [],
      },
      options({ sortOrder: 'type' })
    );
    const a = namespaces[0].children[0].children[0];
    const b = namespaces[1].children[0].children[0];

    expect(dropPlan(a, b)).toBe("'A' can only be moved among the members of 'N1'.");
  });
});
