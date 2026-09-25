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
import type { FolderError } from '../core/folders';
import type {
  HeldAction,
  ServerSource,
  SkippedNote,
  UndoReport,
  UploadMemory,
  WaitingDelete,
} from '../core/upload';

// Re-exported so the shell modules have one import site for the shapes they
// share. These are the core's types, not copies: `export type` re-exports are
// erased at compile time (required under `isolatedModules`).
export type { ExportResponse, Frontmatter, ServerPage, SyncAction };
export type { FolderError, HeldAction, ServerSource, SkippedNote, UndoReport, UploadMemory, WaitingDelete };

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
 * The origin the two tokens above were issued by (review). Not a secret, but
 * kept beside them, in this device's keychain, because it must be exactly as
 * trustworthy as they are: `data.json` syncs and anyone who can write it can
 * change `baseUrl`, so the tokens are only ever sent to the origin stored
 * here (`OriginChangedError`).
 */
export const SECRET_TOKEN_ORIGIN = 'javis-wiki-token-origin';

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
   *
   * With no options this sends exactly what 0.1.x sent (`scope=mcp:read`, no
   * `resource`), so a read-only install keeps working against a server that
   * predates the `/wiki` resource (spec 2026-09-24 §I.4). With options it is
   * the §C.7 step-up: the union scope and the `/wiki` resource, on both the
   * authorize URL and the code exchange (RFC 8707 §2.2), never on refresh.
   */
  connect(options?: ConnectOptions): Promise<void>;

  /**
   * The scopes the stored access token was granted, from its JWT `scope`
   * claim; null when there is no token or it does not decode. Per-device, like
   * the token itself — `data.json` replicates across devices and could not say
   * which device holds a write grant.
   */
  grantedScopes(): string[] | null;

  /**
   * The stored access token's `aud` claim as a list; null when there is no
   * token or it does not decode. Tells a pre-0.2.0 `/mcp`-audience grant from
   * a `/wiki` one (§C.3), which only a new authorization can change.
   */
  grantedAudiences(): string[] | null;

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

/** What a step-up `connect` asks for (spec 2026-09-24 §C.3, §C.7). */
export interface ConnectOptions {
  /** Space-separated. The union `mcp:read wiki:write`, as the MCP step-up flow requires. */
  scope?: string;
  /** RFC 8707 resource indicator: `<baseUrl>/wiki`. */
  resource?: string;
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

/**
 * What set this run going. Reported in the status text. Since 0.2.0 it also
 * decides one thing: whether the upload half may open the browser for a
 * step-up (`command`, `settings`, `review` only — never from a background
 * trigger). `edit` is the optional upload-on-edit debounce; `review` is the
 * "Review pending changes" confirmation.
 */
export type SyncTrigger = 'command' | 'vault-open' | 'interval' | 'settings' | 'edit' | 'review';

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
// Spec 2026-09-24 §E, §F.2 — the upload half
// ---------------------------------------------------------------------------

/**
 * The vault, as the upload half needs it. A separate, narrower seam than
 * `VaultAdapter`, and — like it — with no delete and no trash: §F.2 "the
 * plugin never calls `vault.delete` or `vault.trash`" holds for uploads too.
 */
export interface UploadVault {
  /**
   * Every markdown file under the given folders, with the `javis_source_id`
   * the metadata cache holds for it (a hint for a note that later fails to
   * read, plan D-PLAN-3). Listing only: no file is read.
   */
  listNotesIn(folders: readonly string[]): Promise<readonly { path: string; cachedSourceId: string | null }[]>;

  /**
   * The file's text via `vault.read` — from disk, not `cachedRead`, which can
   * serve a stale copy of a file changed outside Obsidian (§F.2). May block
   * on an evicted iCloud file; the caller bounds it with a timeout.
   */
  readFresh(path: string): Promise<string>;

  /**
   * `vault.process` returning the text it wrote. The stamp needs the
   * post-transform text: if another device's stamp arrived between our read
   * and our write, the transform returns the content unchanged and we must
   * adopt THAT id, not ours (plan D-STAMP-3).
   */
  processText(path: string, transform: (content: string) => string): Promise<string>;

