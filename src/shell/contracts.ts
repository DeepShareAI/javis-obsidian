/**
 * The seams between the four shell modules, and nothing else.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md
 *       §B (the export endpoint), §D (auth), §F (the sync loop), §G (module
 *       boundaries).
 *
 * Three rules govern this file, and every one of them is load-bearing:
 *
 * 1. **No `obsidian` import, ever.** `VaultAdapter` is declared here as a plain
 *    interface over paths and strings precisely so that `src/sync.ts` can be
 *    unit-tested against a fake (§G, §H). `ObsidianVaultAdapter` is the single
 *    module in the repo allowed to `import ... from 'obsidian'`, and it depends
 *    on this file rather than the other way round.
 * 2. **Wire and vault shapes are imported from `src/core`, never redeclared.**
 *    `ServerPage` and `ExportResponse` mirror `WikiExportPage` /
 *    `WikiExportResponse` in app/tools/wiki/schemas.py field for field. A second
 *    copy of them here would be a second thing to keep in sync with the server.
 * 3. **No implementation.** Types, interfaces and the reasoning behind them.
 *    The only runtime values are the two default constants, which are
 *    configuration rather than behaviour.
 */

import type { ExportResponse, Frontmatter, ServerPage } from '../core/types';
import type { SyncAction } from '../core/reconcile';

// Re-exported so the shell modules have one import site for the shapes they
// share. These are the core's types, not copies: `export type` re-exports are
// erased at compile time (required under `isolatedModules`).
export type { ExportResponse, Frontmatter, ServerPage, SyncAction };

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

/**
 * The javis-mcp origin. `/wiki/export` and every `/oauth/*` route live on this
 * same origin (javis_mcp/wiki_export.py:77, javis_mcp/oauth/metadata.py).
 *
 * NOTE the path: the OAuth door serves `/wiki/export` exactly, while the Clerk
 * door on javis-server serves `/api/wiki/export` (the router is mounted with
 * `prefix='/api'`). The plugin uses the OAuth door, so no `/api` prefix.
 */
export const DEFAULT_BASE_URL = 'https://mcp.javis.is';

/** Server default and cap are 500 / 1000 (app/tools/wiki/export.py:28-29). */
export const DEFAULT_PAGE_LIMIT = 500;

// ---------------------------------------------------------------------------
// §D — secrets
// ---------------------------------------------------------------------------

/**
 * The OS keychain, behind an interface so `auth` never touches `App`.
 *
 * SYNCHRONOUS on purpose: `App.secretStorage` in obsidian@1.13.1 declares
 * `setSecret(id, secret): void`, `getSecret(id): string | null` and
 * `listSecrets(): string[]` — none of them return a Promise (obsidian.d.ts
 * 5645/5654/5661). Declaring these async would compile but would misrepresent
 * the API and invite `await`s on non-thenables.
 *
 * Secret ids must be "lowercase alphanumeric with optional dashes"; `setSecret`
 * throws on an invalid id. Hence the dashed constants below — `javis_access_token`
 * would be rejected at runtime.
 */
export interface SecretStore {
  get(id: string): string | null;
  set(id: string, secret: string): void;
  delete(id: string): void;
}

export const SECRET_ACCESS_TOKEN = 'javis-wiki-access-token';
export const SECRET_REFRESH_TOKEN = 'javis-wiki-refresh-token';

/**
 * Hands a URL to the SYSTEM browser.
 *
 * §D step 3 depends on this: `/oauth/authorize` 302s to Clerk sign-in and the
 * `/oauth/callback` page drives Clerk's Frontend API with `credentials:
 * 'include'`. That chain needs the user's existing Clerk cookies, which live in
 * the system browser and not in an Electron window the plugin controls.
 */
export type BrowserOpener = (url: string) => void | Promise<void>;

// ---------------------------------------------------------------------------
// §D — authentication
// ---------------------------------------------------------------------------

/**
 * The non-secret half of a dynamic client registration.
 *
 * Both fields persist to `data.json`; neither is a credential. They are stored
 * TOGETHER and are only valid together: `/oauth/authorize` compares
 * `redirect_uri` against the registered list by exact string match
 * (javis_mcp/oauth/authorize.py:45), and the string contains the ephemeral
 * loopback port. A `clientId` cached without its `redirectUri`, or reused
 * against a different port, fails with `invalid_redirect_uri`.
 *
 * Consequence for the implementer: §D's steps 1 and 2 must be INVERTED — bind
 * the loopback listener first, read the OS-assigned port, then register.
 */
