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
  resolveFolderCase,
} from '../src/shell/vault';

describe('MANAGED_FOLDERS', () => {
  it('is the nine §E folders, under Javis-wiki', () => {
    expect(MANAGED_FOLDERS).toEqual([
      'Javis-wiki/Comparisons',
      'Javis-wiki/Concepts',
      'Javis-wiki/Decisions',
      'Javis-wiki/Entities',
      'Javis-wiki/Gaps',
      'Javis-wiki/Questions',
      'Javis-wiki/Sources',
      'Javis-wiki/Syntheses',
      'Javis-wiki/Topics',
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

describe('resolveFolderCase (review: a differently-cased Javis-wiki folder)', () => {
  // A tiny folder tree: parent real path ('' = vault root) -> child folder names.
  const tree = (folders: Record<string, string[]>) => (parent: string) => folders[parent] ?? [];

  it('uses an existing folder whose name differs only in case', () => {
    // On APFS/NTFS `createFolder('Javis-wiki')` throws "Folder already exists."
    // when `javis-wiki` is there, and the exact-case lookup never finds it.
    const children = tree({ '': ['javis-wiki'], 'javis-wiki': ['concepts'] });
    expect(resolveFolderCase('Javis-wiki/Concepts/Foo.md', children)).toBe('javis-wiki/concepts/Foo.md');
  });

  it('keeps the rest of the path as given once a folder does not exist yet', () => {
    const children = tree({ '': ['javis-wiki'] });
    expect(resolveFolderCase('Javis-wiki/Concepts/Foo.md', children)).toBe('javis-wiki/Concepts/Foo.md');
  });

  it('prefers the exact spelling when both exist (a case-sensitive volume)', () => {
    const children = tree({ '': ['javis-wiki', 'Javis-wiki'], 'Javis-wiki': ['Concepts'] });
    expect(resolveFolderCase('Javis-wiki/Concepts/Foo.md', children)).toBe('Javis-wiki/Concepts/Foo.md');
  });

  it('leaves the file name and root-level paths alone', () => {
    const children = tree({ '': ['foo.md'] });
    expect(resolveFolderCase('Foo.md', children)).toBe('Foo.md');
    expect(resolveFolderCase('Javis-wiki/Concepts/Foo.md', tree({}))).toBe('Javis-wiki/Concepts/Foo.md');
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

// ---------------------------------------------------------------------------
// 0.2.0: the upload half's vault helpers (spec 2026-09-24 §F.2)
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { cachedSourceIdHint, notesUnder } from '../src/shell/vault';

describe('notesUnder', () => {
  it('keeps markdown under a selected folder, by path segment', () => {
    expect(
      notesUnder(
        ['Journal/a.md', 'Journal/sub/b.md', 'Journal2/c.md', 'Journal/d.canvas', 'root.md', 'Inbox/e.MD'],
        ['Journal', 'Inbox'],
      ),
    ).toEqual(['Journal/a.md', 'Journal/sub/b.md']);
  });

  it('keeps only a lowercase .md extension, as the server does (contract review)', () => {
    // The server answers 400 "vault_path must be a .md note" for `.MD`/`.Md`;
    // enumerating one would stamp it on disk and then fail its PUT every run.
    expect(notesUnder(['Inbox/e.MD', 'Inbox/f.Md', 'Inbox/g.md'], ['Inbox'])).toEqual(['Inbox/g.md']);
  });
});

describe('cachedSourceIdHint', () => {
  it('returns a lowercased uuid or null', () => {
    const id = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
    expect(cachedSourceIdHint({ javis_source_id: id.toUpperCase() })).toBe(id);
    expect(cachedSourceIdHint({ javis_source_id: 'nope' })).toBeNull();
    expect(cachedSourceIdHint({ javis_source_id: 42 })).toBeNull();
    expect(cachedSourceIdHint(undefined)).toBeNull();
  });
});

describe('the plugin never deletes or trashes a vault file (§F.2)', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  // Every Obsidian route to removing a file, not just `vault.delete`/`trash`
  // (review): `fileManager.trashFile` is the API Obsidian recommends, and the
  // adapter's `remove`/`rmdir`/`trashSystem`/`trashLocal` are the usual way
  // around the vault. On a vault, adapter or fileManager receiver (optional
  // chaining included), any of those names; the trash-only names anywhere,
  // since nothing else in this codebase is called that.
  const REMOVAL =
    /\b(vault|adapter|fileManager)\s*\??\.\s*(delete|trash|trashFile|remove|rmdir|trashSystem|trashLocal)\s*\(|\.\s*(trash|trashFile|trashSystem|trashLocal|rmdir)\s*\(/;

  it('the pattern catches every removal API it is meant to', () => {
    for (const line of [
      'await this.app.vault.delete(file);',
      'await app.vault.trash(file, true);',
      'await this.#app.fileManager.trashFile(file);',
      'await this.app.vault.adapter.remove(path);',
      'await adapter.rmdir(dir, true);',
      'await this.app.vault.adapter.trashSystem(path);',
      'await vault.adapter?.trashLocal(path);',
      'await (x as any).trash(file);',
    ]) {
      expect(REMOVAL.test(line), line).toBe(true);
    }
    for (const line of ['this.opts.secrets.delete(id);', 'owed.delete(id);', 'deps.api.delete(action.sourceId)']) {
      expect(REMOVAL.test(line), line).toBe(false);
    }
  });

  // The one sanctioned removal (spec 2026-09-27): `removeFolderIfEmpty` deletes
  // a FOLDER, and only after checking it has no children. It can never take a
  // note with it. Exempted by exact file and line text, so any other removal —
  // including a second `vault.delete` in the same file — still fails.
  const SANCTIONED = new Set([`${join('src', 'shell', 'vault.ts')}: await this.#app.vault.delete(folder);`]);

  it('no source file calls a vault, adapter or fileManager removal API', () => {
    // Code lines only: the prohibition is quoted in several doc comments.
    const root = join(__dirname, '..');
    const offenders = sources(join(root, 'src')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .filter((line) => REMOVAL.test(line))
        .map((line) => `${relative(root, file)}: ${line.trim()}`),
    );
    expect(offenders.filter((o) => !SANCTIONED.has(o))).toEqual([]);
    // The exemption is used exactly once; a copy of the line elsewhere in the file would show twice.
    expect(offenders.filter((o) => SANCTIONED.has(o))).toHaveLength(1);
  });

  // Review: with the sanctioned removal above in the code, no prose may still
  // promise there is no `vault.delete` call or no delete primitive at all.
  it('no README or header comment claims the plugin has no delete call', () => {
    const root = join(__dirname, '..');
    const stale = [
      /no call to\s*(>\s*)?`vault\.delete`/,
      /no `delete`, no `trash`, and no way to reach one/,
      /exposes none to call/,
      /no route to the\s*(\*\s*)?vault's destructive API/,
      /with no delete and no trash/,
    ];
    const files = ['README.md', ...sources(join(root, 'src')).map((f) => relative(root, f))];
    const hits = files.flatMap((file) => {
      const text = readFileSync(join(root, file), 'utf8');
      return stale.filter((re) => re.test(text)).map((re) => `${file}: ${re.source}`);
    });
    expect(hits).toEqual([]);
  });
});

describe('the layout move never triggers Obsidian link updates (review)', () => {
  // `FileManager.renameFile` runs Obsidian's link update, and with the default
  // "Automatically update internal links" off that update opens a blocking
  // "Update links?" modal per moved page with incoming links; the sync awaits
  // each one. `Vault.rename` never touches links, and `[[Concepts/Foo]]` still
  // resolves by suffix (spec D4).
  const code = readFileSync(join(__dirname, '..', 'src', 'shell', 'vault.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  it('does not call fileManager.renameFile', () => {
    expect(code).not.toMatch(/fileManager\s*\??\.\s*renameFile\s*\(/);
  });

  it('moves the note with vault.rename', () => {
    expect(code).toMatch(/this\.#app\.vault\.rename\(file, to\)/);
  });
});
