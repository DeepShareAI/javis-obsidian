/**
 * Which folders may be selected for upload.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §F.3.1 ("A selected folder cannot be the vault root, `.obsidian/`, one
 *       of the nine wiki folders, or anything inside one. Selected folders
 *       cannot nest."), §A ("There is no loop").
 * Plan: docs/plans/2026-09-24-upload-half.md, D-FOLD-1, D-PLAN-11.
 *
 * Each rule is there to stop a specific failure:
 *
 * 1. **Not the root.** Selecting the root would upload the nine wiki folders
 *    too, i.e. feed Javis its own output — the loop §A rules out.
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
 * 3. **Not the config folder.** Plugin data, workspace state and (for this
 *    plugin) `data.json` live there. `configDir` is a parameter because a vault
 *    can rename it.
 * 4. **No nesting, no duplicates.** A note under two selected folders would be
 *    listed twice, and removing the outer folder would look like a move.
 * 5. **No hidden segment** (a segment starting with `.`). Obsidian does not
 *    index hidden folders, so their notes are never listed — and a note that is
 *    never listed looks deleted to the delete guards.
 */

import { WIKI_ROOT } from './slug';

/** Trim, drop leading and trailing `/`, collapse `//`. `''` is the vault root. */
export function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** True when `path` is strictly inside `folder` (a path-segment prefix, not a string prefix). */
export function isUnderFolder(path: string, folder: string): boolean {
  if (folder === '') return false;
  return path.startsWith(`${folder}/`);
}

function isSameOrUnder(path: string, folder: string): boolean {
  return path === folder || isUnderFolder(path, folder);
}

export interface FolderError {
  /** The folder as the caller supplied it, normalized. */
  folder: string;
  /** A sentence for the settings UI. */
  reason: string;
}

export interface FolderValidation {
  /** Normalized folders that passed, in input order. */
  ok: string[];
  errors: FolderError[];
}

/**
 * Validate a whole selection at once, because nesting and duplicates are
 * properties of the set, not of one folder.
 *
 * Both ends of a nested pair are rejected, not just the inner one: which of the
 * two the user meant is not ours to guess, and a partly valid selection must
 * not be acted on (D-PLAN-11).
 */
export function validateFolders(folders: readonly string[], configDir: string): FolderValidation {
  // Every comparison is on the lowercased form (rule 2); what is returned and
  // reported is the folder as the user spelled it, normalized.
  const fold = (path: string): string => path.toLowerCase();
  const config = fold(normalizeFolder(configDir));
  const normalized = folders.map(normalizeFolder);
  const folded = normalized.map(fold);
  const ok: string[] = [];
  const errors: FolderError[] = [];
  const seen = new Set<string>();

  for (const [index, folder] of normalized.entries()) {
    const key = folded[index]!;
    const fail = (reason: string): void => {
      errors.push({ folder, reason });
    };

    if (folder === '') {
      fail('The vault root cannot be uploaded; choose a folder inside it.');
      continue;
    }
    if (config !== '' && isSameOrUnder(key, config)) {
      fail("Obsidian's settings folder cannot be uploaded.");
      continue;
    }
    if (isSameOrUnder(key, fold(WIKI_ROOT))) {
      fail(`${WIKI_ROOT} is the folder Javis writes; it cannot be uploaded back.`);
      continue;
    }
    if (folder.split('/').some((segment) => segment.startsWith('.'))) {
      fail('Hidden folders cannot be uploaded, because Obsidian does not list their notes.');
      continue;
    }
    if (seen.has(key)) {
      fail('This folder is already selected.');
      continue;
    }
    const nestAt = folded.findIndex(
      (other, j) => j !== index && other !== key && other !== '' && (isUnderFolder(key, other) || isUnderFolder(other, key)),
    );
    if (nestAt !== -1) {
      const nest = normalized[nestAt]!;
      fail(
        isUnderFolder(key, folded[nestAt]!)
          ? `This folder is inside ${nest}, which is also selected.`
          : `This folder contains ${nest}, which is also selected.`,
      );
      continue;
    }
    seen.add(key);
    ok.push(folder);
  }
  return { ok, errors };
}
