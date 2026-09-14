/**
 * Frontmatter: merging the server's keys into a note's own, and emitting YAML.
 *
 * Spec §E, rules 1-4. Three of the four format rules live here:
 *
 *   1. `javis_type`, `javis_slug` and `javis_rev` carry identity and version;
 *      the path carries neither (the Readwise `booksIDsMap` lesson).
 *   2. `tags`, `aliases` and `cssclasses` are coerced to lists — Obsidian
 *      1.9.10 dropped the singular keys and no longer accepts scalar values
 *      for the plural ones.
 *   3. Any wikilink written into frontmatter is quoted, because unquoted
 *      `[[Foo]]` is a nested YAML flow sequence and the link dies silently.
 *
 * No Obsidian import: every function here takes plain data and returns plain
 * data, which is what makes the decisions testable (§G).
 */

import type { Frontmatter, ServerPage } from './types';
import { JAVIS_DELETED, JAVIS_REV, JAVIS_SLUG, JAVIS_SYNC, JAVIS_TYPE } from './types';

/** Keys Obsidian only understands as lists (§E rule 2). */
export const LIST_KEYS = ['tags', 'aliases', 'cssclasses'] as const;

/**
 * Emission order. Human-facing keys first, then ours, then whatever the user
 * or the server added. Fixed so that a re-render of an unchanged page produces
 * a byte-identical file and does not show up as a change to Obsidian Sync,
 * iCloud, or git (§J: we are the second sync system in this vault).
 */
const KEY_ORDER = ['title', 'aliases', 'tags', 'cssclasses', JAVIS_TYPE, JAVIS_SLUG, JAVIS_REV, JAVIS_SYNC, JAVIS_DELETED];

/**
 * Coerce a frontmatter value to a list of strings.
 *
 * A scalar becomes a one-element list; null, undefined and the empty string
 * become an empty list. Obsidian 1.9.10 ignores `tags: foo` outright, so the
 * cost of not doing this is silently untagged notes.
 */
export function toList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    const text = typeof item === 'string' ? item : String(item);
    if (text.length === 0) continue;
    out.push(text);
  }
  return out;
}

/** Union preserving first-seen order, with the empty string dropped. */
function union(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (item.length === 0 || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * The alias list for a page: the file's own aliases, then the server's, then
 * the raw slug.
 *
 * §E: "`aliases` is a union ... and the plugin never drops an alias it finds in
 * the file." The file's aliases come first so that adding a server alias never
 * reorders what the user already had — a reorder is a diff, and a diff in a
 * vault under Obsidian Sync or git is a conflict waiting to happen.
 *
 * The raw slug is always appended, which covers §E rule 4 ("when sanitization
 * changes the slug, add the original to `aliases`") without a conditional: when
 * sanitization was a no-op the alias merely restates the filename, which is
 * inert, and when it was not, links written against the original slug keep
 * resolving.
 */
export function mergeAliases(existing: Frontmatter, page: ServerPage): string[] {
  return union(toList(existing['aliases']), toList(page.frontmatter?.['aliases']), [page.slug]);
}

/**
 * Merge the server's view of a page into the frontmatter a note already has.
 *
 * Server keys win; keys only the user has survive untouched. Two exceptions,
 * and both are the point of the design:
 *
 *   - `javis_sync` is read from the file and written back unchanged. It is the
 *     release valve (§F.3), it is file-local, and a sync that could clear it
 *     would be a sync that can take a page back off the user.
 *   - `aliases` is a union rather than a replacement, so an alias the user
 *     added by hand is never dropped.
 */
export function mergeServerKeys(page: ServerPage, existing: Frontmatter = {}): Frontmatter {
  const merged: Frontmatter = { ...existing };

  // The server's own frontmatter, minus the keys we compute below and minus
  // anything in our namespace: `javis_*` means "written by this plugin from
  // this page's columns", and letting a JSONB blob claim those keys would let
  // the ingest pipeline forge a revision or clear the release valve.
  for (const [key, value] of Object.entries(page.frontmatter ?? {})) {
    if (key === 'aliases' || key === 'title') continue;
    if (key.startsWith('javis_')) continue;
    merged[key] = value;
  }

  merged['title'] = page.title;
  merged['aliases'] = mergeAliases(existing, page);
  for (const key of LIST_KEYS) {
    if (key in merged) merged[key] = toList(merged[key]);
  }

  merged[JAVIS_TYPE] = page.page_type;
  merged[JAVIS_SLUG] = page.slug;
  merged[JAVIS_REV] = page.updated_at;
  // Absent means "synced"; only an explicit `false` in the file opts out.
  merged[JAVIS_SYNC] = existing[JAVIS_SYNC] === false ? false : true;

  if (page.deleted_at) {
    merged[JAVIS_DELETED] = true;
  } else {
    // The row came back. Drop the tombstone flag rather than setting it false,
    // so a resurrected page looks exactly like one that was never deleted.
    delete merged[JAVIS_DELETED];
  }

  return merged;
}

/** True when the file's frontmatter opts this page out of syncing (§F.3). */
export function isAdopted(existing: Frontmatter | null): boolean {
  return existing !== null && existing[JAVIS_SYNC] === false;
}

/** The revision the file claims to hold, or null when it claims none. */
export function fileRevision(existing: Frontmatter | null): string | null {
  if (existing === null) return null;
  const rev = existing[JAVIS_REV];
  return typeof rev === 'string' ? rev : null;
}

/**
 * A plain scalar safe to emit unquoted: no YAML metacharacter, no leading or
 * trailing space, and nothing that would implicitly resolve to another type.
 *
 * Deliberately conservative. Over-quoting costs a pair of quotes; under-quoting
 * costs a silently mistyped value — and one of those values is `javis_rev`,
 * the only change signal in the system. `2026-09-13T04:12:00Z` unquoted
 * resolves to a Date under js-yaml's default schema, and a Date never compares
 * equal to the string the server sent, so every sync would rewrite every note
 * forever.
 */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 _.\-()'/]*$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const YAML_KEYWORD = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/;

function quoteString(value: string): string {
  if (
    value.length > 0 &&
    PLAIN.test(value) &&
    !NUMERIC.test(value) &&
    !YAML_KEYWORD.test(value) &&
    !value.endsWith(' ')
  ) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function emitScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return quoteString(value);
  return quoteString(String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emit(key: string, value: unknown, indent: string, out: string[]): void {
  const label = `${indent}${quoteString(key)}:`;

  if (value === null || value === undefined) {
    out.push(label);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${label} []`);
      return;
    }
    out.push(label);
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        // Nested collections inside a list have no frontmatter meaning in
        // Obsidian; flatten to a scalar rather than emit YAML the Properties
        // editor will refuse to round-trip.
        out.push(`${indent}  - ${emitScalar(JSON.stringify(item))}`);
      } else {
        out.push(`${indent}  - ${emitScalar(item)}`);
      }
    }
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push(`${label} {}`);
      return;
    }
    out.push(label);
    for (const [childKey, childValue] of entries) {
      emit(childKey, childValue, `${indent}  `, out);
    }
    return;
  }

  out.push(`${label} ${emitScalar(value)}`);
}

/**
 * Serialize frontmatter to the body of a YAML block, `---` fences excluded.
 *
 * Always ends with a newline when non-empty, so callers can concatenate.
 */
export function serializeFrontmatter(fm: Frontmatter): string {
  const keys = Object.keys(fm);
  const ordered = [
    ...KEY_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !KEY_ORDER.includes(key)),
  ];

  const out: string[] = [];
  for (const key of ordered) {
    emit(key, fm[key], '', out);
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}
