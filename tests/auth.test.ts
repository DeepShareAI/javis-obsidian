/**
 * Tests for the pure half of src/shell/auth.ts, plus the two behaviours whose
 * failure modes are expensive and which are testable without a network: the
 * loopback listener (bound on 127.0.0.1, driven with a local request) and the
 * token/refresh state machine (driven through the injected `HttpTransport`).
 *
 * Nothing here talks to javis-mcp, and nothing here imports `obsidian`.
 */

import { describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';

import {
  base64UrlDecode,
  base64UrlEncode,
  buildAuthorizeUrl,
  CLIENT_NAME,
  decodeJwtExpiry,
  deriveChallenge,
  generatePkce,
  isExpired,
  isInvalidGrant,
  JavisOAuth,
  normalizeBaseUrl,
  OAUTH_SCOPE,
  OAUTH_SCOPE_WRITE,
  decodeJwtClaims,
  scopesFromJwt,
  wikiResource,
  audiencesFromJwt,
  connectOptionsFor,
  isLegacyAudience,
  lacksWriteGrant,
  parseCallbackQuery,
  portOf,
  randomToken,
  startLoopbackListener,
  validateCallback,
  type HttpRequestInit,
  type HttpResponseLike,
  type HttpTransport,
  type LoopbackListener,
} from '../src/shell/auth';
import { SECRET_ACCESS_TOKEN, SECRET_REFRESH_TOKEN } from '../src/shell/contracts';
import type { OAuthClientRegistration, SecretStore } from '../src/shell/contracts';
import {
  AuthCancelledError,
  AuthRequiredError,
  AuthRevokedError,
  HttpError,
  NetworkError,
  ProtocolError,
  RateLimitedError,
} from '../src/shell/errors';

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe('base64url', () => {
  it('is unpadded and uses the URL alphabet', () => {
    // 0xFB 0xFF encodes to "+/8=" in standard base64.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('round-trips through the decoder', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const decoded = base64UrlDecode(base64UrlEncode(bytes));
    expect(decoded).not.toBeNull();
    expect([...(decoded as string)].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
  });

  it('returns null rather than throwing on garbage', () => {
    expect(base64UrlDecode('!!!!')).toBeNull();
  });
});

describe('deriveChallenge', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    // The same vector the server's make_challenge satisfies
    // (javis_mcp/oauth/pkce.py: sha256 -> urlsafe b64 -> strip '=').
    await expect(deriveChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('never emits padding or non-URL-safe characters', async () => {
    for (let i = 0; i < 16; i += 1) {
      const challenge = await deriveChallenge(randomToken());
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    }
  });
});

describe('generatePkce', () => {
  it('produces a verifier inside the 43..128 window verify_s256 enforces', async () => {
    const { verifier } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('derives the challenge from its own verifier', async () => {
    const { verifier, challenge } = await generatePkce();
    await expect(deriveChallenge(verifier)).resolves.toBe(challenge);
  });

  it('is fresh on every call', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  const params = {
    baseUrl: 'https://mcp.javis.is',
    clientId: '6f1e2d3c-0000-4000-8000-000000000001',
    redirectUri: 'http://127.0.0.1:51234/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    state: 'st4te',
  };

  it('sends exactly what /oauth/authorize reads', () => {
    const url = new URL(buildAuthorizeUrl(params));
    expect(url.origin + url.pathname).toBe('https://mcp.javis.is/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(params.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(params.redirectUri);
    expect(url.searchParams.get('code_challenge')).toBe(params.codeChallenge);
    // authorize.py:29-32 rejects anything else outright.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPE);
  });

  it('percent-encodes the redirect_uri rather than splitting the query', () => {
    const raw = buildAuthorizeUrl(params);
    expect(raw).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback');
  });

  it('tolerates a base URL with a trailing slash', () => {
    expect(buildAuthorizeUrl({ ...params, baseUrl: 'https://mcp.javis.is///' })).toContain(
      'https://mcp.javis.is/oauth/authorize?',
    );
  });

  it('defaults the scope to the only one the server mints', () => {
    expect(OAUTH_SCOPE).toBe('mcp:read');
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and surrounding space', () => {
    expect(normalizeBaseUrl('  https://mcp.javis.is/  ')).toBe('https://mcp.javis.is');
    expect(normalizeBaseUrl('http://localhost:8100')).toBe('http://localhost:8100');
  });
});

// ---------------------------------------------------------------------------
// Callback parsing and state validation
// ---------------------------------------------------------------------------

describe('parseCallbackQuery', () => {
  it('reads a path-relative loopback request URL', () => {
    expect(parseCallbackQuery('/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
      error: null,
      errorDescription: null,
    });
  });

  it('reads the error form', () => {
    expect(parseCallbackQuery('/callback?error=access_denied&error_description=nope')).toEqual({
      code: null,
      state: null,
      error: 'access_denied',
      errorDescription: 'nope',
    });
  });

  it('percent-decodes values', () => {
    expect(parseCallbackQuery('/callback?code=a%2Fb%2Bc&state=s').code).toBe('a/b+c');
  });

  it('returns all-null for a bare path', () => {
    expect(parseCallbackQuery('/callback')).toEqual({
      code: null,
      state: null,
      error: null,
      errorDescription: null,
    });
  });
});

describe('validateCallback', () => {
  const ok = { code: 'the-code', state: 'expected', error: null, errorDescription: null };

  it('returns the code when the state matches', () => {
    expect(validateCallback(ok, 'expected')).toBe('the-code');
  });

  it('rejects a mismatched state even though a code is present', () => {
    expect(() => validateCallback({ ...ok, state: 'attacker' }, 'expected')).toThrow(ProtocolError);
  });

  it('rejects a missing state', () => {
    expect(() => validateCallback({ ...ok, state: null }, 'expected')).toThrow(ProtocolError);
  });

  it('rejects an empty expected state, so an uninitialised flow cannot pass', () => {
    expect(() => validateCallback({ ...ok, state: '' }, '')).toThrow(ProtocolError);
  });

  it('reports an OAuth error as cancellation, not as a protocol fault', () => {
    expect(() =>
      validateCallback(
        { code: null, state: 'expected', error: 'access_denied', errorDescription: 'no account' },
        'expected',
      ),
    ).toThrow(AuthCancelledError);
  });

  it('checks the error before the state, so a refusal is never mislabelled', () => {
    expect(() =>
      validateCallback(
        { code: null, state: null, error: 'access_denied', errorDescription: null },
        'expected',
      ),
    ).toThrow(AuthCancelledError);
  });

  it('rejects a state-matching callback that carries no code', () => {
    expect(() => validateCallback({ ...ok, code: null }, 'expected')).toThrow(ProtocolError);
  });
});

// ---------------------------------------------------------------------------
// Access-token expiry
// ---------------------------------------------------------------------------

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown): string =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`;
}

describe('decodeJwtExpiry', () => {
  it('reads exp and converts seconds to milliseconds', () => {
    expect(decodeJwtExpiry(jwt({ sub: 'user_1', exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it('returns null for a token without exp', () => {
    expect(decodeJwtExpiry(jwt({ sub: 'user_1' }))).toBeNull();
  });

  it('returns null for an opaque, non-JWT token', () => {
    expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiry('')).toBeNull();
  });

  it('returns null rather than throwing on an undecodable payload', () => {
    expect(decodeJwtExpiry('aaa.@@@@.ccc')).toBeNull();
    expect(decodeJwtExpiry(`aaa.${base64UrlEncode(new TextEncoder().encode('{'))}.ccc`)).toBeNull();
  });
});

describe('isExpired', () => {
  const now = 1_000_000_000_000;

  it('is false well before expiry', () => {
    expect(isExpired(now + 600_000, now)).toBe(false);
  });

  it('is true inside the skew window, before the wall-clock expiry', () => {
    expect(isExpired(now + 30_000, now)).toBe(true);
  });

  it('is true after expiry', () => {
    expect(isExpired(now - 1, now)).toBe(true);
  });

  it('treats an unknown expiry as usable — the 401 path handles it', () => {
    expect(isExpired(null, now)).toBe(false);
  });
});

describe('isInvalidGrant', () => {
  it('is true for the dead-credential errors', () => {
    expect(isInvalidGrant(new HttpError(400, '{"error":"invalid_grant"}'))).toBe(true);
    expect(isInvalidGrant(new HttpError(400, '{"error":"invalid_client"}'))).toBe(true);
  });

  it('is false for invalid_request — our bug must not wipe the user tokens', () => {
    expect(isInvalidGrant(new HttpError(400, '{"error":"invalid_request"}'))).toBe(false);
  });

  it('is false for a 5xx and for a non-JSON body', () => {
    expect(isInvalidGrant(new HttpError(500, '{"error":"invalid_grant"}'))).toBe(false);
    expect(isInvalidGrant(new HttpError(400, '<html>gateway</html>'))).toBe(false);
  });
});

describe('portOf', () => {
  it('reads the port out of a registered redirect URI', () => {
    expect(portOf('http://127.0.0.1:51234/callback')).toBe(51234);
  });

  it('is undefined when there is no explicit port or the URI is junk', () => {
    expect(portOf('http://127.0.0.1/callback')).toBeUndefined();
    expect(portOf('nonsense')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The loopback listener
// ---------------------------------------------------------------------------

function hit(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startLoopbackListener', () => {
  it('binds 127.0.0.1 on an ephemeral port and reports a matching redirect URI', async () => {
    const listener = await startLoopbackListener();
    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.redirectUri).toBe(`http://127.0.0.1:${listener.port}/callback`);
    } finally {
      listener.close();
    }
  });

  it('resolves the code when the state matches, and shows a success page', async () => {
    const listener = await startLoopbackListener();
    try {
      const pending = listener.waitForCode('s-good', 5000);
      const response = await hit(listener.port, '/callback?code=code-1&state=s-good');
      expect(response.status).toBe(200);
      expect(response.body).toContain('Javis is connected');
      await expect(pending).resolves.toBe('code-1');
    } finally {
      listener.close();
    }
  });

  it('rejects a mismatched state and does not tell the browser it worked', async () => {
    const listener = await startLoopbackListener();
    try {
      // The assertion is attached before the request goes out: the handler
      // rejects synchronously inside the server callback.
      const pending = expect(listener.waitForCode('s-good', 5000)).rejects.toBeInstanceOf(
        ProtocolError,
      );
      const response = await hit(listener.port, '/callback?code=code-1&state=s-evil');
      expect(response.status).toBe(400);
      expect(response.body).not.toContain('Javis is connected');
      await pending;
    } finally {
      listener.close();
    }
  });

  it('surfaces an OAuth error as cancellation', async () => {
    const listener = await startLoopbackListener();
    try {
      const pending = expect(listener.waitForCode('s', 5000)).rejects.toBeInstanceOf(
        AuthCancelledError,
      );
      await hit(listener.port, '/callback?error=access_denied&state=s');
      await pending;
    } finally {
      listener.close();
    }
  });

  it('buffers a redirect that arrives before waitForCode is called', async () => {
    const listener = await startLoopbackListener();
    try {
      await hit(listener.port, '/callback?code=early&state=s');
      await expect(listener.waitForCode('s', 5000)).resolves.toBe('early');
    } finally {
      listener.close();
    }
  });

  it('404s any path other than /callback', async () => {
    const listener = await startLoopbackListener();
    try {
      expect((await hit(listener.port, '/')).status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it('times out as cancellation', async () => {
    const listener = await startLoopbackListener();
    try {
      await expect(listener.waitForCode('s', 20)).rejects.toBeInstanceOf(AuthCancelledError);
    } finally {
      listener.close();
    }
  });

  it('releases the port on close, so a reconnect can rebind it', async () => {
    const first = await startLoopbackListener();
    const port = first.port;
    first.close();
    // Give the event loop a tick to actually unbind.
    await new Promise((r) => setTimeout(r, 25));
    const second = await startLoopbackListener(port);
    try {
      expect(second.port).toBe(port);
    } finally {
      second.close();
    }
  });

  it('close() is idempotent', async () => {
    const listener = await startLoopbackListener();
    listener.close();
    expect(() => listener.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// JavisOAuth — the token state machine, driven through the injected transport
// ---------------------------------------------------------------------------

class FakeSecrets implements SecretStore {
  readonly values = new Map<string, string>();
  get(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  set(id: string, secret: string): void {
    this.values.set(id, secret);
  }
  delete(id: string): void {
    this.values.delete(id);
  }
}

const NOW = 1_700_000_000_000;
const liveJwt = jwt({ sub: 'user_1', exp: Math.floor(NOW / 1000) + 3600 });
const deadJwt = jwt({ sub: 'user_1', exp: Math.floor(NOW / 1000) - 10 });

interface Harness {
  auth: JavisOAuth;
  secrets: FakeSecrets;
  calls: HttpRequestInit[];
  client: { value: OAuthClientRegistration | null };
  setClient: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
  listener: LoopbackListener & { closed: boolean };
}

function harness(
  respond: (req: HttpRequestInit, call: number) => HttpResponseLike | Promise<HttpResponseLike>,
  opts: {
    client?: OAuthClientRegistration | null;
    secrets?: Record<string, string>;
    waitForCode?: () => Promise<string>;
  } = {},
): Harness {
  const calls: HttpRequestInit[] = [];
  const http: HttpTransport = async (req) => {
    calls.push(req);
    return respond(req, calls.length);
  };
  const secrets = new FakeSecrets();
  for (const [k, v] of Object.entries(opts.secrets ?? {})) secrets.set(k, v);
  const client = { value: opts.client ?? null };
  const setClient = vi.fn(async (next: OAuthClientRegistration | null) => {
    client.value = next;
  });
  const openBrowser = vi.fn();
  const listener = {
    port: 51234,
    redirectUri: 'http://127.0.0.1:51234/callback',
    closed: false,
    waitForCode: opts.waitForCode ?? (async () => 'the-code'),
    close() {
      this.closed = true;
    },
  };
  const auth = new JavisOAuth({
    baseUrl: 'https://mcp.javis.is/',
    secrets,
    http,
    getClient: () => client.value,
    setClient,
    openBrowser,
    listen: async () => listener,
    now: () => NOW,
  });
  return { auth, secrets, calls, client, setClient, openBrowser, listener };
}

const tokenBody = (access: string, refresh: string): HttpResponseLike => ({
  status: 200,
  text: JSON.stringify({
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope: 'mcp:read',
  }),
});

describe('JavisOAuth.status', () => {
  it('is disconnected with an empty keychain', () => {
    expect(harness(() => ({ status: 200, text: '{}' })).auth.status()).toBe('disconnected');
  });

  it('is connected when a refresh token is stored', () => {
    const h = harness(() => ({ status: 200, text: '{}' }), {
      secrets: { [SECRET_REFRESH_TOKEN]: 'r1' },
    });
    expect(h.auth.status()).toBe('connected');
    expect(h.auth.isConnected()).toBe(true);
  });
});

describe('JavisOAuth.connect', () => {
  it('registers with the loopback URI it actually bound, then exchanges the code', async () => {
    const h = harness((req, n) => {
      if (n === 1) return { status: 201, text: JSON.stringify({ client_id: 'cid-1' }) };
      return tokenBody(liveJwt, 'refresh-1');
    });

    await h.auth.connect();

    // Registration: the redirect_uri must be the one the listener holds, because
    // /oauth/authorize matches it by exact string.
    const register = h.calls[0]!;
    expect(register.url).toBe('https://mcp.javis.is/oauth/register');
    expect(JSON.parse(register.body!)).toEqual({
      redirect_uris: ['http://127.0.0.1:51234/callback'],
      client_name: CLIENT_NAME,
    });

    // Code exchange: form-encoded, because token.py reads `await request.form()`.
    const exchange = h.calls[1]!;
    expect(exchange.url).toBe('https://mcp.javis.is/oauth/token');
    expect(exchange.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(exchange.body!);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('client_id')).toBe('cid-1');
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9\-_]{43}$/);

    // The verifier sent must be the one behind the challenge in the browser URL.
    const authorizeUrl = new URL(h.openBrowser.mock.calls[0]![0] as string);
    await expect(deriveChallenge(form.get('code_verifier')!)).resolves.toBe(
      authorizeUrl.searchParams.get('code_challenge'),
    );

    expect(h.secrets.get(SECRET_ACCESS_TOKEN)).toBe(liveJwt);
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBe('refresh-1');
    expect(h.client.value).toEqual({ clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' });
    expect(h.listener.closed).toBe(true);
    expect(h.auth.status()).toBe('connected');
  });

  it('reuses a cached client_id only when the same port came back', async () => {
    const cached = { clientId: 'cid-cached', redirectUri: 'http://127.0.0.1:51234/callback' };
    const h = harness(() => tokenBody(liveJwt, 'refresh-1'), { client: cached });

    await h.auth.connect();

    expect(h.calls).toHaveLength(1); // no /oauth/register
    expect(h.calls[0]!.url).toBe('https://mcp.javis.is/oauth/token');
    expect(new URLSearchParams(h.calls[0]!.body!).get('client_id')).toBe('cid-cached');
    expect(h.setClient).not.toHaveBeenCalled();
  });

  it('re-registers when the cached registration names a different port', async () => {
    const stale = { clientId: 'cid-stale', redirectUri: 'http://127.0.0.1:40000/callback' };
    const h = harness((_req, n) => {
      if (n === 1) return { status: 201, text: JSON.stringify({ client_id: 'cid-new' }) };
      return tokenBody(liveJwt, 'refresh-1');
    }, { client: stale });

    await h.auth.connect();

    expect(h.calls[0]!.url).toBe('https://mcp.javis.is/oauth/register');
    expect(h.client.value).toEqual({
      clientId: 'cid-new',
      redirectUri: 'http://127.0.0.1:51234/callback',
    });
  });

  it('closes the listener and stores nothing when the user abandons the browser', async () => {
    const h = harness((_req, n) => {
      if (n === 1) return { status: 201, text: JSON.stringify({ client_id: 'cid-1' }) };
      return tokenBody(liveJwt, 'refresh-1');
    }, {
      waitForCode: async () => {
        throw new AuthCancelledError('timed out');
      },
    });

    await expect(h.auth.connect()).rejects.toBeInstanceOf(AuthCancelledError);
    expect(h.listener.closed).toBe(true);
    expect(h.secrets.values.size).toBe(0);
    expect(h.setClient).not.toHaveBeenCalled();
  });

  it('rejects a registration response with no client_id', async () => {
    const h = harness(() => ({ status: 201, text: '{"redirect_uris":[]}' }));
    await expect(h.auth.connect()).rejects.toBeInstanceOf(ProtocolError);
    expect(h.listener.closed).toBe(true);
  });

  it('maps the registration rate limit to RateLimitedError', async () => {
    const h = harness(() => ({ status: 429, text: '{"error":"rate_limited"}' }));
    await expect(h.auth.connect()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('maps a transport failure to NetworkError, not to an auth failure', async () => {
    const h = harness(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(h.auth.connect()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('JavisOAuth.getAccessToken', () => {
  it('returns a stored token that is not near expiry, without a request', async () => {
    const h = harness(() => ({ status: 500, text: 'should not be called' }), {
      secrets: { [SECRET_ACCESS_TOKEN]: liveJwt, [SECRET_REFRESH_TOKEN]: 'r1' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });
    await expect(h.auth.getAccessToken()).resolves.toBe(liveJwt);
    expect(h.calls).toHaveLength(0);
  });

  it('refreshes an expired token and persists the ROTATED refresh token', async () => {
    const fresh = jwt({ sub: 'user_1', exp: Math.floor(NOW / 1000) + 3600 });
    const h = harness(() => tokenBody(fresh, 'refresh-2'), {
      secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-1' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });

    await expect(h.auth.getAccessToken()).resolves.toBe(fresh);

    const form = new URLSearchParams(h.calls[0]!.body!);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-1');
    expect(form.get('client_id')).toBe('cid-1');
    // The old refresh token is dead the moment the new one is issued
    // (store.rotate_token), so it must not survive in the keychain.
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBe('refresh-2');
    expect(h.secrets.get(SECRET_ACCESS_TOKEN)).toBe(fresh);
  });

  it('uses a token of unknown expiry rather than refreshing pre-emptively', async () => {
    const h = harness(() => ({ status: 500, text: 'should not be called' }), {
      secrets: { [SECRET_ACCESS_TOKEN]: 'opaque-token', [SECRET_REFRESH_TOKEN]: 'r1' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });
    await expect(h.auth.getAccessToken()).resolves.toBe('opaque-token');
    expect(h.calls).toHaveLength(0);
  });

  it('is AuthRequiredError when nothing was ever stored', async () => {
    const h = harness(() => ({ status: 200, text: '{}' }));
    await expect(h.auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(h.calls).toHaveLength(0);
  });
});

describe('JavisOAuth.refresh', () => {
  const connected = {
    secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-1' },
    client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
  };

  it('clears both secrets and reports AuthRevokedError on invalid_grant', async () => {
    const h = harness(() => ({ status: 400, text: '{"error":"invalid_grant"}' }), connected);
    const seen: string[] = [];
    h.auth.onStatusChange((s) => seen.push(s));

    await expect(h.auth.refresh()).rejects.toBeInstanceOf(AuthRevokedError);

    expect(h.secrets.get(SECRET_ACCESS_TOKEN)).toBeNull();
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBeNull();
    expect(h.auth.status()).toBe('needs-reconnect');
    expect(seen).toContain('needs-reconnect');
  });

  it('stays AuthRevokedError on a second call, rather than reverting to "never connected"', async () => {
    const h = harness(() => ({ status: 400, text: '{"error":"invalid_grant"}' }), connected);
    await expect(h.auth.refresh()).rejects.toBeInstanceOf(AuthRevokedError);
    await expect(h.auth.refresh()).rejects.toBeInstanceOf(AuthRevokedError);
    expect(h.calls).toHaveLength(1); // the second call never reached the network
  });

  it('keeps the tokens when the network is down — a train is not a revocation', async () => {
    const h = harness(() => {
      throw new Error('offline');
    }, connected);

    await expect(h.auth.refresh()).rejects.toBeInstanceOf(NetworkError);
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBe('refresh-1');
    expect(h.auth.status()).toBe('connected');
  });

  it('keeps the tokens on a 5xx', async () => {
    const h = harness(() => ({ status: 503, text: 'upstream down' }), connected);
    await expect(h.auth.refresh()).rejects.toBeInstanceOf(HttpError);
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBe('refresh-1');
  });

  it('keeps the tokens on a 429', async () => {
    const h = harness(() => ({ status: 429, text: '{"error":"rate_limited"}' }), connected);
    await expect(h.auth.refresh()).rejects.toBeInstanceOf(RateLimitedError);
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBe('refresh-1');
  });

  it('rejects a token response with no refresh_token instead of stranding the plugin', async () => {
    const h = harness(
      () => ({ status: 200, text: JSON.stringify({ access_token: liveJwt, expires_in: 3600 }) }),
      connected,
    );
    await expect(h.auth.refresh()).rejects.toBeInstanceOf(ProtocolError);
    expect(h.secrets.get(SECRET_REFRESH_TOKEN)).toBe('refresh-1');
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness(async () => {
      await gate;
      return tokenBody(liveJwt, 'refresh-2');
    }, connected);

    const a = h.auth.refresh();
    const b = h.auth.refresh();
    release!();
    await Promise.all([a, b]);

    // Two presentations of the same refresh token would make rotate_token treat
    // it as a replay and revoke the whole family.
    expect(h.calls).toHaveLength(1);
  });
});

describe('JavisOAuth.disconnect', () => {
  it('clears the keychain and the registration, and best-effort revokes', async () => {
    const h = harness(() => ({ status: 200, text: '' }), {
      secrets: { [SECRET_ACCESS_TOKEN]: liveJwt, [SECRET_REFRESH_TOKEN]: 'refresh-1' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });

    await h.auth.disconnect();

    expect(h.secrets.values.size).toBe(0);
    expect(h.client.value).toBeNull();
    expect(h.auth.status()).toBe('disconnected');
    const revoke = h.calls[0]!;
    expect(revoke.url).toBe('https://mcp.javis.is/oauth/revoke');
    expect(new URLSearchParams(revoke.body!).get('token')).toBe('refresh-1');
  });

  it('never throws when the server is unreachable', async () => {
    const h = harness(() => {
      throw new Error('offline');
    }, { secrets: { [SECRET_REFRESH_TOKEN]: 'refresh-1' } });

    await expect(h.auth.disconnect()).resolves.toBeUndefined();
    expect(h.secrets.values.size).toBe(0);
  });

  it('beats an in-flight refresh instead of letting it re-arm the keychain', async () => {
    // The refresh token ROTATES: by the time /oauth/token answers, the token
    // `disconnect()` revoked is already dead and the reply carries a live
    // replacement. Storing it would put the user back online one beat after
    // they signed out, for the whole refresh-token TTL — `revoke.py` revokes a
    // single row and never the family, so the old revocation does not cover it.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness(
      async (req) => {
        if (req.url.endsWith('/oauth/revoke')) return { status: 200, text: '' };
        await gate;
        return tokenBody(liveJwt, 'refresh-2');
      },
      {
        secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-1' },
        client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
      },
    );

    const refreshing = h.auth.refresh();
    await h.auth.disconnect();
    release!();

    await expect(refreshing).rejects.toBeInstanceOf(AuthRequiredError);

    expect(h.secrets.values.size).toBe(0);
    expect(h.auth.status()).toBe('disconnected');
    // Both tokens revoked: the one the keychain held, and the one the server
    // minted while the disconnect was landing.
    const revoked = h.calls
      .filter((c) => c.url.endsWith('/oauth/revoke'))
      .map((c) => new URLSearchParams(c.body!).get('token'));
    expect(revoked).toContain('refresh-1');
    expect(revoked).toContain('refresh-2');
  });

  it('revokes against the origin that issued the token, not a newly-typed one', async () => {
    // settings.ts disconnects before moving `baseUrl`, and `baseUrl` is read
    // live — so an in-flight refresh must not post the old origin's token to
    // whatever origin the field holds by the time it resolves.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let origin = 'https://mcp.javis.is';
    const calls: HttpRequestInit[] = [];
    const secrets = new FakeSecrets();
    secrets.set(SECRET_ACCESS_TOKEN, deadJwt);
    secrets.set(SECRET_REFRESH_TOKEN, 'refresh-1');
    const auth = new JavisOAuth({
      baseUrl: () => origin,
      secrets,
      http: async (req) => {
        calls.push(req);
        if (req.url.endsWith('/oauth/revoke')) return { status: 200, text: '' };
        await gate;
        return tokenBody(liveJwt, 'refresh-2');
      },
      getClient: () => ({ clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' }),
      setClient: async () => {},
      now: () => NOW,
    });

    const refreshing = auth.refresh();
    await auth.disconnect();
    origin = 'https://other.example';
    release!();
    await expect(refreshing).rejects.toBeInstanceOf(AuthRequiredError);

    for (const call of calls) expect(call.url.startsWith('https://mcp.javis.is/')).toBe(true);
  });

  it('does not report needs-reconnect when the disconnect is what killed the token', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness(
      async (req) => {
        if (req.url.endsWith('/oauth/revoke')) return { status: 200, text: '' };
        await gate;
        return { status: 400, text: '{"error":"invalid_grant"}' };
      },
      {
        secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-1' },
        client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
      },
    );

    const refreshing = h.auth.refresh();
    await h.auth.disconnect();
    release!();

    await expect(refreshing).rejects.toBeInstanceOf(AuthRequiredError);
    expect(h.auth.status()).toBe('disconnected');
  });

  it('clears the needs-reconnect state so the UI offers "connect" again', async () => {
    const h = harness((_req, n) => {
      if (n === 1) return { status: 400, text: '{"error":"invalid_grant"}' };
      return { status: 200, text: '' };
    }, {
      secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-1' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });

    await expect(h.auth.refresh()).rejects.toBeInstanceOf(AuthRevokedError);
    await h.auth.disconnect();
    expect(h.auth.status()).toBe('disconnected');
  });
});

describe('JavisOAuth.onStatusChange', () => {
  it('returns an unsubscribe that actually unsubscribes', async () => {
    const h = harness(() => tokenBody(liveJwt, 'refresh-1'), {
      secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-0' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });
    const seen: string[] = [];
    const off = h.auth.onStatusChange((s) => seen.push(s));
    off();
    await h.auth.refresh();
    expect(seen).toEqual([]);
  });

  it('survives a listener that throws', async () => {
    const h = harness(() => tokenBody(liveJwt, 'refresh-1'), {
      secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'refresh-0' },
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
    });
    h.auth.onStatusChange(() => {
      throw new Error('bad UI listener');
    });
    await expect(h.auth.refresh()).resolves.toBe(liveJwt);
  });
});

// ---------------------------------------------------------------------------
// 0.2.0: the wiki:write step-up (spec 2026-09-24 §C.7; plan D-AUTH-1..5)
// ---------------------------------------------------------------------------

describe('step-up: authorize URL', () => {
  const params = {
    baseUrl: 'https://mcp.javis.is',
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:51234/callback',
    codeChallenge: 'chal',
    state: 'st',
  };

  it('carries the union scope and the /wiki resource when asked', () => {
    const url = new URL(
      buildAuthorizeUrl({ ...params, scope: OAUTH_SCOPE_WRITE, resource: 'https://mcp.javis.is/wiki' }),
    );
    expect(url.searchParams.get('scope')).toBe('mcp:read wiki:write');
    expect(url.searchParams.get('resource')).toBe('https://mcp.javis.is/wiki');
  });

  it('is byte-identical to 0.1.x without them (D-AUTH-1)', () => {
    expect(buildAuthorizeUrl(params)).toBe(
      'https://mcp.javis.is/oauth/authorize?response_type=code&client_id=cid&redirect_uri=' +
        'http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&code_challenge=chal&code_challenge_method=S256' +
        '&scope=mcp%3Aread&state=st',
    );
  });

  it('wikiResource appends /wiki to the normalized origin', () => {
    expect(wikiResource('https://mcp.javis.is/')).toBe('https://mcp.javis.is/wiki');
    expect(wikiResource(' http://localhost:8000 ')).toBe('http://localhost:8000/wiki');
  });
});

describe('step-up: connect and refresh', () => {
  const writeJwt = jwt({ sub: 'u', exp: Math.floor(NOW / 1000) + 3600, scope: 'mcp:read wiki:write' });

  it('sends scope and resource on authorize AND on the code exchange', async () => {
    const h = harness((_req, n) =>
      n === 1 ? { status: 201, text: JSON.stringify({ client_id: 'cid-1' }) } : tokenBody(writeJwt, 'r1'),
    );
    await h.auth.connect({ scope: OAUTH_SCOPE_WRITE, resource: 'https://mcp.javis.is/wiki' });
    const url = new URL(h.openBrowser.mock.calls[0]![0] as string);
    expect(url.searchParams.get('scope')).toBe('mcp:read wiki:write');
    expect(url.searchParams.get('resource')).toBe('https://mcp.javis.is/wiki');
    const form = new URLSearchParams(h.calls[1]!.body!);
    expect(form.get('resource')).toBe('https://mcp.javis.is/wiki');
    expect(h.auth.grantedScopes()).toEqual(['mcp:read', 'wiki:write']);
  });

  it('JavisOAuth.connect() with no options still sends no resource (the primitive; the plugin never calls it bare)', async () => {
    const h = harness((_req, n) =>
      n === 1 ? { status: 201, text: JSON.stringify({ client_id: 'cid-1' }) } : tokenBody(liveJwt, 'r1'),
    );
    await h.auth.connect();
    const url = new URL(h.openBrowser.mock.calls[0]![0] as string);
    expect(url.searchParams.get('scope')).toBe('mcp:read');
    expect(url.searchParams.has('resource')).toBe(false);
    for (const call of h.calls) expect(call.body ?? '').not.toContain('resource');
  });

  it('never sends resource or scope on a refresh', async () => {
    const h = harness(() => tokenBody(writeJwt, 'r2'), {
      client: { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:51234/callback' },
      secrets: { [SECRET_ACCESS_TOKEN]: deadJwt, [SECRET_REFRESH_TOKEN]: 'r1' },
    });
    await h.auth.getAccessToken();
    const form = new URLSearchParams(h.calls[0]!.body!);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.has('resource')).toBe(false);
    expect(form.has('scope')).toBe(false);
  });
});

describe('grantedScopes', () => {
  it('decodes the scope claim of the stored token', () => {
    const h = harness(() => ({ status: 500, text: '' }), {
      secrets: { [SECRET_ACCESS_TOKEN]: jwt({ scope: 'mcp:read wiki:write' }), [SECRET_REFRESH_TOKEN]: 'r' },
    });
    expect(h.auth.grantedScopes()).toEqual(['mcp:read', 'wiki:write']);
  });

  it('is null for an undecodable token, a token without scope, and no token', () => {
    const opaque = harness(() => ({ status: 500, text: '' }), { secrets: { [SECRET_ACCESS_TOKEN]: 'opaque' } });
    expect(opaque.auth.grantedScopes()).toBeNull();
    const noScope = harness(() => ({ status: 500, text: '' }), { secrets: { [SECRET_ACCESS_TOKEN]: liveJwt } });
    expect(noScope.auth.grantedScopes()).toBeNull();
    const none = harness(() => ({ status: 500, text: '' }));
    expect(none.auth.grantedScopes()).toBeNull();
  });

  it('decodeJwtClaims and scopesFromJwt are total', () => {
    expect(decodeJwtClaims('a.b.c')).toBeNull();
    expect(decodeJwtClaims(jwt({ x: 1 }))).toEqual({ x: 1 });
    expect(scopesFromJwt(jwt({ scope: '  mcp:read  ' }))).toEqual(['mcp:read']);
  });
});

// ---------------------------------------------------------------------------
// Review of 0.2.0: the /wiki resource on every connect, and the audience check
// ---------------------------------------------------------------------------

describe('connectOptionsFor (§C.3 resource always, §C.7 scope only with uploads)', () => {
  it('a read-only connect asks for the /wiki resource and the default scope', () => {
    expect(connectOptionsFor('https://mcp.javis.is/', false)).toEqual({ resource: 'https://mcp.javis.is/wiki' });
  });

  it('with an upload folder it adds the union scope', () => {
    expect(connectOptionsFor('https://mcp.javis.is', true)).toEqual({
      resource: 'https://mcp.javis.is/wiki',
      scope: 'mcp:read wiki:write',
    });
  });

  it('a read-only connect sends resource on authorize AND on the code exchange, scope=mcp:read', async () => {
    const readJwt = jwt({ sub: 'u', exp: Math.floor(NOW / 1000) + 3600, scope: 'mcp:read', aud: 'https://mcp.javis.is/wiki' });
    const h = harness((_req, n) =>
      n === 1 ? { status: 201, text: JSON.stringify({ client_id: 'cid-1' }) } : tokenBody(readJwt, 'r1'),
    );
    await h.auth.connect(connectOptionsFor('https://mcp.javis.is', false));
    const url = new URL(h.openBrowser.mock.calls[0]![0] as string);
    expect(url.searchParams.get('scope')).toBe('mcp:read');
    expect(url.searchParams.get('resource')).toBe('https://mcp.javis.is/wiki');
    const form = new URLSearchParams(h.calls[1]!.body!);
    expect(form.get('resource')).toBe('https://mcp.javis.is/wiki');
    expect(h.auth.grantedAudiences()).toEqual(['https://mcp.javis.is/wiki']);
  });
});

describe('audience', () => {
  it('audiencesFromJwt reads a string or an array, else null', () => {
    expect(audiencesFromJwt(jwt({ aud: 'https://mcp.javis.is/mcp' }))).toEqual(['https://mcp.javis.is/mcp']);
    expect(audiencesFromJwt(jwt({ aud: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(audiencesFromJwt(jwt({ aud: 3 }))).toBeNull();
    expect(audiencesFromJwt(jwt({}))).toBeNull();
    expect(audiencesFromJwt('opaque')).toBeNull();
  });

  it('isLegacyAudience: /mcp is legacy, /wiki (with or without a trailing slash) is not, unknown is not', () => {
    const base = 'https://mcp.javis.is';
    expect(isLegacyAudience(['https://mcp.javis.is/mcp'], base)).toBe(true);
    expect(isLegacyAudience(['https://mcp.javis.is/wiki'], base)).toBe(false);
    expect(isLegacyAudience(['https://mcp.javis.is/wiki/'], `${base}/`)).toBe(false);
    expect(isLegacyAudience(null, base)).toBe(false);
  });

  it('lacksWriteGrant: missing scope, or a legacy audience, or neither', () => {
    const base = 'https://mcp.javis.is';
    const wiki = ['https://mcp.javis.is/wiki'];
    expect(lacksWriteGrant(['mcp:read'], wiki, base)).toBe(true);
    expect(lacksWriteGrant(['mcp:read', 'wiki:write'], ['https://mcp.javis.is/mcp'], base)).toBe(true);
    expect(lacksWriteGrant(['mcp:read', 'wiki:write'], wiki, base)).toBe(false);
    // Undecodable: try it, and let the server decide (D-RUN-3).
    expect(lacksWriteGrant(null, null, base)).toBe(false);
  });

  it('grantedAudiences decodes the stored token, null without one', () => {
    const h = harness(() => ({ status: 500, text: '' }), {
      secrets: { [SECRET_ACCESS_TOKEN]: jwt({ aud: 'https://mcp.javis.is/mcp' }), [SECRET_REFRESH_TOKEN]: 'r' },
    });
    expect(h.auth.grantedAudiences()).toEqual(['https://mcp.javis.is/mcp']);
    expect(harness(() => ({ status: 500, text: '' })).auth.grantedAudiences()).toBeNull();
  });
});
