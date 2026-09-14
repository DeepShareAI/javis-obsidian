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
import { MARKER_START, replaceMarkerBlock } from './markers';

/**
 * The banner prepended to a note whose row was deleted on the server.
 *
 * A callout rather than a frontmatter key alone, because the frontmatter key is
 * invisible in reading mode and the user needs to know why the body emptied.
 * The literal text is also the idempotence guard: it is searched for before it
 * is prepended, so a tombstoned row that reappears in every subsequent delta
 * does not stack banners.
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
 * Blank the generated block and prepend the banner, leaving everything the
 * user wrote exactly where it is.
 *
 * Never unlinks and never truncates: §F.2, "The plugin never calls
 * `vault.delete` or `vault.trash`." A tombstone is a note that stops being
 * updated, not a note that goes away.
 *
 * Idempotent: a second application finds the banner already present and
 * replaces an already-empty block with an empty block.
 */
export function applyTombstone(content: string): string {
  const blanked = replaceMarkerBlock(content, '');
  if (blanked.includes(TOMBSTONE_BANNER)) return blanked;

  // Insert above the generated block but below any frontmatter, so the banner
  // is the first thing rendered and the frontmatter stays a valid YAML block.
  const at = blanked.indexOf(MARKER_START);
  if (at === -1) return `${blanked.replace(/\s+$/, '')}\n\n${TOMBSTONE_BANNER}\n`;
  const head = blanked.slice(0, at).replace(/[ \t]+$/, '');
  return `${head}${TOMBSTONE_BANNER}\n\n${blanked.slice(at)}`;
}

/** The frontmatter of a tombstoned note: the file's own, plus the flag. */
export function tombstoneFrontmatter(existing: Frontmatter): Frontmatter {
  return { ...existing, [JAVIS_DELETED]: true };
}
