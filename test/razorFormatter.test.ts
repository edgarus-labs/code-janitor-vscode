import { describe, expect, it } from 'vitest';
import { formatRazor } from '../src/razor/razorFormatter';

/** Ported from the Visual Studio extension's RazorFormatterLogicTests. */
describe('formatRazor: ported Visual Studio scenarios', () => {
  it('keeps inline when two attributes', () => {
    const input = '<MyComp A="1" B="2" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('keeps markup unchanged regardless of attribute count', () => {
    const input = '<MyComp A="1" B="2" C="3" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('keeps an authored multi-line tag unchanged', () => {
    const input = '<link rel="icon"\n  type="image/png"\n  href="favicon.png" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('formats code inside the @code directive', () => {
    const input = '@code{public void A(){if(true){return;}}}';
    const expected = '@code{\n    public void A()\n    {\n        if (true)\n        {\n            return;\n        }\n    }\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('does not format tags inside the @code directive', () => {
    const input = '@code{\n    var xml = "<MyComp A=\'1\' B=\'2\' C=\'3\' />";\n}\n<MyComp A="1" B="2" C="3" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('formats code inside an @if block', () => {
    const input = '@if(true){<Child A="1" B="2" C="3" /> var x=1+2;}';
    const expected = '@if (true)\n{\n    <Child A="1" B="2" C="3" />\n    var x = 1 + 2;\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('protects string markup inside a @foreach block', () => {
    const input = '@foreach(var item in items){var xml="<Child A=\'1\' B=\'2\' C=\'3\' />";}\n<Child A="1" B="2" C="3" />';
    const expected = '@foreach (var item in items)\n{\n    var xml = "<Child A=\'1\' B=\'2\' C=\'3\' />";\n}\n<Child A="1" B="2" C="3" />';
    expect(formatRazor(input)).toBe(expected);
  });

  it('formats @else block markup', () => {
    const input = '@else{<Child A="1" B="2" C="3" />}';
    const expected = '@else\n{\n    <Child A="1" B="2" C="3" />\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('formats the @else if header and code', () => {
    const input = '@else if(flag&&other){var total=1+2;}';
    const expected = '@else if (flag && other)\n{\n    var total = 1 + 2;\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('formats @try / @catch / @finally blocks', () => {
    const input =
      '@try{var xml="<Child A=\'1\' B=\'2\' C=\'3\' />";}@catch(Exception ex){var total=1+2;}@finally{<Child A="1" B="2" C="3" />}';
    const expected =
      '@try\n{\n    var xml = "<Child A=\'1\' B=\'2\' C=\'3\' />";\n}\n@catch (Exception ex)\n{\n    var total = 1 + 2;\n}\n@finally\n{\n    <Child A="1" B="2" C="3" />\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('keeps a Razor expression with nested quotes intact', () => {
    const input = '<link rel="stylesheet" href="@Assets["app.css"]" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('keeps a Razor expression with nested quotes intact with three attributes', () => {
    const input = '<link rel="stylesheet" href="@Assets["app.css"]" type="text/css" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('keeps a Razor expression with a path and a preceding attribute intact', () => {
    const input = '<link href="@Assets["_content/MudBlazor/MudBlazor.min.css"]" rel="stylesheet" />';
    expect(formatRazor(input)).toBe(input);
  });

  it('keeps Blazor head markup exactly as authored', () => {
    const input = [
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '<base href="/" />',
      '<ResourcePreloader />',
      '<link rel="stylesheet" href="@Assets["app.css"]" />',
      '<link rel="stylesheet"\n      href="@Assets["Jade.Web.styles.css"]" />',
      '<ImportMap />',
      '<link rel="icon"\n      type="image/png"\n      href="favicon.png" />',
      '<link href="https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap" rel="stylesheet" />',
      '<link href="@Assets["_content/MudBlazor/MudBlazor.min.css"]" rel="stylesheet" />',
      '<HeadOutlet />',
    ].join('\n');
    expect(formatRazor(input)).toBe(input);
  });

  it('is idempotent', () => {
    const input = '<MyComp A="1" B="2" C="3" />\n@code{public void A(){if(true){return;}}}';
    const once = formatRazor(input);
    expect(formatRazor(once)).toBe(once);
  });
});

