import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function crlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

/** Applies `csharp_prefer_braces = true:warning` and returns the output and the reported issues. */
function brace(source: string): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: 'root = true\n[*.cs]\ncsharp_prefer_braces = true:warning\n' }], '/repo/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue)).apply(source);

  return { output, issues };
}

function method(...body: string[]): string {
  return lines('class C', '{', '    void M(bool x)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
}

describe('IDE0011 (csharp_prefer_braces) next to // comments', () => {
  it.each([
    ['LF', (text: string) => text],
    ['CRLF', crlf],
  ])('braces a statement followed by a trailing // comment (%s)', (_name, eol) => {
    const { output, issues } = brace(eol(method('if (x)', '    M(x); // trailing')));

    expect(output).toBe(eol(method('if (x)', '{', '    M(x); // trailing', '}')));
    expect(issues).toEqual([]);
  });

  it.each([
    ['LF', (text: string) => text],
    ['CRLF', crlf],
  ])('braces a statement whose header ends in a // comment (%s)', (_name, eol) => {
    const { output, issues } = brace(eol(method('if (x) // why', '    M(x);')));

    expect(output).toBe(eol(method('if (x) // why', '{', '    M(x);', '}')));
    expect(issues).toEqual([]);
  });

  it('braces the if branch when a comment sits between it and else', () => {
    const { output, issues } = brace(method('if (x)', '    M(x); // first', 'else', '    M(!x);'));

    expect(output).toBe(method('if (x)', '{', '    M(x); // first', '}', 'else', '{', '    M(!x);', '}'));
    expect(issues).toEqual([]);
  });

  it('braces the else branch when a comment sits between else and the statement', () => {
    const { output, issues } = brace(method('if (x)', '    M(x);', 'else // other', '    M(!x);'));

    expect(output).toBe(method('if (x)', '{', '    M(x);', '}', 'else // other', '{', '    M(!x);', '}'));
    expect(issues).toEqual([]);
  });

  it('still leaves a statement unbraced when a block comment runs past its line, and reports it', () => {
    const source = method('if (x)', '    M(x); /* runs', '    on */');
    const { output, issues } = brace(source);

    expect(output).toBe(source);
    expect(issues.join('\n')).toContain('IDE0011');
  });
});
