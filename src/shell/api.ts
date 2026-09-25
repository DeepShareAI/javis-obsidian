/**
 * The `GET /wiki/export` client.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md
 *       §B (the endpoint and its paging contract), §F.2 (how the loop consumes
 *       it), §G (module boundaries).
 *
 * Four rules shape this file.
 *
 * 1. **`requestUrl`, never `fetch`.** Requests made from the Obsidian renderer
 *    with `fetch` are subject to CORS and would fail against mcp.javis.is;
 *    `requestUrl` is Obsidian's CORS-free transport. It is reached through a
 *    lazy `require` inside exactly one function (`loadRequestUrl`) — the
 *    `obsidian` package ships types only (`"main": ""`), so any import a bundler
 *    can see statically, `import('obsidian')` included, makes this module
 *    unloadable under vitest and takes the pure logic below with it. Everything
 *    else here is injected through `HttpTransport` and is therefore unit-tested.
 * 2. **The persisted cursor is the server's `server_time`, from the FIRST
 *    batch, and the client clock is never consulted.** §B: a client that stamps
 *    its own clock opens a window of permanently missed updates, and a client
 *    that takes a LATER batch's watermark skips every row committed between
 *    batch 1 and batch N. `runExport` captures it into a `const` before the
 *    paging loop starts, so there is no assignment that could get it wrong, and
 *    `ExportRun.serverTime` is the only way out of this module for a cursor.
 * 3. **`next_cursor` is opaque.** It is base64url of `<iso updated_at>|<id>`
 *    today (app/tools/wiki/export.py:94), and that is the server's business. It
 *    is echoed back verbatim in `?cursor=` and never parsed, compared for
 *    ordering, or constructed. Spec §B's `"next_cursor": 4821` example is stale.
 * 4. **A malformed response never reaches the vault.** `validateExportResponse`
 *    rejects the whole batch rather than passing a half-understood page down to
 *    `reconcile`, because the alternative — dropping the bad page and carrying
 *    on — would let the cursor advance past a row the vault never saw, and
 *    §F.1's recovery story assumes the cursor only ever moves over rows the
 *    vault has actually seen.
 *
 * Nothing in this module logs. The access token appears in exactly one place,
 * the `Authorization` header of an outgoing request; it is never put into an
 * error message, a URL, or a thrown `cause`.
 */

import { DEFAULT_PAGE_LIMIT } from './contracts';
import { assertSecureUrl } from './origin';
import type {
  ApiClientConfig,
  ExportBatch,
  ExportQuery,
  ExportResponse,
  ExportRun,
  JavisApiClient,
  JavisAuth,
  ServerPage,
} from './contracts';
import {
  AuthExpiredError,
  HttpError,
  NetworkError,
  ProtocolError,
  RateLimitedError,
  SyncCancelledError,
  isJavisError,
} from './errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The OAuth door serves this path exactly — no `/api` prefix (§B). */
export const EXPORT_PATH = '/wiki/export';

/** Server-side clamp is `max(1, min(limit, 1000))` (app/tools/wiki/export.py:188). */
export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 1000;

/**
 * A ceiling on batches in one run, purely as a liveness guard.
 *
 * At the 500-row default this is five million rows, i.e. unreachable for a real
 * wiki. It exists so that a server bug cannot turn the sync loop into an
 * unkillable request storm; the duplicate-cursor check below catches the more
 * likely shape of the same bug sooner.
 */
export const MAX_BATCHES = 10_000;

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * One outgoing request.
 *
 * `JavisWikiApiClient` only ever issues GETs — it reads and nothing else — but
 * `method`, `body` and `contentType` are declared so that `obsidianTransport`
 * is general enough to be the ONE `requestUrl` adapter in the plugin, shared
 * with the POSTs the OAuth flow makes. Every field except `url` is optional so
 * a narrower request shape can be passed straight through.
 */
export interface HttpRequest {
  url: string;
  /** Defaults to GET. */
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  /**
   * Checked before and after the call, never handed to the transport:
   * `requestUrl` has no cancellation of its own, so an in-flight request runs
   * to completion and its result is discarded.
   */
  signal?: AbortSignal;
}

