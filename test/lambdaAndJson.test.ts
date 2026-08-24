import { beforeAll, describe, expect, it } from 'vitest';
import { initCSharpParser } from '../src/cleanup/parser';
import {
  jsonSerializerOptionsReuseConverter,
  singleStatementLambdaConverter,
} from '../src/cleanup/transformations/lambdaAndJson';

beforeAll(async () => {
  await initCSharpParser();
});

describe('jsonSerializerOptionsReuseConverter', () => {
  const apply = (source: string) => jsonSerializerOptionsReuseConverter.apply(source);

  it('converts a direct options allocation in a JsonSerializer call', () => {
    expect(
      apply(
        'using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions()); } }'
      )
    ).toBe(
      'using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, null); } }'
    );
  });

  it('converts a named options argument', () => {
    expect(
      apply(
        'using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, options: new JsonSerializerOptions()); } }'
      )
    ).toBe(
      'using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, options: null); } }'
    );
  });

  it('converts a fully qualified JsonSerializer call', () => {
    expect(
      apply(
        'class C { string M(object value) { return System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions()); } }'
      )
    ).toBe('class C { string M(object value) { return System.Text.Json.JsonSerializer.Serialize(value, null); } }');
  });

  it('skips a configured options initializer', () => {
    const input =
      'using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips an options constructor with arguments', () => {
    const input =
      'using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips calls on other receivers', () => {
    const input = 'class C { void M(Foo f) { f.Serialize(new JsonSerializerOptions()); } }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(jsonSerializerOptionsReuseConverter.name).toBe('CA1869 JsonSerializerOptions Reuse');
  });
});

describe('singleStatementLambdaConverter', () => {
  const apply = (source: string) => singleStatementLambdaConverter.apply(source);

  it('simplifies a lambda with a single return statement', () => {
    expect(
      apply(
        'using System.Text.Json; class C { Func<object,string> f = source => { return JsonSerializer.Serialize(source, new JsonSerializerOptions() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }); }; }'
      )
    ).toBe(
      'using System.Text.Json; class C { Func<object,string> f = source => JsonSerializer.Serialize(source, new JsonSerializerOptions() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }); }'
    );
  });

  it('simplifies a lambda with a single expression statement', () => {
    expect(apply('class C { Action a = () => { DoWork(); }; void DoWork(){} }')).toBe(
      'class C { Action a = () => DoWork(); void DoWork(){} }'
    );
  });

  it('skips a lambda with several statements', () => {
    const input = 'class C { Func<int,int> f = x => { Log(x); return x + 1; }; void Log(int _){} }';

    expect(apply(input)).toBe(input);
  });

  it('skips a lambda with a bare return', () => {
    const input = 'class C { Action a = () => { return; }; }';

    expect(apply(input)).toBe(input);
  });

  it('simplifies an anonymous delegate with a return statement', () => {
    expect(apply('using System; class C { Func<int, int> f = delegate(int x) { return x + 1; }; }')).toBe(
      'using System; class C { Func<int, int> f = (int x) => x + 1; }'
    );
  });

  it('simplifies a parameterless anonymous delegate', () => {
    expect(apply('using System; class C { Action a = delegate { DoWork(); }; void DoWork(){} }')).toBe(
      'using System; class C { Action a = () => DoWork(); void DoWork(){} }'
    );
  });

  it('leaves expression-bodied lambdas unchanged', () => {
    const input = 'class C { Func<int,int> f = x => x + 1; }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(singleStatementLambdaConverter.name).toBe('Single Statement Lambda');
  });
});
