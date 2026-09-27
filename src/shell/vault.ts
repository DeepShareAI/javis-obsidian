/**
 * `ObsidianVaultAdapter` — the one module that talks to Obsidian.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md
 *       §E (nine folders at the vault root), §F.1 (frontmatter is the state),
 *       §F.2 (the loop, and `vault.process` as the write primitive),
 *       §G (module boundaries).
 *
 * §G: "A single `ObsidianVaultAdapter` wraps `vault`, `fileManager`, and
 * `metadataCache`, and is the only module that imports `obsidian`." Everything
 * above it — `src/core/*`, `src/shell/contracts.ts`, the sync loop — is plain
 * data in and plain data out, which is what makes §F.2's branches testable
 * without an Obsidian runtime.
 *
 * Three structural decisions in this file, each load-bearing:
 *
 * 1. **No file is ever deleted or trashed.** §F.2: "The plugin never calls
 *    `vault.delete` or `vault.trash`" — with one sanctioned exception (spec
 *    2026-09-27): `removeFolderIfEmpty` deletes an emptied 0.2.x wiki FOLDER,
 *    and only after checking it has no children, so it can never take a note
 *    with it. The `App` handle is a true ECMAScript private field (`#app`), not
 *    a TypeScript `private` — so a caller holding this adapter can reach the
 *    vault's destructive API only through that one guarded method, even after
 *    a cast to `any`, which a compile-time-only modifier would not ensure.
 *
 * 2. **The `obsidian` module is never imported at the top level.** Types come
 *    in through `import type`, which TypeScript erases; the single runtime
 *    value this file needs (`parseYaml`) is resolved lazily, on first use,
 *    through `require`. The reason is prosaic and worth stating: the `obsidian`
 *    npm package is TYPES ONLY — its `package.json` declares `"main": ""` and
 *    ships no JavaScript — so any module that imports it at runtime cannot be
 *    loaded by vitest at all, and the pure helpers below would be untestable.
 *    esbuild lists `obsidian` in `external` (esbuild.config.mjs:19) and emits
 *    CommonJS, so the `require` call survives the bundle verbatim and resolves
 *    against the module Obsidian injects at plugin load.
 *
 * 3. **The pure parts are exported separately from the class.** Path
 *    arithmetic, the folder set, the frontmatter-block scanner and the
 *    max-revision reduction are all plain functions over strings, tested in
 *    tests/vault.test.ts. What is left inside the class is exactly the part
 *    that can only be exercised against a real vault (§H).
 */

import type { App, SecretStorage, TFile } from 'obsidian';

import { JAVIS_REV } from '../core/types';
import { TYPE_TO_PLURAL, WIKI_ROOT } from '../core/slug';
import { isUnderFolder } from '../core/folders';
import { isUuid, SOURCE_ID_KEY } from '../core/note-text';
import type { Frontmatter, SecretStore, UploadVault, VaultAdapter, VaultNote } from './contracts';
import { VaultWriteError } from './errors';

// ---------------------------------------------------------------------------
// The obsidian runtime, resolved lazily
// ---------------------------------------------------------------------------

/** The sliver of the `obsidian` module this file needs at runtime. */
interface ObsidianRuntime {
  parseYaml(yaml: string): unknown;
}

let cachedRuntime: ObsidianRuntime | null = null;

/**
 * `require('obsidian')`, memoized.
 *
 * Called only from `defaultParseYaml`, and therefore only when a frontmatter
 * block is actually parsed — never at import time. See decision 2 in the module
 * comment for why this is not a static import.
 */
function obsidianRuntime(): ObsidianRuntime {
  if (cachedRuntime === null) {
    cachedRuntime = require('obsidian') as ObsidianRuntime;
  }
  return cachedRuntime;
}

/**
 * Obsidian's own YAML reader.
 *
 * Obsidian's, rather than a bundled `js-yaml`: the frontmatter in these files is
 * read back by Obsidian's Properties UI, and a second parser with slightly
 * different scalar resolution would disagree with it about exactly the values
 * §E rule 3 cares about (an unquoted `[[Foo]]`, a bare date).
 */
function defaultParseYaml(yaml: string): unknown {
  return obsidianRuntime().parseYaml(yaml);
}

