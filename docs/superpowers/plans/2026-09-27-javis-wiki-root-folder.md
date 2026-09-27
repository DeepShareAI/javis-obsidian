# Javis-wiki Root Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every wiki page the plugin downloads lands under a fixed `Javis-wiki/` vault folder, and 0.2.x vaults have their existing root-level Javis notes moved there on the next sync.

**Architecture:** `pathForPage` gains a `Javis-wiki/` prefix, so every write path moves in one place. A new pure planner (`src/core/layout-move.ts`) decides which root-level notes are Javis notes and where each one goes. `syncOnce` runs that plan through two new `VaultAdapter` methods before it resolves the cursor, so the delta always reconciles against notes that are already in place. Links in page bodies are untouched: Obsidian resolves `[[Concepts/Foo]]` by path suffix.

**Tech Stack:** TypeScript, Obsidian plugin API (`Vault`, `Vault.rename` — not `FileManager.renameFile`, see spec "Links elsewhere in the vault"), vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md`

## Global Constraints

- The parent folder is the literal `Javis-wiki`, exported once as `WIKI_ROOT` from `src/core/slug.ts`. No setting, no other literal.
- Page bodies and the server are unchanged. Do not rewrite `[[Concepts/Foo]]` links anywhere.
- The plugin never overwrites a note. A move whose destination exists is a conflict, not a write.
- A note is a "Javis note" when its frontmatter has non-empty `javis_type` and `javis_slug` values.
- Folder-name comparisons are case-insensitive, as in `src/core/folders.ts`.
- `src/core/**` must not import from `src/shell/**`. The shell imports core, never the reverse.
- Release version is `0.3.0`; `minAppVersion` stays `1.11.4`.
- Run all commands from `javis-obsidian/`. Baseline before Task 1: `npx vitest run` shows 617 passing.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`javis_slug` that YAML parses as a number** (`javis_slug: 2024`). The note is still a Javis note and must move. Tested in Task 1.
2. **Two root copies that differ only in folder case** (`concepts/Foo.md` and `Concepts/Foo.md` on a case-sensitive volume). The second must be a conflict, not a rename that throws and blocks every future sync. Tested in Task 1.
3. **Metadata cache not yet populated at vault open.** The move must read frontmatter from the file, or a Javis note is skipped and then duplicated by `create`. Tested in Task 5 (`FakeVault.uncached`).
4. **`data.json` lost at the same time as the move** (`cachedCursor: null`). The cursor rescan must still find `javis_rev` on the moved notes. Tested in Task 5.
5. **A root wiki folder holding the user's own notes next to Javis notes.** Only the Javis notes move, the user's notes stay, and a folder with no Javis note is never touched. Tested in Task 5.

---

### Task 1: Pure layout-move planner

**Files:**
- Modify: `src/core/slug.ts` (add `WIKI_ROOT` above `TYPE_TO_PLURAL`)
- Create: `src/core/layout-move.ts`
- Test: `tests/layout-move.test.ts`

**Interfaces:**
- Consumes: `TYPE_TO_PLURAL` from `src/core/slug.ts`; `Frontmatter`, `JAVIS_TYPE`, `JAVIS_SLUG` from `src/core/types.ts`.
- Produces:
  - `export const WIKI_ROOT = 'Javis-wiki'` in `src/core/slug.ts`
  - `export interface LayoutCandidate { path: string; frontmatter: Frontmatter | null }`
  - `export interface LayoutMove { from: string; to: string }`
  - `export interface LayoutMovePlan { moves: LayoutMove[]; conflicts: LayoutMove[] }`
  - `export function legacyDestination(path: string): string | null`
  - `export function planLayoutMove(candidates: readonly LayoutCandidate[], existingPaths: ReadonlySet<string>): LayoutMovePlan`

- [ ] **Step 1: Write the failing test**

Create `tests/layout-move.test.ts`:

```ts
/**
 * Tests for src/core/layout-move.ts — moving 0.2.x's root-level wiki tree
 * under Javis-wiki/ (spec 2026-09-27).
 */

import { describe, expect, it } from 'vitest';

import { legacyDestination, planLayoutMove, type LayoutCandidate } from '../src/core/layout-move';
import { TYPE_TO_PLURAL, WIKI_ROOT } from '../src/core/slug';
import {
  JAVIS_DELETED,
  JAVIS_REV,
  JAVIS_SLUG,
  JAVIS_SYNC,
  JAVIS_TYPE,
  type Frontmatter,
} from '../src/core/types';

function javis(type = 'concept', slug: unknown = 'Foo', extra: Frontmatter = {}): Frontmatter {
  return { [JAVIS_TYPE]: type, [JAVIS_SLUG]: slug, [JAVIS_REV]: '2026-09-13T04:12:00Z', ...extra };
}

function note(path: string, frontmatter: Frontmatter | null): LayoutCandidate {
  return { path, frontmatter };
}

describe('WIKI_ROOT', () => {
  it('is the fixed Javis-wiki folder', () => {
    expect(WIKI_ROOT).toBe('Javis-wiki');
  });
});

describe('legacyDestination', () => {
  it('maps a direct child of each of the nine root folders under Javis-wiki', () => {
    for (const plural of Object.values(TYPE_TO_PLURAL)) {
      expect(legacyDestination(`${plural}/Foo.md`)).toBe(`Javis-wiki/${plural}/Foo.md`);
    }
  });

  it('matches the folder in any case and writes the canonical spelling', () => {
    expect(legacyDestination('concepts/Foo.md')).toBe('Javis-wiki/Concepts/Foo.md');
    expect(legacyDestination('SOURCES/x.md')).toBe('Javis-wiki/Sources/x.md');
  });

  it('ignores nested, root-level, non-markdown, already-moved and unrelated paths', () => {
    for (const path of [
      'Concepts/sub/x.md',
      'x.md',
      'Concepts.md',
      'Concepts/x.canvas',
      'Javis-wiki/Concepts/x.md',
      'Journal/x.md',
      'Conceptsfoo/x.md',
    ]) {
      expect(legacyDestination(path)).toBeNull();
    }
  });
});

