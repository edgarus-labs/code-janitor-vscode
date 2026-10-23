import { describe, expect, it } from 'vitest';
import { XmlDocTargetResult } from '../src/engine/protocol';
import { insertXmlDocumentation } from '../src/engine/xmlDoc';

const NONE = {
  parameters: [],
  typeParameters: [],
  returnType: null,
  containingType: null,
  exceptions: [],
  accessors: null,
  baseTypes: [],
  members: [],
  modifiers: [],
  body: '',
};

function target(insertionLine: number): XmlDocTargetResult {
  return { ...NONE, name: 'M', kind: 'method', text: '', insertionLine, indent: '', signature: 'void M()' };
}

const BLOCK = ['/// <summary>', '/// Runs it.', '/// </summary>'];

describe('insertXmlDocumentation line breaks', () => {
  it('writes the block with the line break of the line it lands before, in a file of mixed line breaks', () => {
    const source = 'a\r\nb\nvoid M() { }\r\nvoid N() { }\nc';

    const output = insertXmlDocumentation(source, [target(2), target(3)], { 0: 'Runs it', 1: 'Runs it' });

    expect(output).toBe(`a\r\nb\n${BLOCK.join('\r\n')}\r\nvoid M() { }\r\n${BLOCK.join('\n')}\nvoid N() { }\nc`);
  });

  it('counts a lone carriage return, NEL, line separator and paragraph separator as line breaks, like the server', () => {
    for (const separator of ['\r', '\u0085', '\u2028', '\u2029']) {
      const output = insertXmlDocumentation(`x${separator}void M() { }`, [target(1)], { 0: 'Runs it' });

      expect(output).toBe(`x${separator}${BLOCK.join(separator)}${separator}void M() { }`);
    }
  });

  it('keeps a byte order mark at the start of the file when documenting its first line', () => {
    const output = insertXmlDocumentation('\uFEFFvoid M() { }\r\n', [target(0)], { 0: 'Runs it' });

    expect(output).toBe(`\uFEFF${BLOCK.join('\r\n')}\r\nvoid M() { }\r\n`);
  });

  it('appends a block after the last line using the file line break', () => {
    const output = insertXmlDocumentation('void M() { }\r\n', [target(1)], { 0: 'Runs it' });

    expect(output).toBe(`void M() { }\r\n${BLOCK.join('\r\n')}\r\n`);
  });

  it('keeps a summary with NEL, line or paragraph separators, CR, LF or other control characters on one summary line', () => {
    const hostile = [
      'Does it.\u0085static C() { System.Console.WriteLine(1); } //',
      'Does\u2028it',
      'Does\u2029it',
      'Does\rit',
      'Does\nit',
      'Does\u0000it',
      'Does\u001Bit',
      'Does\u007Fit',
      'Does\u009Fit',
    ];

    for (const summary of hostile) {
      const output = insertXmlDocumentation('void M() { }\n', [target(0)], { 0: summary });
      const lines = output.split(/\r\n|[\r\n\u0085\u2028\u2029]/);

      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('/// <summary>');
      expect(lines[1]).toMatch(/^\/\/\/ \S/);
      expect(lines[1]).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      expect(lines[2]).toBe('/// </summary>');
      expect(lines[3]).toBe('void M() { }');
    }
  });
});
