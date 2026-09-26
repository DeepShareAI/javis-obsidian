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
 * 2. **Not a wiki folder or inside one.** Same loop, one folder at a time. The
 *    names come from `TYPE_TO_PLURAL`, the same map the download writes with,
 *    compared case-INsensitively: on the default macOS (APFS) and Windows
 *    (NTFS) volumes a user's `sources` folder is the very directory the
 *    download writes `Sources/…` into, and Obsidian may list those pages
 *    under either spelling. (An earlier revision compared case-sensitively,
 *    "because that is how the download creates them"; review showed that lets
 *    the wiki's own pages be uploaded back.) Every other comparison here —
 *    the config folder, duplicates, nesting — is case-insensitive for the
 *    same reason; on a case-sensitive volume that only refuses a selection.
 * 3. **Not the config folder.** Plugin data, workspace state and (for this
 *    plugin) `data.json` live there. `configDir` is a parameter because a vault
 *    can rename it.
 * 4. **No nesting, no duplicates.** A note under two selected folders would be
 *    listed twice, and removing the outer folder would look like a move.
 * 5. **No hidden segment** (a segment starting with `.`). Obsidian does not
 *    index hidden folders, so their notes are never listed — and a note that is
 *    never listed looks deleted to the delete guards.
 */

import { TYPE_TO_PLURAL } from './slug';

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

const WIKI_FOLDERS: readonly string[] = [...new Set(Object.values(TYPE_TO_PLURAL))];

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
    const wiki = WIKI_FOLDERS.find((w) => isSameOrUnder(key, fold(w)));
    if (wiki !== undefined) {
      fail(`${wiki} is one of the wiki folders Javis writes; it cannot be uploaded back.`);
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
