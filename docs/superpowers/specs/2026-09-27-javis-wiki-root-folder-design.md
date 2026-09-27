# Javis-wiki root folder — design

Date: 2026-09-27
Status: approved in brainstorming, pending spec review
Target release: 0.3.0

## Goal

Every wiki page the plugin downloads lands under one fixed vault folder,
`Javis-wiki/`, instead of in nine folders at the vault root:

```
Javis-wiki/
  Gaps/
  Sources/
  Syntheses/
  Topics/
  …          (only the folders that hold pages)
```

The point is a tidy vault root, especially when the plugin is enabled in a
personal vault that already has its own notes. Existing vaults are migrated in
place: the Javis notes already at the root are moved, not duplicated.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | The parent folder is fixed at `Javis-wiki`; no setting. | One known path for the upload guard and the move. A configurable name adds a second migration (on rename) and the case where the chosen folder already holds user notes. |
| D2 | Existing root-level Javis notes are **moved** into `Javis-wiki/`. | Rebuilding would duplicate every page and strand user-edited and adopted notes at the root. |
| D3 | The move is an **idempotent step at the start of every sync**, not a one-time migration flag. | Also heals vaults opened later by an old plugin version, notes restored from backup, and a move interrupted mid-way. The steady-state cost is listing nine folders. |
| D4 | Page bodies and the server are unchanged. Links stay `[[Concepts/Foo]]`. | Obsidian resolves a link path by suffix match, so `[[Concepts/Foo]]` resolves to `Javis-wiki/Concepts/Foo.md`. Verified by manual E2E step 3. |
| D5 | No forced full resync after the move. | Moved files sit exactly where the new `pathForPage` looks, so ordinary deltas reconcile against them. |
| D6 | The upload folder guard protects `Javis-wiki/**` instead of the nine root names. | `src/core/upload.ts` already refuses any note carrying `javis_slug`/`javis_type`, so a stray Javis note elsewhere cannot loop. The nine root names become free for the user's own folders. |

## What changes

### `src/core/slug.ts` — path source of truth

- Add `export const WIKI_ROOT = 'Javis-wiki';`.
- `pathForPage(type, slug)` returns `${WIKI_ROOT}/${folder}/${sanitizeSlug(slug)}.md`.
- `TYPE_TO_PLURAL` and `folderForType` are unchanged: the folder names are
  still the link prefixes stored in page bodies.
- Replace the "Root placement is load-bearing (§E)" comment with the reason
  nesting is safe (D4).

### `src/core/layout-move.ts` — new, pure

```ts
export interface LayoutMove { from: string; to: string }
export interface LayoutMovePlan { moves: LayoutMove[]; conflicts: LayoutMove[] }

export function planLayoutMove(
  candidates: readonly VaultNote[],     // frontmatter read from the file
  existingPaths: ReadonlySet<string>,   // every file path in the vault
): LayoutMovePlan;
```

A candidate is moved when **both** hold:

1. Its path is exactly `<folder>/<name>.md` where `<folder>` is one of the nine
   `TYPE_TO_PLURAL` values, compared case-insensitively (same rationale as
   `src/core/folders.ts` rule 2). Nested paths and root-level files are
   ignored.
2. Its frontmatter has both `javis_type` and `javis_slug`. Notes without them
   are the user's and stay put. Adopted (`javis_sync: false`) and tombstoned
   notes move like any other.

Destination: `${WIKI_ROOT}/<canonical folder>/<name>.md`. The folder takes its
canonical spelling from `TYPE_TO_PLURAL`, so the destination equals what
`pathForPage` produces. The file name is kept as is, so user edits and adopted
notes are carried over untouched.

If the destination already exists (case-insensitive comparison against
`existingPaths`), the pair goes to `conflicts` and is not moved.

The planner is pure and idempotent: planning again after its moves are applied
yields an empty plan.

### `VaultAdapter` — two new methods

In `src/shell/contracts.ts`, `ObsidianVaultAdapter` (`src/shell/vault.ts`) and
the test fake:

- `rename(from: string, to: string): Promise<void>` creates missing parent
  folders (reusing `#ensureFolders`), then calls `app.fileManager.renameFile`
  so Obsidian owns the move and applies the user's link-update preference.
  Rejects with `VaultWriteError` if `to` exists.
- `removeFolderIfEmpty(path: string): Promise<void>` deletes the folder only
  when it has no children. It never deletes files.

`MANAGED_FOLDERS` becomes the nine folders prefixed with `Javis-wiki/`.

### `src/shell/sync.ts` — where the move runs

The move is the first step of `runSync`, before `resolveCursor`:

1. List every `.md` path directly inside the nine root folders (case-insensitive).
2. Read each candidate's frontmatter with `readFrontmatter` (parses the file),
   **not** `metadataCache`. On the vault-open sync the cache may be incomplete.
   A missed Javis note would not move, and the download would then create a
   duplicate at the new path.
3. `planLayoutMove(candidates, existingPaths)`.
4. Apply each move with `rename`. Afterwards call `removeFolderIfEmpty` on each
   root folder that had at least one successful move this run. Untouched root
   folders are left alone, even when empty; they may be the user's.
