/**
 * The RFC 8252 native-app OAuth flow, against javis-mcp's existing server.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md §D.
 * Server: javis_mcp/oauth/{registration,authorize,callback,token,revoke}.py.
 *
 * Three structural decisions, each forced by something in the server or the
 * runtime rather than chosen for taste:
 *
 * 1. **No `obsidian` import.** `node_modules/obsidian` declares `"main": ""` —
 *    it is a types-only package with no runtime entry, so importing it here
 *    would break both vitest and the bundle. Everything Obsidian-shaped arrives
 *    through injected seams: `SecretStore` (the keychain), `BrowserOpener` (the
 *    system browser) and `HttpTransport` (`requestUrl`). That is also what makes
 *    the refresh/rotation logic below unit-testable without a network.
 *
 * 2. **The loopback listener is bound BEFORE registration.** §D lists register
 *    (step 1) before the listener (step 2), and that order cannot work:
 *    `/oauth/authorize` compares `redirect_uri` against the registered list by
 *    exact string match (javis_mcp/oauth/authorize.py:43), and the string
 *    contains the ephemeral port. `_redirect_allowed`
 *    (javis_mcp/oauth/registration.py:17) only checks scheme + hostname, so ANY
 *    127.0.0.1 port registers happily — the rejection lands later, at authorize,
 *    as `invalid_redirect_uri`. So: bind first, read the OS-assigned port, then
 *    register that exact URI. A cached `client_id` is reusable only if we manage
 *    to re-bind the same port, which `connect()` attempts and falls back from.
 *
 * 3. **Both tokens live in `SecretStore` and nowhere else.** §D is explicit:
 *    `data.json` sits inside the vault and would replicate the refresh token to
 *    every device the vault syncs to. The access token's expiry is not persisted
 *    separately either — it is read out of the JWT's own `exp` claim
 *    (javis_mcp/oauth/token.py:81-90 signs one), so a plugin restart recovers it
 *    from the keychain alone.
 *
 * The refresh token ROTATES on every use: `_grant_refresh_token` calls
 * `store.rotate_token`, which revokes the presented token and returns a new one
 * (javis_mcp/oauth/store.py:90-110). Worse, `rotate_token` treats a *reused*
 * token as a breach and revokes the entire family. So the new refresh token is
 * written to the keychain BEFORE this module resolves anything, and a failed
 * refresh is never retried.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

import type {
  AuthStatus,
  BrowserOpener,
  ConnectOptions,
  JavisAuth,
  OAuthClientRegistration,
  SecretStore,
} from './contracts';
import { SECRET_ACCESS_TOKEN, SECRET_REFRESH_TOKEN } from './contracts';
import {
  AuthCancelledError,
  AuthRequiredError,
  AuthRevokedError,
  HttpError,
  NetworkError,
  ProtocolError,
  RateLimitedError,
} from './errors';
import { secureOrigin } from './origin';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The read scope, and still the default: a connect with no upload folder
 * selected asks for exactly this, as 0.1.x did (javis_mcp/oauth/metadata.py:28).
 */
export const OAUTH_SCOPE = 'mcp:read';

/** The scope the upload routes require (spec 2026-09-24 §C.4, §E). */
export const WIKI_WRITE_SCOPE = 'wiki:write';

/**
 * What a step-up asks for: the UNION, not just the new scope. `wiki:write`
 * does not imply read (§C.4), and the MCP step-up flow re-requests everything
 * the client needs, so asking for `wiki:write` alone would trade the download's
 * grant for the upload's.
 */
export const OAUTH_SCOPE_WRITE = `${OAUTH_SCOPE} ${WIKI_WRITE_SCOPE}`;

/** Shown on the server's client row; purely cosmetic. Truncated to 120 chars. */
export const CLIENT_NAME = 'Obsidian — Javis Wiki Sync';

/**
 * How long to wait for the browser to come back with a code.
 *
 * Generous on purpose. The authorization code's own TTL is 60s
 * (javis_mcp/config.py:29) but that clock only starts when `/oauth/callback/finalize`
 * mints the code — everything before it (Clerk sign-in, then the callback page's
 * three sequential Clerk fetches) is unbounded human-and-network time. A budget
 * near 60s would abandon a flow that is still working.
 */
export const DEFAULT_AUTHORIZE_TIMEOUT_MS = 180_000;

