/**
 * The generated-block markers, and the one function allowed to write inside
 * them.
 *
 * Spec §E / "Prior art": Ansible's `blockinfile` and `terraform-docs --inject`
 * both replace everything between two markers and leave the rest of the file
 * alone. Obsidian Sync's diff-match-patch merge is documented to produce
 * duplicated text a human then has to clean up. Wholesale block replacement
 * has no merge step and therefore no merge failures — which is the entire
 * reason a one-way mirror is safe to point at a file a human also edits.
 *
 * `%%` is Obsidian's native comment syntax: the markers render invisibly in
 * both reading and live-preview mode, so the user never sees them.
 */

export const MARKER_START = '%% javis:generated:start %%';
export const MARKER_END = '%% javis:generated:end %%';

/** Normalize line endings and strip the trailing blank lines that cause drift. */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/** The marker block for `body`, with no surrounding whitespace. */
function block(body: string): string {
  const inner = normalizeBody(body);
  return inner.length > 0
    ? `${MARKER_START}\n${inner}\n${MARKER_END}`
    : `${MARKER_START}\n${MARKER_END}`;
}

/**
 * Replace the generated block in `content` with `body`, or append one.
 *
 * Everything above `MARKER_START` and below `MARKER_END` is returned byte for
 * byte. That text belongs to the user permanently; this function is the only
 * thing standing between a human's notes and a generator that rewrites bodies
 * wholesale on every re-ingest.
 *
 * Idempotent by construction: the output always contains exactly one marker
 * pair, in the position the next call will find, wrapping exactly the text the
 * next call would write. `f(f(c, b)) === f(c, b)` for every input, including a
 * file with no markers, an empty file, and a file whose `%% ...:start %%` was
 * never closed.
 */
export function replaceMarkerBlock(content: string, body: string): string {
  const source = content.replace(/\r\n/g, '\n');
  const start = source.indexOf(MARKER_START);

  if (start === -1) {
    // No block yet. Append one, separated by a blank line from whatever the
    // user already wrote. A stray, unopened MARKER_END above is left where it
    // is: it is the user's text, and the next call will find OUR start marker
    // first and replace in place, so appending stays idempotent.
    const head = source.replace(/\s+$/, '');
    const prefix = head.length > 0 ? `${head}\n\n` : '';
    return `${prefix}${block(body)}\n`;
  }

  const endAt = source.indexOf(MARKER_END, start + MARKER_START.length);
  const head = source.slice(0, start);

  if (endAt === -1) {
    // An opened-but-unclosed block. Everything after the start marker was
    // claimed by the generator, so it is ours to replace; treating it as user
    // text instead would mean appending a second block and leaving two start
    // markers, which never converges.
    return `${head}${block(body)}\n`;
  }

  const tail = source.slice(endAt + MARKER_END.length);
  return `${head}${block(body)}${tail}`;
}

/**
 * The text currently inside the marker block, or null when there is no block.
 *
 * Read-only; used to decide whether a write is a no-op and to blank a block on
 * tombstone.
 */
export function extractMarkerBlock(content: string): string | null {
  const source = content.replace(/\r\n/g, '\n');
  const start = source.indexOf(MARKER_START);
  if (start === -1) return null;
  const endAt = source.indexOf(MARKER_END, start + MARKER_START.length);
  if (endAt === -1) return null;
  return source.slice(start + MARKER_START.length, endAt).replace(/^\n/, '').replace(/\n$/, '');
}