/** Just enough of `RequestUrlResponse` to decide what happened. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * The seam that keeps this module testable.
 *
 * A transport MUST NOT throw on a 4xx/5xx — it returns the response and lets
 * the client map the status. `obsidianTransport` passes `throw: false` for
 * exactly that reason. Throwing is reserved for a request that produced no
 * response at all (DNS, TLS, offline), which becomes `NetworkError`.
 */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** The two auth calls this client makes. A full `JavisAuth` satisfies it. */
export type ApiAuth = Pick<JavisAuth, 'getAccessToken' | 'refresh'>;

/**
 * The type comes from the typings; the VALUE comes from the host at runtime.
 * `typeof import(...)` is a type-only construct and emits nothing.
 */
type RequestUrlFn = typeof import('obsidian').requestUrl;

let cachedRequestUrl: RequestUrlFn | null = null;

/**
 * The one place in this module that touches Obsidian.
 *
 * `require`, not a static or dynamic `import`, and this is load-bearing:
 *
 * - The `obsidian` package is types-only (`"main": ""`). Any import a bundler
 *   can see statically — including `import('obsidian')`, which Vite resolves at
 *   transform time — makes this module unloadable under vitest, and takes every
 *   pure function above down with it.
 * - Inside the plugin, `obsidian` is external and the output format is CJS, so
 *   `require('obsidian')` is literally what esbuild would emit for a static
 *   import anyway. Obsidian provides the module to the plugin's `require`.
 *
 * Called lazily, so a test that constructs a client with its own transport
 * never reaches it.
 */
function loadRequestUrl(): RequestUrlFn {
  if (cachedRequestUrl === null) {
    const mod = require('obsidian') as { requestUrl: RequestUrlFn };
    cachedRequestUrl = mod.requestUrl;
  }
  return cachedRequestUrl;
}

export const obsidianTransport: HttpTransport = async (req) => {
  const requestUrl = loadRequestUrl();
  const response = await requestUrl({
    url: req.url,
    method: req.method ?? 'GET',
    headers: req.headers ?? {},
    ...(req.body === undefined ? {} : { body: req.body }),
    ...(req.contentType === undefined ? {} : { contentType: req.contentType }),
    // Without this, `requestUrl` throws on 401/429/400 and the status — the
    // one thing the retry and backoff decisions turn on — is lost in a string.
    throw: false,
  });
  return {
    status: response.status,
    headers: response.headers ?? {},
    text: response.text ?? '',
  };
};

// ---------------------------------------------------------------------------
// Pure: the request URL
// ---------------------------------------------------------------------------

/**
 * Clamp to the server's own bounds before the request goes out.
 *
 * The two doors disagree about an out-of-range `limit`: the OAuth door
 * saturates at 1000 while the Clerk door declares `ge=1, le=1000` and answers
 * 422. Clamping here means the plugin behaves identically against either, and a
 * settings field with a typo in it never becomes an HTTP error.
 */
export function clampLimit(limit?: number | null): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  const whole = Math.floor(limit);
  if (whole < MIN_PAGE_LIMIT) return MIN_PAGE_LIMIT;
  if (whole > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return whole;
}

/**
 * `${baseUrl}/wiki/export?since=&limit=&cursor=`.
 *
 * `since` and `cursor` are omitted entirely when absent — an empty `since=` is
 * a malformed timestamp to the server and comes back 400, which is a worse
 * failure than the full export the caller actually asked for. A trailing slash
 * on `baseUrl` is tolerated because users paste one.
 *
 * Throws a plain `Error` on a `baseUrl` that is not an absolute http(s) URL,
 * or that is plain http to anything but this machine (origin.ts, review).
 * That is a configuration mistake rather than a protocol failure, so it stays
 * outside the `JavisError` vocabulary and surfaces as itself.
 */
