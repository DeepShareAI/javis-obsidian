/**
 * The client for `GET/PUT/DELETE /wiki/sources/obsidian`.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §E (the routes, their bodies and status codes), §C.4 (403
 *       insufficient_scope), §F.2 (`requestUrl` with `throw: false`).
 * Plan: docs/plans/2026-09-24-upload-half.md, D-WIRE-1..4, D-API-1..2.
 *
 * The server half (PR 3) does not exist yet; every shape here is the §E
 * contract as the plan fixes it, so PR 3 can match it or push back. The
 * decisions the wire could have gone either way on are marked `D-WIRE-*`.
 *
 * Four rules:
 *
 * 1. **Reuse, don't refactor, the download client's plumbing** (D-API-1).
 *    `obsidianTransport`, `headerValue`, `parseRetryAfterMs` and
 *    `parseJsonBody` come from api.ts unchanged, and the 401 sequence (one
 *    refresh, one retry of the same request, then `AuthExpiredError`) is
 *    copied rather than extracted from `JavisWikiApiClient.send`, so the 290
 *    tests that guard the download keep guarding exactly the code they did.
 * 2. **A half-understood listing is a `ProtocolError`** (D-WIRE-1). The listing
 *    drives deletes. Dropping one malformed row would make its source look
 *    absent from the server, and a row the plugin thinks is absent is a row it
 *    will PUT as new — or, for the delete guards, a live source it cannot see.
 *    Rejecting the whole response costs one run.
 * 3. **Per-note outcomes are values; run-level failures are throws.** 400, 409
 *    and 413 describe one note and come back as `PutOutcome`/`DeleteOutcome`.
 *    401-after-refresh, 403, 429, 5xx and no-response are thrown, and the
 *    upload loop decides which of them stop the run (plan D-RUN-4).
 * 4. **The token appears in one place:** the `Authorization` header. Never in
 *    a URL, an error message, or a `cause`.
 * 5. **HTTPS, or this machine** (review). An `http:` server URL is refused
 *    before any request unless its host is loopback: note text and a write
 *    bearer must not cross a network in the clear. The same rule now guards
 *    the download and OAuth (origin.ts).
 *
 * `baseUrl` is read through a function on every request (D-API-2), as
 * `JavisOAuth` does, so a settings change cannot send this user's bearer to
 * the origin they just left.
 */

import type {
  DeleteOutcome,
  PutOutcome,
  PutSourceBody,
  ServerSource,
  SourcesApi,
  SourcesListing,
  UndoReport,
} from './contracts';
import type { ApiAuth, HttpResponse, HttpTransport } from './api';
import { headerValue, obsidianTransport, parseJsonBody, parseRetryAfterMs } from './api';
import { assertSecureUrl } from './origin';
// Re-exported for existing importers; the rule itself lives in origin.ts.
export { isLoopbackHost } from './origin';
import {
  AuthExpiredError,
  HttpError,
  InsufficientScopeError,
  NetworkError,
  ProtocolError,
  RateLimitedError,
  SyncCancelledError,
  isJavisError,
} from './errors';

export const SOURCES_PATH = '/wiki/sources/obsidian';

// ---------------------------------------------------------------------------
// Pure: URLs and headers
// ---------------------------------------------------------------------------

/** `${base}/wiki/sources/obsidian[/<id>]`. Throws a plain Error on a bad base URL. */
export function buildSourcesUrl(baseUrl: string, sourceId?: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('Javis server URL is not set.');
  let url: URL;
  try {
    // D-WIRE-4: the id is validated as a uuid before it gets here; encoding
    // it anyway means a bug upstream cannot turn into a different path.
    url = new URL(trimmed + SOURCES_PATH + (sourceId === undefined ? '' : `/${encodeURIComponent(sourceId)}`));
  } catch {
    throw new Error(`Javis server URL is not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Javis server URL must be http or https, got ${url.protocol}`);
  }
  // Rule 5: note text and a `wiki:write` bearer never go in the clear
  // (origin.ts, shared with the download and OAuth since the second review).
  assertSecureUrl(url);
  return url.toString();
}