export interface OAuthClientRegistration {
  clientId: string;
  /** `http://127.0.0.1:<port>/callback`, byte-identical to the registered one. */
  redirectUri: string;
}

/** Connection state, for the settings tab and the status affordance. */
export type AuthStatus =
  /** No tokens in the keychain. The user has never connected, or disconnected. */
  | 'disconnected'
  /** Tokens present and usable (possibly after a refresh). */
  | 'connected'
  /**
   * Tokens present but the refresh token was rejected. The user must reconnect;
   * §D step 6 says show a notice and STOP rather than retry.
   */
  | 'needs-reconnect';

/**
 * The OAuth surface, as the rest of the shell sees it.
 *
 * How a failed refresh is reported — this is the contract every caller codes
 * against:
 *
 * - `getAccessToken()` REJECTS with `AuthRevokedError` when the refresh token is
 *   gone or the server answered `invalid_grant`. It does not return a stale
 *   token, does not return null, and does not retry. The implementation clears
 *   both secrets before rejecting, so `status()` is `'needs-reconnect'`
 *   afterwards and a second call fails the same way.
 * - `getAccessToken()` rejects with `AuthRequiredError` when nothing was ever
 *   stored, so "never connected" and "connection died" stay distinguishable in
 *   the Notice text.
 * - Transport trouble during a refresh rejects with `NetworkError`, which is
 *   retryable and MUST NOT clear the secrets: a flaky network is not a
 *   revocation.
 * - `onStatusChange` fires on every transition, so the settings tab and the
 *   status bar update without polling.
 */
export interface JavisAuth {
  status(): AuthStatus;
  /** Convenience for `status() === 'connected'`. */
  isConnected(): boolean;

  /**
   * The full §D 1-6 dance: bind loopback → register → open the system browser →
   * wait for the code → exchange it → store both tokens in the keychain.
   *
   * Rejects with `AuthCancelledError` if the user abandons the browser tab or
   * the listener times out; the loopback socket is closed in a `finally` either
   * way. Resolves only once both tokens are in `SecretStore`.
   */
  connect(): Promise<void>;

  /**
   * A valid bearer, refreshing first if the access token is expired or within
   * the skew window. Never returns an empty string.
   *
   * The refresh token ROTATES on every use (javis_mcp/oauth/token.py:
   * `_grant_refresh_token` → `store.rotate_token`): the old one is dead the
   * moment the new one is issued, so the implementation must persist the new
   * refresh token before resolving, or the next refresh logs the user out.
   */
  getAccessToken(): Promise<string>;

  /**
   * Force a refresh and return the new access token. `JavisApiClient` calls
   * this exactly once on a 401 and retries the request once with the result.
   * Concurrent callers share one in-flight refresh.
   */
  refresh(): Promise<string>;

  /** Clear both secrets and the cached registration. Never throws. */
  disconnect(): Promise<void>;

  /** Returns an unsubscribe function. */
  onStatusChange(listener: (status: AuthStatus) => void): () => void;
}

// ---------------------------------------------------------------------------
// §B — the export client
// ---------------------------------------------------------------------------

export interface ApiClientConfig {
  /** Origin only, no trailing slash and no path. See `DEFAULT_BASE_URL`. */
  baseUrl: string;
  /** Rows per request. Clamped server-side to 1000; defaults to 500. */
  limit?: number;
}

/** Query string of one `GET /wiki/export` request. */
export interface ExportQuery {
  /**
   * ISO8601, filtered `updated_at >` (strictly greater). null or omitted means
   * a full export, which also means tombstones are excluded (§C).
   */
  since?: string | null;
  /**
   * OPAQUE. base64url of `<iso updated_at>|<id>` today
   * (app/tools/wiki/export.py:94) — echo it back verbatim and never parse,
   * compare, or construct one. Spec §B's `"next_cursor": 4821` example is stale.
   */
  cursor?: string | null;
  limit?: number;
}

/** What one batch tells the caller about where it sits in the run. */
export interface ExportBatch {
  pages: readonly ServerPage[];
  /** 1-based. `index === 1` is the batch whose `server_time` becomes the cursor. */
  index: number;
  /** Straight from the wire; null on the final batch. */
  nextCursor: string | null;
  /** This batch's `server_time`. Only the FIRST batch's value is the cursor. */
  serverTime: string;
}

