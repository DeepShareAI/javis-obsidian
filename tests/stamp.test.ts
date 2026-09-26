/**
 * Tests for src/core/stamp.ts — the §H "stamp inserter" bullets.
 *
 * The central assertion is literal: remove the one line the stamp inserted and
 * the result is `===` the input. Nothing else in the file may move.
 */

import { describe, expect, it } from 'vitest';

import { restampText, stampText } from '../src/core/stamp';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** The §H YAML fixture: comments, quotes, flow lists, dates, a tag, a blank line. */
const YAML_FIXTURE = [
  '---',
  '# my own comment, which processFrontMatter would drop',
  "single: 'quoted value'",
  'double: "quoted: value"',
  'tags: [a, b]',
  'date: 2026-09-24',
  'odd: !!str x',
  '',
  'aliases:',
  '  - One',
  '---',
  'Body text.',
  '',
].join('\n');

function ok(result: ReturnType<typeof stampText>): string {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result.text;
}

describe('stampText', () => {
  it('inserts exactly one line before the closing fence, byte-identical otherwise', () => {
    const out = ok(stampText(YAML_FIXTURE, ID));
    const line = `javis_source_id: ${ID}\n`;
    expect(out.split(line).length).toBe(2);
    expect(out.replace(line, '')).toBe(YAML_FIXTURE);
    // Directly before the closing fence.
    expect(out).toContain(`  - One\n${line}---\nBody text.`);
  });

  it('prepends a block to a note with no frontmatter', () => {
    expect(ok(stampText('# Title\nbody\n', ID))).toBe(`---\njavis_source_id: ${ID}\n---\n# Title\nbody\n`);
    expect(ok(stampText('', ID))).toBe(`---\njavis_source_id: ${ID}\n---\n`);
  });

  it('keeps a BOM as the first bytes of the file (D-STAMP-2)', () => {
    expect(ok(stampText('﻿body\n', ID))).toBe(`﻿---\njavis_source_id: ${ID}\n---\nbody\n`);
    expect(ok(stampText('﻿---\na: 1\n---\n', ID))).toBe(`﻿---\na: 1\njavis_source_id: ${ID}\n---\n`);
  });

  it('inserts into an empty block', () => {
    expect(ok(stampText('---\n---\nbody\n', ID))).toBe(`---\njavis_source_id: ${ID}\n---\nbody\n`);
  });

  it('handles a file that is exactly ---\\n--- with no trailing break', () => {
    expect(ok(stampText('---\n---', ID))).toBe(`---\njavis_source_id: ${ID}\n---`);
  });

  it('uses the file\'s CRLF and leaves no bare \\n behind (D-STAMP-1)', () => {
    const crlf = '---\r\ntitle: x\r\n---\r\nbody\r\n';
    const out = ok(stampText(crlf, ID));
    expect(out).toBe(`---\r\ntitle: x\r\njavis_source_id: ${ID}\r\n---\r\nbody\r\n`);
    expect(/(^|[^\r])\n/.test(out)).toBe(false);
    const noFm = ok(stampText('a\r\nb\r\n', ID));
    expect(noFm).toBe(`---\r\njavis_source_id: ${ID}\r\n---\r\na\r\nb\r\n`);
  });

  it('refuses a malformed note (opening fence, no close)', () => {
    expect(stampText('---\ntitle: x\nbody\n', ID)).toEqual({ kind: 'malformed' });
    expect(stampText('---', ID)).toEqual({ kind: 'malformed' });
  });

  it('is idempotent: stamping twice is a no-op', () => {
    const once = ok(stampText(YAML_FIXTURE, ID));
    expect(stampText(once, ID2)).toEqual({ kind: 'already' });
    expect(stampText(once, ID)).toEqual({ kind: 'already' });
  });

  it('never stamps over an existing line, even an invalid one', () => {
    expect(stampText('---\njavis_source_id: hand-typed\n---\n', ID)).toEqual({ kind: 'already' });
  });

  it('stamps a note whose javis_source_id is only in the body', () => {
    const text = `plain\njavis_source_id: ${ID2}\n`;
    expect(ok(stampText(text, ID))).toBe(`---\njavis_source_id: ${ID}\n---\n${text}`);
  });
});

describe('restampText', () => {
  it('replaces the value only, byte-identical elsewhere', () => {
    const stamped = ok(stampText(YAML_FIXTURE, ID));
    const out = restampText(stamped, ID2);
    expect(out).toEqual({ kind: 'ok', text: stamped.replace(ID, ID2) });
  });

  it('writes a bare uuid over a quoted one and keeps the CRLF', () => {
    const text = `---\r\na: 1\r\njavis_source_id: "${ID}"\r\nb: 2\r\n---\r\n`;
    expect(restampText(text, ID2)).toEqual({
      kind: 'ok',
      text: `---\r\na: 1\r\njavis_source_id: ${ID2}\r\nb: 2\r\n---\r\n`,
    });
  });

  it('is a no-op when the value is already the new id (any case, any quotes)', () => {
    expect(restampText(`---\njavis_source_id: '${ID.toUpperCase()}'\n---\n`, ID)).toEqual({ kind: 'already' });
  });

  it('passes malformed through, and reports a note with no id line', () => {
    expect(restampText(`---\njavis_source_id: ${ID}\n`, ID2)).toEqual({ kind: 'malformed' });
    expect(restampText('body only', ID2)).toEqual({ kind: 'missing' });
  });

  it('rewrites only the first of two id lines', () => {
    const text = `---\njavis_source_id: ${ID}\njavis_source_id: ${ID}\n---\n`;
    expect(restampText(text, ID2)).toEqual({
      kind: 'ok',
      text: `---\njavis_source_id: ${ID2}\njavis_source_id: ${ID}\n---\n`,
    });
  });
});
