import { describe, expect, it } from 'vitest';

import {
  MARKER_END,
  MARKER_START,
  extractMarkerBlock,
  replaceMarkerBlock,
} from '../src/core/markers';

/**
 * Spec §H: "`replaceMarkerBlock` preserves text above and below the markers,
 * handles a missing marker pair by appending one, and is idempotent."
 *
 * These three properties are the whole safety argument for pointing a
 * generator at a file a human also edits (§ "Prior art"): replace a marked
 * block, never merge.
 */
describe('replaceMarkerBlock', () => {
  const withBlock = (body: string) =>
    ['---', 'title: Agent Builder', '---', '', 'My own notes above.', '', MARKER_START, body, MARKER_END, '', 'My own notes below.', ''].join('\n');

  it('preserves text above and below the markers byte for byte', () => {
    const out = replaceMarkerBlock(withBlock('old generated body'), 'new generated body');

    expect(out).toContain('My own notes above.');
    expect(out).toContain('My own notes below.');
    expect(out).toContain('title: Agent Builder');
    expect(out).not.toContain('old generated body');
    expect(out).toBe(withBlock('new generated body'));
  });

  it('does not disturb a user paragraph that mentions the marker text in prose', () => {
    const content = ['Notes about %% javis:generated:start %%-style markers follow.', '', 'more notes'].join('\n');
    const out = replaceMarkerBlock(content, 'body');
    // The prose mention IS the first start marker, so the text above it is
    // preserved and everything after is treated as the (unterminated) block.
    expect(out.startsWith('Notes about ')).toBe(true);
    expect(replaceMarkerBlock(out, 'body')).toBe(out);
  });

  it('appends a block when the file has no markers, keeping the existing text', () => {
    const content = '---\ntitle: Mine\n---\n\nEntirely hand-written.\n';
    const out = replaceMarkerBlock(content, 'generated');

    expect(out).toContain('Entirely hand-written.');
    expect(out).toContain(MARKER_START);
    expect(out).toContain(MARKER_END);
    expect(out.indexOf('Entirely hand-written.')).toBeLessThan(out.indexOf(MARKER_START));
    expect(out).toBe('---\ntitle: Mine\n---\n\nEntirely hand-written.\n\n' + MARKER_START + '\ngenerated\n' + MARKER_END + '\n');
  });

  it('appends exactly one block to an empty file', () => {
    const out = replaceMarkerBlock('', 'generated');
    expect(out).toBe(`${MARKER_START}\ngenerated\n${MARKER_END}\n`);
    expect(out.split(MARKER_START)).toHaveLength(2);
  });

  it('closes an unterminated start marker instead of appending a second one', () => {
    const content = `Above.\n\n${MARKER_START}\nhalf-written body with no end marker\n`;
    const out = replaceMarkerBlock(content, 'fresh');

    expect(out.split(MARKER_START)).toHaveLength(2);
    expect(out.split(MARKER_END)).toHaveLength(2);
    expect(out).toContain('Above.');
    expect(out).not.toContain('half-written body');
  });

  it('is idempotent across every shape of input', () => {
    const inputs = [
      '',
      'plain text, no markers\n',
      withBlock('old body'),
      `Above.\n\n${MARKER_START}\nunterminated\n`,
      `${MARKER_END}\nstray end marker on its own\n`,
      `${MARKER_START}\n${MARKER_END}\n`,
      '   \n\n  \n',
    ];
    for (const input of inputs) {
      for (const body of ['new body', '', 'multi\nline\nbody']) {
        const once = replaceMarkerBlock(input, body);
        const twice = replaceMarkerBlock(once, body);
        expect(twice, `not idempotent for ${JSON.stringify(input)} / ${JSON.stringify(body)}`).toBe(once);
      }
    }
  });

  it('normalizes CRLF so a Windows-edited file does not churn on every sync', () => {
    const crlf = `Above.\r\n\r\n${MARKER_START}\r\nold\r\n${MARKER_END}\r\n`;
    const out = replaceMarkerBlock(crlf, 'new');
    expect(out).not.toContain('\r');
    expect(replaceMarkerBlock(out, 'new')).toBe(out);
  });

  it('writes an empty but well-formed block for an empty body', () => {
    const out = replaceMarkerBlock(withBlock('old'), '');
    expect(out).toContain(`${MARKER_START}\n${MARKER_END}`);
    expect(out).toContain('My own notes below.');
  });
});

describe('extractMarkerBlock', () => {
  it('returns the generated text and nothing around it', () => {
    const content = `Above.\n\n${MARKER_START}\nthe body\n${MARKER_END}\n\nBelow.\n`;
    expect(extractMarkerBlock(content)).toBe('the body');
  });

  it('returns null when there is no complete marker pair', () => {
    expect(extractMarkerBlock('no markers here')).toBeNull();
    expect(extractMarkerBlock(`${MARKER_START}\nunterminated`)).toBeNull();
  });

  it('round-trips what replaceMarkerBlock wrote', () => {
    const out = replaceMarkerBlock('Above.\n', 'multi\nline\nbody');
    expect(extractMarkerBlock(out)).toBe('multi\nline\nbody');
  });
});
