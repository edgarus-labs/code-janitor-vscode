import { describe, expect, it } from 'vitest';
import { invalidNewName } from '../src/cleanup/naming/renamer';

describe('invalidNewName', () => {
  it('accepts a different, valid, non-keyword identifier', () => {
    expect(invalidNewName('Count', '_count')).toBeUndefined();
    expect(invalidNewName('x', 'Éclair')).toBeUndefined();
  });

  it('refuses to rename a contextual keyword', () => {
    expect(invalidNewName('var', 'Var')).toContain('contextual keyword');
  });

  it('refuses an empty or unchanged name', () => {
    expect(invalidNewName('Count', '')).toContain('no compliant name');
    expect(invalidNewName('Count', 'Count')).toContain('no compliant name');
  });

  it('refuses a name that is not a C# identifier', () => {
    expect(invalidNewName('Count', '1count')).toContain('not a valid C# identifier');
    expect(invalidNewName('Count', 'a-b')).toContain('not a valid C# identifier');
  });

  it('refuses a reserved keyword', () => {
    expect(invalidNewName('Class', 'class')).toContain('C# keyword');
    expect(invalidNewName('Params', 'params')).toContain('C# keyword');
  });
});