describe('formatRazor: continuations and indentation', () => {
  it('puts else if / else written after the closing brace on their own lines', () => {
    const input = '@if(a){<p>A</p>}else if(b){<p>B</p>}else{<p>C</p>}';
    const expected = '@if (a)\n{\n    <p>A</p>\n}\nelse if (b)\n{\n    <p>B</p>\n}\nelse\n{\n    <p>C</p>\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('formats bare catch and finally after @try', () => {
    const input = '@try{var a=1;}catch(Exception ex){var b=2;}finally{var c=3;}';
    const expected = '@try\n{\n    var a = 1;\n}\ncatch (Exception ex)\n{\n    var b = 2;\n}\nfinally\n{\n    var c = 3;\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('indents an indented block from its own line, once', () => {
    const input = '<div>\n    @if(a){\n    <p>A</p>\n    }\n</div>';
    const expected = '<div>\n    @if (a)\n    {\n        <p>A</p>\n    }\n</div>';
    expect(formatRazor(input)).toBe(expected);
    expect(formatRazor(expected)).toBe(expected);
  });

  it('moves nested markup as a whole and keeps its own indentation', () => {
    const input = '@if(a){\n<ul>\n  <li>@x</li>\n  <li>y</li>\n</ul>\n}';
    const expected = '@if (a)\n{\n    <ul>\n      <li>@x</li>\n      <li>y</li>\n    </ul>\n}';
    expect(formatRazor(input)).toBe(expected);
  });

  it('keeps two elements written side by side on one line', () => {
    const input = '@if(a){<b>x</b> <i>y</i>}';
    expect(formatRazor(input)).toBe('@if (a)\n{\n    <b>x</b> <i>y</i>\n}');
  });

  it('keeps a blank line between statements of a block', () => {
    const input = '@if(a){\n<p>A</p>\n\nvar x=1;\n}';
    expect(formatRazor(input)).toBe('@if (a)\n{\n    <p>A</p>\n\n    var x = 1;\n}');
  });

  it('follows the tab indentation of the file', () => {
    const input = '<div>\n\t@if(a){\n\t<p>A</p>\n\t}\n</div>';
    expect(formatRazor(input)).toBe('<div>\n\t@if (a)\n\t{\n\t\t<p>A</p>\n\t}\n</div>');
  });

  it('uses the configured indent size', () => {
    expect(formatRazor('@if(a){var x=1;}', { indentSize: 2, indentStyle: 'space' })).toBe('@if (a)\n{\n  var x = 1;\n}');
    expect(formatRazor('@if(a){var x=1;}', { indentStyle: 'tab' })).toBe('@if (a)\n{\n\tvar x = 1;\n}');
  });

  it('keeps CRLF line endings and the byte order mark', () => {
    const output = formatRazor('\uFEFF@if(a){\r\nvar x=1;\r\n}\r\n');
    expect(output).toBe('\uFEFF@if (a)\r\n{\r\n    var x = 1;\r\n}\r\n');
  });

  it('lays out the members of @functions and @code with their accessors and enums', () => {
    const input = '@code {\nint a;int b;\n[Parameter] public int P{get;set;}\nenum E{A,B}\nint Twice()=>a*2;\n}';
    const expected =
      '@code {\n    int a;\n    int b;\n    [Parameter] public int P { get; set; }\n    enum E\n    {\n        A,\n        B\n    }\n    int Twice() => a * 2;\n}';
    expect(formatRazor(input)).toBe(expected);
    expect(formatRazor(expected)).toBe(expected);
  });

  it('keeps the lines of a multi-line string literal exactly', () => {
    const input = '@code {\nstring s = """\n  raw\n     text\n  """;\n}';
    expect(formatRazor(input)).toBe('@code {\n    string s = """\n  raw\n     text\n  """;\n}');
  });

  it('keeps the lines of a multi-line literal in a control block stable', () => {
    const input = '@if(a){\nvar s = @"x\n   y";\n}';
    const once = formatRazor(input);
    expect(once).toBe('@if (a)\n{\n    var s = @"x\n   y";\n}');
    expect(formatRazor(once)).toBe(once);
  });

  it('formats the header of a @switch and moves case labels as authored', () => {
    expect(formatRazor('@switch(a){case 1:return;default:break;}')).toBe('@switch (a)\n{\n    case 1:return;default:break;\n}');
  });

  it('keeps case bodies with markup at their authored depth', () => {
    const input = '@switch(a){\ncase 1:\n<p>one</p>\nbreak;\ndefault:\n<p>other</p>\nbreak;\n}';
    const expected = '@switch (a)\n{\n    case 1:\n    <p>one</p>\n    break;\n    default:\n    <p>other</p>\n    break;\n}';
    expect(formatRazor(input)).toBe(expected);
    expect(formatRazor(expected)).toBe(expected);
  });

  it('puts an @else written on an indented line of its own at the indent of the chain', () => {
    const input = '@if (a)\n{\n<p>x</p>\n}\n    @else if(b){\n<p>y</p>\n}';
    const blankLine = '@if (a)\n{\n<p>x</p>\n}\n\n    @else{\n<p>y</p>\n}';
    const expected = '@if (a)\n{\n    <p>x</p>\n}\n@else if (b)\n{\n    <p>y</p>\n}';

    expect(formatRazor(input)).toBe(expected);
    expect(formatRazor(expected)).toBe(expected);
    expect(formatRazor(blankLine)).toBe('@if (a)\n{\n    <p>x</p>\n}\n\n@else\n{\n    <p>y</p>\n}');
  });
});