5. Continue with the normal delta sync.

`SyncResult` gains `moved: number` and `moveConflicts: LayoutMove[]`.

### `src/core/folders.ts` — upload guard

The upload guard (`WIKI_FOLDERS`) is replaced by one rule: a selected folder
cannot be `Javis-wiki` or inside it (case-insensitive). The error reads
"Javis-wiki is the folder Javis writes; it cannot be uploaded back." The vault
root, config folder, hidden, duplicate and nesting rules are unchanged.

### `src/main.ts` — notices

- `moved > 0`: `Javis: moved N notes into Javis-wiki/.`
- `moveConflicts.length > 0`: the paths are written to the console on every
  run; on interactive runs only (Sync now, settings, review) a notice says
  `Javis: N notes in the vault root were not moved because Javis-wiki already
  has a note with the same name.` A conflict persists until the user resolves
  it, and a notice on every timer run would nag.
- Nothing moved: no notice.

## Error handling

| Case | Behaviour |
|------|-----------|
| A `rename` throws (file locked, I/O error) | The remaining moves still run. The sync then **stops before the download** and reports through the existing sync-failure notice. Continuing would let `create` write the page at its new path, leaving a permanent root/new-path conflict. The next sync retries. |
| A root note's frontmatter block will not parse, but it has a top-level `javis_slug:`/`javis_type:` line (hand-broken YAML) | Treated as a failed move: the other moves still run, then the sync **stops before the download** and the failure notice names the note. Skipping it would let `create` write a second copy under `Javis-wiki/`. Once the user fixes its YAML, the next sync moves it. |
| Destination already exists | Root file left in place, reported as a conflict. Sync continues and updates the `Javis-wiki/` copy. The user picks which copy to keep. |
| `removeFolderIfEmpty` throws | Logged and ignored; an empty folder is harmless and the next sync retries. |
| Nothing to move | Steady state. Only the folder listing runs, with no notice. |

**Links elsewhere in the vault.** With "Automatically update internal links"
on, Obsidian may rewrite the user's links to `[[Javis-wiki/Concepts/Foo]]`.
With it off, links stay `[[Concepts/Foo]]` and resolve by suffix. Both work. A
page body Obsidian rewrites is replaced with the server's version at that
page's next server update. This is harmless because `javis_rev` is untouched.

**Rollback.** Reinstalling 0.2.1 writes a fresh tree at the root, since the
old version only looks there. The release notes say so. There is no reverse
move.

## Testing

Unit tests (vitest):

- `tests/layout-move.test.ts` (new)
  - Javis notes in each of the nine folders are planned to their canonical
    destinations.
  - Notes without `javis_type`/`javis_slug` are not moved.
  - Folder names in other cases (`concepts/Foo.md`) match and map to
    `Javis-wiki/Concepts/Foo.md`.
  - Nested (`Concepts/sub/x.md`) and root-level (`x.md`) files are ignored.
  - Adopted and tombstoned notes move with their names kept.
  - An existing destination (in either case) is reported as a conflict.
  - Re-planning after the moves are applied is empty.
- `tests/sync.test.ts`
  - The move runs before cursor resolution.
  - A failed `rename` stops the run before any `create`.
  - A conflict still lets the `Javis-wiki/` copy update.
  - A second run makes no moves.
  - Only root folders touched by a move are removed, and only when empty.
- `tests/slug.test.ts`: `pathForPage` returns `Javis-wiki/…`.
- `tests/folders.test.ts`: `Javis-wiki` and `Javis-wiki/Topics` are refused. A
  root `Topics` folder is now allowed.
- `tests/vault.test.ts`: the new `MANAGED_FOLDERS`; the fake adapter gets
  `rename` and `removeFolderIfEmpty`.

Manual E2E, in the `Javis-wiki` vault, before tagging the release:

1. On 0.2.1, sync so the nine root folders exist. Edit one page's body and
   adopt another (`javis_sync: false`).
2. Install the 0.3.0 build and press **Sync now**. The tree matches the goal,
   the root wiki folders are gone, and the edited and adopted notes are intact.
   The notice reports the move count.
3. Click a `[[Concepts/…]]` link inside a wiki page. It opens the page under
   `Javis-wiki/Concepts/` (verifies D4).
4. Copy one note back to its old root path and sync. A conflict notice appears
   and nothing is overwritten.
5. Sync again: no moves, no notice.

## Release

- `npm version minor` → 0.3.0 (updates `manifest.json`, `versions.json`).
- README: rewrite "Nine folders, at the root of the vault" (≈ lines 89–118),
  the upload-guard sentence (≈ line 208), and the example paths
  (`Concepts/Agent-Builder.md`, `Sources/obsidian-note-<id>.md`).
- Release notes: describe the move and the rollback caveat.
- javis-server: no change. Source pages for uploaded notes now land in
  `Javis-wiki/Sources/`.

## Out of scope

- A configurable or blank (root) parent folder (D1).
- Rewriting links in page bodies, on the server or in the plugin (D4).
- A reverse move for downgrades.
