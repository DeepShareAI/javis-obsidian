/**
 * The text of a user note, as the upload half sees it: where its frontmatter
 * block sits, what gets sent, what gets hashed, and the two properties read out
 * of it (the source id and the title).
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §B.1 (the stored body has `javis_*` lines removed), §E (the server
 *       rejects `sha256(text) != body_hash`), §F.1 (the hash; "stamping never
 *       looks like an edit"), §F.2 (the stamp is a text insert).
 * Plan: docs/plans/2026-09-24-upload-half.md, D-HASH-1..5, D-ID-1..2, D-PLAN-17.
 *
 * Five rules, each load-bearing:
 *
 * 1. **Everything here is text-level. Nothing parses YAML.** The id must be
 *    readable from a note whose YAML the user has broken by hand (a stray colon
 *    in a title is the common case), because identity is what keeps a rename
 *    from becoming a delete plus a new source. `parseYaml`/`metadataCache` would
 *    answer "no id" for such a note, and the plugin would stamp it a second
 *    time — the obsync #179 loop, one device at a time.
 * 2. **The scanner agrees with `extractFrontmatterBlock` (src/shell/vault.ts)
 *    about where a block is**, and therefore with Obsidian: the first line must
 *    be exactly `---` (a BOM is skipped), and the block ends at the first later
 *    line that is exactly `---`. It is a second implementation rather than a
 *    call because the stamp needs byte OFFSETS into the original string, and
 *    the shell helper normalizes CRLF before it looks. tests/note-text.test.ts
 *    pins the two to each other.
 * 3. **What is hashed is exactly what is sent** (D-HASH-1). `uploadText` is the
 *    PUT's `text`, and `noteHash` is `sha256(uploadText)`. §B.1 stores the body
 *    "with javis_* lines removed" and §E checks `sha256(text) == body_hash`;
 *    hashing anything other than the transmitted string breaks one of the two.
 * 4. **A block that is empty after removal is dropped with its fences, and so is
 *    one that was empty to begin with** (D-HASH-2). The stamp prepends a fence
 *    pair to a note without frontmatter, so without this rule the first upload
 *    of every such note would hash differently from the note the user wrote,
 *    and `hash(stamp(t)) == hash(t)` — the reason a stamp is never an edit —
 *    would fail on the most common kind of note there is.
 * 5. **No clock, no I/O, no Obsidian.** Same rule as the rest of src/core.
 */

import { sha256Hex } from './sha256';

// ---------------------------------------------------------------------------
// The frontmatter block
// ---------------------------------------------------------------------------

/** Where a note's frontmatter block sits, as offsets into the ORIGINAL text. */
export type FrontmatterRange =
  /** The first line is not `---`: the note has no frontmatter. */
  | { kind: 'none'; start: number; eol: string }
  /**
   * The first line is `---` but no later line closes it. Obsidian shows such a
   * note as having no properties; the stamp refuses it (§F.2), because
   * inserting a line into a block that does not exist would move the user's
   * body into their properties the moment they add the missing fence.
   */
  | { kind: 'malformed'; start: number; eol: string }
  | {
      kind: 'block';
      /** Offset of the opening `---` (1 when the file starts with a BOM, else 0). */
      start: number;
      /** Offset just past the opening fence's line break. */
      openEnd: number;
      /** Offset of the closing `---`. Equals `openEnd` for an empty block. */
      closeStart: number;
      /** Offset just past the closing fence's line break, or the end of the text. */
      closeEnd: number;
      /** The line break the opening fence uses: `\n` or `\r\n`. */
      eol: string;
    };

const BOM = '﻿';
const FENCE = '---';