export function buildExportUrl(baseUrl: string, query: ExportQuery = {}): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('Javis server URL is not set.');

  let url: URL;
  try {
    url = new URL(trimmed + EXPORT_PATH);
  } catch {
    // No `cause`: `Error.cause` is ES2022 and this project compiles against
    // `lib: ES2021` (see the same note in errors.ts).
    throw new Error(`Javis server URL is not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Javis server URL must be http or https, got ${url.protocol}`);
  }
  // Since 0.2.0 the bearer this request carries may hold `wiki:write`, which
  // can delete every uploaded source: https, or this machine (origin.ts).
  assertSecureUrl(url);

  const since = typeof query.since === 'string' ? query.since.trim() : '';
  if (since !== '') url.searchParams.set('since', since);

  // Opaque: echoed exactly as the server issued it (rule 3).
  const cursor = typeof query.cursor === 'string' ? query.cursor : '';
  if (cursor !== '') url.searchParams.set('cursor', cursor);

  url.searchParams.set('limit', String(clampLimit(query.limit)));
  return url.toString();
}

// ---------------------------------------------------------------------------
// Pure: response headers and status
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup; `requestUrl` does not promise a casing. */
export function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

/**
 * `Retry-After` in milliseconds, or null when the server did not say.
 *
 * RFC 9110 allows either delta-seconds or an HTTP-date, and the token bucket at
 * javis_mcp/wiki_export.py sends neither today — so null is the expected answer
 * and the caller must have its own backoff. Parsed here anyway because the day
 * the server starts sending one, honouring it is strictly better than guessing.
 */
