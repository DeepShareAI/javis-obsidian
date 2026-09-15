/**
 * Tests for the pure half of src/shell/vault.ts.
 *
 * `ObsidianVaultAdapter` itself is exempt from unit tests by spec §H — it is
 * exercised manually against a scratch vault. Everything that could be pulled
 * out of it and tested without a runtime was, and that is what this file
 * covers: path arithmetic, the folder set, the frontmatter-block scanner, and
 * the §F.1 max-revision reduction.
 *
 * That this file imports src/shell/vault.ts at all is itself an assertion: the
 * `obsidian` package ships types and no JavaScript, so a module importing it at
 * runtime cannot be loaded here. If someone converts the lazy `require` into a
 * static import, every test below fails at collection.
 */

import { describe, expect, it } from 'vitest';

import { TYPE_TO_PLURAL, pathForPage } from '../src/core/slug';
import type { VaultNote } from '../src/shell/contracts';
import {
  MANAGED_FOLDERS,
  REVISION_FUTURE_SKEW_MS,
  extractFrontmatterBlock,
  folderAncestors,
  maxRevision,
  parentFolder,
  parseFrontmatterBlock,
} from '../src/shell/vault';

describe('MANAGED_FOLDERS', () => {
  it('is the nine §E folders', () => {
    expect(MANAGED_FOLDERS).toEqual([
      'Comparisons',
      'Concepts',
      'Decisions',
      'Entities',
      'Gaps',
      'Questions',
      'Sources',
      'Syntheses',
      'Topics',
    ]);
  });

  it('covers the folder of every path pathForPage can produce', () => {
    for (const pageType of Object.keys(TYPE_TO_PLURAL)) {
      const path = pathForPage(pageType, 'Whatever');
      expect(path).not.toBeNull();
      expect(MANAGED_FOLDERS).toContain(parentFolder(path as string));
    }
  });

  it('holds no duplicates', () => {
    expect(new Set(MANAGED_FOLDERS).size).toBe(MANAGED_FOLDERS.length);
  });
});

describe('parentFolder', () => {
  it('returns the containing folder', () => {
    expect(parentFolder('Concepts/Agent-Builder.md')).toBe('Concepts');
  });

  it('returns the whole chain for a nested path', () => {
    expect(parentFolder('A/B/C/note.md')).toBe('A/B/C');
  });

  it('returns null at the vault root', () => {
    expect(parentFolder('note.md')).toBeNull();
  });

  it('returns null for a path that only looks rooted', () => {
    // A leading slash is not a vault path; treating '' as a folder name and
    // trying to create it would be worse than ignoring it.
    expect(parentFolder('/note.md')).toBeNull();
  });
});