describe('planLayoutMove', () => {
  it('moves every Javis note to its canonical destination, keeping the file name', () => {
    const plan = planLayoutMove(
      [note('Concepts/Foo.md', javis()), note('topics/Bar Baz.md', javis('topic', 'Bar Baz'))],
      new Set(['Concepts/Foo.md', 'topics/Bar Baz.md']),
    );
    expect(plan).toEqual({
      moves: [
        { from: 'Concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' },
        { from: 'topics/Bar Baz.md', to: 'Javis-wiki/Topics/Bar Baz.md' },
      ],
      conflicts: [],
    });
  });

  it('leaves notes without both javis_type and javis_slug where they are', () => {
    const plan = planLayoutMove(
      [
        note('Concepts/a.md', null),
        note('Concepts/b.md', {}),
        note('Concepts/c.md', { [JAVIS_TYPE]: 'concept' }),
        note('Concepts/d.md', { [JAVIS_SLUG]: 'd' }),
        note('Concepts/e.md', { [JAVIS_TYPE]: '', [JAVIS_SLUG]: 'e' }),
        note('Concepts/f.md', { [JAVIS_TYPE]: 'concept', [JAVIS_SLUG]: null }),
      ],
      new Set(),
    );
    expect(plan).toEqual({ moves: [], conflicts: [] });
  });

  it('moves a note whose javis_slug YAML-parsed as a number (Review Focus 1)', () => {
    const plan = planLayoutMove([note('Topics/2024.md', javis('topic', 2024))], new Set());
    expect(plan.moves).toEqual([{ from: 'Topics/2024.md', to: 'Javis-wiki/Topics/2024.md' }]);
  });

  it('moves adopted and tombstoned notes like any other', () => {
    const plan = planLayoutMove(
      [
        note('Concepts/Adopted.md', javis('concept', 'Adopted', { [JAVIS_SYNC]: false })),
        note('Concepts/Gone.md', javis('concept', 'Gone', { [JAVIS_DELETED]: true })),
      ],
      new Set(),
    );
    expect(plan.moves.map((m) => m.to)).toEqual([
      'Javis-wiki/Concepts/Adopted.md',
      'Javis-wiki/Concepts/Gone.md',
    ]);
  });

  it('reports an existing destination, in any case, as a conflict and does not move it', () => {
    const plan = planLayoutMove(
      [note('Concepts/Foo.md', javis()), note('Gaps/G.md', javis('gap', 'G'))],
      new Set(['javis-wiki/concepts/foo.md']),
    );
    expect(plan.conflicts).toEqual([{ from: 'Concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' }]);
    expect(plan.moves).toEqual([{ from: 'Gaps/G.md', to: 'Javis-wiki/Gaps/G.md' }]);
  });

  it('turns the second of two case-variant sources into a conflict (Review Focus 2)', () => {
    const plan = planLayoutMove(
      [note('Concepts/Foo.md', javis()), note('concepts/Foo.md', javis())],
      new Set(),
    );
    expect(plan.moves).toEqual([{ from: 'Concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' }]);
    expect(plan.conflicts).toEqual([{ from: 'concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' }]);
  });

  it('plans nothing once its moves are applied', () => {
    const first = planLayoutMove([note('Concepts/Foo.md', javis())], new Set(['Concepts/Foo.md']));
    const after = first.moves.map((m) => note(m.to, javis()));
    expect(planLayoutMove(after, new Set(after.map((n) => n.path)))).toEqual({ moves: [], conflicts: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/layout-move.test.ts`
Expected: FAIL, "Failed to resolve import ../src/core/layout-move" (or `WIKI_ROOT` undefined).

- [ ] **Step 3: Write minimal implementation**

In `src/core/slug.ts`, add directly above the `TYPE_TO_PLURAL` doc comment:

```ts
/**
 * The one vault folder every wiki page lives under (spec 2026-09-27, D1).
 *
 * Fixed, not a setting: the upload guard (src/core/folders.ts) and the 0.2.x
 * layout move (src/core/layout-move.ts) both need to know it without asking,
 * and a renameable folder would need a second migration every time it moved.
 */
export const WIKI_ROOT = 'Javis-wiki';

```

Create `src/core/layout-move.ts`:

```ts
/**
 * Moving 0.2.x's root-level wiki tree under `Javis-wiki/`.
 *
 * Spec: docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md
 *
 * Up to 0.2.x the nine page-type folders sat at the vault root. From 0.3.0
 * `pathForPage` puts them under `WIKI_ROOT`, and every sync starts by moving
 * whatever the old layout left behind. This module is the decision half of
 * that move, as a pure function; `moveLegacyLayout` in src/shell/sync.ts
 * carries it out.
 *
 * Only Javis notes move: a note with no `javis_type`/`javis_slug` in a root
 * `Concepts/` folder is the user's and stays. The file name is kept, so user
 * edits and adopted notes arrive untouched. A destination that already exists
 * is a conflict, never an overwrite.
 */

import { TYPE_TO_PLURAL, WIKI_ROOT } from './slug';
import type { Frontmatter } from './types';
import { JAVIS_SLUG, JAVIS_TYPE } from './types';

/** A note to consider, with frontmatter read from the FILE (not the cache). */
export interface LayoutCandidate {
  path: string;
  frontmatter: Frontmatter | null;
}

export interface LayoutMove {
  from: string;
  to: string;
}

export interface LayoutMovePlan {
  moves: LayoutMove[];
  /** Destination already taken: left in place and reported. */
  conflicts: LayoutMove[];
}

/** Lowercased folder name → canonical spelling, for the nine page-type folders. */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  Object.values(TYPE_TO_PLURAL).map((plural) => [plural.toLowerCase(), plural]),
);

/**
 * Where a 0.2.x root-level wiki note belongs now, or null when `path` is not a
 * direct `.md` child of one of the nine root folders.
 *
 * The folder is matched case-insensitively (on APFS and NTFS `concepts` IS
 * `Concepts`) and written in its canonical spelling, so the destination is
 * exactly what `pathForPage` produces and the next delta finds the note there.
 */
export function legacyDestination(path: string): string | null {
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const [folder, name] = parts as [string, string];
  if (!name.toLowerCase().endsWith('.md')) return null;
  const canonical = CANONICAL.get(folder.toLowerCase());
  if (canonical === undefined) return null;
  return `${WIKI_ROOT}/${canonical}/${name}`;
}

/**
 * Present and non-empty. Not `typeof === 'string'`: YAML parses
 * `javis_slug: 2024` as a number, and that note is still ours.
 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function isJavisNote(frontmatter: Frontmatter | null): boolean {
  return frontmatter !== null && hasValue(frontmatter[JAVIS_TYPE]) && hasValue(frontmatter[JAVIS_SLUG]);
}

/**
 * Decide which candidates move and which conflict.
 *
 * `existingPaths` is every file path in the vault. Destinations are compared
 * lowercased, and each planned move claims its destination, so two sources
 * that differ only in folder case cannot both be sent to one path: the second
 * becomes a conflict instead of a rename that throws on every sync.
 */
export function planLayoutMove(
  candidates: readonly LayoutCandidate[],
  existingPaths: ReadonlySet<string>,
): LayoutMovePlan {
  const taken = new Set([...existingPaths].map((path) => path.toLowerCase()));
  const moves: LayoutMove[] = [];
  const conflicts: LayoutMove[] = [];
  for (const candidate of candidates) {
    const to = legacyDestination(candidate.path);
    if (to === null || !isJavisNote(candidate.frontmatter)) continue;
    const key = to.toLowerCase();
    if (taken.has(key)) {
      conflicts.push({ from: candidate.path, to });
      continue;
    }
    taken.add(key);
    moves.push({ from: candidate.path, to });
  }
  return { moves, conflicts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/layout-move.test.ts && npx tsc -noEmit`
Expected: all `layout-move` tests PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/slug.ts src/core/layout-move.ts tests/layout-move.test.ts
git commit -m "feat(layout): pure planner for moving the root wiki tree under Javis-wiki

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Write new pages under Javis-wiki/

**Files:**
- Modify: `src/core/slug.ts` (`folderForType` doc, `pathForPage`)
- Modify: `src/shell/vault.ts:92-106` (`MANAGED_FOLDERS`) and the `folderAncestors` doc comment (≈ line 120)
- Test: `tests/reconcile.test.ts`, `tests/sync.test.ts`, `tests/vault.test.ts`

**Interfaces:**
- Consumes: `WIKI_ROOT` (Task 1).
- Produces: `pathForPage(type, slug)` returns `Javis-wiki/<Plural>/<sanitized slug>.md`; `MANAGED_FOLDERS` is the nine `Javis-wiki/<Plural>` paths, sorted.

- [ ] **Step 1: Update the tests to the new paths (they will fail)**

Rewrite quoted wiki paths in the two test files that assert on `pathForPage` output. The regex only touches paths that start right after a quote, so link text such as `[[Concepts/Foo]]` inside bodies is left alone:

```bash
sed -i '' -E "s#'(Sources|Entities|Concepts|Topics|Comparisons|Questions|Syntheses|Decisions|Gaps)/#'Javis-wiki/\1/#g" tests/reconcile.test.ts tests/sync.test.ts
```

Then fix the one template literal the regex cannot see, in `tests/sync.test.ts` (in the test "is idempotent: a second run over the same delta writes nothing new"):

```ts
      const path = `Javis-wiki/Concepts/${p.slug}.md`;
```

In `tests/reconcile.test.ts`, rename the test `'routes each page type to its own vault-root folder'` to `'routes each page type to its own folder under Javis-wiki'`.

In `tests/vault.test.ts`, replace the `'is the nine §E folders'` expectation:

```ts
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
```

Leave the `parentFolder('Concepts/Agent-Builder.md')` assertions in `tests/vault.test.ts` alone: they test string arithmetic, not the layout.

Review the rewrite before running anything:

Run: `git diff --stat tests/ && git diff tests/sync.test.ts | grep '^[-+]' | grep -v "Javis-wiki/" | grep -v '^[-+][-+]'`
Expected: only `tests/reconcile.test.ts`, `tests/sync.test.ts`, `tests/vault.test.ts` changed, and the second command prints only `-` lines (every added line mentions `Javis-wiki/`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/reconcile.test.ts tests/sync.test.ts tests/vault.test.ts`
Expected: FAIL. Path assertions report `Concepts/Agent-Builder.md` where `Javis-wiki/Concepts/Agent-Builder.md` was expected, and `MANAGED_FOLDERS` lacks the prefix.

- [ ] **Step 3: Implement**

In `src/core/slug.ts`, replace the `folderForType` and `pathForPage` blocks with:

```ts
/** The page-type folder (inside `WIKI_ROOT`) for a type, or null when the type is unknown. */
export function folderForType(pageType: string): string | null {
  return TYPE_TO_PLURAL[pageType] ?? null;
}

/**
 * Vault-relative path for a page, or null when the page type is unknown.
 *
 * Under `WIKI_ROOT` since 0.3.0 (spec 2026-09-27). Bodies still contain
 * `[[Concepts/Foo]]` literally, and that keeps working one folder down:
 * Obsidian resolves a link path by suffix, so `Concepts/Foo` finds
 * `Javis-wiki/Concepts/Foo.md` without any link being rewritten.
 */
export function pathForPage(pageType: string, slug: string): string | null {
  const folder = folderForType(pageType);
  if (folder === null) return null;
  return `${WIKI_ROOT}/${folder}/${sanitizeSlug(slug)}.md`;
}
```

In `src/shell/vault.ts`, change the import to `import { TYPE_TO_PLURAL, WIKI_ROOT } from '../core/slug';` and replace the `MANAGED_FOLDERS` block (doc comment included) with:

```ts
/**
 * The nine §E folders, under `WIKI_ROOT`, in a stable order.
 *
 * Derived from `TYPE_TO_PLURAL` rather than written out again: the map is
 * already the single source of truth for the folder half of
 * `pathForPage(page_type, slug)`, and a second literal list would be a second
 * thing to keep in step with the server's `PLURAL_TO_TYPE`.
 *
 * Deduplicated defensively — two page types mapping to one folder is not
 * something the current map does, but `Set` costs nothing and a duplicate
 * `createFolder` would throw.
 */
export const MANAGED_FOLDERS: readonly string[] = Object.freeze(
  [...new Set(Object.values(TYPE_TO_PLURAL))].sort().map((plural) => `${WIKI_ROOT}/${plural}`),
);
```

In the `folderAncestors` doc comment, replace the example and the "today's `pathForPage` never produces" sentence with:

```ts
 * `'Javis-wiki/Concepts/Agent-Builder.md'` yields
 * `['Javis-wiki', 'Javis-wiki/Concepts']`, outermost first, because
 * `Vault.createFolder` does not create intermediate folders.
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run && npx tsc -noEmit`
Expected: all tests PASS (617 + Task 1's), tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/slug.ts src/shell/vault.ts tests/reconcile.test.ts tests/sync.test.ts tests/vault.test.ts
git commit -m "feat(layout): write wiki pages under Javis-wiki/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Upload guard protects Javis-wiki/

**Files:**
- Modify: `src/core/folders.ts` (module doc rule 2, `WIKI_FOLDERS`, the wiki check in `validateFolders`)
- Modify: `src/shell/settings.ts:315` (folder picker description)
- Test: `tests/folders.test.ts`

**Interfaces:**
- Consumes: `WIKI_ROOT` (Task 1).
- Produces: `validateFolders` refuses `Javis-wiki` and anything inside it (case-insensitive) with the reason `Javis-wiki is the folder Javis writes; it cannot be uploaded back.` The nine names at the root are allowed.

- [ ] **Step 1: Write the failing tests**

In `tests/folders.test.ts`, change the import `import { TYPE_TO_PLURAL } from '../src/core/slug';` to `import { TYPE_TO_PLURAL, WIKI_ROOT } from '../src/core/slug';`, then replace the two tests `'rejects each of the nine wiki folders and anything inside one'` and `'rejects a wiki folder in any case: on APFS and NTFS "sources" IS "Sources" (review)'` with:

```ts
  it('rejects Javis-wiki and anything inside it', () => {
    for (const folder of [WIKI_ROOT, `${WIKI_ROOT}/Topics`, `${WIKI_ROOT}/Concepts/Sub`]) {
      const result = ok([folder]);
      expect(result.ok).toEqual([]);
      expect(result.errors[0]!.reason).toBe('Javis-wiki is the folder Javis writes; it cannot be uploaded back.');
    }
  });

  it('rejects Javis-wiki in any case: on APFS and NTFS "javis-wiki" IS "Javis-wiki" (review)', () => {
    for (const folder of ['javis-wiki', 'JAVIS-WIKI/sources']) {
      expect(ok([folder]).errors[0]!.reason).toMatch(/Javis-wiki/);
    }
    expect(ok(['.OBSIDIAN']).errors).toHaveLength(1);
    expect(validateFolders(['Config/x'], 'config').errors).toHaveLength(1);
  });

  it('allows root folders named like the page types, now that the wiki lives in Javis-wiki', () => {
    for (const folder of Object.values(TYPE_TO_PLURAL)) {
      expect(ok([folder])).toEqual({ ok: [folder], errors: [] });
    }
  });

  it('treats a name prefix of Javis-wiki as a different folder', () => {
    expect(ok(['Javis-wiki-notes'])).toEqual({ ok: ['Javis-wiki-notes'], errors: [] });
  });
```

In the existing test `'returns user-facing sentences'`, change `['', 'Concepts', 'A', 'A/B']` to `['', 'Javis-wiki', 'A', 'A/B']`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/folders.test.ts`
Expected: FAIL. `Javis-wiki` is accepted, and root `Concepts` is still rejected.

- [ ] **Step 3: Implement**

In `src/core/folders.ts`:

1. Replace rule 2 in the module doc comment with:

```ts
 * 2. **Not `Javis-wiki` or inside it.** That is where the download writes
 *    (src/core/slug.ts `WIKI_ROOT`), so uploading it would feed Javis its own
 *    output — the loop §A rules out. Compared case-INsensitively: on the
 *    default macOS (APFS) and Windows (NTFS) volumes a user's `javis-wiki`
 *    folder is the very directory the download writes into. The nine page-type
 *    names at the vault root are the user's again since 0.3.0; a stray Javis
 *    note anywhere else is still refused per file by src/core/upload.ts (a
 *    note carrying `javis_slug`/`javis_type` is never sent). Every other
 *    comparison here — the config folder, duplicates, nesting — is
 *    case-insensitive for the same reason; on a case-sensitive volume that
 *    only refuses a selection.
```

2. Change the import to `import { WIKI_ROOT } from './slug';`.
3. Delete the `WIKI_FOLDERS` constant.
4. Replace the wiki check inside `validateFolders`:

```ts
    if (isSameOrUnder(key, fold(WIKI_ROOT))) {
      fail(`${WIKI_ROOT} is the folder Javis writes; it cannot be uploaded back.`);
      continue;
    }
```

In `src/shell/settings.ts:315`, change the description to:

```ts
      .setDesc('Every note inside it, including subfolders, is uploaded. The Javis-wiki folder cannot be chosen.')
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc -noEmit`
Expected: all PASS, tsc exits 0. If a test in `tests/upload-plan.test.ts` or `tests/upload.test.ts` relied on a root wiki folder being refused, it now fails: change that test's folder to `Javis-wiki/<Plural>` and keep its assertion.

- [ ] **Step 5: Commit**

```bash
git add src/core/folders.ts src/shell/settings.ts tests/folders.test.ts
git commit -m "feat(upload): guard Javis-wiki/ instead of the nine root folders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: VaultAdapter gains rename and removeFolderIfEmpty

**Files:**
- Modify: `src/shell/contracts.ts` (`VaultAdapter`, after `listMarkdownFiles`)
- Modify: `src/shell/vault.ts` (`ObsidianVaultAdapter`, after `listMarkdownFiles`)
- Modify: `tests/sync.test.ts` (`FakeVault`)

**Interfaces:**
- Produces:
  - `VaultAdapter.rename(from: string, to: string): Promise<void>` rejects with `VaultWriteError` when `from` is missing, `to` exists, or the move fails.
  - `VaultAdapter.removeFolderIfEmpty(path: string): Promise<void>` deletes the folder only when it has no children; a no-op when absent or non-empty.
  - `FakeVault.rename` records `rename <from> -> <to>` in `calls`, honours `failWrites` on `from`, and rejects when `to` exists.
  - `FakeVault.removeFolderIfEmpty` records `rmdir-if-empty <path>`.
  - `FakeVault.uncached: Set<string>` lists paths whose `listMarkdownFiles` frontmatter is `null`, simulating a metadata cache that has not indexed them yet.

`ObsidianVaultAdapter` is exempt from unit tests by §H (exercised in the Task 8 E2E). This task's check is that the contract and fake compile and the suite stays green. The behavioural tests that drive the fake are in Task 5.

- [ ] **Step 1: Add the contract methods**

In `src/shell/contracts.ts`, inside `interface VaultAdapter`, after `listMarkdownFiles(): Promise<readonly VaultNote[]>;`:

```ts

  /**
   * Move a note (spec 2026-09-27, the 0.2.x → 0.3.0 layout move).
   *
   * MUST create `to`'s parent folders first, and MUST use `Vault.rename`, not
   * `FileManager.renameFile`: the latter runs Obsidian's link update, which
   * with the default link setting opens a blocking prompt per moved page.
   * Links keep resolving by suffix (spec D4). Rejects with
   * `VaultWriteError` when `from` is missing, when anything already exists at
   * `to` (a move never overwrites), or when the rename fails.
   */
  rename(from: string, to: string): Promise<void>;

  /**
   * Delete the folder at `path` only when Obsidian lists nothing inside it; a
   * no-op when it is absent or not empty. The only removal this contract
   * allows, and it can never take a note with it.
   */
  removeFolderIfEmpty(path: string): Promise<void>;
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npx tsc -noEmit`
Expected: FAIL. `ObsidianVaultAdapter` and `FakeVault` do not implement `rename` / `removeFolderIfEmpty`.

- [ ] **Step 3: Implement in ObsidianVaultAdapter**

In `src/shell/vault.ts`, inside `ObsidianVaultAdapter`, directly after the `listMarkdownFiles` method:

```ts

  /**
   * Move a note, creating the destination folders first.
   *
   * `vault.rename`, not `fileManager.renameFile` (review): the file manager
   * runs Obsidian's link update, and with "Automatically update internal
   * links" off (the default) that update opens a blocking "Update links?"
   * modal for every moved page with incoming links. `vault.rename` never
   * touches links; `[[Concepts/Foo]]` still resolves by suffix (spec D4).
   */
  async rename(from: string, to: string): Promise<void> {
    const file = this.#require(from);
    if (this.#app.vault.getAbstractFileByPath(to) !== null) {
      throw new VaultWriteError(from, `Could not move ${from}: ${to} already exists`);
    }
    await this.#ensureFolders(to);
    try {
      await this.#app.vault.rename(file, to);
    } catch (err) {
      throw new VaultWriteError(from, `Could not move ${from} to ${to}: ${describeError(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * Remove an emptied 0.2.x root wiki folder. `children` is Obsidian's view,
   * which omits OS files such as `.DS_Store`; a folder holding one makes
   * `vault.delete` throw, and the caller treats that as "leave it".
   */
  async removeFolderIfEmpty(path: string): Promise<void> {
    const folder = this.#app.vault.getFolderByPath(path);
    if (folder === null || folder.children.length > 0) return;
    await this.#app.vault.delete(folder);
  }
```

- [ ] **Step 4: Implement in FakeVault**

In `tests/sync.test.ts`, inside `class FakeVault`, add the field below `failWrites`:

```ts
  /** Paths the metadata cache has not indexed yet: `listMarkdownFiles` reports no frontmatter. */
  readonly uncached = new Set<string>();
```

Replace `listMarkdownFiles` with:

```ts
  async listMarkdownFiles(): Promise<readonly VaultNote[]> {
    return [...this.files.entries()].map(([path, file]) => ({
      path,
      frontmatter: this.uncached.has(path) ? null : file.frontmatter,
    }));
  }
```

Add, above `#guard`:

```ts
  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    this.#guard(from);
    const file = this.files.get(from);
    if (file === undefined) throw new VaultWriteError(from, `No note at ${from}`);
    if (this.files.has(to)) throw new VaultWriteError(from, `${to} already exists`);
    this.files.delete(from);
    this.files.set(to, file);
  }

  async removeFolderIfEmpty(path: string): Promise<void> {
    this.calls.push(`rmdir-if-empty ${path}`);
  }
```

- [ ] **Step 5: Run typecheck and suite**

Run: `npx tsc -noEmit && npx vitest run`
Expected: tsc exits 0; all tests PASS (no behaviour changed yet).

- [ ] **Step 6: Commit**

```bash
git add src/shell/contracts.ts src/shell/vault.ts tests/sync.test.ts
git commit -m "feat(vault): rename and removeFolderIfEmpty on VaultAdapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Run the layout move at the start of every sync

**Files:**
- Modify: `src/shell/contracts.ts` (`SyncResult`)
- Modify: `src/shell/sync.ts` (new `moveLegacyLayout`, call in `syncOnce`, result fields)
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `legacyDestination`, `planLayoutMove`, `LayoutMove` (Task 1); `VaultAdapter.rename`, `removeFolderIfEmpty`, `FakeVault.uncached` (Task 4); `parentFolder` from `src/shell/vault.ts`.
- Produces:
  - `export interface LayoutMoveResult { moved: number; conflicts: readonly LayoutMove[] }` in `src/shell/sync.ts`
  - `export async function moveLegacyLayout(vault: VaultAdapter): Promise<LayoutMoveResult>`: throws `VaultWriteError` after attempting every move if any failed.
  - `SyncResult.moved: number` and `SyncResult.moveConflicts: readonly LayoutMove[]`

- [ ] **Step 1: Write the failing tests**

In `tests/sync.test.ts`:

1. Change the types import line to `import { JAVIS_DELETED, JAVIS_REV, JAVIS_SLUG, JAVIS_SYNC, JAVIS_TYPE } from '../src/core/types';`.
2. Change the sync import to `import { applyAction, decideAction, moveLegacyLayout, resolveCursor, summarize, syncOnce } from '../src/shell/sync';`.
3. Below `const CONCEPT_PATH = ...`, add:

```ts
function javisFm(type: string, slug: string, rev = '2026-09-13T04:12:00Z'): Frontmatter {
  return { [JAVIS_TYPE]: type, [JAVIS_SLUG]: slug, [JAVIS_REV]: rev };
}
```

4. In the `summarize` describe's `base` object, add `moved: 0,` and `moveConflicts: [],` after `pendingFullResync: false,`.
5. Add this block before `describe('summarize', ...)`:

```ts
// ---------------------------------------------------------------------------
// moveLegacyLayout — spec 2026-09-27
// ---------------------------------------------------------------------------

describe('moveLegacyLayout', () => {
  it('moves root-level Javis notes under Javis-wiki and tidies only the folders it moved from (Review Focus 5)', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', javisFm('concept', 'A'), 'a body');
    vault.seed('Concepts/mine.md', null, 'my own note');
    vault.seed('Topics/T.md', javisFm('topic', 'T'));
    vault.seed('Gaps/mine.md', { tags: ['x'] });
    vault.seed('Journal/j.md', null);

    const result = await moveLegacyLayout(vault);

    expect(result).toEqual({ moved: 2, conflicts: [] });
    expect(vault.calls).toEqual([
      'rename Concepts/A.md -> Javis-wiki/Concepts/A.md',
      'rename Topics/T.md -> Javis-wiki/Topics/T.md',
      'rmdir-if-empty Concepts',
      'rmdir-if-empty Topics',
    ]);
    expect(vault.files.get('Javis-wiki/Concepts/A.md')?.content).toBe('a body');
    expect(vault.files.has('Concepts/mine.md')).toBe(true);
    expect(vault.files.has('Gaps/mine.md')).toBe(true);
  });

  it('reads frontmatter from the file, not the metadata cache (Review Focus 3)', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', javisFm('concept', 'A'));
    vault.uncached.add('Concepts/A.md');

    expect(await moveLegacyLayout(vault)).toEqual({ moved: 1, conflicts: [] });
    expect(vault.files.has('Javis-wiki/Concepts/A.md')).toBe(true);
  });

  it('reports a conflict and leaves both copies where they are', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', javisFm('concept', 'A'), 'old');
    vault.seed('Javis-wiki/Concepts/A.md', javisFm('concept', 'A'), 'new');

    const result = await moveLegacyLayout(vault);

    expect(result).toEqual({
      moved: 0,
      conflicts: [{ from: 'Concepts/A.md', to: 'Javis-wiki/Concepts/A.md' }],
    });
    expect(vault.calls).toEqual([]);
    expect(vault.files.get('Concepts/A.md')?.content).toBe('old');
    expect(vault.files.get('Javis-wiki/Concepts/A.md')?.content).toBe('new');
  });

  it('attempts every move, then throws if any failed', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', javisFm('concept', 'A'));
    vault.seed('Concepts/B.md', javisFm('concept', 'B'));
    vault.failWrites.add('Concepts/A.md');

    await expect(moveLegacyLayout(vault)).rejects.toBeInstanceOf(VaultWriteError);
    expect(vault.files.has('Javis-wiki/Concepts/B.md')).toBe(true);
    expect(vault.files.has('Concepts/A.md')).toBe(true);
  });

  it('does nothing on a vault that is already migrated', async () => {
    const vault = new FakeVault();
    vault.seed('Javis-wiki/Concepts/A.md', javisFm('concept', 'A'));

    expect(await moveLegacyLayout(vault)).toEqual({ moved: 0, conflicts: [] });
    expect(vault.calls).toEqual([]);
  });
});
```

6. Add these tests at the end of `describe('syncOnce', ...)`:

```ts
  it('moves the old layout first, so the delta reconciles against the moved note', async () => {
    const vault = new FakeVault();
    const p = page();
    vault.seed('Concepts/Agent-Builder.md', javisFm('concept', 'Agent-Builder', p.updated_at), 'body');
    const api = new FakeApi([{ pages: [p], serverTime: '2026-09-13T06:00:00Z' }]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.moved).toBe(1);
    expect(result.moveConflicts).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(vault.calls).toEqual([
      'rename Concepts/Agent-Builder.md -> Javis-wiki/Concepts/Agent-Builder.md',
      'rmdir-if-empty Concepts',
    ]);
  });

  it('downloads nothing when a move fails', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/Agent-Builder.md', javisFm('concept', 'Agent-Builder'));
    vault.failWrites.add('Concepts/Agent-Builder.md');
    const api = new FakeApi([{ pages: [page()], serverTime: '2026-09-13T06:00:00Z' }]);

    await expect(syncOnce(deps({ api, vault }))).rejects.toBeInstanceOf(VaultWriteError);
    expect(api.sinceSeen).toEqual([]);
    expect(vault.files.has('Javis-wiki/Concepts/Agent-Builder.md')).toBe(false);
  });

  it('recovers the cursor from moved notes when data.json is gone (Review Focus 4)', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/Agent-Builder.md', javisFm('concept', 'Agent-Builder', '2026-09-20T00:00:00Z'));
    const api = new FakeApi([{ pages: [], serverTime: '2026-09-27T00:00:00Z' }]);

    await syncOnce(deps({ api, vault, cachedCursor: null }));

    expect(api.sinceSeen).toEqual(['2026-09-20T00:00:00Z']);
  });

  it('reports a conflict and still syncs the Javis-wiki copy', async () => {
    const vault = new FakeVault();
    const p = page();
    vault.seed('Concepts/Agent-Builder.md', javisFm('concept', 'Agent-Builder', p.updated_at), 'old');
    vault.seed('Javis-wiki/Concepts/Agent-Builder.md', javisFm('concept', 'Agent-Builder', p.updated_at), 'new');
    const api = new FakeApi([{ pages: [p], serverTime: '2026-09-13T06:00:00Z' }]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.moved).toBe(0);
    expect(result.moveConflicts).toEqual([
      { from: 'Concepts/Agent-Builder.md', to: 'Javis-wiki/Concepts/Agent-Builder.md' },
    ]);
    expect(result.skipped).toBe(1);
    expect(vault.files.get('Concepts/Agent-Builder.md')?.content).toBe('old');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL. `moveLegacyLayout` is not exported, and `result.moved` is `undefined`.

- [ ] **Step 3: Implement**

In `src/shell/contracts.ts`:
- Add the import `import type { LayoutMove } from '../core/layout-move';` next to the other `../core` imports.
- Inside `interface SyncResult`, after `pendingFullResync: boolean;`, add:

```ts
  /** Notes moved from the 0.2.x root layout into `Javis-wiki/` this run (spec 2026-09-27). */
  moved: number;
  /** Root-level Javis notes left in place because their `Javis-wiki/` path was taken. */
  moveConflicts: readonly LayoutMove[];
```

In `src/shell/sync.ts`:
- Add `import { legacyDestination, planLayoutMove, type LayoutCandidate, type LayoutMove } from '../core/layout-move';` after the `../core/markers` import.
- Change the errors import to `import { HttpError, SyncCancelledError, VaultWriteError, isJavisError } from './errors';`.
- Change `import { maxRevision } from './vault';` to `import { maxRevision, parentFolder } from './vault';`.
- Add, directly above `export async function syncOnce`:

```ts
/** What the layout move did, for the notices in src/main.ts. */
export interface LayoutMoveResult {
  moved: number;
  conflicts: readonly LayoutMove[];
}

/**
 * Move whatever the 0.2.x root layout left behind into `Javis-wiki/`
 * (spec 2026-09-27). Runs at the start of every sync and is a folder listing
 * once nothing is left to move.
 *
 * Frontmatter comes from `readFrontmatter` (the file), not from
 * `listMarkdownFiles` (the metadata cache): on the vault-open sync the cache
 * may not have indexed a note yet, and a Javis note missed here would be
 * re-created at its new path by the download, leaving a permanent conflict.
 *
 * Every move is attempted. If any failed, this throws AFTER the rest, so the
 * caller downloads nothing this run: a download would `create` the unmoved
 * page at its new path. The next sync retries the move.
 *
 * Only a root folder that lost a note this run is offered to
 * `removeFolderIfEmpty`; a failure there is logged and ignored.
 */
export async function moveLegacyLayout(vault: VaultAdapter): Promise<LayoutMoveResult> {
  const listed = await vault.listMarkdownFiles();
  const candidates: LayoutCandidate[] = [];
  for (const note of listed) {
    if (legacyDestination(note.path) === null) continue;
    candidates.push({ path: note.path, frontmatter: await vault.readFrontmatter(note.path) });
  }
  const plan = planLayoutMove(candidates, new Set(listed.map((note) => note.path)));

  let moved = 0;
  const failures: { path: string; message: string }[] = [];
  const emptied = new Set<string>();
  for (const move of plan.moves) {
    try {
      await vault.rename(move.from, move.to);
      moved += 1;
      emptied.add(parentFolder(move.from)!);
    } catch (error) {
      failures.push({ path: move.from, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const folder of emptied) {
    try {
      await vault.removeFolderIfEmpty(folder);
    } catch (error) {
      console.warn(`Javis: could not remove the emptied folder ${folder}`, error);
    }
  }

  if (failures.length > 0) {
    const first = failures[0]!;
    throw new VaultWriteError(
      first.path,
      `Could not move ${failures.length} ${failures.length === 1 ? 'note' : 'notes'} into Javis-wiki/ ` +
        `(${first.path}: ${first.message}). Nothing was downloaded; the next sync retries.`,
    );
  }
  return { moved, conflicts: plan.conflicts };
}

```

- In `syncOnce`, replace:

```ts
  throwIfAborted(signal);
  const since = await resolveCursor(vault, deps.cachedCursor, deps.pendingFullResync);
```

with:

```ts
  throwIfAborted(signal);
  // Before the cursor: the rescan and every `decideAction` must see the notes
  // where `pathForPage` now puts them (spec 2026-09-27).
  const layout = await moveLegacyLayout(vault);
  throwIfAborted(signal);
  const since = await resolveCursor(vault, deps.cachedCursor, deps.pendingFullResync);
```

- In the object `syncOnce` returns, after the `pendingFullResync: ...` line, add:

```ts
    moved: layout.moved,
    moveConflicts: layout.conflicts,
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc -noEmit`
Expected: all PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/shell/contracts.ts src/shell/sync.ts tests/sync.test.ts
git commit -m "feat(sync): move the 0.2.x root layout into Javis-wiki before each sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tell the user what moved

**Files:**
- Modify: `src/main.ts` (`#download`, after the existing failures notice ≈ line 384)
- Modify: `docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md` (notices section)

**Interfaces:**
- Consumes: `SyncResult.moved`, `SyncResult.moveConflicts` (Task 5); the existing `INTERACTIVE` set in `src/main.ts`.

`main.ts` is plugin wiring with no unit tests in this repo; it is verified by `npm run build` here and by E2E steps 2 and 4 in Task 8.

A conflict persists until the user resolves it, so its notice is limited to interactive triggers. Otherwise the timer would raise it every few minutes. The console line is always written. Step 2 records this refinement in the spec.

- [ ] **Step 1: Add the notices**

In `src/main.ts` `#download`, directly after the `if (result.failures.length > 0) { ... }` block and before `return result;`:

```ts
    // Spec 2026-09-27. The move happens once per vault, so its notice is shown
    // whatever started the run; a conflict persists until the user resolves
    // it, so its notice waits for a run the user started.
    if (result.moved > 0) {
      new Notice(`Javis: moved ${result.moved} ${result.moved === 1 ? 'note' : 'notes'} into Javis-wiki/.`);
    }
    if (result.moveConflicts.length > 0) {
      console.warn('Javis: not moved into Javis-wiki/ because the destination exists:', result.moveConflicts);
      if (INTERACTIVE.has(trigger)) {
        const n = result.moveConflicts.length;
        new Notice(
          `Javis: ${n} ${n === 1 ? 'note' : 'notes'} in the vault root ${n === 1 ? 'was' : 'were'} not moved ` +
            'because Javis-wiki already has a note with the same name. The developer console lists them.',
          12_000,
        );
      }
    }
```

- [ ] **Step 2: Record the refinement in the spec**

In `docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md`, section "`src/main.ts` — notices", replace the second bullet with:

```markdown
- `moveConflicts.length > 0`: the paths are written to the console on every
  run; on interactive runs only (Sync now, settings, review) a notice says
  `Javis: N notes in the vault root were not moved because Javis-wiki already
  has a note with the same name.` A conflict persists until the user resolves
  it, and a notice on every timer run would nag.
```

- [ ] **Step 3: Build**

Run: `npm run build && npx vitest run`
Expected: tsc and esbuild succeed (a fresh `main.js` is written); all tests PASS.

- [ ] **Step 4: Commit**

`main.js` is the release artifact. Commit it only if `git status` shows it as tracked and modified. Otherwise leave it out:

```bash
git status --short main.js
git add src/main.ts docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md
git commit -m "feat(sync): notices for notes moved into Javis-wiki and for conflicts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: README, release notes, version 0.3.0

**Files:**
- Modify: `README.md` (≈ lines 17, 89–118, 208, 226)
- Create: `docs/pr-drafts/0.3.0-javis-wiki-root.md`
- Modify via `npm version`: `package.json`, `package-lock.json`, `manifest.json`, `versions.json`

- [ ] **Step 1: README**

1. Line ≈ 17: change "writes into nine folders at the root of whatever vault it is enabled" to say it writes into a `Javis-wiki/` folder of that vault. Keep the rest of the sentence.
2. Replace the section from `## What it creates` down to (not including) `## What a synced note looks like` with:

````markdown
## What it creates

One folder, `Javis-wiki/`, with a subfolder per page type:

```
Javis-wiki/
  Sources/  Entities/  Concepts/  Topics/  Comparisons/
  Questions/  Syntheses/  Decisions/  Gaps/
```

A subfolder is created only when a page needs it.

Page bodies contain links such as `[[Concepts/Foo]]` literally. Obsidian
resolves a link path by its ending, so that link finds
`Javis-wiki/Concepts/Foo.md` and no link is rewritten.

**Upgrading from 0.2.x.** Earlier versions wrote the nine folders at the
vault root. The first sync after upgrading moves every Javis note from those
folders into `Javis-wiki/`, including notes you edited or adopted. Your own
notes in those folders stay where they are. A root folder is removed only if
the move left it empty. If `Javis-wiki/` already has a note with the same
name, the root copy is left alone and Sync now tells you. Downgrading to
0.2.x writes a fresh copy of the wiki at the vault root.
````

3. In `## What a synced note looks like`, change the example path `` `Concepts/Agent-Builder.md`: `` to `` `Javis-wiki/Concepts/Agent-Builder.md`: ``. Leave the `[[Concepts/Foo]]` line inside the example body unchanged.
4. Line ≈ 208: replace "You cannot pick the vault root, `.obsidian/`, one of the nine wiki folders, or a folder inside one." with "You cannot pick the vault root, `.obsidian/`, `Javis-wiki/`, or a folder inside one of them."
5. Line ≈ 226: change `Sources/obsidian-note-<id>.md` to `Javis-wiki/Sources/obsidian-note-<id>.md`.

Run: `grep -n "root of\|nine wiki\|^Nine\|\`Sources/obsidian" README.md`
Expected: no remaining line that says the wiki lives at the vault root.

- [ ] **Step 2: Release notes draft**

Create `docs/pr-drafts/0.3.0-javis-wiki-root.md`:

```markdown
# Javis Wiki Sync 0.3.0: the wiki moves into Javis-wiki/

**Branch:** `feat/javis-wiki-root-folder` · target `main`

**Spec:** `docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md`
**Plan:** `docs/superpowers/plans/2026-09-27-javis-wiki-root-folder.md`

## What changes for users

- Wiki pages are written under `Javis-wiki/<Type>/` instead of nine folders at
  the vault root.
- The first sync after upgrading moves existing Javis notes from the root
  folders into `Javis-wiki/`, including edited and adopted notes. Your own
  notes in those folders stay put, and a root folder is removed only if the
  move emptied it.
- If `Javis-wiki/` already has a note with the same name, the root copy is
  left alone and Sync now reports it. Nothing is ever overwritten.
- Links such as `[[Concepts/Foo]]` keep working; nothing is rewritten.
- The upload folder picker now refuses `Javis-wiki/` and allows your own
  root folders named `Topics/`, `Sources/` and so on.

## Rollback

Reinstalling 0.2.1 writes a fresh copy of the wiki at the vault root; it does
not move notes back.

## Server

No change.
```

- [ ] **Step 3: Bump the version**

Run: `npm version minor --no-git-tag-version`
Expected: prints `v0.3.0`. `git diff --stat` shows `package.json`, `package-lock.json`, `manifest.json` (`"version": "0.3.0"`), and `versions.json` (a `"0.3.0": "1.11.4"` entry). The `version` script runs `version-bump.mjs` and stages `manifest.json` and `versions.json`.

- [ ] **Step 4: Full check**

Run: `npx vitest run && npm run build`
Expected: all tests PASS (including the release metadata consistency test in `tests/run.test.ts`); build succeeds.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/pr-drafts/0.3.0-javis-wiki-root.md package.json package-lock.json manifest.json versions.json
git commit -m "chore(release): 0.3.0 — wiki under Javis-wiki/, README and notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Manual E2E in the Javis-wiki vault (with Samuel)

`ObsidianVaultAdapter.rename`, `removeFolderIfEmpty`, and the link-resolution assumption (spec D4) are exempt from unit tests by §H. This task is where they are verified. It needs Samuel's Obsidian; the executor prepares the build and walks through the steps with him.

**Files:** none changed unless a step fails. A failure goes back to the owning task as a bug fix with a regression test where one is possible.

- [ ] **Step 1: Baseline on 0.2.1.** In the `Javis-wiki` vault with 0.2.1 installed, run Sync now so the root folders exist. Edit one wiki page's body outside the marker block. Adopt another page (`javis_sync: false`). Add a note of your own, `Concepts/mine.md`, with no frontmatter.
- [ ] **Step 2: Upgrade and sync.** Copy the Task 7 build (`main.js`, `manifest.json`, `styles.css` if present) into `<vault>/.obsidian/plugins/<plugin id>/`, reload Obsidian, and press **Sync now**.
  - Expected: the notice `Javis: moved N notes into Javis-wiki/.`
  - The file explorer shows `Javis-wiki/` with only the page-type folders that hold pages.
  - The root wiki folders are gone, except `Concepts/` holding `mine.md`.
  - The edited and adopted notes keep their content.
- [ ] **Step 3: Links.** Open a wiki page containing `[[Concepts/…]]` and click the link. Expected: it opens the page under `Javis-wiki/Concepts/`, not a new empty note (verifies D4).
- [ ] **Step 4: Conflict.** Copy one note from `Javis-wiki/Topics/` to `Topics/` at the root and press Sync now.
  - Expected: the conflict notice, and the console lists the path.
  - Both files are unchanged.
- [ ] **Step 5: Steady state.** Press Sync now again after deleting the copy from Step 4. Expected: no move notice and no conflict notice.
- [ ] **Step 6: Upload guard.** In settings, try to add `Javis-wiki` as an upload folder. Expected: refused with "Javis-wiki is the folder Javis writes; it cannot be uploaded back."
- [ ] **Step 7: Record the result** in `docs/pr-drafts/0.3.0-javis-wiki-root.md` under a new `## E2E` heading (date, pass/fail per step), then commit:

```bash
git add docs/pr-drafts/0.3.0-javis-wiki-root.md
git commit -m "docs: 0.3.0 E2E results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