export function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  now: number = Date.now(),
): number | null {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;

  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Map a >= 400 response onto the error vocabulary.
 *
 * 401 maps to `AuthExpiredError`, which is only correct AFTER the one refresh
 * and one retry the §B contract allows — `fetchBatch` owns that sequence and is
 * the only caller that should ever reach this with a 401.
 */
export function errorForResponse(
  status: number,
  body: string,
  headers?: Record<string, string>,
  now: number = Date.now(),
): HttpError | RateLimitedError | AuthExpiredError {
  if (status === 429) {
    return new RateLimitedError(parseRetryAfterMs(headers, now));
  }
  if (status === 401) {
    return new AuthExpiredError(
      'The Javis server rejected the access token even after a refresh.',
    );
  }
  // Truncated: an HTML error page from a proxy is otherwise megabytes of noise
  // in a Notice.
  return new HttpError(status, body.slice(0, 500));
}

// ---------------------------------------------------------------------------
// Pure: response validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  where: string,
  allowEmpty = false,
): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new ProtocolError(`${where}: \`${key}\` is ${describe(value)}, expected a string`);
  }
  if (!allowEmpty && value === '') {
    throw new ProtocolError(`${where}: \`${key}\` is empty`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * One row of `pages`, rebuilt field by field.
 *
 * A fresh object rather than the parsed one: what goes into `render` and
 * `reconcile` is then exactly the seven fields §B documents, with nothing the
 * server happened to add along for the ride and nothing inherited from a
 * hand-crafted JSON payload.
 *
 * Required: `page_type`, `slug`, `title`, `updated_at` — the identity and the
 * change signal. `title` may legitimately be empty; the other three may not,
 * because an empty `slug` collapses to `untitled.md` and an empty `updated_at`
 * would be written into `javis_rev` and compared against forever.
 *
 * Optional, matching the server's own defaults (app/tools/wiki/schemas.py:63):
 * `frontmatter` ({}), `body` ('') and `deleted_at` (null).
 */
export function validateServerPage(value: unknown, where: string): ServerPage {
  if (!isRecord(value)) {
    throw new ProtocolError(`${where} is ${describe(value)}, expected an object`);
  }

  const page_type = requiredString(value, 'page_type', where);
  const slug = requiredString(value, 'slug', where);
  const title = requiredString(value, 'title', where, true);
  const updated_at = requiredString(value, 'updated_at', where);

  const rawFrontmatter = value['frontmatter'];
  if (rawFrontmatter !== undefined && rawFrontmatter !== null && !isRecord(rawFrontmatter)) {
    throw new ProtocolError(
      `${where}: \`frontmatter\` is ${describe(rawFrontmatter)}, expected an object`,
    );
  }
  const frontmatter = isRecord(rawFrontmatter) ? rawFrontmatter : {};

  const rawBody = value['body'];
  if (rawBody !== undefined && rawBody !== null && typeof rawBody !== 'string') {
    throw new ProtocolError(`${where}: \`body\` is ${describe(rawBody)}, expected a string`);
  }
  const body = typeof rawBody === 'string' ? rawBody : '';

  const rawDeletedAt = value['deleted_at'];
  if (rawDeletedAt !== undefined && rawDeletedAt !== null && typeof rawDeletedAt !== 'string') {
    throw new ProtocolError(
      `${where}: \`deleted_at\` is ${describe(rawDeletedAt)}, expected a string or null`,
    );
  }
  // Normalized to null rather than left undefined: `reconcile` branches on
  // truthiness, and '' would read as live. An empty string here is a server bug
  // either way, so it is treated as "not deleted" and the page syncs normally.
  const deleted_at = typeof rawDeletedAt === 'string' && rawDeletedAt !== '' ? rawDeletedAt : null;

  return { page_type, slug, title, updated_at, frontmatter, body, deleted_at };
}

/** `JSON.parse` with the failure reported as a protocol failure, not a SyntaxError. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(
      `The Javis server returned a body that is not JSON: ${text.slice(0, 200)}`,
      { cause: err },
    );
  }
}

/**
 * The §B response shape, validated whole.
 *
 * `pages` and `server_time` are required; `next_cursor` must be present but may
 * be null, which is how the server says "that was the last row". A response
 * missing `server_time` cannot yield a cursor, and a response with a bad page in
 * it cannot yield a vault — both reject the batch (rule 4).
 */
export function validateExportResponse(value: unknown): ExportResponse {
  const where = 'GET /wiki/export';
  if (!isRecord(value)) {
    throw new ProtocolError(`${where} returned ${describe(value)}, expected an object`);
  }

  const rawPages = value['pages'];
  if (!Array.isArray(rawPages)) {
    throw new ProtocolError(`${where}: \`pages\` is ${describe(rawPages)}, expected an array`);
  }

  const server_time = requiredString(value, 'server_time', where);

  const rawCursor = value['next_cursor'];
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== 'string') {
    throw new ProtocolError(
      `${where}: \`next_cursor\` is ${describe(rawCursor)}, expected a string or null`,
    );
  }
  const next_cursor = typeof rawCursor === 'string' && rawCursor !== '' ? rawCursor : null;

  const pages = rawPages.map((page, index) =>
    validateServerPage(page, `${where}: pages[${index}]`),
  );

  return { pages, next_cursor, server_time };
}

// ---------------------------------------------------------------------------
// Pure: the paging loop
// ---------------------------------------------------------------------------

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncCancelledError('Sync was cancelled.');
}

/**
 * Page one delta to exhaustion, handing each batch to `onBatch`.
 *
 * Pure in the sense that matters: it takes `fetchBatch` as an argument, so the
 * whole paging contract is exercised in tests with no HTTP and no Obsidian.
 *
 * The cursor guarantee (rule 2) is structural. The first request happens BEFORE
 * the loop and its `server_time` is bound to a `const`, so there is no
 * assignment anywhere that a later batch could win. Each batch still reports its
 * own `server_time` in `ExportBatch.serverTime` for diagnostics, but only
 * `ExportRun.serverTime` is a cursor.
 *
 * `onBatch` is awaited before the next request goes out. That is what keeps
 * vault writes serialized against a stream of 500-row batches, and it is why a
 * rejection from `onBatch` stops the run: the caller must then NOT advance the
 * cursor, and re-delivery is free because every §F.2 write is idempotent.
 */