  /** `app.vault.configDir`, for folder validation. */
  configDir(): string;
}

/** `GET /wiki/sources/obsidian`, validated (plan D-WIRE-1). */
export interface SourcesListing {
  sources: ServerSource[];
  /** Rows per status. Optional on the wire; `{}` when absent. */
  counts: Record<string, number>;
}

/** The PUT body, exactly the four keys §E names. */
export interface PutSourceBody {
  vault_path: string;
  title: string;
  text: string;
  body_hash: string;
}

export type PutOutcome =
  /** 200: same hash; only path and title were updated. No LLM call. */
  | { kind: 'unchanged' }
  /** 202: stored, `status=pending`. */
  | { kind: 'accepted' }
  /** 400: the server named what was wrong. Per-note; retrying cannot help. */
  | { kind: 'rejected'; message: string }
  /** 409: the row is `deleting`/`deleted`; an id is never resurrected. */
  | { kind: 'conflict-deleted' }
  /** 413: above 256 KiB. */
  | { kind: 'oversize' };

export type DeleteOutcome =
  /** 202: `status=deleting`, body nulled; pages follow on the next tick. */
  | { kind: 'deleting' }
  /** 204: unknown or already deleted. */
  | { kind: 'gone' }
  | { kind: 'rejected'; message: string };

/**
 * The three §E routes. Error contract, as for `JavisApiClient`: 401 → one
 * refresh, one retry, then `AuthExpiredError`; 403 insufficient_scope →
 * `InsufficientScopeError`; 429 → `RateLimitedError`; other >= 400 not listed
 * above → `HttpError`; no response → `NetworkError`; a malformed listing →
 * `ProtocolError` (a half-understood list must not drive deletes).
 */
export interface SourcesApi {
  list(signal?: AbortSignal): Promise<SourcesListing>;
  put(sourceId: string, body: PutSourceBody, signal?: AbortSignal): Promise<PutOutcome>;
  delete(sourceId: string, signal?: AbortSignal): Promise<DeleteOutcome>;
}

/**
 * Records the paths the upload itself just wrote, so their `modify` is ignored
 * (§F.2). The tracker reads its own injected clock at `mark` time: a run can
 * take minutes, so the run's start time would be the wrong "now" for a
 * seconds-long suppression window.
 */
export interface SelfWriteMarker {
  mark(path: string): void;
}

export interface UploadDeps {
  api: SourcesApi;
  vault: UploadVault;
  /** `settings.uploadFolders`. Empty → the run makes no request at all (D-RUN-2). */
  folders: readonly string[];
  memory: UploadMemory;
  /**
   * The injected clock for the debounce, epoch ms. A function, read once per
   * run at the moment the vault is enumerated, and never at the start of the
   * run (review): an interactive run can spend minutes in the step-up's
   * consent screen before it lists anything, and `planUpload` stores this
   * time as `missingSince` for every row the listing misses. A clock read
   * before the step-up dated the first miss minutes before it was seen, so a
   * second run one minute after the first could already pass the §F.3.3
   * "two misses at least five minutes apart" test. Both runs read it at the
   * same point — right after `listNotesIn` returns — so the span between two
   * stored times is the span between two observations of the vault.
   */
  now: () => number;
  /** `crypto.randomUUID` in the plugin; the core never generates an id. */
  newId: () => string;
  reuploadAll: boolean;
  /** Ids owed a re-send after an earlier "Re-upload all" PUT failed (review). */
  reuploadIds?: readonly string[];
  /**
   * `settings.uploadRemovedIds`: ids this vault DELETEd on earlier runs. The
   * server fills a row's undo report after the DELETE, on a later tick, by
   * which time the id has left upload memory; this is how a later run still
   * knows the report is this vault's to show (see `UploadResult.undoReports`).
   */
  removedIds?: readonly string[];
  release: readonly string[];
  signal?: AbortSignal;
  /**
   * One interactive re-authorization with the union scope (§C.7). Supplied
   * only for user-initiated triggers; background runs never open a browser.
   */
  stepUp?: () => Promise<void>;
  /**
   * True when the stored token visibly cannot write: its decodable scope
   * lacks `wiki:write`, or its decodable audience is not `/wiki`
   * (`lacksWriteGrant` in auth.ts). Asked before the first request, so a run
   * that is going to need a step-up gets it before it stamps anything into a
   * note — a stamp written ahead of a 403 the user then declines is an edit
   * to their file with nothing uploaded. Absent or false → try, and let a 403
   * decide (D-RUN-3).
   */
  lacksWriteGrant?: () => boolean;
  /** Cancellable sleep for 429 backoff. Injected so tests do not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  selfWrites?: SelfWriteMarker;
  /** Per-read timeout, default 10 s (§F.2). */
  readTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/** One run of the upload half. `uploadOnce` never throws; this is how it reports. */
export interface UploadResult {
  /** PUTs answered 202. */
  uploaded: number;
  /** PUTs answered 200 (a rename or re-upload with the same hash). */
  unchanged: number;
  /** DELETEs answered 202 or 204. */
  removed: number;
  stamped: number;
  failures: { path: string; message: string }[];
  skipped: SkippedNote[];
  held: HeldAction[];
  waiting: WaitingDelete[];
  invalidFolders: FolderError[];
  /**
   * Rows carrying an undo report, from this run's listing (§D.4) — only rows
   * this vault owns or removed (review). The listing is per ACCOUNT (rule 9
   * of core/upload.ts), and this list is persisted into `data.json`, which
   * lives inside the vault and may be shared (obsidian-git, a shared Sync
   * vault). Unfiltered, a team vault's `data.json` carried the paths of the
   * user's personal vault's deleted notes to every coworker. Owned means in
   * upload memory before or after this run, removed by this run, or in
   * `UploadDeps.removedIds`.
   */
  undoReports: { path: string; report: UndoReport }[];
  /**
   * This vault's rows the server's poller left `failed` (§D.5 "After three
   * failures a row stays `failed` and shows its error"), with `last_error`.
   * The plugin is the only place the user can see them: every later PUT of
   * an unchanged note answers 200, so the run itself records no failure
   * (review). From this run's listing, after planning (so only rows this
   * vault owns, D-PLAN-18).
   */
  serverFailures: { path: string; message: string }[];
  /** Ids whose PUT this run succeeded (202 or 200). */
  sentIds: string[];
  /** Ids whose DELETE this run succeeded (202 or 204); the caller adds them to `uploadRemovedIds`. */
  removedIds: string[];
  /**
   * Ids of re-sends ("Re-upload all", or owed from one) whose PUT failed in a
   * way worth retrying — a 5xx, one note's vault error — rather than a 400
   * about the note itself (review). The caller keeps them owed.
   */
  retryIds: string[];
  /** Server rows per status, from this run's listing. */
  counts: Record<string, number>;
  /** Persist this as `settings.uploadMemory`, whatever else happened. */
  nextMemory: UploadMemory;
  /** Why the run stopped early, or null. Partial progress above is still real. */
  stoppedBy: { code: string; message: string; needsUserAction: boolean } | null;
  /** False when the half did nothing because no folder is selected. */
  ran: boolean;
  /**
   * True once `planUpload` ran. False when the run stopped before it (no
   * write grant, a failed listing, a failed enumeration, an invalid
   * selection): then `held`, `skipped` and `waiting` are empty because
   * nothing was decided, not because nothing is pending, and the persisted
   * report keeps the previous run's lists (`uploadReport`).
   */
  planned: boolean;
}

/** `UploadResult` minus the memory, as persisted for the settings tab. */
export interface LastUploadReport extends Omit<UploadResult, 'nextMemory'> {
  /** ISO8601. */
  at: string;
  summary: string;
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

