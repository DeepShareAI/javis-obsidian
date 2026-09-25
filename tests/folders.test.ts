/**
 * Tests for src/core/folders.ts — §F.3.1 folder validation.
 */

import { describe, expect, it } from 'vitest';

import { isUnderFolder, normalizeFolder, validateFolders } from '../src/core/folders';
import { TYPE_TO_PLURAL } from '../src/core/slug';

describe('normalizeFolder', () => {
  it('trims, strips slashes, and collapses doubled slashes', () => {
    expect(normalizeFolder(' /Journal/ ')).toBe('Journal');
    expect(normalizeFolder('a//b')).toBe('a/b');
    expect(normalizeFolder('/')).toBe('');
  });
});

describe('validateFolders', () => {
  const ok = (folders: string[], configDir = '.obsidian') => validateFolders(folders, configDir);

  it('accepts ordinary sibling folders', () => {
    expect(ok(['Journal', 'Inbox'])).toEqual({ ok: ['Journal', 'Inbox'], errors: [] });
  });

  it('rejects the vault root', () => {
    const result = ok(['', '/']);
    expect(result.ok).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.reason).toMatch(/root/i);
  });

  it('rejects the config folder and anything inside it, including a custom one', () => {
    expect(ok(['.obsidian', '.obsidian/x']).errors).toHaveLength(2);
    const custom = ok(['.config', 'cfg'], '.config');
    expect(custom.ok).toEqual(['cfg']);
    expect(custom.errors[0]!.reason).toMatch(/settings/i);
  });

  it('rejects each of the nine wiki folders and anything inside one', () => {
    for (const folder of Object.values(TYPE_TO_PLURAL)) {
      const result = ok([folder]);
      expect(result.ok).toEqual([]);
      expect(result.errors[0]!.reason).toMatch(/wiki/i);
    }
    expect(ok(['Concepts/Sub']).errors).toHaveLength(1);
  });

  it('treats a name prefix as a different folder', () => {
    expect(ok(['Conceptsfoo', 'Journal2', 'Journal']).errors).toEqual([]);
  });

  it('rejects nested selections, both ends', () => {
    const result = ok(['A', 'A/B']);
    expect(result.ok).toEqual([]);
    expect(result.errors.map((e) => e.folder)).toEqual(['A', 'A/B']);
    expect(result.errors[0]!.reason).toMatch(/inside|contains/i);
  });

  it('rejects duplicates, after normalization', () => {
    const result = ok(['Journal', '/Journal/']);
    expect(result.errors).toHaveLength(1);
    expect(result.ok).toEqual(['Journal']);
  });

  it('rejects hidden folders, which Obsidian never lists notes from', () => {
    expect(ok(['.hidden']).errors).toHaveLength(1);
    expect(ok(['Notes/.trash']).errors).toHaveLength(1);
  });

  it('returns user-facing sentences', () => {
    for (const e of ok(['', 'Concepts', 'A', 'A/B']).errors) {
      expect(e.reason).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('isUnderFolder', () => {
  it('is a path-segment prefix test', () => {
    expect(isUnderFolder('Journal/a.md', 'Journal')).toBe(true);
    expect(isUnderFolder('Journal/2026/a.md', 'Journal')).toBe(true);
    expect(isUnderFolder('Journal2/a.md', 'Journal')).toBe(false);
    expect(isUnderFolder('Journal', 'Journal')).toBe(false);
    expect(isUnderFolder('a.md', '')).toBe(false);
  });
});
