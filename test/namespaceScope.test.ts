import { describe, expect, it } from 'vitest';
import { SourceTransformationPipeline } from '../src/cleanup/pipeline';
import {
  convertToFileScoped,
  fileScopedNamespaceConverter,
  hasMultipleNamespaces,
  moveUsingsOutside,
  moveUsingsOutsideNamespaceConverter,
} from '../src/cleanup/transformations/namespaceScope';

describe('moveUsingsOutside', () => {
  it('moves usings from a block namespace to the top', () => {
    const input =
      'namespace CodeJanitor\r\n{\r\n    using System;\r\n    using System.Collections.Generic;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n';
    const result = moveUsingsOutside(input);

    expect(result.startsWith('using System;\r\nusing System.Collections.Generic;\r\n\r\nnamespace CodeJanitor')).toBe(
      true
    );
    expect(result).not.toContain('{\r\n    using System;');
  });

  it('moves usings from a file-scoped namespace to the top', () => {
    const input =
      'namespace CodeJanitor;\r\n\r\nusing System;\r\nusing System.Linq;\r\n\r\npublic class Sample\r\n{\r\n}\r\n';

    expect(
      moveUsingsOutside(input).startsWith('using System;\r\nusing System.Linq;\r\n\r\nnamespace CodeJanitor;')
    ).toBe(true);
  });

  it('leaves usings that are already at the top unchanged', () => {
    const input =
      'using System;\r\n\r\nnamespace CodeJanitor\r\n{\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n';

    expect(moveUsingsOutside(input)).toBe(input);
  });

  it('merges and deduplicates against existing top-level usings', () => {
    const input =
      'using System;\r\nusing System.Text;\r\n\r\nnamespace CodeJanitor\r\n{\r\n    using System;\r\n    using System.Collections.Generic;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n';

    expect(
      moveUsingsOutside(input).startsWith(
        'using System;\r\nusing System.Text;\r\nusing System.Collections.Generic;\r\n\r\nnamespace CodeJanitor'
      )
    ).toBe(true);
  });

  it('preserves the file header when moving usings to the top', () => {
    const input =
      '// Copyright (c) 2026\r\n\r\nnamespace CodeJanitor\r\n{\r\n    using System;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n';

    expect(moveUsingsOutside(input).startsWith('// Copyright (c) 2026\r\n\r\nusing System;\r\n\r\nnamespace CodeJanitor')).toBe(
      true
    );
  });

  it('produces clean file-scoped code when combined with the file-scoped converter', () => {
    const input = 'namespace CodeJanitor\r\n{\r\n    using System;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n';
    const pipeline = new SourceTransformationPipeline([
      moveUsingsOutsideNamespaceConverter,
      fileScopedNamespaceConverter,
    ]);

    expect(pipeline.run(input)).toBe(
      'using System;\r\n\r\nnamespace CodeJanitor;\r\n\r\npublic class Sample\r\n{\r\n}\r\n'
    );
  });

  it('handles an empty source', () => {
    expect(moveUsingsOutside('')).toBe('');
  });

  it('is named', () => {
    expect(moveUsingsOutsideNamespaceConverter.name).toBe('Move using directives outside namespace');
  });
});

describe('convertToFileScoped', () => {
  it('converts a single block namespace', () => {
    expect(convertToFileScoped('namespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n')).toBe(
      'namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n'
    );
  });

  it('moves usings outside while converting', () => {
    expect(
      convertToFileScoped('namespace A\r\n{\r\n    using System;\r\n\r\n    class C\r\n    {\r\n    }\r\n}\r\n')
    ).toBe('using System;\r\n\r\nnamespace A;\r\n\r\nclass C\r\n{\r\n}\r\n');
  });

  it('leaves an already file-scoped namespace unchanged', () => {
    const input = 'namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n';

    expect(convertToFileScoped(input)).toBe(input);
  });

  it('leaves multiple namespaces unchanged', () => {
    const input = 'namespace A\r\n{\r\n}\r\nnamespace B\r\n{\r\n}\r\n';

    expect(convertToFileScoped(input)).toBe(input);
  });

  it('leaves a file without a namespace unchanged', () => {
    const input = 'class C\r\n{\r\n}\r\n';

    expect(convertToFileScoped(input)).toBe(input);
  });

  it('leaves nested namespaces unchanged', () => {
    const input = 'namespace A\r\n{\r\n    namespace B\r\n    {\r\n    }\r\n}\r\n';

    expect(convertToFileScoped(input)).toBe(input);
  });

  it('preserves the file header and outer usings', () => {
    expect(
      convertToFileScoped(
        '// file header\r\nusing System;\r\n\r\nnamespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n'
      )
    ).toBe('// file header\r\nusing System;\r\n\r\nnamespace A;\r\n\r\nclass C\r\n{\r\n}\r\n');
  });

  it('is named', () => {
    expect(fileScopedNamespaceConverter.name).toBe('File-Scoped Namespace');
  });
});

describe('hasMultipleNamespaces', () => {
  it('detects multiple top-level namespaces', () => {
    expect(hasMultipleNamespaces('namespace A\r\n{\r\n}\r\nnamespace B\r\n{\r\n}\r\n')).toBe(true);
  });

  it('detects a nested namespace', () => {
    expect(hasMultipleNamespaces('namespace A\r\n{\r\n    namespace B\r\n    {\r\n    }\r\n}\r\n')).toBe(true);
  });

  it('returns false for a single block namespace', () => {
    expect(hasMultipleNamespaces('namespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n')).toBe(false);
  });

  it('returns false for a single file-scoped namespace', () => {
    expect(hasMultipleNamespaces('namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n')).toBe(false);
  });

  it('returns false when there is no namespace', () => {
    expect(hasMultipleNamespaces('class C\r\n{\r\n}\r\n')).toBe(false);
  });
});
