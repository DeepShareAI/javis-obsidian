/**
 * Turning a server page into note text, and marking one as deleted.
 *
 * Pure: no Obsidian import, no filesystem, no clock. `render` produces the
 * whole file for a note that does not exist yet; an existing note is never
 * re-rendered wholesale, because everything outside the marker block belongs
 * to the user (see markers.ts).
 */

import type { Frontmatter, ServerPage } from './types';
import { JAVIS_DELETED } from './types';
import { mergeServerKeys, serializeFrontmatter } from './frontmatter';
import { replaceMarkerBlock } from './markers';

/**
 * The banner shown in a note whose row was deleted on the server.
 *
 * A callout rather than a frontmatter key alone, because the frontmatter key is
 * invisible in reading mode and the user needs to know why the body emptied.
 *
 * It is the generated block's *content* while the page is deleted — never text
 * written above the block. See applyTombstone for why that distinction is the
 * whole fix.
 */
export const TOMBSTONE_BANNER =
  '> [!warning] Deleted in Javis\n> This page no longer exists on the server. Nothing has been removed from this file except the generated block; the note itself is yours to keep or delete.';

/** Full note text for a page that has no file yet. */
export function render(page: ServerPage, existing: Frontmatter = {}): string {
  const frontmatter = mergeServerKeys(page, existing);
  const yaml = serializeFrontmatter(frontmatter);
  const body = replaceMarkerBlock('', page.body);
  return `---\n${yaml}---\n\n${body}`;
}

/**
 * Replace the generated block with the banner, leaving everything the user
 * wrote exactly where it is.
 *
 * Never unlinks and never truncates: §F.2, "The plugin never calls
 * `vault.delete` or `vault.trash`." A tombstone is a note that stops being
 * updated, not a note that goes away.
 *
 * The banner goes INSIDE the marker block, and that placement is load-bearing.
 * An earlier version wrote it above MARKER_START, in the half of the file the
 * plugin is forbidden to touch — so restoring the page cleared `javis_deleted`
 * and refilled the block but could never remove the banner, and a note deleted
 * once read as deleted forever. The E2E runbook's G3 caught it against a real
 * vault. Inside the block, a restore overwrites the banner like any other
 * generated content, with no exception carved out of the never-touch rule.
 *
 * Idempotent, and trivially so: replacing the block with the banner twice
 * yields the same file.
 */
export function applyTombstone(content: string): string {
  return replaceMarkerBlock(content, TOMBSTONE_BANNER);
}

/** The frontmatter of a tombstoned note: the file's own, plus the flag. */
export function tombstoneFrontmatter(existing: Frontmatter): Frontmatter {
  return { ...existing, [JAVIS_DELETED]: true };
}
