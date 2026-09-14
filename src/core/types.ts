/**
 * The wire shapes and the vault shapes, with no Obsidian import anywhere.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md §B, §E.
 *
 * `ServerPage` mirrors `WikiExportPage` in app/tools/wiki/schemas.py field for
 * field. It is deliberately not `Partial<>`-ed or widened: a missing field on
 * the wire is a server bug, and the sync loop should fail loudly rather than
 * write half a note.
 */

/** One row of `wiki_pages` as `GET /wiki/export` serializes it. */
export interface ServerPage {
  page_type: string;
  slug: string;
  title: string;
  /** ISO8601. The only change signal; stored verbatim as `javis_rev`. */
  updated_at: string;
  frontmatter: Frontmatter;
  body: string;
  /** ISO8601 when the row is tombstoned, null while it is live. */
  deleted_at?: string | null;
}

/** One page of `GET /wiki/export`. */
export interface ExportResponse {
  pages: ServerPage[];
  /** null once the last row has been returned. Echoed back verbatim. */
  next_cursor: string | null;
  /**
   * The server's clock, held back by a lag window (see export.py). The client
   * stores THIS as the next `since`, never its own clock: skew otherwise opens
   * a window of permanently missed updates.
   */
  server_time: string;
}

/** A YAML frontmatter block, parsed. Values are whatever YAML produced. */
export type Frontmatter = Record<string, unknown>;

/** Frontmatter keys this plugin owns. Everything else belongs to the user. */
export const JAVIS_TYPE = 'javis_type';
export const JAVIS_SLUG = 'javis_slug';
export const JAVIS_REV = 'javis_rev';
export const JAVIS_SYNC = 'javis_sync';
export const JAVIS_DELETED = 'javis_deleted';
