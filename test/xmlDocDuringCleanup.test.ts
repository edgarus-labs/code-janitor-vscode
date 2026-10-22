import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentDuringCleanup, formatXmlDocCleanupSummary, readXmlDocCleanupLimits } from '../src/ai/xmlDocDuringCleanup';
import type { XmlDocCleanupIo, XmlDocCleanupLimits } from '../src/ai/xmlDocDuringCleanup';
import { collectFiles, writeFileContent } from '../src/commands/cleanupCore';
import type { XmlDocTargetResult } from '../src/engine/protocol';
import { createOutputChannel } from '../src/logging';
import { useFakeEngine } from './helpers/fakeEngine';
import type { EngineParams, FakeEngine } from './helpers/fakeEngine';
import { Uri, createContext, resetMock, state } from './helpers/vscodeMock';

/** The fake engine's `xmlDocTargets`: `public void M()` methods (AI) and `public int F;` fields (deterministic) without `///` above them. */
function xmlDocTargets(text: string): XmlDocTargetResult[] {
  const lines = text.split('\n');

  return lines.flatMap((line, index): XmlDocTargetResult[] => {
    const match = /^(\s*)public (void|int) (\w+)(\(\))?/.exec(line);
    if (!match || (lines[index - 1] ?? '').trim().startsWith('///')) {
      return [];
    }

    const method = match[4] !== undefined;

    return [
      {
        name: match[3],
        kind: method ? 'method' : 'field',
        text: line.trim(),
        insertionLine: index,
        indent: match[1],
        signature: line.trim(),
        body: '',
        parameters: [],
        typeParameters: [],
        returnType: method ? 'void' : null,
        containingType: { name: 'C', kind: 'class' },
        exceptions: [],
        accessors: null,
        baseTypes: [],
        members: [],
        modifiers: ['public'],
      },
    ];
  });
}

/** A class with the given members, one per line: `M()` is a method, anything else an `int` field. */
function source(...members: string[]): string {
  return `internal class C\n{\n${members.map((member) => (member.endsWith('()') ? `    public void ${member} { }\n` : `    public int ${member};\n`)).join('')}}\n`;
}

const LIMITS: XmlDocCleanupLimits = {
  maxRequests: 25,
  maxEstimatedTokens: 100_000,
  timeoutMs: 10_000,
  maxParallelFiles: 4,
  maxTokensPerRequest: 256,
  allowFallback: true,
  options: { maxMembersPerFile: 25, maxInputCharsPerMember: 2500, ignoreGeneratedCode: true, ignoreObsolete: true, ignoreTestMethods: true, ignorePattern: '' },
};

let engine: FakeEngine;
let prompts: string[];

function io(
  complete: XmlDocCleanupIo['complete'] = (_system, prompt) => {
    prompts.push(prompt);

    return Promise.resolve('Does the work.');
  },
  overrides: Partial<XmlDocCleanupIo> = {}
): XmlDocCleanupIo {
  return { read: async (uri) => (await collectFiles([uri]))[0], write: writeFileContent, complete, ...overrides };
}

function files(...texts: string[]): Uri[] {
  return texts.map((text, index) => {
    const uri = Uri.file(`/w/F${index}.cs`);
    state.files.set(uri.fsPath, text);

    return uri;
  });
}

beforeEach(() => {
  resetMock();
  createOutputChannel(createContext());
  prompts = [];
  engine = useFakeEngine({ query: (params: EngineParams) => (params.query === 'xmlDocTargets' ? xmlDocTargets(params.text) : null) });
});