export async function runExport(
  fetchBatch: (query: ExportQuery, signal?: AbortSignal) => Promise<ExportResponse>,
  opts: {
    since: string | null;
    limit?: number;
    signal?: AbortSignal;
    onBatch: (batch: ExportBatch) => Promise<void> | void;
    maxBatches?: number;
  },
): Promise<ExportRun> {
  const { since, limit, signal, onBatch } = opts;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES;

  ensureNotAborted(signal);
  let response = await fetchBatch({ since, limit, cursor: null }, signal);

  // The one and only assignment of the run's cursor, from batch 1 (§B).
  const serverTime = response.server_time;

  const seenCursors = new Set<string>();
  let index = 1;
  let pages = 0;

  for (;;) {
    pages += response.pages.length;
    await onBatch({
      pages: response.pages,
      index,
      nextCursor: response.next_cursor,
      serverTime: response.server_time,
    });

    const cursor = response.next_cursor;
    if (cursor === null) break;

    // A server that re-issues a cursor it already issued would page forever.
    // Cheaper to notice than to survive.
    if (seenCursors.has(cursor)) {
      throw new ProtocolError(
        'The Javis server repeated a pagination cursor; stopping to avoid an endless export.',
      );
    }
    seenCursors.add(cursor);

    if (index >= maxBatches) {
      throw new ProtocolError(
        `The export did not terminate after ${maxBatches} batches; stopping.`,
      );
    }

    ensureNotAborted(signal);
    index += 1;
    response = await fetchBatch({ since, limit, cursor }, signal);
  }

  return { serverTime, batches: index, pages };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * `JavisApiClient` over Obsidian's `requestUrl`.
 *
 * The 401 sequence is the §B contract exactly: one refresh, one retry of the
 * SAME request, and a second 401 is `AuthExpiredError` — a freshly minted token
 * being rejected is a server-side or scope problem, not expiry, and hammering
 * it would only burn the 60/min bucket.
 *
 * Errors raised by `JavisAuth` itself (`AuthRequiredError` when nothing was ever
 * stored, `AuthRevokedError` when the refresh token is dead) pass through
 * untouched: they already say precisely what the user has to do, and rewrapping
 * them as `NetworkError` would turn "reconnect" into "try again later" forever.
 */
export class JavisWikiApiClient implements JavisApiClient {
  private readonly baseUrl: string;
  private readonly limit: number;

  constructor(
    config: ApiClientConfig,
    private readonly auth: ApiAuth,
    private readonly transport: HttpTransport = obsidianTransport,
  ) {
    this.baseUrl = config.baseUrl;
    this.limit = clampLimit(config.limit);
  }

  async fetchBatch(query: ExportQuery = {}, signal?: AbortSignal): Promise<ExportResponse> {
    const url = buildExportUrl(this.baseUrl, {
      since: query.since ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit ?? this.limit,
    });

    let response = await this.send(url, await this.auth.getAccessToken(), signal);

    if (response.status === 401) {
      ensureNotAborted(signal);
      response = await this.send(url, await this.auth.refresh(), signal);
    }

    if (response.status >= 400) {
      throw errorForResponse(response.status, response.text, response.headers);
    }

    return validateExportResponse(parseJsonBody(response.text));
  }

  exportAll(opts: {
    since: string | null;
    limit?: number;
    signal?: AbortSignal;
    onBatch: (batch: ExportBatch) => Promise<void> | void;
  }): Promise<ExportRun> {
    return runExport((query, signal) => this.fetchBatch(query, signal), {
      ...opts,
      limit: opts.limit ?? this.limit,
    });
  }

  /**
   * One request. `token` is used here and nowhere else: it is not logged, not
   * put in the URL, and not attached to any error this method raises.
   */
  private async send(
    url: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    ensureNotAborted(signal);
    let response: HttpResponse;
    try {
      response = await this.transport({
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal,
      });
    } catch (err) {
      // A JavisError from a transport is already the right answer; anything
      // else means no HTTP response happened at all.
      if (isJavisError(err)) throw err;
      throw new NetworkError(`Could not reach the Javis server at ${url}`, { cause: err });
    }
    ensureNotAborted(signal);
    return response;
  }
}
