/**
 * E2E runbook D2 + F3 (2026-09-26).
 *
 * D2: reordering two frontmatter keys (what Obsidian's Properties editor does)
 * changed the upload hash, so the note was re-sent and re-distilled for no
 * content change. The wire hash must stay `sha256(uploadText)` (the server
 * checks it), so the planner gets a second, order-insensitive `contentKey`.
 *
 * F3: the empty and >80%-shrink guards measured the whole sent text, and a
 * short note's frontmatter kept a body wipe above both thresholds (177 → 82
 * bytes, body gone, uploaded). They now measure the body after the block.
 */
import { describe, expect, it } from 'vitest';

import { bodyText, contentKey } from '../src/core/note-text';
import { describeNote } from '../src/shell/upload';

const ID = 'javis_source_id: 11111111-2222-4333-8444-555555555555';

describe('bodyText', () => {
  it('is the text after the frontmatter block', () => {
    expect(bodyText(`---\ntitle: T\n${ID}\n---\n# Body\n\nText\n`)).toBe('# Body\n\nText\n');
  });
  it('is the whole note when there is no block', () => {
    expect(bodyText('# Just a body\n')).toBe('# Just a body\n');
  });
  it('is the whole note when the block is malformed (never closed)', () => {
    expect(bodyText('---\ntitle: T\n# body\n')).toBe('---\ntitle: T\n# body\n');
  });
});

describe('contentKey', () => {
  const base = `---\ntitle: Heliotrope budget\nstatus: draft\nowner: finance\n${ID}\n---\n# Budget\n\nHB-3301\n`;

  it('ignores the order of top-level frontmatter keys', () => {
    const reordered = `---\ntitle: Heliotrope budget\nowner: finance\nstatus: draft\n${ID}\n---\n# Budget\n\nHB-3301\n`;
    expect(contentKey(reordered)).toBe(contentKey(base));
  });

  it('keeps a key together with its continuation lines when reordering', () => {
    const a = `---\ntags:\n  - a\n  - b\ntitle: T\n---\nx\n`;
    const b = `---\ntitle: T\ntags:\n  - a\n  - b\n---\nx\n`;
    const c = `---\ntitle: T\ntags:\n  - b\n  - a\n---\nx\n`;
    expect(contentKey(a)).toBe(contentKey(b));
    expect(contentKey(c)).not.toBe(contentKey(a));
  });

  it('changes when a value or the body changes', () => {
    expect(contentKey(base.replace('status: draft', 'status: final'))).not.toBe(contentKey(base));
    expect(contentKey(base.replace('HB-3301', 'HB-3302'))).not.toBe(contentKey(base));
  });

  it('ignores javis_* keys and line-ending style', () => {
    const noId = base.replace(`${ID}\n`, '');
    expect(contentKey(noId)).toBe(contentKey(base));
    expect(contentKey(base.replace(/\n/g, '\r\n'))).toBe(contentKey(base));
  });
});

describe('describeNote measures the body (F3)', () => {
  it('a note left with only its properties is blank', () => {
    const d = describeNote('Journal/f6.md', `---\ntitle: Filler 06\n${ID}\n---\n\n`, null);
    expect(d.blank).toBe(true);
    expect(d.bodyBytes).toBe(1);
    expect(d.bytes).toBeGreaterThan(d.bodyBytes);
  });

  it('bodyBytes counts only what follows the block', () => {
    const d = describeNote('Journal/n.md', `---\ntitle: Big properties block here\n${ID}\n---\n12345`, null);
    expect(d.bodyBytes).toBe(5);
    expect(d.blank).toBe(false);
    expect(d.contentKey).toBe(contentKey(`---\ntitle: Big properties block here\n${ID}\n---\n12345`));
  });
});