/** The outcome of paging one delta to exhaustion. */
export interface ExportRun {
  /**
   * The `server_time` of the FIRST batch, and therefore the next `since`.
   *
   * The first, not the last: `server_time` is read before the row SELECT and
   * held back 60s (SERVER_TIME_LAG_SECONDS), so it is a watermark that every
   * row in the run is at or above. Taking a LATER batch's watermark would skip
   * rows committed between batch 1 and batch N. Never the client's own clock.
   */
  serverTime: string;
  batches: number;
  /** Rows delivered across every batch, tombstones included. */
  pages: number;
}

/**
 * The HTTP client. One method per need, both of them paging-aware.
 *
 * Implemented over Obsidian's `requestUrl`, NOT `fetch`: requests from the
 * Obsidian renderer are subject to CORS and would fail against mcp.javis.is.
 * That is an implementation detail and deliberately absent from this interface,
 * so `src/sync.ts` can be tested against a fake client.
 *
 * Error contract:
 * - 401 → refresh once via `JavisAuth.refresh()` and retry the SAME request
 *   once. A second 401 rejects with `AuthExpiredError`.
 * - 429 → `RateLimitedError`, carrying `retryAfterMs` when the server said so.
 *   The OAuth door allows 60 requests/minute per user (javis_mcp/wiki_export.py:28).
 * - 400 → `HttpError` with the server's `invalid_request` body. A 400 means a
 *   malformed `since`/`cursor`/`limit`; retrying the same request cannot help.
 * - any other >= 400 → `HttpError`.
 * - transport failure → `NetworkError`.
 * - a 200 whose body is missing `pages` or `server_time` → `ProtocolError`. Half
 *   a response must not become half a vault.
 */
export interface JavisApiClient {
  /** One request. Exposed mainly so a "Test connection" button can be cheap. */
  fetchBatch(query: ExportQuery, signal?: AbortSignal): Promise<ExportResponse>;

  /**
   * Follow `next_cursor` until it is null, handing each batch to `onBatch`.
   *
   * Streams rather than accumulating: a full export of a large wiki should not
   * sit in memory as one array, and the caller wants to write notes as they
   * arrive so a cancelled run still made progress. `onBatch` is awaited before
   * the next request goes out, which also keeps vault writes serialized.
   *
   * Rejection from `onBatch` propagates and stops the run — the cursor is then
   * NOT advanced by the caller, so the next run re-delivers the batch. Every
   * write in §F.2 is idempotent, which is what makes that safe.
   */
  exportAll(
    opts: {
      since: string | null;
      limit?: number;
      signal?: AbortSignal;
      onBatch: (batch: ExportBatch) => Promise<void> | void;
    },
  ): Promise<ExportRun>;
}

// ---------------------------------------------------------------------------
// §F.2, §G — the vault
// ---------------------------------------------------------------------------

/** One markdown file, as the vault scan reports it. */
export interface VaultNote {
  /** Vault-relative, forward slashes, including the `.md` extension. */
  path: string;
  /** Parsed frontmatter, or null when the file has no frontmatter block. */
  frontmatter: Frontmatter | null;
}

/**
 * Everything the sync loop needs from a vault, with no Obsidian types in sight.
 *
 * `ObsidianVaultAdapter` is the only implementation and the only module that
 * imports `obsidian` (§G). A `FakeVaultAdapter` in tests/ is the other, which
 * is the whole point: §F.2's five branches are then testable without a runtime.
 *
 * Every path is vault-relative with forward slashes, exactly as
 * `pathForPage(page_type, slug)` in src/core/slug.ts produces it.
 */
export interface VaultAdapter {
  /** Whole file text, or null when no file exists at `path`. */
  read(path: string): Promise<string | null>;

  /**
   * Whether a file exists at `path`, regardless of what is inside it.
   *
   * §F.2 branches on `vault.getFileByPath(path)` — on the FILE, not on its
   * frontmatter — and this is the method that says so. `readFrontmatter`
   * answers null for three different situations (no file, no frontmatter
   * block, frontmatter that will not parse) and only the first of them means
   * `create`. Collapsing the other two into it aims `create` at an occupied
   * path, which fails on every run forever because nothing about the note ever
   * changes to un-stick it.
   */
  exists(path: string): Promise<boolean>;