// ---------------------------------------------------------------------------
// Pure helpers — no Obsidian, no I/O
// ---------------------------------------------------------------------------

/**
 * The nine §E folders, under `WIKI_ROOT`, in a stable order.
 *
 * Derived from `TYPE_TO_PLURAL` rather than written out again: the map is
 * already the single source of truth for the folder half of
 * `pathForPage(page_type, slug)`, and a second literal list would be a second
 * thing to keep in step with the server's `PLURAL_TO_TYPE`.
 *
 * Deduplicated defensively — two page types mapping to one folder is not
 * something the current map does, but `Set` costs nothing and a duplicate
 * `createFolder` would throw.
 */
export const MANAGED_FOLDERS: readonly string[] = Object.freeze(
  [...new Set(Object.values(TYPE_TO_PLURAL))].sort().map((plural) => `${WIKI_ROOT}/${plural}`),
);

/**
 * The folder containing `path`, or null when `path` sits at the vault root.
 *
 * Vault paths are always forward-slashed and never absolute (see
 * `pathForPage`), so this is string arithmetic and not a path library.
 */
export function parentFolder(path: string): string | null {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return null;
  return path.slice(0, cut);
}

/**
 * Every folder that must exist before `path` can be created, outermost first.
 *
 * `'Javis-wiki/Concepts/Agent-Builder.md'` yields
 * `['Javis-wiki', 'Javis-wiki/Concepts']`, outermost first, because
 * `Vault.createFolder` does not create intermediate folders.
 *
 * Empty segments (a doubled slash, a leading slash) are dropped rather than
 * turned into a folder named `''`.
 */
export function folderAncestors(path: string): string[] {
  const folder = parentFolder(path);
  if (folder === null) return [];
  const out: string[] = [];
  let prefix = '';
  for (const segment of folder.split('/')) {
    if (segment === '') continue;
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    out.push(prefix);
  }
  return out;
}

/**
 * The YAML text of a note's frontmatter block, or null when there is none.
 *
 * Obsidian's rule, reproduced deliberately rather than approximated: the block
 * counts only when the file's very first line is `---`, and it ends at the next
 * line that is exactly `---`. A `---` used as a horizontal rule further down
 * the note is therefore not a frontmatter fence, and an UNTERMINATED opening
 * fence is not a block either — Obsidian shows such a file as having no
 * properties, and this function must agree with it or the plugin would decide
 * a note is adopted (or unchanged) based on YAML that Obsidian never applied.
 *
 * CRLF is normalized first, and a UTF-8 BOM is skipped, because both are
 * routine in a vault that has been touched by a Windows editor and neither
 * should cost the file its identity.
 */
export function extractFrontmatterBlock(content: string): string | null {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n') && text !== '---') return null;

  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      return lines.slice(1, i).join('\n');
    }
  }
  return null;
}

/**
 * A note's frontmatter as a plain object, or null when it has none.
 *
 * `parseYaml` is passed in rather than imported so this stays pure and
 * testable; `ObsidianVaultAdapter` supplies Obsidian's.
 *
 * Anything that is not a plain object collapses to null. An empty block parses
 * to `null`, a block holding a bare scalar parses to a string, and a block
 * holding a list parses to an array — none of which is frontmatter, and all of
 * which would otherwise reach `reconcile` as an `existing` that is neither null
 * nor usable. A parse error is likewise null, not a throw: a note the user has
 * broken should be skipped over, not abort the run.
 */
export function parseFrontmatterBlock(
  content: string,
  parseYaml: (yaml: string) => unknown,
): Frontmatter | null {
  const block = extractFrontmatterBlock(content);
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Frontmatter;
}

/**
 * How far past the local clock a `javis_rev` may sit and still be believed.
 *
 * `javis_rev` is the SERVER's `updated_at`, so a machine whose clock trails the
 * server's reads every fresh revision as slightly future-dated. An hour swallows
 * any skew a real pair of clocks produces (NTP keeps them within seconds; a
 * hand-set clock within minutes) while still catching the case this bound
 * exists for: a year typed wrong in the Properties editor.
 *
 * Erring low is cheap and erring high is not. A revision wrongly rejected only
 * LOWERS the cursor, which re-delivers pages the loop then skips as
 * `unchanged`; a revision wrongly believed RAISES it past updates that are
 * never re-sent.
 */