describe('documentDuringCleanup', () => {
  it('documents the members with an AI summary each, and the formulaic ones without a request', async () => {
    const [uri] = files(source('Run()', 'Count'));

    const summary = await documentDuringCleanup([uri], io(), LIMITS);

    expect(prompts).toHaveLength(1);
    expect(state.files.get(uri.fsPath)).toContain('    /// <summary>\n    /// Does the work.\n    /// </summary>\n    public void Run() { }');
    expect(state.files.get(uri.fsPath)).toMatch(/\/\/\/ <summary>\n {4}\/\/\/ [^\n]+\n {4}\/\/\/ <\/summary>\n {4}public int Count;/);
    expect(summary).toEqual({ documentedFiles: 1, documentedMembers: 2, skippedByBudget: 0, skippedFiles: 0, failedRequests: 0, fallbacks: 0, failedFiles: 0 });
    expect(engine.requests('query')[0].arguments).toMatchObject({ maxMembersPerFile: 25, ignoreTestMethods: true });
  });

  it('makes at most maxRequestsPerCleanup AI requests across the files, and skips the rest by budget', async () => {
    const uris = files(source('A()', 'B()'), source('C()', 'D()'));

    const summary = await documentDuringCleanup(uris, io(), { ...LIMITS, maxRequests: 3, maxParallelFiles: 1 });

    expect(prompts).toHaveLength(3);
    expect(summary).toMatchObject({ documentedMembers: 3, skippedByBudget: 1 });
    expect(state.files.get('/w/F1.cs')).toContain('public void C()');
    expect(state.files.get('/w/F1.cs')!.match(/<summary>/g)).toHaveLength(1);
  });

  it('stops requesting once the estimated tokens would pass maxEstimatedTokensPerCleanup', async () => {
    const [uri] = files(source('A()', 'B()', 'C()'));

    const summary = await documentDuringCleanup([uri], io(), { ...LIMITS, maxTokensPerRequest: 1000, maxEstimatedTokens: 2500 });

    expect(prompts).toHaveLength(2);
    expect(summary).toMatchObject({ documentedMembers: 2, skippedByBudget: 1 });
  });

  it('leaves the rest undocumented once globalTimeoutSeconds is over, the file in progress included', async () => {
    const uris = files(source('A()', 'B()'), source('C()'));
    let now = 0;
    const complete = (_system: string, prompt: string): Promise<string> => {
      prompts.push(prompt);
      now += 2000;

      return Promise.resolve('Does the work.');
    };

    const summary = await documentDuringCleanup(uris, io(complete, { now: () => now }), { ...LIMITS, timeoutMs: 1000, maxParallelFiles: 1 });

    expect(prompts).toHaveLength(1);
    expect(summary).toMatchObject({ documentedFiles: 1, documentedMembers: 1, skippedByBudget: 1, skippedFiles: 1 });
    expect(state.files.get('/w/F1.cs')).toBe(source('C()'));
  });

  it('does not wait for an AI answer past the deadline', async () => {
    const [uri] = files(source('A()'));
    const waits: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      waits.push(ms);

      return Promise.resolve();
    };

    const summary = await documentDuringCleanup(
      [uri],
      io(() => Promise.withResolvers<string>().promise, { sleep }),
      { ...LIMITS, timeoutMs: 50 }
    );

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(50);
    expect(summary).toMatchObject({ documentedMembers: 0, skippedByBudget: 1, failedRequests: 0 });
    expect(state.files.get(uri.fsPath)).toBe(source('A()'));
  });

  it('documents at most maxParallelFiles files at the same time', async () => {
    const uris = files(...['A()', 'B()', 'C()', 'D()', 'E()'].map((member) => source(member)));
    const answers: (() => void)[] = [];
    let running = 0;
    let most = 0;
    const complete = (): Promise<string> => {
      running++;
      most = Math.max(most, running);
      const { promise, resolve } = Promise.withResolvers<string>();
      answers.push(() => {
        running--;
        resolve('Does the work.');
      });

      return promise;
    };
    let done = false;
    const run = documentDuringCleanup(uris, io(complete), { ...LIMITS, maxParallelFiles: 2 }).finally(() => {
      done = true;
    });

    for (;;) {
      await vi.waitFor(() => expect(answers.length > 0 || done).toBe(true));
      if (done) {
        break;
      }

      answers.shift()!();
    }

    expect(most).toBe(2);
    expect((await run).documentedFiles).toBe(5);
  });

  it('uses the deterministic summary for a failed AI request when the fallback is allowed', async () => {
    const [uri] = files(source('Run()'));

    const summary = await documentDuringCleanup(
      [uri],
      io(() => Promise.reject(new Error('endpoint unreachable'))),
      LIMITS
    );

    expect(summary).toMatchObject({ documentedMembers: 1, failedRequests: 1, fallbacks: 1 });
    expect(state.files.get(uri.fsPath)).toContain('/// <summary>');
    expect(state.outputChannelLines.some((line) => line.includes('endpoint unreachable'))).toBe(true);
  });

  it('leaves a member whose AI request failed undocumented without the fallback', async () => {
    const [uri] = files(source('Run()'));

    const summary = await documentDuringCleanup(
      [uri],
      io(() => Promise.resolve('  ')),
      { ...LIMITS, allowFallback: false }
    );

    expect(summary).toMatchObject({ documentedMembers: 0, documentedFiles: 0, failedRequests: 1, fallbacks: 0 });
    expect(state.files.get(uri.fsPath)).toBe(source('Run()'));
  });

  it('counts a file that cannot be written as failed and documents the others', async () => {
    const uris = files(source('A()'), source('B()'));
    state.failingWrites.add('/w/F0.cs');

    const summary = await documentDuringCleanup(uris, io(), LIMITS);

    expect(summary).toMatchObject({ documentedFiles: 1, failedFiles: 1 });
    expect(state.files.get('/w/F1.cs')).toContain('/// <summary>');
  });
});

describe('readXmlDocCleanupLimits', () => {
  it('reads the codeJanitor.ai.xmlDoc budget settings', () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.maxRequestsPerCleanup', 7);
    state.configuration.set('codeJanitor.ai.xmlDoc.maxEstimatedTokensPerCleanup', 900);
    state.configuration.set('codeJanitor.ai.xmlDoc.globalTimeoutSeconds', 3);
    state.configuration.set('codeJanitor.ai.xmlDoc.maxParallelFiles', 2);
    state.configuration.set('codeJanitor.ai.xmlDoc.allowDeterministicFallback', false);

    expect(readXmlDocCleanupLimits()).toMatchObject({
      maxRequests: 7,
      maxEstimatedTokens: 900,
      timeoutMs: 3000,
      maxParallelFiles: 2,
      maxTokensPerRequest: 256,
      allowFallback: false,
    });
  });

  it('falls back to the defaults for values that are not positive', () => {
    state.configuration.set('codeJanitor.ai.xmlDoc.maxRequestsPerCleanup', 0);
    state.configuration.set('codeJanitor.ai.xmlDoc.maxParallelFiles', -1);

    expect(readXmlDocCleanupLimits()).toMatchObject({ maxRequests: 25, maxEstimatedTokens: 8000, timeoutMs: 10_000, maxParallelFiles: 4 });
  });
});

describe('formatXmlDocCleanupSummary', () => {
  it('says what was documented, skipped by the budget and failed', () => {
    expect(
      formatXmlDocCleanupSummary({
        documentedFiles: 2,
        documentedMembers: 5,
        skippedByBudget: 3,
        skippedFiles: 1,
        failedRequests: 2,
        fallbacks: 1,
        failedFiles: 1,
      })
    ).toBe(
      'AI XML documentation during cleanup: 5 member(s) documented in 2 file(s); 3 member(s) and 1 file(s) skipped by the budget; 2 AI request(s) failed (1 replaced by the deterministic summary); 1 file(s) failed.'
    );
  });
});