  /**
   * The file's parsed frontmatter, or null when the file is absent OR has no
   * frontmatter block. `reconcile(page, existing)` takes exactly this value,
   * and it must be the FILE's frontmatter — never the server's (§F.3).
   *
   * Parse the file's own `---` block with `parseYaml` rather than reading
   * `metadataCache`, which can be stale for the milliseconds after a write and
   * would make the loop re-write a note it just wrote.
   */
  readFrontmatter(path: string): Promise<Frontmatter | null>;

  /**
   * Create a new note. MUST create the parent folder first: `vault.create`
   * fails outright when the folder is absent, and a fresh vault has none of the
   * nine §E folders. Swallow the "Folder already exists" race.
   *
   * Rejects with `VaultWriteError` if a file already exists at `path` — the
   * caller reached the create branch only because `readFrontmatter` returned
   * null, so an existing file means someone else wrote it in between.
   */
  create(path: string, content: string): Promise<void>;

  /**
   * Atomic read-modify-write over the note's text, via `Vault.process`.
   *
   * `transform` is pure and may be invoked more than once if Obsidian retries;
   * pass `replaceMarkerBlock`/`applyTombstone` (both idempotent) and nothing
   * else. Writing the file behind Obsidian's back races the open editor's
   * render-and-save cycle.
   */
  process(path: string, transform: (content: string) => string): Promise<void>;

  /**
   * Write frontmatter as a COMPLETE REPLACEMENT of the note's block.
   *
   * `next` is the whole desired frontmatter, not a patch: keys present in the
   * file and absent from `next` MUST be deleted. This is not pedantry —
   * `mergeServerKeys` signals a resurrection by DELETING `javis_deleted` from
   * the object it returns (src/core/frontmatter.ts:122-128). An adapter that
   * did `Object.assign(fm, next)` would leave a resurrected page flagged
   * deleted forever, and `reconcile` would never correct it, because the
   * `already-tombstoned` skip only fires on rows that are still deleted.
   *
   * Goes through `FileManager.processFrontMatter` so Obsidian owns the write.
   */
  writeFrontmatter(path: string, next: Frontmatter): Promise<void>;

  /**
   * Every markdown file in the vault with its frontmatter, for the §F.1 rescan
   * that recovers the cursor when `data.json` is lost.
   *
   * Reads `metadataCache` rather than the files: this runs over the whole vault
   * and staleness is harmless here — a rev that is one sync old only re-delivers
   * pages the loop then skips as `unchanged`.
   */
  listMarkdownFiles(): Promise<readonly VaultNote[]>;
}

// ---------------------------------------------------------------------------
// §F — the sync orchestrator
// ---------------------------------------------------------------------------

/** What set this run going. Reported in the status text; never changes behaviour. */
export type SyncTrigger = 'command' | 'vault-open' | 'interval' | 'settings';

/** One run's tally, keyed by the `SyncAction.kind` that produced it. */
export interface SyncResult {
  trigger: SyncTrigger;
  created: number;
  replaced: number;
  tombstoned: number;
  skipped: number;
  /** Rows seen, i.e. `created + replaced + tombstoned + skipped`. */
  scanned: number;
  /**
   * The cursor to persist: the first batch's `server_time`. null when the run
   * failed before the first batch, in which case the caller keeps the old one.
   */
  nextCursor: string | null;
  /** Paths the loop could not write. A failed note never fails the whole run. */
  failures: readonly { path: string; message: string }[];
  /**
   * What the caller must persist as `JavisSettings.pendingFullResync`.
   *
   * True when this run failed on a note AND its cursor came from the §F.1
   * vault rescan rather than from `data.json`. In that one combination
   * withholding `nextCursor` is not enough: the rescan takes `max(javis_rev)`
   * across the vault, the rows that DID land raise that maximum past the row
   * that did not, and the failed row is never asked for again. Forcing the next
   * run to a full export is the cheap way back, and the only one the user can
   * also reach by hand ("Forget position").
   *
   * Always written, never OR-ed: a clean run clears the flag.
   */
  pendingFullResync: boolean;
  startedAt: string;
  finishedAt: string;
}

