import { describe, expect, it } from 'vitest';
import {
  applySummaries,
  buildFallbackSummary,
  createDefaultXmlDocOptions,
  generateXmlDocumentation,
  planTargets,
} from '../src/cleanup/xmlDocumentation';
import { parseCSharp } from '../src/cleanup/parser';

describe('Constructor XML documentation', () => {
  it('documents class constructor with parameters and thrown exceptions', () => {
    const source = `
namespace Demo;

public class UserManager
{
    public UserManager(string connectionString, int timeout)
    {
        if (connectionString == null)
        {
            throw new ArgumentNullException(nameof(connectionString));
        }
    }
}
`;
    const updated = generateXmlDocumentation(
      source,
      createDefaultXmlDocOptions(),
      (member) => 'Initializes user manager service.'
    );

    expect(updated).toContain('/// <summary>');
    expect(updated).toContain('Initializes user manager service.');
    expect(updated).toContain('<param name="connectionString">');
    expect(updated).toContain('<param name="timeout">');
    expect(updated).toContain('<exception cref="ArgumentNullException">');
  });

  it('documents record constructor and record methods with parameters and exceptions', () => {
    const source = `
namespace Demo;

public record BackupRetention
{
    public BackupRetention(int days)
    {
        if (days <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(days));
        }
    }

    public bool IsValid()
    {
        return true;
    }
}
`;
    const targets = planTargets(source, createDefaultXmlDocOptions());
    const ctorTarget = targets.find((t) => t.kind === 'constructor');
    expect(ctorTarget).toBeDefined();
    expect(ctorTarget?.memberName).toBe('BackupRetention');
    expect(ctorTarget?.requiresAi).toBe(true);
    expect(ctorTarget?.prompt).toContain("constructor of record 'BackupRetention'");
    expect(ctorTarget?.prompt).toContain('public BackupRetention(int days)');
    expect(ctorTarget?.prompt).toContain('Detected thrown exceptions: ArgumentOutOfRangeException');

    const updated = applySummaries(source, createDefaultXmlDocOptions(), {
      [ctorTarget!.index]: 'Initializes a new instance of the BackupRetention record with the specified parameters.',
    });

    expect(updated).toContain('/// <summary>');
    expect(updated).toContain('/// Initializes a new instance of the BackupRetention record with the specified parameters.');
    expect(updated).toContain('<param name="days">');
    expect(updated).toContain('<exception cref="ArgumentOutOfRangeException">');
  });

  it('generates Microsoft-style fallback summaries for constructors', () => {
    const source = `
public record BackupRetention
{
    public BackupRetention(int days) { }
}

public class NormalClass
{
    public NormalClass() { }
}

public class ConfiguredClass
{
    public ConfiguredClass(string config) { }
}

public struct PointStruct
{
    public PointStruct() { }
}

public struct PointStructWithParams
{
    public PointStructWithParams(int x, int y) { }
}
`;
    const tree = parseCSharp(source);
    try {
      const ctors = tree.rootNode.descendantsOfType('constructor_declaration');
      expect(ctors).toHaveLength(5);

      expect(buildFallbackSummary(ctors[0])).toBe(
        'Initializes a new instance of the BackupRetention record with the specified parameters.'
      );
      expect(buildFallbackSummary(ctors[1])).toBe('Initializes a new instance of the NormalClass class.');
      expect(buildFallbackSummary(ctors[2])).toBe(
        'Initializes a new instance of the ConfiguredClass class with the specified parameters.'
      );
      expect(buildFallbackSummary(ctors[3])).toBe('Initializes a new instance of the PointStruct struct.');
      expect(buildFallbackSummary(ctors[4])).toBe(
        'Initializes a new instance of the PointStructWithParams struct with the specified parameters.'
      );
    } finally {
      tree.delete();
    }
  });

  it('filters out static constructors and already documented constructors', () => {
    const source = `
public class Worker
{
    static Worker()
    {
    }

    /// <summary>Already documented.</summary>
    public Worker(int id)
    {
    }

    public Worker(string name)
    {
    }
}
`;
    const targets = planTargets(source, createDefaultXmlDocOptions());
    const ctorTargets = targets.filter((t) => t.kind === 'constructor');
    expect(ctorTargets).toHaveLength(1);
    expect(ctorTargets[0].memberName).toBe('Worker');
  });

  it('filters constructors in test types when ignoreTestMethods is true', () => {
    const source = `
public class OrderServiceTests
{
    public OrderServiceTests()
    {
    }
}

public class OrderService
{
    public OrderService()
    {
    }
}
`;
    const optsWithIgnore = { ...createDefaultXmlDocOptions(), ignoreTestMethods: true };
    const targets = planTargets(source, optsWithIgnore);
    const ctorTargets = targets.filter((t) => t.kind === 'constructor');

    expect(ctorTargets).toHaveLength(1);
    expect(targets.some((t) => t.memberName === 'OrderServiceTests')).toBe(false);
    expect(targets.some((t) => t.memberName === 'OrderService')).toBe(true);
  });

  it('honors ignoreObsolete on constructors', () => {
    const source = `
public class LegacyService
{
    [Obsolete("Use newer overload")]
    public LegacyService()
    {
    }

    public LegacyService(string mode)
    {
    }
}
`;
    const targets = planTargets(source, { ...createDefaultXmlDocOptions(), ignoreObsolete: true });
    const ctorTargets = targets.filter((t) => t.kind === 'constructor');

    expect(ctorTargets).toHaveLength(1);
  });

  it('honors ignorePattern on constructors', () => {
    const source = `
namespace Acme.Services;

public class PaymentService
{
    public PaymentService(string apiKey)
    {
    }
}
`;
    const opts = { ...createDefaultXmlDocOptions(), ignorePattern: 'PaymentService\\.PaymentService' };
    const targets = planTargets(source, opts);
    const ctorTargets = targets.filter((t) => t.kind === 'constructor');

    expect(ctorTargets).toHaveLength(0);
  });
});