/** The file's own line break: the first one found, `\n` when there is none. */
function firstEol(text: string): string {
  const lf = text.indexOf('\n');
  if (lf < 0) return '\n';
  return lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Find the frontmatter block without changing a byte.
 *
 * Line breaks are `\n` and `\r\n`, as in `extractFrontmatterBlock`. A lone `\r`
 * is not a break here (it is not one to Obsidian's reader either); `uploadText`
 * normalizes it before scanning, which is the only other caller that cares.
 */
export function frontmatterRange(text: string): FrontmatterRange {
  const start = text.startsWith(BOM) ? 1 : 0;
  const eol = firstEol(text);

  // The opening line, which must be exactly `---`.
  const firstBreak = text.indexOf('\n', start);
  const firstLineEnd = firstBreak < 0 ? text.length : firstBreak;
  let firstLine = text.slice(start, firstLineEnd);
  if (firstLine.endsWith('\r')) firstLine = firstLine.slice(0, -1);
  if (firstLine !== FENCE) return { kind: 'none', start, eol };
  if (firstBreak < 0) return { kind: 'malformed', start, eol };

  const openEnd = firstBreak + 1;
  let cursor = openEnd;
  while (cursor <= text.length) {
    const lf = text.indexOf('\n', cursor);
    const lineEnd = lf < 0 ? text.length : lf;
    let line = text.slice(cursor, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === FENCE) {
      return {
        kind: 'block',
        start,
        openEnd,
        closeStart: cursor,
        closeEnd: lf < 0 ? text.length : lf + 1,
        eol,
      };
    }
    if (lf < 0) break;
    cursor = lf + 1;
  }
  return { kind: 'malformed', start, eol };
}

/**
 * The block's lines, each WITHOUT its line break, plus the break style. Empty
 * for an empty block. Only meaningful for `kind: 'block'`.
 */
function blockLines(text: string, range: Extract<FrontmatterRange, { kind: 'block' }>): string[] {
  const inner = text.slice(range.openEnd, range.closeStart);
  if (inner === '') return [];
  // `inner` always ends in the break that precedes the closing fence.
  const body = inner.endsWith('\r\n') ? inner.slice(0, -2) : inner.slice(0, -1);
  return body.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

/** A top-level (column-0) key named `javis_*`. */
const JAVIS_KEY = /^javis_[^\s:]*\s*:/;

/**
 * A line that continues the value of the key above it: indented, or a
 * column-0 sequence item (`- a` is legal YAML directly under a top-level key).
 */
function isContinuation(line: string): boolean {
  return /^[ \t]/.test(line) || line === '-' || line.startsWith('- ');
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * Drop every top-level `javis_*` key and its continuation lines.
 *
 * Blank lines directly after a removed key are removed only when more of its
 * value follows them (a block scalar can contain a blank line); a trailing run
 * of blanks is given back, because it separates the user's own keys.
 */
function withoutJavisKeys(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!JAVIS_KEY.test(line)) {
      kept.push(line);
      i += 1;
      continue;
    }
    // Skip the key, then its continuation run.
    let j = i + 1;
    let lastContinuation = i;
    while (j < lines.length && (isContinuation(lines[j]!) || isBlank(lines[j]!))) {
      if (!isBlank(lines[j]!)) lastContinuation = j;
      j += 1;
    }
    i = lastContinuation + 1;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// What is sent and what is hashed
// ---------------------------------------------------------------------------

/** Strip the BOM and normalize every line break to `\n`. */
function normalizeEol(text: string): string {
  const noBom = text.startsWith(BOM) ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

/**
 * The PUT's `text` (D-HASH-1): BOM stripped, line breaks normalized to `\n`,
 * top-level `javis_*` frontmatter keys removed with their continuation lines,
 * and a block left empty (or empty to begin with) dropped with its fences.
 *
 * A malformed note (unclosed opening fence) has no block to edit and is only
 * EOL-normalized. It is never stamped, so it never carries a line we wrote.
 */
export function uploadText(raw: string): string {
  const text = normalizeEol(raw);
  const range = frontmatterRange(text);
  if (range.kind !== 'block') return text;

  const kept = withoutJavisKeys(blockLines(text, range));
  const rest = text.slice(range.closeEnd);
  if (kept.every(isBlank)) return rest;

  return `${text.slice(0, range.openEnd)}${kept.map((l) => `${l}\n`).join('')}${text.slice(range.closeStart)}`;
}

/**
 * The note's body: everything after a well-formed frontmatter block, or the
 * whole (EOL-normalized) note when there is none or it is malformed.
 *
 * E2E runbook F3: the blank and >80%-shrink guards measure THIS, not the sent
 * text. A short note's properties block used to keep a body wipe above both
 * thresholds (177 → 82 bytes with the body gone), and the wipe was uploaded.
 */
export function bodyText(raw: string): string {
  const text = normalizeEol(raw);
  const range = frontmatterRange(text);
  return range.kind === 'block' ? text.slice(range.closeEnd) : text;
}

/**
 * A digest of the note's CONTENT that ignores the order of its top-level
 * frontmatter keys, `javis_*` keys and line-ending style. Planner-only: the
 * wire hash stays `noteHash` (the server checks `sha256(text) == body_hash`).
 *
 * E2E runbook D2: Obsidian's Properties editor reorders keys, which changed
 * `noteHash` and re-sent (and re-distilled) a note whose content had not
 * changed. Each top-level key is kept together with its continuation lines,
 * the groups are sorted, and the body is appended; text-level only, like the
 * rest of this module, so a note with broken YAML still gets a key.
 */
export function contentKey(raw: string): string {
  const text = normalizeEol(raw);
  const range = frontmatterRange(text);
  if (range.kind !== 'block') return sha256Hex(`\u0000frontmatter\u0000\n${text}`);
  const groups: string[] = [];
  for (const line of withoutJavisKeys(blockLines(text, range))) {
    if (groups.length > 0 && (isContinuation(line) || isBlank(line))) {
      groups[groups.length - 1] += `\n${line}`;
    } else if (!isBlank(line)) {
      groups.push(line);
    }
  }
  const keys = groups.map((g) => g.replace(/\s+$/, '')).sort();
  return sha256Hex(`\u0000frontmatter\u0000${keys.join('\u0001')}\n${text.slice(range.closeEnd)}`);
}

/** `sha256(uploadText(raw))`, 64 lowercase hex. The server recomputes exactly this. */
export function noteHash(raw: string): string {
  return sha256Hex(uploadText(raw));
}

/** UTF-8 length, which is what §E's 256 KiB limit counts. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * True when `text` holds a UTF-16 surrogate that is not half of a pair.
 *
 * `TextEncoder` turns one into U+FFFD, so our hash would cover a character the
 * server never receives; Python's `str.encode('utf-8')` raises on it outright.
 * Either way the PUT fails, so such a note is reported as unreadable instead
 * (D-HASH-5). Only reachable through a corrupted file.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * True when the server would refuse `text` as a string field: a lone surrogate
 * (D-HASH-5) or a NUL. The server's `_storable` / `_check_text_and_hash`
 * answer 400 "text contains invalid characters" (or "title contains ...") for
 * either, because a PostgreSQL `text` column can hold neither. Before the
 * contract review only the surrogate was screened here, so a note with a NUL
 * (a pasted binary fragment, a corrupted sync) was planned as a PUT, failed
 * with a 400, and was planned again on every run: one request from the
 * 120/min bucket each time and a failure that never became a visible skip.
 *
 * The whole file text is checked, not only what `uploadText` sends: the title
 * is read from the same text, and a NUL on a stripped `javis_*` line is a
 * corrupted file too. The text is never rewritten to drop the NUL, because the
 * server hashes exactly what it receives and the hash must stay ours.
 */
export function hasInvalidChars(text: string): boolean {
  return text.includes('\u0000') || hasLoneSurrogate(text);
}

// ---------------------------------------------------------------------------
// Properties read out of the text
// ---------------------------------------------------------------------------

/** The key the stamp writes (§F.2). */
export const SOURCE_ID_KEY = 'javis_source_id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical 8-4-4-4-12 hex, either case. The server 400s anything else (§E). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * A scalar's text: one layer of matching quotes stripped, or, unquoted, a
 * trailing ` # comment` dropped. Deliberately not a YAML parser (rule 1).
 */
export function scalarValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) return value.slice(1, -1);
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

/**
 * The first top-level `key:` line inside the block: its offsets in the
 * ORIGINAL text (line break excluded) and the raw text after the colon. Null
 * when the note has no closed block or the block has no such line.
 *
 * Offsets rather than a copy because the restamp rewrites exactly this span and
 * nothing else.
 */
export function findTopLevelLine(
  text: string,
  key: string,
): { lineStart: number; lineEnd: number; rawValue: string } | null {
  const range = frontmatterRange(text);
  if (range.kind !== 'block') return null;
  const pattern = new RegExp(`^${key}\\s*:(.*)$`);
  let cursor = range.openEnd;
  while (cursor < range.closeStart) {
    const lf = text.indexOf('\n', cursor);
    const breakAt = lf < 0 || lf > range.closeStart ? range.closeStart : lf;
    const lineEnd = breakAt > cursor && text[breakAt - 1] === '\r' ? breakAt - 1 : breakAt;
    const match = pattern.exec(text.slice(cursor, lineEnd));
    if (match) return { lineStart: cursor, lineEnd, rawValue: match[1] ?? '' };
    cursor = breakAt + 1;
  }
  return null;
}

/** The value of the first top-level `key:` line in the block, or null. */
function topLevelValue(text: string, key: string): string | null {
  return findTopLevelLine(text, key)?.rawValue ?? null;
}

/**
 * The note's `javis_source_id`, read from the text (D-ID-1), or null when the
 * block has no such line.
 *
 * A line that is present but does not hold a uuid comes back `valid: false`
 * rather than null (D-ID-2): null would make the plan stamp the note, the stamp
 * would find the line and refuse (it is idempotent), and the note would be
 * neither uploaded nor reported. Invalid is reported in settings, and the file
 * is left alone — rewriting a line the user edited is an unrequested edit.
 */
export function readSourceId(text: string): { id: string; valid: boolean } | null {
  const raw = topLevelValue(text, SOURCE_ID_KEY);
  if (raw === null) return null;
  const id = scalarValue(raw).toLowerCase();
  return { id, valid: isUuid(id) };
}

/**
 * True when the note is one the download wrote: its frontmatter block has a
 * top-level `javis_slug:` or `javis_type:` line, the keys `mergeServerKeys`
 * writes into every wiki page and that nothing else in the plugin writes.
 *
 * Defense in depth for §A's "there is no loop" (review): folder validation is
 * the first guard, but a wiki page can still land in a selected folder — a
 * case-insensitive volume, a page the user moved by hand — and uploading it
 * would feed the wiki its own output. Such a note is skipped, never stamped.
 */
export function isWikiPageText(text: string): boolean {
  return findTopLevelLine(text, 'javis_slug') !== null || findTopLevelLine(text, 'javis_type') !== null;
}

/** §B.1 `title` is `String(500)`. */
export const MAX_TITLE_CHARS = 500;

/**
 * The note's title (D-PLAN-17): the top-level `title:` scalar, else the file
 * name without `.md`. A block scalar (`title: |`) is not read — its text is on
 * the following lines — and falls back to the file name.
 *
 * Truncated by code point, so a title never ends in half a surrogate pair,
 * which would itself be a lone surrogate on the wire.
 */
export function noteTitle(text: string, path: string): string {
  const raw = topLevelValue(text, 'title');
  let title = raw === null ? '' : scalarValue(raw);
  if (/^[|>]/.test(title)) title = '';
  if (title === '') {
    const base = path.slice(path.lastIndexOf('/') + 1);
    // Case-sensitive like the server's `_clean_title`: only a `.md` note is
    // ever enumerated (see `notesUnder`), so no other spelling reaches here.
    title = base.endsWith('.md') ? base.slice(0, -3) : base;
  }
  const points = Array.from(title);
  return points.length > MAX_TITLE_CHARS ? points.slice(0, MAX_TITLE_CHARS).join('') : title;
}
