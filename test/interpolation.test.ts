import { describe, expect, it } from 'vitest';
import { interpolationHoles, interpolationWritesName } from '../src/cleanup/transformations/interpolation';

describe('interpolationHoles', () => {
  it('returns the expression of each hole without its format or alignment', () => {
    expect(interpolationHoles('$"a {x} b {y + 1:D3} c {z,10} d {w,-5:N2}"')).toEqual(['x', 'y + 1', 'z,10', 'w,-5']);
  });

  it('keeps a conditional expression whole', () => {
    expect(interpolationHoles('$"{(a ? b : c)} {a ? b : c}"')).toEqual(['(a ? b : c)', 'a ? b ']);
  });

  it('skips doubled braces', () => {
    expect(interpolationHoles('$"{{literal}} {x} }}"')).toEqual(['x']);
  });

  it('reads verbatim and raw interpolated strings', () => {
    expect(interpolationHoles('$@"line {x}\n""q"" {y}"')).toEqual(['x', 'y']);
    expect(interpolationHoles('@$"{x}"')).toEqual(['x']);
    expect(interpolationHoles('$"""a "" {x} """')).toEqual(['x']);
  });

  it('reads raw strings that need more than one dollar sign', () => {
    // With two dollar signs a hole opens with two braces; a third brace is literal text.
    expect(interpolationHoles('$$"""{{x}} {literal} {{{y}}}"""')).toEqual(['x', 'y']);
  });

  it('reads holes that contain strings, characters and braces', () => {
    expect(interpolationHoles('$"{M("}", \'}\', new[] { 1 })}"')).toEqual(['M("}", \'}\', new[] { 1 })']);
  });

  it('reads nested interpolated strings', () => {
    expect(interpolationHoles('$"a{$"b{c}"}"')).toEqual(expect.arrayContaining(['c']));
  });

  it('returns nothing for a string without holes, a plain string and non-literals', () => {
    expect(interpolationHoles('$"plain"')).toEqual([]);
    expect(interpolationHoles('"{x}"')).toEqual([]);
    expect(interpolationHoles('x + y')).toEqual([]);
    expect(interpolationHoles('$""')).toEqual([]);
  });

  it('tolerates an unterminated literal and an unterminated hole', () => {
    expect(interpolationHoles('$"open {x}')).toEqual(['x']);
    expect(interpolationHoles('$"open {x')).toEqual(['x']);
  });
});

describe('interpolationWritesName', () => {
  it.each([
    ['ref', '$"{M(ref _n)}"'],
    ['out', '$"{M(out _n)}"'],
    ['postfix increment', '$"{_n++}"'],
    ['prefix increment', '$"{++_n}"'],
    ['assignment', '$"{(_n = 1)}"'],
    ['compound assignment', '$"{(_n ??= 1)}"'],
    ['shift assignment', '$"{(_n <<= 1)}"'],
    ['this-qualified', '$"{this._n++}"'],
    ['address-of', '$"{(int)&_n}"'],
    ['nested hole', '$"a{$"b{_n++}"}"'],
  ])('finds a write: %s', (_name, literal) => {
    expect(interpolationWritesName(literal, '_n')).toBe(true);
  });

  it.each([
    ['a read', '$"{_n}"'],
    ['a comparison', '$"{_n == 1} {_n >= 1} {_n != 1} {_n <= 1}"'],
    ['a lambda arrow', '$"{(Func<int>)(() => _n)} {M(_n => _n)}"'],
    ['a longer identifier', '$"{other_n++} {_nx++} {x_n = 1}"'],
    ['another receiver', '$"{o._n++} {o._n = 1}"'],
    ['text that looks like a write', '$"_n++ {"_n = 1"} {\'_\'}"'],
    ['text outside the holes', '$"_n++ and ref _n and {{_n = 1}}"'],
    ['a plain string', '"{_n++}"'],
  ])('ignores %s', (_name, literal) => {
    expect(interpolationWritesName(literal, '_n')).toBe(false);
  });

  it('escapes regular expression characters in the name', () => {
    expect(interpolationWritesName('$"{a$b++}"', 'a$b')).toBe(true);
  });
});