  // -- 0.2.0: the upload half (spec 2026-09-24 §F). Every field is additive
  // -- with a default, so a 0.1.x `data.json` loads unchanged.

  /**
   * Folders whose notes are uploaded (§F.3.1 validated). Empty by default:
   * nothing leaves the vault until the user picks a folder.
   */
  uploadFolders: string[];
  /** Upload 2 minutes after the last edit (§F.4). Off by default. */
  uploadOnEdit: boolean;
  /**
   * `{sourceId → {path, hash, bytes, missingSince}}` (§F.1). A cache: losing
   * it only delays deletes and re-evaluates shrink checks. `missingSince` is
   * always null here: the debounce clock is per device and lives in
   * `localStorage` (settings-load.ts `MISSING_SINCE_STORAGE_KEY`, review),
   * because this file syncs and another device's clock must not shorten this
   * device's two-scan wait.
   */
  uploadMemory: UploadMemory;
  /** The last upload run, for the settings tab and the review command. */
  lastUpload: LastUploadReport | null;
  /** "Re-upload all" survives a run that stops early; cleared by a clean run. */
  pendingReuploadAll: boolean;
  /**
   * Ids a "Re-upload all" did not get through (a 5xx on their PUT). Re-sent on
   * later runs until each goes out; before review the flag above was cleared
   * by a run that merely did not STOP, so those notes were never re-sent.
   */
  pendingReuploadIds: string[];
  /**
   * The ids this vault removed from Javis, most recent last, capped at
   * `REMOVED_IDS_CAP`. Ids only — the paths are already in upload memory
   * until the delete. Read to decide which undo reports in an
   * account-wide listing are this vault's (review).
   */
  uploadRemovedIds: string[];
}

/** How many removed ids `uploadRemovedIds` keeps (review). */
export const REMOVED_IDS_CAP = 200;

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
  uploadFolders: [],
  uploadOnEdit: false,
  uploadMemory: {},
  lastUpload: null,
  pendingReuploadAll: false,
  pendingReuploadIds: [],
  uploadRemovedIds: [],
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