/**
 * Parse one `WWW-Authenticate` challenge: the scheme and its auth-params,
 * lowercased names, quoted values unescaped. Commas inside quotes do not split.
 * Enough of RFC 9110 §11.6.1 for the one header we read.
 */
export function parseWwwAuthenticate(header: string | null): { scheme: string; params: Record<string, string> } | null {
  if (header === null) return null;
  const text = header.trim();
  const match = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s*(.*)$/s.exec(text);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const rest = match[2] ?? '';
  const params: Record<string, string> = {};
  const re = /\s*,?\s*([A-Za-z0-9_.-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^,\s]*)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (m[0] === '') break;
    const name = m[1]!.toLowerCase();
    const value = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : (m[2] ?? '');
    if (!(name in params)) params[name] = value;
  }
  return { scheme, params };
}

/** True for a 403 whose challenge says `error="insufficient_scope"` (RFC 6750 §3.1). */
export function isInsufficientScope(response: HttpResponse): boolean {
  if (response.status !== 403) return false;
  const challenge = parseWwwAuthenticate(headerValue(response.headers, 'www-authenticate'));
  return challenge?.scheme === 'bearer' && challenge.params['error'] === 'insufficient_scope';
}

/** The server's own words for a 400, truncated: `detail`, `error_description`, `error`, `message`, else the body. */
export function serverMessage(text: string): string {
  let message = text;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      for (const key of ['detail', 'error_description', 'error', 'message']) {
        const v = b[key];
        if (typeof v === 'string' && v !== '') {
          message = v;
          break;
        }
      }
    }
  } catch {
    // Plain text; used as-is.
  }
  return message.trim().slice(0, 200) || 'rejected by the server';
}

// ---------------------------------------------------------------------------
// Pure: listing validation (D-WIRE-1)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const HASH = /^[0-9a-f]{64}$/i;
const UNDO_KEYS = ['pages_tombstoned', 'pages_rebuilt', 'pages_marked_stale', 'pages_skipped_adopted'] as const;

function validateUndoReport(value: unknown, where: string): UndoReport | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new ProtocolError(`${where}: \`undo_report\` is not an object`);
  const out = {} as Record<(typeof UNDO_KEYS)[number], number>;
  for (const key of UNDO_KEYS) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new ProtocolError(`${where}: \`undo_report.${key}\` is not a number`);
    }
    out[key] = n;
  }
  return out;
}

export function validateSourceRow(value: unknown, where: string): ServerSource {
  if (!isRecord(value)) throw new ProtocolError(`${where} is not an object`);
  const str = (key: string): string => {
    const v = value[key];
    if (typeof v !== 'string' || v === '') throw new ProtocolError(`${where}: \`${key}\` is missing or not a string`);
    return v;
  };
  const source_id = str('source_id').toLowerCase();
  const vault_path = str('vault_path');
  const body_hash = str('body_hash');
  if (!HASH.test(body_hash)) throw new ProtocolError(`${where}: \`body_hash\` is not 64 hex characters`);
  const status = str('status');
  const deleted = value['deleted'];
  if (typeof deleted !== 'boolean') throw new ProtocolError(`${where}: \`deleted\` is not a boolean`);
  const rawError = value['last_error'];
  if (rawError !== undefined && rawError !== null && typeof rawError !== 'string') {
    throw new ProtocolError(`${where}: \`last_error\` is not a string or null`);
  }
  return {
    source_id,
    vault_path,
    body_hash: body_hash.toLowerCase(),
    status,
    deleted,
    last_error: typeof rawError === 'string' ? rawError : null,
    undo_report: validateUndoReport(value['undo_report'], where),
  };
}

export function validateSourcesResponse(value: unknown): SourcesListing {
  const where = `GET ${SOURCES_PATH}`;
  if (!isRecord(value)) throw new ProtocolError(`${where} did not return an object`);
  const raw = value['sources'];
  if (!Array.isArray(raw)) throw new ProtocolError(`${where}: \`sources\` is not an array`);
  const sources = raw.map((row, i) => validateSourceRow(row, `${where}: sources[${i}]`));

  const rawCounts = value['counts'];
  const counts: Record<string, number> = {};
  if (rawCounts !== undefined && rawCounts !== null) {
    if (!isRecord(rawCounts)) throw new ProtocolError(`${where}: \`counts\` is not an object`);
    for (const [k, v] of Object.entries(rawCounts)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ProtocolError(`${where}: \`counts.${k}\` is not a number`);
      }
      counts[k] = v;
    }
  }
  return { sources, counts };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncCancelledError('Upload was cancelled.');
}