export const REVISION_FUTURE_SKEW_MS = 60 * 60 * 1000;

/**
 * The §F.1 rescan: the newest `javis_rev` anywhere in the vault, or null.
 *
 * This is what makes losing `data.json` cost "a rescan and nothing else". The
 * value returned is the STRING as it was found in the file, byte for byte,
 * because it goes straight back out as `?since=` and the server compares it
 * after parsing (`updated_at >`, strictly greater — so the page that produced
 * the maximum is correctly not re-delivered).
 *
 * Ordering is by parsed instant, not by string comparison. Two ISO8601 strings
 * for the same moment can differ in offset (`...Z` versus `+00:00`) or in
 * fractional-second digits, and lexicographic order gets both wrong. A value
 * that is not a string, or that does not parse as a date, is ignored entirely:
 * a hand-mangled `javis_rev` in one note must not be able to push the cursor
 * into the future and silently skip every update behind it.
 *
 * And neither may a value that PARSES. A string rev bearing a future date — a
 * year typed wrong in the Properties editor is the realistic way to get one —
 * would otherwise become the cursor, the server would answer it with zero rows,
 * and the run would stamp `cachedCursor = server_time`: the window between the
 * vault's true state and that moment is lost, and "Forget position" cannot
 * recover it, because the rescan re-derives the same poisoned value. So
 * anything beyond `now + REVISION_FUTURE_SKEW_MS` is ignored exactly like an
 * unparseable one, which is what the paragraph above promises.
 */
export function maxRevision(
  notes: readonly VaultNote[],
  now: number = Date.now(),
): string | null {
  const ceiling = now + REVISION_FUTURE_SKEW_MS;
  let best: string | null = null;
  let bestAt = -Infinity;

  for (const note of notes) {
    const rev = note.frontmatter?.[JAVIS_REV];
    if (typeof rev !== 'string') continue;
    const at = Date.parse(rev);
    if (Number.isNaN(at)) continue;
    if (at > ceiling) continue;
    if (at > bestAt) {
      bestAt = at;
      best = rev;
    }
  }
  return best;
}

/**
 * The markdown paths under any of `folders` (spec 2026-09-24 §F.2 enumeration).
 * A path-segment prefix test, so `Journal2/` is not under `Journal`.
 *
 * The extension test is case-sensitive, matching the server's
 * `_check_vault_path` (`norm.endswith('.md')`). Whether Obsidian lists a
 * `.MD` file as markdown depends on the build; if it does, keeping it here
 * would stamp the file and then fail its PUT with a 400 on every run. Such a
 * file is simply not a note to the upload, like a `.canvas` (contract review).
 */
export function notesUnder(paths: readonly string[], folders: readonly string[]): string[] {
  return paths.filter(
    (path) => path.endsWith('.md') && folders.some((folder) => isUnderFolder(path, folder)),
  );
}

/**
 * A metadata-cache `javis_source_id` as a presence hint (plan D-PLAN-3): a
 * lowercased uuid, or null for anything else. Only ever used to PREVENT a
 * delete for a note whose file could not be read.
 */
