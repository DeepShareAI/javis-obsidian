/**
 * Slug sanitization and the type-to-folder map.
 *
 * Spec §E rule 4: one pure function, applied to both the filename and to any
 * link text that targets it, so the two cannot disagree. Slugs are
 * LLM-generated into a `String(200)` column, so nothing on the server prevents
 * a `:` or a `?` from reaching us (§J).
 */

/**
 * Inverse of `PLURAL_TO_TYPE` in app/tools/wiki/links.py.
 *
 * Copied rather than fetched: the folder names are also the link prefixes
 * already baked into every page body (`[[Concepts/Foo]]`), so they are part of
 * the stored data, not configuration. A server that changed them would break
 * existing bodies first.
 */
export const TYPE_TO_PLURAL: Readonly<Record<string, string>> = {
  source: 'Sources',
  entity: 'Entities',
  concept: 'Concepts',
  topic: 'Topics',
  comparison: 'Comparisons',
  question: 'Questions',
  synthesis: 'Syntheses',
  decision: 'Decisions',
  gap: 'Gaps',
};

/**
 * Characters Obsidian, Windows, or macOS reject in a filename, plus the four
 * that would turn a filename into link or embed syntax when it is echoed back
 * into a `[[...]]`.
 */
const ILLEGAL = /[[\]#^|*"\\/:?<>]/g;

/** C0 controls and DEL. A slug carrying one produces a file nothing can open. */
const CONTROL = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

const FALLBACK = 'untitled';

/**
 * Make `slug` safe to use as a filename, idempotently.
 *
 * Idempotence is the property the whole scheme rests on: the filename is
 * derived from the slug on every sync, and a function that drifted on the
 * second application would rename the note under itself and re-create it as a
 * duplicate — the Readwise `booksIDsMap` failure, arrived at from the other
 * direction. After one pass the result contains no illegal or control
 * character, starts with neither a dot nor whitespace, and ends with neither a
 * period nor whitespace, so a second pass has nothing left to remove.
 */
export function sanitizeSlug(slug: string): string {
  const stripped = slug.replace(CONTROL, '').replace(ILLEGAL, '');
  // Leading dots hide the file from every OS file browser and from Obsidian
  // itself; leading whitespace is silently trimmed by some filesystems and
  // kept by others, which is worse than either.
  const front = stripped.replace(/^[\s.]+/, '');
  // Windows silently drops trailing periods and spaces, so a note written as
  // "Foo." comes back as "Foo" and the next sync creates "Foo." again.
  const out = front.replace(/[\s.]+$/, '');
  return out.length > 0 ? out : FALLBACK;
}

/** The vault-root folder for a page type, or null when the type is unknown. */
export function folderForType(pageType: string): string | null {
  return TYPE_TO_PLURAL[pageType] ?? null;
}

/**
 * Vault-relative path for a page, or null when the page type is unknown.
 *
 * Root placement is load-bearing (§E): bodies contain `[[Concepts/Foo]]`
 * literally, and Obsidian resolves that from the vault root. Nesting the tree
 * under a parent folder would mean rewriting every link on every write.
 */
export function pathForPage(pageType: string, slug: string): string | null {
  const folder = folderForType(pageType);
  if (folder === null) return null;
  return `${folder}/${sanitizeSlug(slug)}.md`;
}
