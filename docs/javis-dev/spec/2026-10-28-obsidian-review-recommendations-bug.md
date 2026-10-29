# Bug: Obsidian review flags vault enumeration and unattested release assets

## Symptoms

The plugin review for `javis-wiki-sync` on community.obsidian.md, run against release 0.3.2, lists two **Recommendations** (not errors):

1. **Vault Enumeration**: the plugin "enumerates all files in the vault (`vault.getFiles`, `getMarkdownFiles`, etc.)", which gives it access to every file path in the vault.
2. **Releases**: the release asset `main.js` has no GitHub artifact attestation, so users cannot verify it was built from this repository.

## Root Cause

### 1. Whole-vault listings where a few folders would do

`ObsidianVaultAdapter` (src/shell/vault.ts) lists the whole vault in three places, although each needs only a few folders. These calls predate 0.3.2: 0.3.2 did not touch them.

| Call | Caller | What it actually needs |
|---|---|---|
| `listMarkdownFiles()` → `vault.getMarkdownFiles()` (vault.ts:513) | sync.ts:96 and :439, the cursor rescan (`maxRevision`) | Notes under `Javis-wiki/`: only downloaded pages carry `javis_rev`. A page still in a legacy root folder that is missed only lowers the cursor, which sync.ts already treats as safe (a lower cursor re-delivers pages the loop skips as `unchanged`). |
| the same | sync.ts:263, the 0.2.x layout move | Notes directly inside the nine legacy root folders (`legacyDestination` accepts only `<Folder>/<name>.md`, any case of the folder name). |
| `listNotesIn(folders)` → `vault.getMarkdownFiles()` (vault.ts:579), then `notesUnder` filters | upload.ts:431 | Notes under the upload folders the user selected. |
| `folderPaths()` → `vault.getAllFolders(false)` (vault.ts:614) | folder-suggest.ts:37, the settings folder picker | Every folder **name**: a picker has to offer them all. It reads no file and sends nothing. Kept, and disclosed. |

### 2. Hand-built release

Release 0.3.2 was built on a Mac (`npm run build`) and uploaded with `gh release create`. The repo has no `.github/workflows/`, so no CI build exists that could sign a provenance attestation for `main.js`.

## Fix

1. Add a private helper `#markdownIn(folder, { recursive })` to `ObsidianVaultAdapter`. It walks `getFolderByPath(folder).children` (a `TFolder` has `children`; a `TFile` with `extension === 'md'` is a note; no `instanceof`, because `obsidian` is not imported at runtime).
   - `listMarkdownFiles(folders, opts)` takes the folders to list. The contract changes in contracts.ts and in the test fake.
   - Cursor rescan (sync.ts:96, :439): `listMarkdownFiles([WIKI_ROOT], { recursive: true })`.
   - Layout move (sync.ts:263): the legacy root folders that exist (root children whose lowercased name is a legacy plural), non-recursive.
   - `listNotesIn(folders)`: walks only the selected folders, then applies `notesUnder` as before, so the result is identical.
   - `getMarkdownFiles` is no longer called anywhere. `getAllFolders` stays only in `folderPaths()`.
2. README: add a short "Files the plugin can see" section saying what the plugin lists and why. That covers `Javis-wiki/`, the upload folders you pick, the legacy root folders (once, on upgrade), and folder names for the picker.
3. Add `.github/workflows/release.yml`. On a pushed `x.y.z` tag, or a manual run with a tag:
   - `npm ci`, `npm test`, `npm run build`;
   - check that the tag equals `manifest.json` `version`;
   - `actions/attest-build-provenance@v2` on `main.js`;
   - create the release if it is missing, then `gh release upload --clobber main.js manifest.json`.
4. Bump to 0.3.3 (`npm version 0.3.3 --no-git-tag-version`, which also updates manifest.json and versions.json), merge, tag `0.3.3`, and let the workflow publish it.

## Testing

- New unit tests in tests/vault-adapter-folders.test.ts, which already fakes the Obsidian tree:
  - each listing returns exactly the notes of the given folders;
  - the layout-move folder lookup is case-insensitive;
  - a fake `getMarkdownFiles` that throws is never called.
- The existing sync, layout-move and upload tests run unchanged, with the fake updated to the new signature.
- `npm test`, `npm run typecheck`, `npm run build`.
- `rg -n "getMarkdownFiles|getFiles\(" src` prints nothing.
- After the 0.3.3 tag: the workflow run is green, and `gh attestation verify main.js -R DeepShareAI/javis-obsidian` passes on the downloaded asset.

## Prevention

- Releases go through the workflow only; a hand `gh release create` is no longer the release path (README "Releasing").
- The adapter has no whole-vault listing left except the folder picker, and the README states what the plugin can see.
