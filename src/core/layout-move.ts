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