describe('formatRazor: content it must not touch', () => {
  const unchanged = (name: string, input: string): void => {
    it(name, () => {
      expect(formatRazor(input)).toBe(input);
    });
  };

  unchanged('a Razor comment holding a block', '@* @if(a){var x=1;} *@');
  unchanged('an HTML comment', '<!-- @if(a){var x=1;} -->');
  unchanged('a script element', '<script>\nif(a){var x=1;}\n</script>');
  unchanged('an escaped @@if', '<p>@@if(a){var x=1;}</p>');
  unchanged('an address that looks like a directive', '<p>mail me at name@if(a){x}</p>');
  unchanged('@code holding code that does not parse', '@code {\nvoid M( { int x = ; \n}');
  unchanged('a block that is never closed', '@if(a){\n<p>x</p>');
  unchanged('an @if inside @{ } code', '@{\n    var list = new List<int>();\n    if(a){list.Add(1);}\n}');
  unchanged('a block holding a pre element', '@if(a){\n<pre>\n  keep   this\n</pre>\n}');
  unchanged('text without any block', 'Hello @name, you have @count new messages.\n<p class="x">a &amp; b</p>\n');
  unchanged('an empty file', '');
  unchanged('a lone carriage return', '@if(a){\rvar x=1;\r}');
  // A line break added after `}` or inside the block would land in the rendered text of the line.
  unchanged('a block followed by text on its line', '<p>Total: @if (a) {<b>x</b>}items</p>');
  unchanged('an if/else chain inside an inline element', '<span>@if (a) {<b>x</b>} else {<i>y</i>}</span>');
  unchanged('a block preceded by text on its line', '<p>Total: @if (a) {<b>x</b>}\n</p>');
  // Razor drops the line break after `}` and renders the next line: moving the markup off the brace
  // line adds a line break (or an indent) next to text that had none.
  unchanged('a block alone on its line with markup on the brace line, followed by text', '<p>Total:\n@if (a) {<b>x</b>}\nitems</p>');
  unchanged('two blocks on consecutive lines with markup on the brace lines', '@if (a) {<b>x</b>}\n@if (b) {<i>y</i>}\n');
  unchanged('markup followed by code on its line inside the block', '@if (a) {\n<i>y</i>var x = 1;\n<b>z</b>\n}\n');
  // Whitespace-significant elements nested in a statement of the block: their lines are rendered text.
  unchanged('a pre element nested in a statement of a block', '@if(a){\nif(b){\n<pre>\nkeep\n  this\n</pre>\n}\n}\n');
  unchanged('a textarea nested in a statement of a block', '@foreach(var x in xs){\nforeach(var y in x){\n<textarea>\nline1\nline2</textarea>\n}\n}');
  // The lines of a multi-line literal in Razor code inside markup are part of its value.
  unchanged('a verbatim string in a code block inside markup', '@if(a){\n<div>\n@{ var s = @"x\ny"; }\n<p>@s</p>\n</div>\n}');
  unchanged('a verbatim string in an expression inside an attribute', '@if(a){\n<div title="@(@"x\ny")">\n</div>\n}');
  // Rewriting every line ending as CRLF would change the LF lines inside literals and pre elements too.
  unchanged('a file with mixed line endings', '<p>a</p>\r\n@if(a){\n<pre>\n  x\n</pre>\n}\r\n@code{\nstring s=@"a\nb";\n}\n');
  // A line break inside a quoted attribute value is part of the value.
  unchanged('a multi-line attribute value in markup of a block', '@if(a){\n<div data-x="one\n  two">\n</div>\n}');
  unchanged('a multi-line attribute value nested in a statement of a block', "@if(a){\nif(b){\n<div data-x='one\n  two'>\n</div>\n}\n}");
  // Razor reads an unterminated comment or code block up to the end of the file.
  unchanged('a block after an unterminated Razor comment', '@* disabled:\n@if(a){var x=1;}');
  unchanged('a block after an unterminated code block', '@{ var y = 1;\n@if(a){var x=1;}');

  it('still formats a block whose markup has its attributes on lines of their own', () => {
    const input = '@if(a){\n<div\n  id="x"\n  title="@(b ? "y" : "z")">\n</div>\n}';
    expect(formatRazor(input)).toBe('@if (a)\n{\n    <div\n      id="x"\n      title="@(b ? "y" : "z")">\n    </div>\n}');
  });

  it('still formats a block whose markup holds Razor code without multi-line literals', () => {
    const input = '@if(a){\n<div>\n@{ var s = "x"; }\n<p title="@(b ? "y" : "z")">@s</p>\n</div>\n}';
    expect(formatRazor(input)).toBe('@if (a)\n{\n    <div>\n    @{ var s = "x"; }\n    <p title="@(b ? "y" : "z")">@s</p>\n    </div>\n}');
  });

  it('still moves markup off the brace line when whitespace is rendered around it anyway', () => {
    const indentedNext = '<p>Total:\n    @if (a) {<b>x</b>}\n    items</p>';
    const spaced = '<p>Total:\n@if (a) { <b>x</b> }\nitems</p>';

    expect(formatRazor(indentedNext)).toBe('<p>Total:\n    @if (a)\n    {\n        <b>x</b>\n    }\n    items</p>');
    expect(formatRazor(spaced)).toBe('<p>Total:\n@if (a)\n{\n    <b>x</b>\n}\nitems</p>');
  });

  it('does not treat a less-than in code as markup', () => {
    expect(formatRazor('@if(a<b){var c=a<b;}')).toBe('@if (a < b)\n{\n    var c = a < b;\n}');
  });

  it('reads braces and quotes in markup text without mistaking them for code', () => {
    const input = "@if(a){<p>it's {not code}</p>}";
    expect(formatRazor(input)).toBe("@if (a)\n{\n    <p>it's {not code}</p>\n}");
  });

  it('formats a block that follows a comment containing a brace', () => {
    expect(formatRazor('<!-- { -->\n@if(a){var x=1;}')).toBe('<!-- { -->\n@if (a)\n{\n    var x = 1;\n}');
  });

  it('leaves a whole try chain as authored when a catch has a filter', () => {
    const input = '@try{var a=1;}catch(Exception ex) when (ex is null){var b=2;}';
    expect(formatRazor(input)).toBe(input);
  });

  it('still formats the chain that follows an unreadable one', () => {
    const input = '@try{var a=1;}catch(Exception ex) when (ex is null){var b=2;}\n@if(a){var c=1;}';
    expect(formatRazor(input)).toBe('@try{var a=1;}catch(Exception ex) when (ex is null){var b=2;}\n@if (a)\n{\n    var c = 1;\n}');
  });
});