/**
 * Refresh this far before the access token actually expires.
 *
 * Access tokens live 3600s (javis_mcp/config.py:27). A minute of headroom covers
 * modest clock skew between this machine and the server without refreshing on
 * every call.
 */
export const EXPIRY_SKEW_MS = 60_000;

/** Bytes of entropy behind the PKCE verifier and the CSRF `state`. */
const ENTROPY_BYTES = 32;

// ---------------------------------------------------------------------------
// HTTP seam
// ---------------------------------------------------------------------------

export interface HttpRequestInit {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponseLike {
  status: number;
  text: string;
}

/**
 * The one network primitive this module needs.
 *
 * MUST resolve for any HTTP response, including 4xx and 5xx — a rejection is
 * read as a transport failure and becomes `NetworkError`, which deliberately
 * never clears the stored tokens. Obsidian's `requestUrl` throws on non-2xx by
 * default, so the adapter that supplies this must pass `throw: false`:
 *
 * ```ts
 * import { requestUrl } from 'obsidian';
 * const transport: HttpTransport = async (req) => {
 *   const r = await requestUrl({ ...req, throw: false });
 *   return { status: r.status, text: r.text };
 * };
 * ```
 *
 * `requestUrl` rather than `fetch`: renderer-side `fetch` is subject to CORS and
 * would fail against mcp.javis.is.
 */
export type HttpTransport = (req: HttpRequestInit) => Promise<HttpResponseLike>;

// ---------------------------------------------------------------------------
// Pure helpers — PKCE, URLs, callback parsing
// ---------------------------------------------------------------------------

/** base64url, unpadded — the encoding every OAuth value here uses. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of {@link base64UrlEncode}; returns null on anything unparseable. */
export function base64UrlDecode(value: string): string | null {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** `ENTROPY_BYTES` of CSPRNG output, base64url. 43 characters for 32 bytes. */
export function randomToken(bytes = ENTROPY_BYTES): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/**
 * `base64url(SHA-256(verifier))`, byte-identical to the server's
 * `make_challenge` (javis_mcp/oauth/pkce.py:8-10).
 *
 * Async because `crypto.subtle.digest` is. Both Electron's renderer and Node 18+
 * expose Web Crypto on the `crypto` global, so this needs no polyfill in either.
 */
export async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * A fresh PKCE pair. The verifier is 43 characters, inside the 43..128 window
 * `verify_s256` enforces (javis_mcp/oauth/pkce.py:4-5,14).
 */
export async function generatePkce(): Promise<PkcePair> {
  const verifier = randomToken();
  return { verifier, challenge: await deriveChallenge(verifier) };
}

/** Trailing slashes make `${base}/oauth/token` into a 404 via `//`. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export interface AuthorizeUrlParams {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
  /**
   * RFC 8707 resource indicator. Omitted entirely when absent, which yields
   * 0.1.x's URL byte for byte. The plugin itself always passes one since
   * review of 0.2.0 (`connectOptionsFor`); the omission is kept for callers
   * that ask for nothing.
   */
  resource?: string;
}

/**
 * The URL handed to the SYSTEM browser.
 *
 * Not an Electron window, and not a `fetch`: `/oauth/authorize` 302s to Clerk
 * sign-in and sets an httpOnly state cookie, and the `/oauth/callback` page then
 * drives Clerk's Frontend API with `credentials: 'include'`
 * (javis_mcp/oauth/callback.py:58-88). That chain runs on the user's existing
 * Clerk cookies, which live in their real browser.
 *
 * `code_challenge_method` is hard-coded: authorize rejects anything but S256
 * (javis_mcp/oauth/authorize.py:29-32).
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: params.scope ?? OAUTH_SCOPE,
    state: params.state,
  });
  if (params.resource !== undefined) query.set('resource', params.resource);
  return `${normalizeBaseUrl(params.baseUrl)}/oauth/authorize?${query.toString()}`;
}

/** What the browser put on the loopback redirect. Every field may be absent. */
export interface CallbackQuery {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/**
 * Parse the query of the loopback request.
 *
 * Takes the raw `req.url`, which for a loopback request is path-relative
 * (`/callback?code=...&state=...`), hence the dummy base.
 */
export function parseCallbackQuery(rawUrl: string): CallbackQuery {
  let query: URLSearchParams;
  try {
    query = new URL(rawUrl, 'http://127.0.0.1').searchParams;
  } catch {
    query = new URLSearchParams();
  }
  return {
    code: query.get('code'),
    state: query.get('state'),
    error: query.get('error'),
    errorDescription: query.get('error_description'),
  };
}

/**
 * Turn a parsed callback into an authorization code, or throw.
 *
 * `state` is checked BEFORE anything else is trusted, and a mismatch is fatal.
 * The listener is bound to loopback but any local process can reach it, so this
 * comparison is the only thing standing between the flow and an attacker-chosen
 * code being exchanged with our verifier.
 */
export function validateCallback(query: CallbackQuery, expectedState: string): string {
  if (query.error) {
    // The user declined, or Clerk refused. §D step 6's sibling case: a decision,
    // not a fault. `access_denied` is also what /oauth/callback/finalize returns
    // when there is no `users` row yet (javis_mcp/oauth/callback.py:139-145).
    const detail = query.errorDescription ? `: ${query.errorDescription}` : '';
    throw new AuthCancelledError(`Authorization was refused (${query.error})${detail}`);
  }
  if (!query.state || query.state !== expectedState) {
    throw new ProtocolError(
      'OAuth state mismatch on the loopback callback — the response did not come from the ' +
        'sign-in this plugin started. Nothing was stored; try connecting again.',
    );
  }
  if (!query.code) {
    throw new ProtocolError('OAuth callback carried no authorization code.');
  }
  return query.code;
}

/**
 * The `exp` claim of a JWT access token, in epoch MILLISECONDS; null when the
 * token is not a decodable JWT.
 *
 * Reading expiry out of the token is what lets both secrets live in the keychain
 * with nothing in `data.json` (§D). A null here is not an error — the caller
 * simply uses the token and lets a 401 drive the refresh.
 */
export function decodeJwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  const json = base64UrlDecode(payload);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== 'object' || claims === null) return null;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * A JWT's payload claims, or null when the token is not a decodable JWT.
 * Signature is NOT checked: the server checks it; this only reads what the
 * token says it was granted, to decide whether to try an upload at all.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  const json = base64UrlDecode(payload);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The space-separated `scope` claim as a list; null when absent or undecodable. */
export function scopesFromJwt(token: string): string[] | null {
  const scope = decodeJwtClaims(token)?.['scope'];
  if (typeof scope !== 'string') return null;
  return scope.split(' ').filter((s) => s !== '');
}

/**
 * The resource the upload routes live under (§C.3): `<origin>/wiki`. For the
 * default origin that is `https://mcp.javis.is/wiki`.
 */
export function wikiResource(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/wiki`;
}

/**
 * The `aud` claim as a list (RFC 7519 §4.1.3 allows a string or an array);
 * null when absent or undecodable. Read for the same reason `scopesFromJwt`
 * is: to decide what to ask for, never to trust — the server checks it.
 */
export function audiencesFromJwt(token: string): string[] | null {
  const aud = decodeJwtClaims(token)?.['aud'];
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud) && aud.every((a): a is string => typeof a === 'string')) return aud;
  return null;
}

/** The server's comparison form (javis_mcp/resources.py `canonical`): one trailing `/` dropped. */
function canonicalResource(resource: string): string {
  return normalizeBaseUrl(resource);
}

/**
 * True when the token's audience is decodable and is NOT this origin's `/wiki`
 * resource: a grant minted before 0.2.0 (or by a 0.2.0 build that still sent
 * no `resource`), whose `aud` is the MCP resource. The server accepts that
 * audience on `/wiki/export` for one release only (§C.3), and never on the
 * upload routes, and a refresh can confirm a grant's audience but never switch
 * it (javis_mcp/oauth/token.py `_resource_param_matches`) — so only a new
 * authorization moves such a device. Undecodable → false: try it, and let the
 * server decide.
 */
export function isLegacyAudience(audiences: readonly string[] | null, baseUrl: string): boolean {
  if (audiences === null) return false;
  const wiki = canonicalResource(wikiResource(baseUrl));
  return !audiences.some((aud) => canonicalResource(aud) === wiki);
}

/**
 * True when the stored token visibly cannot write (plan D-RUN-3, widened): its
 * decodable `scope` lacks `wiki:write`, or its decodable `aud` is not the
 * `/wiki` resource. The second half matters because the upload routes accept
 * the `/wiki` audience only: a legacy-audience token fails authentication
 * there with a 401, not the 403 `insufficient_scope` the step-up listens
 * for, so without this check such a token reads as "expired even after a
 * refresh" and the step-up is never reached.
 */
export function lacksWriteGrant(
  scopes: readonly string[] | null,
  audiences: readonly string[] | null,
  baseUrl: string,
): boolean {
  if (scopes !== null && !scopes.includes(WIKI_WRITE_SCOPE)) return true;
  return isLegacyAudience(audiences, baseUrl);
}

/**
 * What `connect` should ask for (§C.3, §C.7).
 *
 * The `/wiki` resource ALWAYS: §C.3 says the plugin requests it, and the old
 * `/mcp` audience is accepted on `/wiki/export` for one release only, after
 * which a read-only device still holding an `/mcp` grant would stop syncing
 * with no code path in the plugin to move it (a refresh keeps the audience).
 * `mcp:read` alone is valid on the `/wiki` resource, and a server from before
 * the resource split ignores the parameter (§C.3 "it ignores it today"), so
 * sending it costs nothing. This departs from the plan's D-AUTH-1, which kept
 * read-only connects byte-identical to 0.1.x and deferred the resource to
 * 0.3.0; review found that leaves every read-only 0.2.0 install on the
 * audience the server has scheduled for removal.
 *
 * The union scope only once an upload folder is selected (§C.7): a user who
 * never uploads never sees a consent screen asking to store their notes.
 */
export function connectOptionsFor(baseUrl: string, uploads: boolean): ConnectOptions {
  return {
    resource: wikiResource(baseUrl),
    ...(uploads ? { scope: OAUTH_SCOPE_WRITE } : {}),
  };
}

/** Expired, or close enough to expiry that a request would race the clock. */
export function isExpired(expiresAt: number | null, now: number, skewMs = EXPIRY_SKEW_MS): boolean {
  if (expiresAt === null) return false; // unknown expiry: try it, refresh on 401
  return now >= expiresAt - skewMs;
}

// ---------------------------------------------------------------------------
// The loopback listener (§D step 2)
// ---------------------------------------------------------------------------

export interface LoopbackListener {
  /** OS-assigned unless a preferred port was both requested and available. */
  readonly port: number;
  /** `http://127.0.0.1:<port>/callback` — register and authorize with this exact string. */
  readonly redirectUri: string;
  /** Resolves with the authorization code, or rejects per {@link validateCallback}. */
  waitForCode(expectedState: string, timeoutMs?: number): Promise<string>;
  /** Idempotent. MUST be called in a `finally`, or the port stays bound. */
  close(): void;
}

const CALLBACK_PATH = '/callback';

function browserPage(title: string, body: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
    title +
    '</title><style>body{font-family:system-ui,sans-serif;padding:3rem;color:#333;' +
    'max-width:34rem;margin:0 auto}h1{font-size:1.25rem}</style></head><body><h1>' +
    title +
    '</h1><p>' +
    body +
    '</p></body></html>'
  );
}