export function cachedSourceIdHint(frontmatter: Record<string, unknown> | undefined): string | null {
  const value = frontmatter?.[SOURCE_ID_KEY];
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return isUuid(id) ? id : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ObsidianVaultAdapterOptions {
  /**
   * Override the YAML reader. Exists for tests and for nothing else; the
   * default is Obsidian's `parseYaml` and should stay that way in the plugin.
   */
  parseYaml?: (yaml: string) => unknown;
}

/**
 * `VaultAdapter` over a live Obsidian `App`.
 *
 * Not unit-tested, by §H: "`ObsidianVaultAdapter` is not unit-tested; it is
 * exercised manually against a scratch vault." Everything in here that could be
 * tested without a runtime has been lifted out into the pure helpers above,
 * which is the reason this class is as thin as it is.
 */
export class ObsidianVaultAdapter implements VaultAdapter, UploadVault {
  /**
   * A real private field, not a `private` modifier.
   *
   * `private` is erased at compile time: `(adapter as any).app.vault.trash(...)`
   * would compile and run. `#app` does not exist outside this class body at
   * runtime, so §F.2's "never unlink" is enforced by the language rather than
   * by review.
   */
  readonly #app: App;
  readonly #parseYaml: (yaml: string) => unknown;

  constructor(app: App, options: ObsidianVaultAdapterOptions = {}) {
    this.#app = app;
    this.#parseYaml = options.parseYaml ?? defaultParseYaml;
  }

  /**
   * Whole file text, or null when nothing is at `path`.
   *
   * `cachedRead`, not `read`: this is a decision input, not the basis of a
   * write. Every write below goes through `Vault.process`, which does its own
   * atomic read from disk, so a value that is momentarily stale can only cost a
   * wrong skip-versus-replace call on one note — and Obsidian invalidates this
   * cache on its own writes, which are the only writes the plugin makes.
   */
  async read(path: string): Promise<string | null> {
    const file = this.#find(path);
    if (file === null) return null;
    return this.#app.vault.cachedRead(file);
  }

  /**
   * Is there a file at `path` — whatever is (or is not) inside it?
   *
   * §F.2 branches on `vault.getFileByPath(path)`, not on whether the file has
   * frontmatter we recognize, and the difference is the whole point of this
   * method. `readFrontmatter` answers null for a file with no frontmatter block
   * AND for one whose YAML will not parse, so a loop that inferred existence
   * from it would aim `create` at a path that is already occupied — a write
   * that fails on every run forever, because nothing about the note ever
   * changes. Existence is its own question and gets its own call.
   */
  async exists(path: string): Promise<boolean> {
    return this.#find(path) !== null;
  }

  /**
   * The FILE's frontmatter (§F.3), parsed from its own `---` block.
   *
   * Deliberately NOT `metadataCache.getFileCache()`. The metadata cache is
   * populated by a separate asynchronous parse that lags a write by some
   * milliseconds, so a loop that consulted it would read back the note it just
   * wrote as it was BEFORE the write, decide it is still out of date, and write
   * it again. The per-note read is cheap because it only happens for rows the
   * server actually sent in this delta.
   */
  async readFrontmatter(path: string): Promise<Frontmatter | null> {
    const content = await this.read(path);
    if (content === null) return null;
    return parseFrontmatterBlock(content, this.#parseYaml);
  }

  /**
   * Create a note, creating its folder first.
   *
   * `Vault.create` does not create intermediate folders and fails outright when
   * the parent is missing — and a fresh vault has none of the nine §E folders,
   * so without this every single create on a first sync would fail.
   */
  async create(path: string, content: string): Promise<void> {
    await this.#ensureFolders(path);
    try {
      await this.#app.vault.create(path, content);
    } catch (err) {
      // `Vault.create` throws "File already exists" among other things. Reaching
      // here after `readFrontmatter` returned null means something else created
      // the file in between — another sync system, or a second run of this one.
      // One note's failure is not the run's failure (contracts.ts: SyncResult.failures).
      throw new VaultWriteError(path, `Could not create ${path}: ${describeError(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * Atomic read-modify-write through Obsidian's own write path (§F.2).
   *
   * `Vault.process` is the primitive the spec names: writing the file behind
   * Obsidian's back races the open editor's render-and-save cycle, and the
   * editor wins. `transform` may be invoked more than once if Obsidian retries,
   * which is why the contract restricts it to `replaceMarkerBlock` and
   * `applyTombstone`, both idempotent.
   */
  async process(path: string, transform: (content: string) => string): Promise<void> {
    const file = this.#require(path);
    try {
      await this.#app.vault.process(file, transform);
    } catch (err) {
      throw new VaultWriteError(path, `Could not update ${path}: ${describeError(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * Replace the note's frontmatter wholesale with `next`.
   *
   * REPLACEMENT, not merge, and the distinction is not academic:
   * `mergeServerKeys` signals a resurrection by OMITTING `javis_deleted` from
   * the object it returns (src/core/frontmatter.ts). An `Object.assign` here
   * would leave a resurrected page flagged deleted for good, and `reconcile`
   * would never correct it, because its `already-tombstoned` skip only fires
   * while the server row is still deleted.
   *
   * `processFrontMatter` hands over a mutable object and writes back whatever it
   * holds, so the replacement is: delete every existing key, then assign the new
   * ones. Keys whose value is `undefined` are dropped rather than written —
   * `stringifyYaml` would otherwise emit them as `key: null`, and a null
   * `javis_sync` is not the same thing as an absent one.
   */
  async writeFrontmatter(path: string, next: Frontmatter): Promise<void> {
    const file = this.#require(path);
    try {
      await this.#app.fileManager.processFrontMatter(file, (frontmatter: Frontmatter) => {
        // Snapshot the keys first: deleting while iterating the live object is
        // undefined behaviour waiting to happen.
        for (const key of Object.keys(frontmatter)) delete frontmatter[key];
        for (const [key, value] of Object.entries(next)) {
          if (value !== undefined) frontmatter[key] = value;
        }
      });
    } catch (err) {
      // `processFrontMatter` throws YAMLParseError on a note whose frontmatter
      // the user has broken by hand. That is one note's problem, not the run's.
      throw new VaultWriteError(
        path,
        `Could not write properties of ${path}: ${describeError(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * Every markdown file with its frontmatter, for the §F.1 cursor rescan.
   *
   * `metadataCache` rather than reading the files: this runs over the whole
   * vault, and a vault of ten thousand notes is ten thousand disk reads
   * otherwise. Staleness is harmless in exactly this one place — a `javis_rev`
   * one sync behind only lowers the cursor, which re-delivers pages the loop
   * then skips as `unchanged`. Too low is a wasted request; too high would be a
   * lost update, and the cache cannot be too high.
   *
   * The frontmatter is copied rather than handed out: the cache object belongs
   * to Obsidian and callers must not be able to mutate it.
   */
  async listMarkdownFiles(): Promise<readonly VaultNote[]> {
    const cache = this.#app.metadataCache;
    return this.#app.vault.getMarkdownFiles().map((file) => {
      const frontmatter = cache.getFileCache(file)?.frontmatter;
      return {
        path: file.path,
        frontmatter: frontmatter === undefined ? null : { ...frontmatter },
      };
    });
  }

  /**
   * Move a note, creating the destination folders first.
   *
   * `fileManager.renameFile`, not `vault.rename`: the file manager is what
   * applies the user's link-update preference to notes that link here.
   * Whichever way that preference is set, links keep resolving — rewritten ones
   * point at the new path, untouched ones resolve by suffix.
   */
  async rename(from: string, to: string): Promise<void> {
    const file = this.#require(from);
    if (this.#app.vault.getAbstractFileByPath(to) !== null) {
      throw new VaultWriteError(from, `Could not move ${from}: ${to} already exists`);
    }
    await this.#ensureFolders(to);
    try {
      await this.#app.fileManager.renameFile(file, to);
    } catch (err) {
      throw new VaultWriteError(from, `Could not move ${from} to ${to}: ${describeError(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * Remove an emptied 0.2.x root wiki folder. `children` is Obsidian's view,
   * which omits OS files such as `.DS_Store`; a folder holding one makes
   * `vault.delete` throw, and the caller treats that as "leave it".
   */
  async removeFolderIfEmpty(path: string): Promise<void> {
    const folder = this.#app.vault.getFolderByPath(path);
    if (folder === null || folder.children.length > 0) return;
    await this.#app.vault.delete(folder);
  }

  // -- the upload half (spec 2026-09-24 §F.2) ------------------------------
  //
  // Still no delete and no trash. The upload never removes a vault file: a
  // source leaves the wiki by a DELETE to the server, never by touching disk.

  /** The markdown files under the selected folders, with a cached-id hint. Reads no file. */
  async listNotesIn(folders: readonly string[]): Promise<readonly { path: string; cachedSourceId: string | null }[]> {
    const cache = this.#app.metadataCache;
    const byPath = new Map(this.#app.vault.getMarkdownFiles().map((file) => [file.path, file] as const));
    return notesUnder([...byPath.keys()], folders).map((path) => ({
      path,
      cachedSourceId: cachedSourceIdHint(cache.getFileCache(byPath.get(path)!)?.frontmatter),
    }));
  }

  /**
   * `vault.read`, not `cachedRead` (§F.2): the cache can hold a stale copy of a
   * file changed outside Obsidian, and an upload of stale text is an edit the
   * user did not make. Deliberately separate from `read()`, whose documented
   * `cachedRead` the download depends on.
   */
  async readFresh(path: string): Promise<string> {
    const file = this.#find(path);
    if (file === null) throw new VaultWriteError(path, `No note at ${path}`);
    return this.#app.vault.read(file);
  }

  /** `vault.process`, returning the text it wrote (plan D-STAMP-3). */
  async processText(path: string, transform: (content: string) => string): Promise<string> {
    const file = this.#require(path);
    try {
      return await this.#app.vault.process(file, transform);
    } catch (err) {
      throw new VaultWriteError(path, `Could not update ${path}: ${describeError(err)}`, { cause: err });
    }
  }

  configDir(): string {
    return this.#app.vault.configDir;
  }

  /** Every folder path in the vault, for the settings folder picker. */
  folderPaths(): string[] {
    return this.#app.vault.getAllFolders(false).map((folder) => folder.path);
  }

  // -- internals ------------------------------------------------------------

  #find(path: string): TFile | null {
    return this.#app.vault.getFileByPath(path);
  }

  #require(path: string): TFile {
    const file = this.#find(path);
    if (file === null) {
      throw new VaultWriteError(path, `No note at ${path}`);
    }
    return file;
  }

  /**
   * Make sure every folder above `path` exists.
   *
   * The "already exists" race is real and not theoretical: two folders being
   * created concurrently, or another sync system (§J — most vaults also run
   * Obsidian Sync, iCloud, or git) materializing the folder between the check
   * and the call. So a `createFolder` failure is re-checked rather than
   * rethrown, and only a folder that is STILL absent afterwards is an error.
   * That second check also catches the one genuinely broken case: a FILE
   * occupying the folder's path, where `getFolderByPath` returns null and
   * `createFolder` throws forever.
   */
  async #ensureFolders(path: string): Promise<void> {
    for (const folder of folderAncestors(path)) {
      if (this.#app.vault.getFolderByPath(folder) !== null) continue;
      try {
        await this.#app.vault.createFolder(folder);
      } catch (err) {
        if (this.#app.vault.getFolderByPath(folder) === null) {
          throw new VaultWriteError(
            path,
            `Could not create folder ${folder}: ${describeError(err)}`,
            { cause: err },
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The keychain
// ---------------------------------------------------------------------------

/**
 * `SecretStore` over `App.secretStorage` — the OS keychain (§D step 5).
 *
 * It lives here, next to the vault adapter, for one reason: §G allows exactly
 * one module to import `obsidian`, and `app.secretStorage` is an Obsidian API.
 * `src/auth` takes a `SecretStore` and stays testable as a result.
 *
 * `SecretStorage` (obsidian.d.ts, @since 1.11.4) is SYNCHRONOUS — `setSecret`
 * returns `void`, `getSecret` returns `string | null` — which is why the
 * `SecretStore` contract is synchronous too.
 *
 * NOTE, and this is the one wrinkle: the API has `setSecret`, `getSecret` and
 * `listSecrets`, and NO remove. `delete()` is therefore emulated by storing the
 * empty string, and `get()` maps an empty string back to null so that "cleared"
 * and "never stored" are the same thing to every caller — which matters,
 * because §D step 6 clears both secrets and the next `getAccessToken()` must
 * see "nothing stored" rather than a token that is the empty string.
 * `listSecrets()` will still report the id afterwards; nothing in the plugin
 * uses `listSecrets`.
 */
export class ObsidianSecretStore implements SecretStore {
  readonly #storage: SecretStorage;

  constructor(app: App) {
    this.#storage = app.secretStorage;
  }

  get(id: string): string | null {
    const value = this.#storage.getSecret(id);
    return value === null || value === '' ? null : value;
  }

  /** Throws if `id` is not lowercase-alphanumeric-with-dashes (Obsidian's rule). */
  set(id: string, secret: string): void {
    this.#storage.setSecret(id, secret);
  }

  delete(id: string): void {
    this.#storage.setSecret(id, '');
  }
}

// ---------------------------------------------------------------------------

/** Best-effort one-line description of whatever Obsidian threw. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
