# Obsidian review recommendations (0.3.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop listing the whole vault where a few folders are enough, and publish releases with a signed build-provenance attestation, released as 0.3.3.
**Architecture:** `ObsidianVaultAdapter` gains one private folder walker used by `listMarkdownFiles(folders, opts)` and `listNotesIn(folders)`. sync.ts passes `Javis-wiki/` or the legacy root folders. A new GitHub Actions workflow builds, tests, attests and uploads release assets on a version tag.
**Tech Stack:** TypeScript, Obsidian API (types only at runtime), vitest, esbuild, GitHub Actions (`actions/attest-build-provenance@v2`).

Bug doc: docs/javis-dev/spec/2026-10-28-obsidian-review-recommendations-bug.md
Impact (gitnexus): `VaultAdapter.listMarkdownFiles` is LOW risk (3 direct callers, the #download flow). `ObsidianVaultAdapter.listNotesIn` is HIGH risk (the #upload, readNotes and uploadOnce flows): a note it fails to list is treated as deleted. Task 3 therefore pins the new walk against the old whole-vault filter.

---

### Task 0: Baseline

- [ ] `npm test && npm run typecheck`. Expected: 22 files, 685 tests pass; typecheck clean. Record the counts.

### Task 1: Folder walker in the adapter

**Files:** Modify `src/shell/vault.ts` (adapter, near `listMarkdownFiles` at :511 and `listNotesIn` at :577)

- [ ] Add a private `#markdownIn(folder: string, recursive: boolean): TFile[]`:
  - resolve the folder with `this.#resolve(folder)`;
  - `getFolderByPath` returns null → `[]`;
  - walk `children`: a child with `children` is a folder (recurse when `recursive`); a child with `extension === 'md'` is a note;
  - no `instanceof`, because `obsidian` is not imported at runtime.
- [ ] `listMarkdownFiles(folders: readonly string[], opts: { recursive: boolean })` maps `#markdownIn` over the folders, dedupes by path, and keeps the frontmatter copy from the metadata cache as today.
- [ ] `listNotesIn(folders)`: build `byPath` from `#markdownIn(folder, true)` for each folder (deduped), then `notesUnder([...byPath.keys()], folders)` as today, so the output is unchanged.
- [ ] Add `legacyRootFolders(): string[]`: the root children that are folders and whose lowercased name is a legacy plural. This needs `isLegacyFolderName(name)` exported from src/core/layout-move.ts over `CANONICAL`.

### Task 2: Contract and callers

**Files:** `src/shell/contracts.ts:421`, `src/shell/sync.ts:96, :263, :439`, `src/core/layout-move.ts`

- [ ] `VaultAdapter.listMarkdownFiles(folders, opts)` with the doc comment updated (no longer "every markdown file in the vault"); add `legacyRootFolders()`.
- [ ] sync.ts:96 and :439 → `vault.listMarkdownFiles([WIKI_ROOT], { recursive: true })`.
- [ ] sync.ts:263 → `vault.listMarkdownFiles(vault.legacyRootFolders(), { recursive: false })`.
- [ ] Update the fakes: tests/sync.test.ts `FakeVault.listMarkdownFiles` filters its notes by folder and depth; add `legacyRootFolders`.

### Task 3: Tests

**Files:** `tests/vault-adapter-folders.test.ts` (it already fakes the tree), `tests/layout-move.test.ts`

- [ ] The fake tree holds `Javis-wiki/Topics/a.md`, `Javis-wiki/Tasks/t.md`, `topics/old.md` (lower case), `Journal/x.md`, `Journal2/y.md`, `Journal/sub/z.md`, `Journal/c.canvas`, and a `getMarkdownFiles` that throws.
- [ ] `listMarkdownFiles(['Javis-wiki'], {recursive:true})` returns exactly the two Javis-wiki notes.
- [ ] `legacyRootFolders()` returns `['topics']`; `listMarkdownFiles(['topics'], {recursive:false})` returns `topics/old.md`.
- [ ] Pinning test: `listNotesIn(['Journal'])` equals `notesUnder(<all .md paths>, ['Journal'])`, i.e. `Journal/x.md` and `Journal/sub/z.md`, not `Journal2/y.md` or the canvas. The same holds for a folder given in a different case than on disk.
- [ ] `isLegacyFolderName` is case-insensitive, and `Tasks` is not legacy.
- [ ] `npm test && npm run typecheck`. Expected: the baseline count plus the new tests, all passing.
- [ ] `rg -n "getMarkdownFiles|getFiles\(" src` prints nothing.

### Task 4: README

- [ ] Add a "Files the plugin can see" section under "What it does not do". It lists `Javis-wiki/` (sync), the upload folders you choose, the nine legacy root folders (only to move 0.2.x notes), and folder names for the settings picker. It states that no other file is read.
- [ ] Add a "Releasing" note: push a version tag, and the Release workflow builds, attests and uploads; no hand uploads.

### Task 5: Release workflow

**Files:** Create `.github/workflows/release.yml`

- [ ] Triggers: `push` tags `'[0-9]+.[0-9]+.[0-9]+'`, and `workflow_dispatch` with input `tag`. Permissions: `contents: write`, `id-token: write`, `attestations: write`.
- [ ] Steps:
  - checkout at the tag;
  - setup-node 22 with npm cache;
  - `npm ci`, `npm test`, `npm run build`;
  - check that `node -p "require('./manifest.json').version"` equals the tag;
  - `actions/attest-build-provenance@v2` with `subject-path: main.js`;
  - `gh release view "$TAG" || gh release create "$TAG" --verify-tag --title "$TAG" --generate-notes`;
  - `gh release upload "$TAG" main.js manifest.json --clobber`.

### Task 6: Version 0.3.3, commit, PR, release

- [ ] `npm version 0.3.3 --no-git-tag-version` (runs version-bump.mjs: manifest.json, versions.json, package.json, package-lock.json).
- [ ] Commit on `fix/obsidian-review-recommendations`, open a PR, and merge it once tests are green.
- [ ] Tag `0.3.3` on the merge commit and push the tag. The workflow then releases.
- [ ] Verify: the workflow run is green; the release has `main.js` and `manifest.json`; `gh attestation verify <downloaded main.js> -R DeepShareAI/javis-obsidian` passes. Set the release notes with `gh release edit`.