/**
 * Bind an ephemeral loopback listener for the OAuth redirect.
 *
 * `127.0.0.1` rather than `localhost`: `_redirect_allowed` accepts both
 * (javis_mcp/oauth/registration.py:21), but `localhost` can resolve to `::1`
 * first on a dual-stack machine and then the browser reaches a port nothing is
 * listening on. The literal address removes that failure mode.
 *
 * `preferredPort` is tried first so a cached `client_id` — whose registered
 * `redirect_uri` embeds a port — can be reused. Any bind failure falls back to
 * port 0, and the caller then re-registers.
 */
export function startLoopbackListener(preferredPort?: number): Promise<LoopbackListener> {
  return new Promise<LoopbackListener>((resolve, reject) => {
    const server: Server = createServer();
    const sockets = new Set<Socket>();
    let closed = false;
    let listening = false;

    // The redirect is BUFFERED rather than validated on arrival, because
    // `waitForCode` (which supplies the expected `state`) may not have been
    // called yet — `connect()` awaits `openBrowser` first, and an opener that
    // resolves slowly must not cost us the callback. Validation therefore
    // happens in `waitForCode`, where the expected state definitely exists.
    let received: CallbackQuery | null = null;
    let deliver: ((query: CallbackQuery) => void) | null = null;
    let expectedState: string | null = null;

    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';
      const path = url.split('?')[0];
      // `Connection: close` on every reply so no keep-alive socket outlives
      // close() and leaves the port bound.
      if (path !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Not found');
        return;
      }
      const query = parseCallbackQuery(url);
      // The page the user is left looking at. Judged against the expected state
      // when we already have it, so a mismatched or refused callback does not
      // get to display "connected".
      let ok = query.error === null && query.code !== null;
      if (ok && expectedState !== null) ok = query.state === expectedState;
      if (ok) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(browserPage('Javis is connected', 'You can close this tab and go back to Obsidian.'));
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(
          browserPage(
            'Sign-in could not be completed',
            'Nothing was saved. Go back to Obsidian and try connecting again.',
          ),
        );
      }
      if (received !== null) return; // first redirect wins
      received = query;
      if (deliver) deliver(query);
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    };

    server.on('error', (error: unknown) => {
      if (listening) return; // a post-bind socket error is not a bind failure
      if (preferredPort !== undefined) {
        // The cached port is taken (another vault, or a stale process). Not
        // fatal — drop the cached registration and take whatever the OS gives.
        close();
        startLoopbackListener().then(resolve, reject);
        return;
      }
      close();
      reject(new NetworkError('Could not bind a loopback port for the Javis sign-in.', { cause: error }));
    });

    server.listen(preferredPort ?? 0, '127.0.0.1', () => {
      listening = true;
      const address = server.address();
      if (address === null || typeof address === 'string') {
        close();
        reject(new NetworkError('Loopback listener reported no port.'));
        return;
      }
      const port = (address as AddressInfo).port;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        waitForCode(state: string, timeoutMs = DEFAULT_AUTHORIZE_TIMEOUT_MS): Promise<string> {
          expectedState = state;
          return new Promise<string>((res, rej) => {
            const finish = (query: CallbackQuery): void => {
              clearTimeout(timer);
              try {
                res(validateCallback(query, state));
              } catch (error) {
                rej(error);
              }
            };
            const timer = setTimeout(() => {
              deliver = null;
              rej(
                new AuthCancelledError(
                  'Timed out waiting for the Javis sign-in to come back from the browser.',
                ),
              );
            }, timeoutMs);
            // Node keeps the process alive for a pending timer; irrelevant in
            // Electron but polite in tests.
            if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
              (timer as { unref(): void }).unref();
            }
            if (received !== null) finish(received);
            else deliver = finish;
          });
        },
        close,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// JavisOAuth
// ---------------------------------------------------------------------------

export interface JavisOAuthOptions {
  /** The javis-mcp origin. A function so a settings change is picked up live. */
  baseUrl: string | (() => string);
  secrets: SecretStore;
  http: HttpTransport;
  /** `settings.oauthClient` — non-secret, persisted in data.json. */
  getClient(): OAuthClientRegistration | null;
  setClient(client: OAuthClientRegistration | null): Promise<void>;
  /** Hands the authorize URL to the SYSTEM browser. */
  openBrowser?: BrowserOpener;
  /** Seam for tests; defaults to the real {@link startLoopbackListener}. */
  listen?: (preferredPort?: number) => Promise<LoopbackListener>;
  /** Seam for tests. */
  now?: () => number;
  authorizeTimeoutMs?: number;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
}

export class JavisOAuth implements JavisAuth {
  private readonly opts: JavisOAuthOptions;
  private readonly listeners = new Set<(status: AuthStatus) => void>();

  /**
   * Set once a refresh has been definitively rejected. Distinguishes "never
   * connected" (`AuthRequiredError`) from "connection died" (`AuthRevokedError`)
   * after both secrets have been cleared and the keychain looks identical.
   */
  private revoked = false;

  /** In-flight refresh, shared by concurrent callers so the token rotates once. */
  private refreshing: Promise<string> | null = null;

  /**
   * Bumped by every `disconnect()`. Read by `doRefresh` on both sides of the
   * `/oauth/token` round trip.
   *
   * A refresh is a rotation: the server mints a NEW refresh token and the old
   * one dies. `disconnect()` revokes whatever is in the keychain and clears it —
   * but if it lands while a refresh is in the air, it revokes the token the
   * server has already rotated out (`revoke.py` revokes one row and only when
   * `revoked_at is None`; it never calls `revoke_family`), and the refresh then
   * writes the freshly minted one back into the keychain the user just emptied.
   * The connection survives the Disconnect button, and the surviving token lives
   * for the full refresh-token TTL. The same race walks the previous origin's
   * tokens back in after the baseUrl guard (settings.ts) disconnected for them.
   *
   * A counter rather than `await this.refreshing` in `disconnect()`: that method
   * is contracted never to throw and must clear the keychain even offline, so it
   * cannot be made to wait on a network call that may hang or reject.
   */
  private generation = 0;

  constructor(options: JavisOAuthOptions) {
    this.opts = options;
  }

  // -- status ---------------------------------------------------------------

  status(): AuthStatus {
    if (this.revoked) return 'needs-reconnect';
    return this.readSecret(SECRET_REFRESH_TOKEN) ? 'connected' : 'disconnected';
  }

  isConnected(): boolean {
    return this.status() === 'connected';
  }

  onStatusChange(listener: (status: AuthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // A broken UI listener must not take down the auth flow.
      }
    }
  }

  // -- §D steps 1-5: connect ------------------------------------------------

  /**
   * The scopes the stored access token carries (plan D-AUTH-2). Read from the
   * token rather than persisted: the token already says, it is per-device as a
   * grant is, and a refresh keeps the granted scope (§C.7), so the claim stays
   * true across refreshes.
   */
  grantedScopes(): string[] | null {
    const access = this.readSecret(SECRET_ACCESS_TOKEN);
    return access ? scopesFromJwt(access) : null;
  }

  /** The stored access token's `aud`, as `grantedScopes` reads `scope`; null when unknown. */
  grantedAudiences(): string[] | null {
    const access = this.readSecret(SECRET_ACCESS_TOKEN);
    return access ? audiencesFromJwt(access) : null;
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    // Before binding a port or opening a browser: a refresh token (and, with
    // uploads on, a `wiki:write` grant) must never be minted over cleartext
    // to another machine (origin.ts, review).
    this.secureBaseUrl();
    const cached = this.opts.getClient();
    const cachedPort = cached ? portOf(cached.redirectUri) : undefined;
    const listen = this.opts.listen ?? startLoopbackListener;

    // Bind FIRST. The redirect_uri we are about to register has to contain the
    // port we actually hold, because authorize compares it by exact string.
    const listener = await listen(cachedPort);
    try {
      // Reuse the cached registration only if we re-bound its exact URI; any
      // other port makes the cached client_id useless (invalid_redirect_uri).
      const client =
        cached && cached.redirectUri === listener.redirectUri
          ? cached
          : await this.register(listener.redirectUri);

      const { verifier, challenge } = await generatePkce();
      const state = randomToken();

      const url = buildAuthorizeUrl({
        baseUrl: this.secureBaseUrl(),
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        codeChallenge: challenge,
        state,
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.resource === undefined ? {} : { resource: options.resource }),
      });
      await this.openBrowser(url);

      const code = await listener.waitForCode(
        state,
        this.opts.authorizeTimeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS,
      );

      const tokens = await this.exchangeCode({
        code,
        verifier,
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        resource: options.resource,
      });

      // Persist the registration only once it has demonstrably produced tokens,
      // so a half-finished attempt never leaves a client_id pointing at a port
      // we no longer hold.
      if (!cached || cached.clientId !== client.clientId || cached.redirectUri !== client.redirectUri) {
        await this.opts.setClient(client);
      }
      this.storeTokens(tokens);
      this.revoked = false;
      this.emit();
    } finally {
      // Never leave a port bound — on success, on rejection, on timeout.
      listener.close();
    }
  }

  private async openBrowser(url: string): Promise<void> {
    if (this.opts.openBrowser) {
      await this.opts.openBrowser(url);
      return;
    }
    const open = (globalThis as { open?: (u: string, t?: string) => unknown }).open;
    if (typeof open !== 'function') {
      throw new NetworkError('No way to open the system browser for the Javis sign-in.');
    }
    open(url, '_blank');
  }

  /** §D step 1 — dynamic client registration. */
  private async register(redirectUri: string): Promise<OAuthClientRegistration> {
    const body = await this.postJson('/oauth/register', {
      redirect_uris: [redirectUri],
      client_name: CLIENT_NAME,
    });
    const clientId = body['client_id'];
    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new ProtocolError('Client registration returned no client_id.');
    }
    return { clientId, redirectUri };
  }

  /** §D step 4 — authorization-code grant. */
  private async exchangeCode(args: {
    code: string;
    verifier: string;
    clientId: string;
    redirectUri: string;
    /** RFC 8707 §2.2: the same resource again on the code exchange. */
    resource?: string;
  }): Promise<TokenResponse> {
    const body = await this.postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      ...(args.resource === undefined ? {} : { resource: args.resource }),
    });
    return readTokens(body);
  }

  // -- §D step 6: tokens and refresh ---------------------------------------

  async getAccessToken(): Promise<string> {
    const access = this.readSecret(SECRET_ACCESS_TOKEN);
    if (access && !isExpired(decodeJwtExpiry(access), this.now())) return access;
    return this.refresh();
  }

  refresh(): Promise<string> {
    // Single-flight. Two concurrent refreshes would present the same refresh
    // token twice, and `rotate_token` reads a reused token as a breach and
    // revokes the whole family (javis_mcp/oauth/store.py:95-98).
    if (this.refreshing) return this.refreshing;
    const run = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }

  private async doRefresh(): Promise<string> {
    const generation = this.generation;
    // Snapshotted, not re-read: `baseUrl` is a live function of the settings,
    // and the origin that issues a token is the only one allowed to be shown it.
    // Also the https check (origin.ts, review): the refresh token is never
    // presented over cleartext to another machine. A plain Error, not an
    // auth error, so the stored sign-in survives until the URL is fixed.
    const origin = this.secureBaseUrl();
    const refreshToken = this.readSecret(SECRET_REFRESH_TOKEN);
    const client = this.opts.getClient();

    if (!refreshToken || !client) {
      // Nothing to refresh with. Which sentence the UI shows depends on whether
      // we got here by never connecting or by being kicked out.
      if (this.revoked) {
        throw new AuthRevokedError('The Javis connection expired. Reconnect in settings.');
      }
      throw new AuthRequiredError('Connect your Javis account in the plugin settings.');
    }

    let body: Record<string, unknown>;
    try {
      body = await this.postForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.clientId,
      });
    } catch (error) {
      if (error instanceof HttpError && isInvalidGrant(error)) {
        // A disconnect that landed mid-flight is the likeliest reason the token
        // we presented is now invalid — it revoked it. Saying "needs-reconnect"
        // for that would put a scary state on a button the user chose.
        if (this.generation !== generation) {
          throw new AuthRequiredError('Connect your Javis account in the plugin settings.');
        }
        // Terminal: the token was revoked, rotated out from under us, or aged
        // past its 30-day TTL. §D step 6 — clear, notify, STOP. Retrying cannot
        // help; the presented token is dead by construction.
        this.clearSecrets();
        this.revoked = true;
        this.emit();
        throw new AuthRevokedError(
          'Javis rejected the saved sign-in. Reconnect in the plugin settings.',
          { cause: error },
        );
      }
      // NetworkError, 5xx, 429 — transient. Secrets stay exactly where they are:
      // a laptop on a train is not a revocation.
      throw error;
    }

    const tokens = readTokens(body);

    // The user disconnected while this request was in the air. `disconnect()`
    // already revoked the token we PRESENTED and emptied the keychain; the
    // server has since rotated that token into the one we are holding, and
    // storing it would undo the disconnect. So put it back instead, and fail
    // the caller the way an unconnected plugin fails.
    if (this.generation !== generation) {
      await this.revokeToken(tokens.refreshToken, origin);
      throw new AuthRequiredError('Connect your Javis account in the plugin settings.');
    }

    this.storeTokens(tokens);
    this.revoked = false;
    this.emit();
    return tokens.accessToken;
  }

  async disconnect(): Promise<void> {
    // FIRST, and before any await: a refresh already in the air must not be
    // allowed to store the token the server is minting for it. See `generation`.
    this.generation += 1;

    const refreshToken = this.readSecret(SECRET_REFRESH_TOKEN);
    this.clearSecrets();
    this.revoked = false;
    try {
      await this.opts.setClient(null);
    } catch {
      // Settings write failed; the tokens are gone either way, which is what
      // "disconnect" has to guarantee. Contract says this never throws.
    }
    if (refreshToken) await this.revokeToken(refreshToken, this.baseUrl());
    this.emit();
  }

  /**
   * Best effort `/oauth/revoke`. Never throws.
   *
   * `revoke.py` marks one stored refresh row revoked and answers 200 regardless,
   * so a token this fails to reach simply lives out its TTL — which is why an
   * offline disconnect still clears the keychain and returns.
   */
  private async revokeToken(token: string, origin: string): Promise<void> {
    try {
      // Revoking over cleartext would hand the token to anyone on the path;
      // an insecure origin just lets it live out its TTL (origin.ts, review).
      secureOrigin(origin);
    } catch {
      return;
    }
    try {
      await this.opts.http({
        url: `${origin}/oauth/revoke`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch {
      // Offline disconnect still has to clear the keychain.
    }
  }

  // -- plumbing -------------------------------------------------------------

  private baseUrl(): string {
    const raw = typeof this.opts.baseUrl === 'function' ? this.opts.baseUrl() : this.opts.baseUrl;
    return normalizeBaseUrl(raw);
  }

  /** `baseUrl()`, refused unless https or loopback http (origin.ts). Throws. */
  private secureBaseUrl(): string {
    return secureOrigin(this.baseUrl());
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private readSecret(id: string): string | null {
    try {
      return this.opts.secrets.get(id) || null;
    } catch {
      // A locked or unavailable keychain reads as "not connected" rather than
      // crashing the sync run.
      return null;
    }
  }

  /**
   * Refresh token FIRST.
   *
   * If the process dies between the two writes, a stored refresh token with a
   * stale access token recovers on the next call (one refresh). The reverse
   * order would leave a usable access token with no way to renew it, and the
   * old refresh token is already dead server-side.
   */
  private storeTokens(tokens: TokenResponse): void {
    this.opts.secrets.set(SECRET_REFRESH_TOKEN, tokens.refreshToken);
    this.opts.secrets.set(SECRET_ACCESS_TOKEN, tokens.accessToken);
  }

  private clearSecrets(): void {
    for (const id of [SECRET_ACCESS_TOKEN, SECRET_REFRESH_TOKEN]) {
      try {
        this.opts.secrets.delete(id);
      } catch {
        // Nothing useful to do; the next refresh fails closed.
      }
    }
  }

  private async postJson(path: string, payload: unknown): Promise<Record<string, unknown>> {
    return this.send({
      url: `${this.secureBaseUrl()}${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  private async postForm(
    path: string,
    fields: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    // application/x-www-form-urlencoded, not JSON: the token endpoint reads
    // `await request.form()` (javis_mcp/oauth/token.py:30).
    return this.send({
      url: `${this.secureBaseUrl()}${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  private async send(req: HttpRequestInit): Promise<Record<string, unknown>> {
    let response: HttpResponseLike;
    try {
      response = await this.opts.http(req);
    } catch (error) {
      throw new NetworkError(`Could not reach ${req.url}.`, { cause: error });
    }

    if (response.status === 429) {
      // /oauth/register is 10/min per IP, /oauth/token 60/min per client_id.
      throw new RateLimitedError(null, 'Javis rate-limited the sign-in. Try again shortly.');
    }
    if (response.status >= 400) {
      throw new HttpError(response.status, response.text ?? '');
    }

    const parsed = parseJsonObject(response.text);
    if (parsed === null) {
      throw new ProtocolError(`${req.url} answered ${response.status} with a body that is not JSON.`);
    }
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// Module-private pure helpers
// ---------------------------------------------------------------------------

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Both token grants answer `{"error": "invalid_grant"}` with status 400
 * (javis_mcp/oauth/token.py:21-22, 64, 117). That is the one error meaning "this
 * credential is dead" as opposed to "try again later".
 *
 * `invalid_client` counts too: it means the cached `client_id` is unknown or
 * malformed (token.py:56, 109), which also needs a fresh registration and so a
 * fresh sign-in. `invalid_request` deliberately does NOT — that one means we
 * sent a malformed body, which is our bug, and destroying the user's tokens over
 * it would turn a code defect into a forced re-authentication.
 */
export function isInvalidGrant(error: HttpError): boolean {
  if (error.status !== 400 && error.status !== 401) return false;
  const code = parseJsonObject(error.body)?.['error'];
  return code === 'invalid_grant' || code === 'invalid_client';
}

function readTokens(body: Record<string, unknown>): TokenResponse {
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ProtocolError('Token response carried no access_token.');
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    // Not optional here: the server rotates and always returns one
    // (javis_mcp/oauth/token.py:96, 139). Missing it would silently strand the
    // plugin one hour from now with no way to renew.
    throw new ProtocolError('Token response carried no refresh_token.');
  }
  return { accessToken, refreshToken };
}

/** The port out of a stored `http://127.0.0.1:<port>/callback`, if it parses. */
export function portOf(redirectUri: string): number | undefined {
  try {
    const port = Number(new URL(redirectUri).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}