export interface SourcesApiConfig {
  /** Read on every request (D-API-2). */
  baseUrl: () => string;
}

export class JavisSourcesApiClient implements SourcesApi {
  constructor(
    private readonly config: SourcesApiConfig,
    private readonly auth: ApiAuth,
    private readonly transport: HttpTransport = obsidianTransport,
  ) {}

  async list(signal?: AbortSignal): Promise<SourcesListing> {
    const response = await this.request('GET', buildSourcesUrl(this.config.baseUrl()), undefined, signal);
    if (response.status !== 200) throw this.failure(response);
    return validateSourcesResponse(parseJsonBody(response.text));
  }

  async put(sourceId: string, body: PutSourceBody, signal?: AbortSignal): Promise<PutOutcome> {
    // Exactly the four §E keys, in a fresh object: nothing else a caller
    // happened to put on `body` reaches the server.
    const payload = JSON.stringify({
      vault_path: body.vault_path,
      title: body.title,
      text: body.text,
      body_hash: body.body_hash,
    });
    const response = await this.request('PUT', buildSourcesUrl(this.config.baseUrl(), sourceId), payload, signal);
    const { status } = response;
    if (status === 200) return { kind: 'unchanged' };
    if (status >= 200 && status < 300) return { kind: 'accepted' };
    if (status === 400) return { kind: 'rejected', message: serverMessage(response.text) };
    if (status === 409) return { kind: 'conflict-deleted' };
    if (status === 413) return { kind: 'oversize' };
    throw this.failure(response);
  }

  async delete(sourceId: string, signal?: AbortSignal): Promise<DeleteOutcome> {
    const response = await this.request('DELETE', buildSourcesUrl(this.config.baseUrl(), sourceId), undefined, signal);
    const { status } = response;
    if (status === 204) return { kind: 'gone' };
    if (status >= 200 && status < 300) return { kind: 'deleting' };
    if (status === 400 || status === 409) return { kind: 'rejected', message: serverMessage(response.text) };
    throw this.failure(response);
  }

  /** Map a response no caller handled onto the error vocabulary. */
  private failure(response: HttpResponse): Error {
    if (response.status === 401) {
      return new AuthExpiredError('The Javis server rejected the access token even after a refresh.');
    }
    if (isInsufficientScope(response)) return new InsufficientScopeError();
    if (response.status === 429) return new RateLimitedError(parseRetryAfterMs(response.headers));
    if (response.status >= 400) return new HttpError(response.status, response.text.slice(0, 500));
    return new ProtocolError(`${SOURCES_PATH} answered an unexpected status ${response.status}.`);
  }

  /** One request with the §B 401 sequence: refresh once, retry the same request once. */
  private async request(method: string, url: string, body: string | undefined, signal?: AbortSignal): Promise<HttpResponse> {
    let response = await this.send(method, url, body, await this.auth.getAccessToken(), signal);
    if (response.status === 401) {
      ensureNotAborted(signal);
      response = await this.send(method, url, body, await this.auth.refresh(), signal);
    }
    return response;
  }

  private async send(
    method: string,
    url: string,
    body: string | undefined,
    token: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    ensureNotAborted(signal);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: HttpResponse;
    try {
      response = await this.transport({
        url,
        method,
        headers,
        ...(body === undefined ? {} : { body, contentType: 'application/json' }),
        signal,
      });
    } catch (err) {
      if (isJavisError(err)) throw err;
      throw new NetworkError(`Could not reach the Javis server at ${url}`, { cause: err });
    }
    // Not re-checked after the call: `requestUrl` cannot be aborted, so a
    // completed PUT has happened on the server whatever the signal says, and
    // its outcome is worth recording. Cancellation is checked between notes.
    return response;
  }
}
