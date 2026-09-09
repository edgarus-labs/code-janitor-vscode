import { describe, expect, it } from 'vitest';
import {
  createDefaultXmlDocOptions,
  normalizeSentence,
  sanitizeAiCompletion,
} from '../src/cleanup/xmlDocumentation';

describe('sanitizeAiCompletion', () => {
  it('returns empty for null/empty input', () => {
    expect(sanitizeAiCompletion('')).toBe('');
    expect(sanitizeAiCompletion('   ')).toBe('');
  });

  it('strips <think> blocks', () => {
    expect(sanitizeAiCompletion('<think>reasoning here</think>Builds the thing.')).toBe('Builds the thing.');
  });

  it('strips <thought> blocks', () => {
    expect(sanitizeAiCompletion('<thought>thinking</thought>Creates the item.')).toBe('Creates the item.');
  });

  it('strips <reasoning> blocks', () => {
    expect(sanitizeAiCompletion('<reasoning>because</reasoning>Does the work.')).toBe('Does the work.');
  });

  it('strips unclosed <think> block', () => {
    expect(sanitizeAiCompletion('<think>partial reasoning')).toBe('');
  });

  it('strips markdown code fences', () => {
    expect(sanitizeAiCompletion('```csharp\nBuilds the thing.\n```')).toBe('Builds the thing.');
  });

  it('strips "Here is the summary:" prefix', () => {
    expect(sanitizeAiCompletion('Here is the summary: Builds the thing.')).toBe('Builds the thing.');
  });

  it('strips "Summary:" prefix', () => {
    expect(sanitizeAiCompletion('Summary: Builds the thing.')).toBe('Builds the thing.');
  });

  it('strips "Description:" prefix', () => {
    expect(sanitizeAiCompletion('Description: Builds the thing.')).toBe('Builds the thing.');
  });

  it('strips leading /// and <summary> tags', () => {
    expect(sanitizeAiCompletion('/// <summary>\n/// Builds the thing.\n/// </summary>')).toBe('Builds the thing.');
  });

  it('strips trailing /// </summary>', () => {
    expect(sanitizeAiCompletion('/// Builds the thing.\n/// </summary>')).toBe('Builds the thing.');
  });

  it('handles Thinking Process with drafts', () => {
    const input = '**Thinking Process**:\nDraft 1: Bad idea.\nFinal Draft: Creates the widget.\n';
    const result = sanitizeAiCompletion(input);

    expect(result).toBe('Creates the widget.');
  });

  it('handles Thinking Process with no good drafts', () => {
    const input = '**Thinking Process**:\nDraft 1: x.\n';

    expect(sanitizeAiCompletion(input)).toBe('');
  });

  it('handles "Here is a concise summary sentence:" prefix', () => {
    expect(sanitizeAiCompletion('Here is a concise summary sentence: Does stuff.')).toBe('Does stuff.');
  });

  it('handles "Here is a summary sentence:" prefix', () => {
    expect(sanitizeAiCompletion('Here is a summary sentence: Does stuff.')).toBe('Does stuff.');
  });

  it('handles "Here is a concise summary:" prefix', () => {
    expect(sanitizeAiCompletion('Here is a concise summary: Does stuff.')).toBe('Does stuff.');
  });

  it('handles "Here is a summary:" prefix', () => {
    expect(sanitizeAiCompletion('Here is a summary: Does stuff.')).toBe('Does stuff.');
  });

  it('handles "Here is the concise summary sentence:" prefix', () => {
    expect(sanitizeAiCompletion('Here is the concise summary sentence: Does stuff.')).toBe('Does stuff.');
  });

  it('handles "Here is the concise summary:" prefix', () => {
    expect(sanitizeAiCompletion('Here is the concise summary: Does stuff.')).toBe('Does stuff.');
  });

  it('handles "Here is the summary sentence:" prefix', () => {
    expect(sanitizeAiCompletion('Here is the summary sentence: Does stuff.')).toBe('Does stuff.');
  });

  it('trims whitespace', () => {
    expect(sanitizeAiCompletion('  Builds the thing.  ')).toBe('Builds the thing.');
  });

  it('handles complex nested thinking blocks', () => {
    const input = '<think>step 1\nstep 2</think>Here is the summary: Builds the thing.';
    expect(sanitizeAiCompletion(input)).toBe('Builds the thing.');
  });

  it('handles multiple <think> blocks', () => {
    const input = '<think>first</think><think>second</think>Builds the thing.';
    expect(sanitizeAiCompletion(input)).toBe('Builds the thing.');
  });

  it('handles mixed case tags', () => {
    const input = '<THINK>reasoning</THINK>Builds the thing.';
    expect(sanitizeAiCompletion(input)).toBe('Builds the thing.');
  });

  it('handles plain text unchanged', () => {
    expect(sanitizeAiCompletion('Builds the thing.')).toBe('Builds the thing.');
  });

  it('handles Thinking Process with asterisks', () => {
    const input = '*Thinking Process*:\nDraft 1: Bad.\nSummary: Creates the item.\n';
    expect(sanitizeAiCompletion(input)).toBe('Creates the item.');
  });
});

describe('normalizeSentence', () => {
  it('returns default for empty input', () => {
    expect(normalizeSentence('')).toBe('Performs the operation.');
    expect(normalizeSentence('   ')).toBe('Performs the operation.');
  });

  it('trims quotes and adds period', () => {
    expect(normalizeSentence('"Builds the thing"')).toBe('Builds the thing.');
  });

  it('trims backticks and adds period', () => {
    expect(normalizeSentence('`Builds the thing`')).toBe('Builds the thing.');
  });

  it('trims asterisks and adds period', () => {
    expect(normalizeSentence('*Builds the thing*')).toBe('Builds the thing.');
  });

  it('collapses whitespace', () => {
    expect(normalizeSentence('Builds   the   thing.')).toBe('Builds the thing.');
  });

  it('adds period when missing', () => {
    expect(normalizeSentence('Builds the thing')).toBe('Builds the thing.');
  });

  it('keeps existing period', () => {
    expect(normalizeSentence('Builds the thing.')).toBe('Builds the thing.');
  });

  it('keeps exclamation mark', () => {
    expect(normalizeSentence('Builds the thing!')).toBe('Builds the thing!');
  });

  it('keeps question mark', () => {
    expect(normalizeSentence('What does it do?')).toBe('What does it do?');
  });

  it('handles AI completion with thinking', () => {
    expect(normalizeSentence('<think>reasoning</think>Creates the widget')).toBe('Creates the widget.');
  });

  it('handles AI completion with markdown fence', () => {
    expect(normalizeSentence('```csharp\nCreates the widget.\n```')).toBe('Creates the widget.');
  });
});

describe('createDefaultXmlDocOptions', () => {
  it('creates defaults with maxMembersPerFile', () => {
    const opts = createDefaultXmlDocOptions(10);

    expect(opts.maxMembersPerFile).toBe(10);
    expect(opts.maxInputCharsPerMember).toBe(2500);
    expect(opts.ignoreGeneratedCode).toBe(false);
    expect(opts.ignoreObsolete).toBe(false);
    expect(opts.ignoreTestMethods).toBe(false);
    expect(opts.ignorePattern).toBe('');
  });

  it('uses 25 as default maxMembersPerFile', () => {
    const opts = createDefaultXmlDocOptions();

    expect(opts.maxMembersPerFile).toBe(25);
  });

  it('clamps zero or negative to 25', () => {
    expect(createDefaultXmlDocOptions(0).maxMembersPerFile).toBe(25);
    expect(createDefaultXmlDocOptions(-5).maxMembersPerFile).toBe(25);
  });
});