describe('folderAncestors', () => {
  it('yields the single folder of a §E path', () => {
    expect(folderAncestors('Concepts/Agent-Builder.md')).toEqual(['Concepts']);
  });

  it('yields every ancestor, outermost first', () => {
    // Vault.createFolder does not create intermediate folders, so the order is
    // the contract, not a detail.
    expect(folderAncestors('A/B/C/note.md')).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('is empty at the vault root', () => {
    expect(folderAncestors('note.md')).toEqual([]);
  });

  it('drops empty segments rather than inventing a folder named ""', () => {
    expect(folderAncestors('A//B/note.md')).toEqual(['A', 'A/B']);
  });
});

describe('extractFrontmatterBlock', () => {
  it('returns the YAML between the opening and closing fences', () => {
    const content = '---\ntitle: Agent Builder\njavis_sync: true\n---\n\nbody\n';
    expect(extractFrontmatterBlock(content)).toBe('title: Agent Builder\njavis_sync: true');
  });

  it('returns null when the file has no frontmatter', () => {
    expect(extractFrontmatterBlock('Just a note.\n')).toBeNull();
  });

  it('returns null when the fence is not the very first line', () => {
    // Obsidian applies no properties to such a file; agreeing with it is the
    // whole point — a note the user believes is unmanaged must not be read as
    // adopted or as unchanged.
    expect(extractFrontmatterBlock('\n---\ntitle: X\n---\n')).toBeNull();
  });

  it('returns null when the opening fence is never closed', () => {
    expect(extractFrontmatterBlock('---\ntitle: X\n\nstill going\n')).toBeNull();
  });

  it('ignores a --- used as a horizontal rule further down', () => {
    const content = 'Above.\n\n---\n\nBelow.\n';
    expect(extractFrontmatterBlock(content)).toBeNull();
  });

  it('stops at the FIRST closing fence', () => {
    const content = '---\na: 1\n---\nbody\n---\nnot frontmatter\n---\n';
    expect(extractFrontmatterBlock(content)).toBe('a: 1');
  });

  it('handles an empty block', () => {
    expect(extractFrontmatterBlock('---\n---\nbody\n')).toBe('');
  });

  it('handles CRLF line endings', () => {
    expect(extractFrontmatterBlock('---\r\ntitle: X\r\n---\r\nbody\r\n')).toBe('title: X');
  });

  it('skips a UTF-8 BOM', () => {
    expect(extractFrontmatterBlock('﻿---\ntitle: X\n---\n')).toBe('title: X');
  });

  it('does not treat an indented fence as a fence', () => {
    expect(extractFrontmatterBlock('---\na: 1\n  ---\nb: 2\n')).toBeNull();
  });
});

describe('parseFrontmatterBlock', () => {
  const asObject = (yaml: string): unknown => (yaml === '' ? null : { yaml });

  it('returns the parsed object', () => {
    const fm = parseFrontmatterBlock('---\na: 1\n---\nbody\n', asObject);
    expect(fm).toEqual({ yaml: 'a: 1' });
  });

  it('returns null when there is no block', () => {
    expect(parseFrontmatterBlock('body only\n', asObject)).toBeNull();
  });

  it('returns null for an empty block', () => {
    // An empty block parses to null in YAML, which is not frontmatter.
    expect(parseFrontmatterBlock('---\n---\nbody\n', asObject)).toBeNull();
  });

  it('returns null when the block parses to a scalar', () => {
    expect(parseFrontmatterBlock('---\njust a string\n---\n', () => 'just a string')).toBeNull();
  });

  it('returns null when the block parses to a list', () => {
    expect(parseFrontmatterBlock('---\n- a\n- b\n---\n', () => ['a', 'b'])).toBeNull();
  });

  it('returns null rather than throwing when the YAML is broken', () => {
    // A note whose properties the user has mangled is skipped, not fatal.
    const boom = (): unknown => {
      throw new Error('YAMLParseError');
    };
    expect(parseFrontmatterBlock('---\na: [\n---\n', boom)).toBeNull();
  });

  it('never calls the parser when there is no block', () => {
    let calls = 0;
    parseFrontmatterBlock('no frontmatter', () => {
      calls += 1;
      return {};
    });
    expect(calls).toBe(0);
  });
});

describe('maxRevision', () => {
  const note = (path: string, rev: unknown): VaultNote => ({
    path,
    frontmatter: rev === undefined ? null : { javis_rev: rev },
  });

  it('is null for an empty vault', () => {
    expect(maxRevision([])).toBeNull();
  });

  it('is null when nothing carries a javis_rev', () => {
    expect(maxRevision([note('a.md', undefined), { path: 'b.md', frontmatter: {} }])).toBeNull();
  });

  it('returns the newest revision', () => {
    const notes = [
      note('a.md', '2026-09-01T00:00:00Z'),
      note('b.md', '2026-09-13T04:12:00Z'),
      note('c.md', '2026-05-30T23:59:59Z'),
    ];
    expect(maxRevision(notes)).toBe('2026-09-13T04:12:00Z');
  });

  it('returns the string verbatim, since it goes straight back out as ?since=', () => {
    expect(maxRevision([note('a.md', '2026-09-13T04:12:00.123456+00:00')])).toBe(
      '2026-09-13T04:12:00.123456+00:00',
    );
  });

  it('orders by instant, not lexicographically', () => {
    // '2026-09-13T03:12:00-02:00' sorts BEFORE '2026-09-13T04:12:00Z' as a
    // string, but is 05:12Z — the later moment by an hour. A string compare
    // would pick the wrong one and lose an hour of updates.
    const notes = [note('a.md', '2026-09-13T04:12:00Z'), note('b.md', '2026-09-13T03:12:00-02:00')];
    expect(maxRevision(notes)).toBe('2026-09-13T03:12:00-02:00');
  });

  it('ignores a javis_rev that is not a string', () => {
    // js-yaml resolves an unquoted ISO8601 to a Date; a file written by an
    // older plugin build, or by hand, can carry one.
    const notes = [note('a.md', new Date('2099-01-01T00:00:00Z')), note('b.md', '2026-01-01T00:00:00Z')];
    expect(maxRevision(notes)).toBe('2026-01-01T00:00:00Z');
  });

  it('ignores an unparseable javis_rev', () => {
    // A hand-mangled rev must not be able to push the cursor forward and
    // silently skip every update behind it.
    const notes = [note('a.md', 'yesterday, ish'), note('b.md', '2026-01-01T00:00:00Z')];
    expect(maxRevision(notes)).toBe('2026-01-01T00:00:00Z');
  });

  it('ignores notes with no frontmatter at all', () => {
    const notes = [{ path: 'a.md', frontmatter: null }, note('b.md', '2026-01-01T00:00:00Z')];
    expect(maxRevision(notes)).toBe('2026-01-01T00:00:00Z');
  });

  it('keeps the first of two equal revisions', () => {
    const notes = [note('a.md', '2026-01-01T00:00:00Z'), note('b.md', '2026-01-01T00:00:00.000Z')];
    expect(maxRevision(notes)).toBe('2026-01-01T00:00:00Z');
  });

  it('ignores a rev dated in the future, which parses perfectly and is still wrong', () => {
    // A year typed wrong in the Properties editor. It parses, so the "not a
    // date" guard above never sees it; as the cursor it would make the server
    // answer with zero rows, and the run would then stamp `cachedCursor =
    // server_time` — losing every update between the vault's real state and
    // now, unrecoverably, because "Forget position" re-derives the same value.
    const now = Date.parse('2026-09-14T00:00:00Z');
    const notes = [note('a.md', '2126-01-01T00:00:00Z'), note('b.md', '2026-09-13T00:00:00Z')];
    expect(maxRevision(notes, now)).toBe('2026-09-13T00:00:00Z');
  });

  it('is null when every rev is future-dated, which asks for a full export', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    expect(maxRevision([note('a.md', '2126-01-01T00:00:00Z')], now)).toBeNull();
  });

  it('allows the skew a server clock ahead of this one produces', () => {
    // `javis_rev` is the SERVER's updated_at, so a laptop running a few minutes
    // slow reads every fresh revision as slightly future-dated. Rejecting those
    // would re-export the whole wiki on every sync.
    const now = Date.parse('2026-09-14T00:00:00Z');
    const skewed = new Date(now + REVISION_FUTURE_SKEW_MS - 1_000).toISOString();
    expect(maxRevision([note('a.md', skewed)], now)).toBe(skewed);
  });

  it('rejects the moment the allowance runs out', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    const beyond = new Date(now + REVISION_FUTURE_SKEW_MS + 1_000).toISOString();
    expect(maxRevision([note('a.md', beyond)], now)).toBeNull();
  });
});
