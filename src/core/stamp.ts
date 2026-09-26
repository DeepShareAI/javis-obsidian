/**
 * The id stamp: one line of text, inserted without reformatting anything.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §F.2 ("The stamp is a text insert, not `processFrontMatter`"), §F.1
 *       (the copy and deleted-id restamps), Goals ("it never reformats a user's
 *       frontmatter").
 * Plan: docs/plans/2026-09-24-upload-half.md, D-STAMP-1..5.
 *
 * Why text and not `FileManager.processFrontMatter`: that API re-serializes the
 * whole block. It drops comments and quotes, rewrites flow lists and dates, and
 * drops `!!` tags; Obsidian staff call this intended (forum thread 65851). On a
 * note the user wrote by hand that is an unrequested edit to their file — the
 * one thing Phase 1 promised never to do. So:
 *
 * 1. **Byte-identical except for the one inserted line** (or the three prepended
 *    lines when there is no block). tests/stamp.test.ts removes the line again
 *    and asserts `===` against the input.
 * 2. **The file's own line break** is used for what we insert (D-STAMP-1), so a
 *    CRLF note stays uniformly CRLF and a Windows editor does not flag it.
 * 3. **Malformed is refused** (D-STAMP-5): an opening fence with no close. There
 *    is no block to put a line into, and prepending a new one would turn the
 *    user's half-typed properties into body text. Reported in settings.
 * 4. **Idempotent.** These are the transforms handed to `vault.process`, which
 *    may call them more than once, and a note that already carries an id is
 *    never stamped again — that is what makes a two-device stamp loop
 *    (obsync #179) impossible rather than merely unlikely.
 * 5. **Pure.** The uuid is an argument; the core never generates one (D-ID-3).
 */

import { findTopLevelLine, frontmatterRange, readSourceId, scalarValue, SOURCE_ID_KEY } from './note-text';

export type StampResult =
  /** The new text. */
  | { kind: 'ok'; text: string }
  /** Nothing to do: the note already carries an id (stamp) or this id (restamp). */
  | { kind: 'already' }
  /** An opening `---` with no closing fence. Not touched; reported. */
  | { kind: 'malformed' }
  /** Restamp only: the note has no `javis_source_id` line to rewrite. */
  | { kind: 'missing' };

/**
 * Give a note its `javis_source_id`.
 *
 * - A closed block: insert `javis_source_id: <id>` directly before the closing
 *   fence. Last, not first, so the user's own keys keep their order in the
 *   Properties view and the diff is one line at the bottom of the block.
 * - No block: prepend `---`, the line, `---` (after the BOM, if any — the BOM
 *   must stay the first bytes of the file, D-STAMP-2).
 * - A note with any `javis_source_id` line — valid or not — is `already`.
 */
export function stampText(content: string, id: string): StampResult {
  const range = frontmatterRange(content);
  if (range.kind === 'malformed') return { kind: 'malformed' };
  if (readSourceId(content) !== null) return { kind: 'already' };

  const line = `${SOURCE_ID_KEY}: ${id}${range.eol}`;
  if (range.kind === 'none') {
    const head = content.slice(0, range.start);
    const tail = content.slice(range.start);
    return { kind: 'ok', text: `${head}---${range.eol}${line}---${range.eol}${tail}` };
  }
  return {
    kind: 'ok',
    text: `${content.slice(0, range.closeStart)}${line}${content.slice(range.closeStart)}`,
  };
}

/**
 * Replace the value on the existing top-level `javis_source_id:` line, and
 * nothing else (D-STAMP-4).
 *
 * Used when two notes share an id (a copy) and when the server says the id was
 * deleted (§E: an id is never resurrected, so the note needs a new one to be
 * uploaded again). The value is written bare — a uuid needs no quotes — and the
 * line's own break is kept.
 */
export function restampText(content: string, newId: string): StampResult {
  const range = frontmatterRange(content);
  if (range.kind === 'malformed') return { kind: 'malformed' };
  const found = findTopLevelLine(content, SOURCE_ID_KEY);
  if (found === null) return { kind: 'missing' };
  if (scalarValue(found.rawValue).toLowerCase() === newId.toLowerCase()) return { kind: 'already' };
  return {
    kind: 'ok',
    text: `${content.slice(0, found.lineStart)}${SOURCE_ID_KEY}: ${newId}${content.slice(found.lineEnd)}`,
  };
}