/**
 * The §F.2 loop, as a pure-ish function of its dependencies.
 *
 * Deliberately not a class and deliberately not aware of `Plugin`: everything
 * it touches arrives through this object, so a test supplies a fake
 * `JavisApiClient` and a fake `VaultAdapter` and asserts on the `SyncResult`.
 * Single-flight is the CALLER's job (src/main.ts) — three triggers plus a
 * settings button can otherwise race two runs onto `vault.process` for the same
 * file.
 */
export interface SyncDeps {
  api: JavisApiClient;
  vault: VaultAdapter;
  /** `settings.cachedCursor`; null forces the `listMarkdownFiles` rescan. */
  cachedCursor: string | null;
  /**
   * `settings.pendingFullResync`. When true, this run ignores every cursor and
   * asks for a full export — the recovery path for a previous run that failed
   * on a note the §F.1 rescan would now skip over. See `SyncResult`.
   */
  pendingFullResync?: boolean;
  trigger: SyncTrigger;
  limit?: number;
  signal?: AbortSignal;
  /** Called after each batch, for the status bar. */
  onProgress?: (done: number, action: SyncAction['kind']) => void;
}

// ---------------------------------------------------------------------------
// Persisted settings — data.json
// ---------------------------------------------------------------------------

/**
 * Everything the plugin writes to `data.json`, and NOTHING ELSE.
 *
 * `data.json` lives inside the vault, so anything here replicates to every
 * device the vault syncs to and lands in whatever git repo or iCloud folder the
 * user keeps. §D: "Never write either token to `data.json`." Both tokens live
 * in `SecretStore` (the OS keychain) and have no field on this type; the
 * compile-time assertion below enforces that no one adds one later.
 *
 * Losing this file costs a rescan and nothing else (§F.1) — `cachedCursor` is a
 * speed-up over `max(javis_rev)` across the vault, and `oauthClient` re-registers.
 */
export interface JavisSettings {
  /** javis-mcp origin. Editable so a dev can point at a local server. */
  baseUrl: string;

  /** Non-secret OAuth registration; null until the first successful connect. */
  oauthClient: OAuthClientRegistration | null;

  /** §F.4 trigger: sync once when the vault finishes loading, debounced. */
  syncOnVaultOpen: boolean;

  /** §F.4 trigger: the interval. DISABLED by default, by spec. */
  intervalEnabled: boolean;
  /** Minutes between interval runs. Ignored when `intervalEnabled` is false. */
  intervalMinutes: number;

  /**
   * The last `server_time` the plugin successfully consumed, used as the next
   * `since`. A cache, not the source of truth.
   */
  cachedCursor: string | null;

  /**
   * Force the next run to a full export (`since: null`), whatever any cursor
   * says.
   *
   * Set by a run that failed on a note while working from the §F.1 vault
   * rescan, and by the "Resync everything" button. It exists because the rescan
   * is `max(javis_rev)` across the vault: the notes that DID land in a failed
   * run raise that maximum above the note that did not, so the next rescan asks
   * for rows strictly newer than a row the vault never received. Withholding
   * `cachedCursor` cannot help when `cachedCursor` was never the cursor.
   *
   * Cleared by the first run that completes without a failure.
   */
  pendingFullResync: boolean;

  /** ISO8601 of the last completed run, for the settings tab. Never a cursor. */
  lastSyncAt: string | null;
  /** One-line human status from the last run, success or failure. */
  lastSyncSummary: string | null;
}

export const DEFAULT_SETTINGS: JavisSettings = {
  baseUrl: DEFAULT_BASE_URL,
  oauthClient: null,
  syncOnVaultOpen: true,
  intervalEnabled: false,
  intervalMinutes: 30,
  cachedCursor: null,
  pendingFullResync: false,
  lastSyncAt: null,
  lastSyncSummary: null,
};

/**
 * Compile-time guard for §D. Adding a token-shaped key to `JavisSettings` turns
 * this into `Assert<false>` and the build fails with the comment right here to
 * explain why. Types only — nothing is emitted.
 */
type TokenShapedKey =
  | 'token'
  | 'tokens'
  | 'secret'
  | 'password'
  | 'accessToken'
  | 'refreshToken'
  | 'access_token'
  | 'refresh_token'
  | 'clientSecret'
  | 'client_secret';

type Assert<T extends true> = T;
type _SettingsCarryNoSecrets = Assert<
  Extract<keyof JavisSettings, TokenShapedKey> extends never ? true : false
>;
