/**
 * Tests for the pure half of src/shell/api.ts.
 *
 * Everything here runs without Obsidian and without a network: api.ts reaches
 * the `obsidian` module through a lazy `require` inside `obsidianTransport`,
 * which no test touches, and `JavisWikiApiClient` takes its transport and its
 * auth as constructor arguments.
 *
 * What is deliberately NOT tested: `obsidianTransport` itself. It is three lines
 * of adaptation over `requestUrl` and it is exercised manually against a scratch
 * vault, per spec §H.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ExportQuery, ExportResponse, ServerPage } from '../src/shell/contracts';
import { DEFAULT_PAGE_LIMIT } from '../src/shell/contracts';
import {
  AuthExpiredError,
  AuthRevokedError,
  HttpError,
  NetworkError,
  ProtocolError,
  RateLimitedError,
  SyncCancelledError,
} from '../src/shell/errors';
import {
  type ApiAuth,
  type HttpRequest,
  type HttpResponse,
  JavisWikiApiClient,
  MAX_PAGE_LIMIT,
  buildExportUrl,
  clampLimit,
  errorForResponse,
  headerValue,
  parseJsonBody,
  parseRetryAfterMs,
  runExport,
  validateExportResponse,
  validateServerPage,
} from '../src/shell/api';

const BASE = 'https://mcp.javis.is';

function page(overrides: Partial<ServerPage> = {}): ServerPage {
  return {
    page_type: 'concept',
    slug: 'Agent-Builder',
    title: 'Agent Builder',
    updated_at: '2026-09-13T04:12:00Z',
    frontmatter: {},
    body: 'A body.',
    deleted_at: null,
    ...overrides,
  };
}

function response(overrides: Partial<ExportResponse> = {}): ExportResponse {
  return {
    pages: [page()],
    next_cursor: null,
    server_time: '2026-09-13T04:12:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe('clampLimit', () => {
  it('defaults when the limit is missing or not a number', () => {
    expect(clampLimit()).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(null)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('clamps to the server bounds instead of letting either door reject it', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-10)).toBe(1);
    expect(clampLimit(5000)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(MAX_PAGE_LIMIT)).toBe(MAX_PAGE_LIMIT);
  });

  it('floors a fractional limit', () => {
    expect(clampLimit(10.9)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// buildExportUrl
// ---------------------------------------------------------------------------

describe('buildExportUrl', () => {
  it('refuses cleartext http except to this machine: the bearer on it can write (review)', () => {
    expect(() => buildExportUrl('http://javis.example.lan')).toThrow(/https/);
    expect(() => buildExportUrl('http://10.0.0.5:8000')).toThrow(/https/);
    expect(buildExportUrl('http://localhost:8000')).toContain('http://localhost:8000/wiki/export');
    expect(buildExportUrl('http://127.0.0.1:8000')).toContain('http://127.0.0.1:8000/wiki/export');
  });

  it('hits /wiki/export with no /api prefix and the default limit', () => {
    expect(buildExportUrl(BASE)).toBe(`${BASE}/wiki/export?limit=${DEFAULT_PAGE_LIMIT}`);
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildExportUrl('https://mcp.javis.is///')).toBe(
      `${BASE}/wiki/export?limit=${DEFAULT_PAGE_LIMIT}`,
    );
  });

  it('omits since and cursor entirely when they are absent', () => {
    const url = buildExportUrl(BASE, { since: null, cursor: null });
    expect(url).not.toContain('since=');
    expect(url).not.toContain('cursor=');
  });

  it('omits an empty or whitespace since rather than sending since=', () => {
    expect(buildExportUrl(BASE, { since: '   ' })).not.toContain('since=');
  });

  it('sends since as a query parameter', () => {
    const url = new URL(buildExportUrl(BASE, { since: '2026-09-13T04:12:00Z' }));
    expect(url.searchParams.get('since')).toBe('2026-09-13T04:12:00Z');
  });

  it('echoes the opaque cursor verbatim, never reinterpreting it', () => {
    // base64url of "2026-09-13T04:12:00+00:00|4821", padding stripped.
    const cursor = 'MjAyNi0wOS0xM1QwNDoxMjowMCswMDowMHw0ODIx';
    const url = new URL(buildExportUrl(BASE, { cursor }));
    expect(url.searchParams.get('cursor')).toBe(cursor);
  });

  it('clamps the limit it puts on the wire', () => {
    const url = new URL(buildExportUrl(BASE, { limit: 99999 }));
    expect(url.searchParams.get('limit')).toBe(String(MAX_PAGE_LIMIT));
  });

  it('rejects an unset or unusable base URL as a configuration error', () => {
    expect(() => buildExportUrl('')).toThrow(/not set/);
    expect(() => buildExportUrl('   ')).toThrow(/not set/);
    expect(() => buildExportUrl('mcp.javis.is')).toThrow(/not a valid URL/);
    expect(() => buildExportUrl('ftp://mcp.javis.is')).toThrow(/http or https/);
  });
});

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

describe('headerValue', () => {
  it('is case-insensitive, because requestUrl promises no casing', () => {
    expect(headerValue({ 'Retry-After': '30' }, 'retry-after')).toBe('30');
    expect(headerValue({ 'retry-after': '30' }, 'Retry-After')).toBe('30');
  });

  it('returns null when missing or when there are no headers', () => {
    expect(headerValue({}, 'retry-after')).toBeNull();
    expect(headerValue(undefined, 'retry-after')).toBeNull();
  });
});

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '30' })).toBe(30_000);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-09-13T04:12:00Z');
    expect(parseRetryAfterMs({ 'retry-after': 'Sun, 13 Sep 2026 04:12:30 GMT' }, now)).toBe(30_000);
  });

  it('never returns a negative delay for a date already past', () => {
    const now = Date.parse('2026-09-13T04:12:00Z');
    expect(parseRetryAfterMs({ 'retry-after': 'Sun, 13 Sep 2026 04:11:00 GMT' }, now)).toBe(0);
  });

  it('returns null when the server said nothing usable — the common case today', () => {
    expect(parseRetryAfterMs({})).toBeNull();
    expect(parseRetryAfterMs({ 'retry-after': '' })).toBeNull();
    expect(parseRetryAfterMs({ 'retry-after': 'soon' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// errorForResponse
// ---------------------------------------------------------------------------

describe('errorForResponse', () => {
  it('maps 429 to a retryable RateLimitedError carrying the delay', () => {
    const err = errorForResponse(429, 'rate_limited', { 'Retry-After': '5' });
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(5_000);
    expect(err.retryable).toBe(true);
  });

  it('maps 429 without a Retry-After to a null delay', () => {
    expect((errorForResponse(429, '') as RateLimitedError).retryAfterMs).toBeNull();
  });

  it('maps 401 to AuthExpiredError, which needs the user', () => {
    const err = errorForResponse(401, 'unauthorized');
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect(err.needsUserAction).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it('maps 400 to a non-retryable HttpError carrying the server body', () => {
    const err = errorForResponse(400, '{"error":"invalid_request"}') as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.body).toContain('invalid_request');
    expect(err.retryable).toBe(false);
  });

  it('marks 5xx retryable', () => {
    expect(errorForResponse(503, 'upstream').retryable).toBe(true);
  });

  it('truncates a giant error body', () => {
    const err = errorForResponse(500, 'x'.repeat(10_000)) as HttpError;
    expect(err.body.length).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe('parseJsonBody', () => {
  it('parses JSON', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it('turns a non-JSON body into a ProtocolError, not a SyntaxError', () => {
    expect(() => parseJsonBody('<html>502 Bad Gateway</html>')).toThrow(ProtocolError);
  });
});

describe('validateServerPage', () => {
  it('accepts a whole page', () => {
    expect(validateServerPage(page(), 'p')).toEqual(page());
  });

  it('applies the server-side defaults for frontmatter, body and deleted_at', () => {
    const parsed = validateServerPage(
      { page_type: 'concept', slug: 'A', title: 'A', updated_at: '2026-01-01T00:00:00Z' },
      'p',
    );
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('');
    expect(parsed.deleted_at).toBeNull();
  });

  it('keeps a tombstone timestamp', () => {
    const parsed = validateServerPage(page({ deleted_at: '2026-09-01T00:00:00Z' }), 'p');
    expect(parsed.deleted_at).toBe('2026-09-01T00:00:00Z');
  });

  it('drops keys the wire contract does not declare', () => {
    const parsed = validateServerPage({ ...page(), surprise: 'ignore me' }, 'p') as unknown as Record<
      string,
      unknown
    >;
    expect(parsed['surprise']).toBeUndefined();
  });

  it('rejects a missing or non-string identity field', () => {
    for (const key of ['page_type', 'slug', 'title', 'updated_at']) {
      const bad: Record<string, unknown> = { ...page() };
      delete bad[key];
      expect(() => validateServerPage(bad, 'p'), key).toThrow(ProtocolError);
      expect(() => validateServerPage({ ...page(), [key]: 42 }, 'p'), key).toThrow(ProtocolError);
    }
  });

  it('rejects an empty slug, page_type or updated_at but allows an empty title', () => {
    expect(() => validateServerPage(page({ slug: '' }), 'p')).toThrow(ProtocolError);
    expect(() => validateServerPage(page({ page_type: '' }), 'p')).toThrow(ProtocolError);
    expect(() => validateServerPage(page({ updated_at: '' }), 'p')).toThrow(ProtocolError);
    expect(validateServerPage(page({ title: '' }), 'p').title).toBe('');
  });

  it('rejects a frontmatter that is not an object', () => {
    expect(() => validateServerPage({ ...page(), frontmatter: ['a'] }, 'p')).toThrow(ProtocolError);
    expect(() => validateServerPage({ ...page(), frontmatter: 'x' }, 'p')).toThrow(ProtocolError);
  });

  it('rejects a non-string body and a non-string deleted_at', () => {
    expect(() => validateServerPage({ ...page(), body: 12 }, 'p')).toThrow(ProtocolError);
    expect(() => validateServerPage({ ...page(), deleted_at: 12 }, 'p')).toThrow(ProtocolError);
  });

  it('rejects a page that is not an object at all', () => {
    expect(() => validateServerPage(null, 'p')).toThrow(ProtocolError);
    expect(() => validateServerPage('page', 'p')).toThrow(ProtocolError);
  });
});

describe('validateExportResponse', () => {
  it('accepts the §B shape', () => {
    expect(validateExportResponse(response())).toEqual(response());
  });

  it('rejects a response with no server_time, because it could not yield a cursor', () => {
    const { pages, next_cursor } = response();
    expect(() => validateExportResponse({ pages, next_cursor })).toThrow(ProtocolError);
  });

  it('rejects a response whose pages is not an array', () => {
    expect(() => validateExportResponse({ ...response(), pages: null })).toThrow(ProtocolError);
  });

  it('rejects the WHOLE batch when one page is malformed', () => {
    // Half a response must not become half a vault: dropping the bad row would
    // let the cursor advance past a page the vault never saw.
    const body = { ...response(), pages: [page(), { slug: 'no-type' }] };
    expect(() => validateExportResponse(body)).toThrow(ProtocolError);
    expect(() => validateExportResponse(body)).toThrow(/pages\[1\]/);
  });

  it('keeps next_cursor opaque and normalizes absent/empty to null', () => {
    expect(validateExportResponse({ ...response(), next_cursor: 'OPAQUE' }).next_cursor).toBe(
      'OPAQUE',
    );
    expect(validateExportResponse({ ...response(), next_cursor: '' }).next_cursor).toBeNull();
    const { pages, server_time } = response();
    expect(validateExportResponse({ pages, server_time }).next_cursor).toBeNull();
  });

  it('rejects a non-string next_cursor rather than coercing it', () => {
    // Spec §B's `"next_cursor": 4821` example is stale; the server sends a
    // string. A number here means we are not talking to the server we think.
    expect(() => validateExportResponse({ ...response(), next_cursor: 4821 })).toThrow(
      ProtocolError,
    );
  });

  it('accepts an empty page list', () => {
    expect(validateExportResponse({ ...response(), pages: [] }).pages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runExport — the paging contract
// ---------------------------------------------------------------------------

function scriptedFetch(responses: ExportResponse[]): {
  fetchBatch: (query: ExportQuery, signal?: AbortSignal) => Promise<ExportResponse>;
  queries: ExportQuery[];
} {
  const queries: ExportQuery[] = [];
  let i = 0;
  const fetchBatch = async (query: ExportQuery): Promise<ExportResponse> => {
    queries.push(query);
    const next = responses[i++];
    if (!next) throw new Error(`runExport asked for batch ${i}, which the test did not script`);
    return next;
  };
  return { fetchBatch, queries };
}

describe('runExport', () => {
  it('returns after a single batch and reports its tally', async () => {
    const { fetchBatch, queries } = scriptedFetch([response()]);
    const run = await runExport(fetchBatch, { since: null, onBatch: () => {} });

    expect(run).toEqual({ serverTime: '2026-09-13T04:12:00Z', batches: 1, pages: 1 });
    expect(queries).toEqual([{ since: null, limit: undefined, cursor: null }]);
  });

  it('follows next_cursor to exhaustion, echoing each cursor verbatim', async () => {
    const { fetchBatch, queries } = scriptedFetch([
      response({ pages: [page({ slug: 'A' })], next_cursor: 'C1' }),
      response({ pages: [page({ slug: 'B' })], next_cursor: 'C2' }),
      response({ pages: [page({ slug: 'C' })], next_cursor: null }),
    ]);

    const seen: string[] = [];
    const run = await runExport(fetchBatch, {
      since: '2026-09-01T00:00:00Z',
      limit: 500,
      onBatch: (batch) => {
        for (const p of batch.pages) seen.push(p.slug);
      },
    });

    expect(seen).toEqual(['A', 'B', 'C']);
    expect(run.batches).toBe(3);
    expect(run.pages).toBe(3);
    expect(queries.map((q) => q.cursor)).toEqual([null, 'C1', 'C2']);
    // `since` is the same on every request of the run; only the cursor moves.
    expect(queries.every((q) => q.since === '2026-09-01T00:00:00Z')).toBe(true);
  });

  it('takes the cursor from the FIRST batch, never a later one', async () => {
    // The watermark is read before the row SELECT and held back 60s. A later
    // batch's server_time is newer and would skip rows committed mid-run.
    const { fetchBatch } = scriptedFetch([
      response({ next_cursor: 'C1', server_time: '2026-09-13T04:00:00Z' }),
      response({ next_cursor: 'C2', server_time: '2026-09-13T04:05:00Z' }),
      response({ next_cursor: null, server_time: '2026-09-13T04:10:00Z' }),
    ]);

    const run = await runExport(fetchBatch, { since: null, onBatch: () => {} });
    expect(run.serverTime).toBe('2026-09-13T04:00:00Z');
  });

  it('reports each batch its own server_time and 1-based index', async () => {
    const { fetchBatch } = scriptedFetch([
      response({ next_cursor: 'C1', server_time: 'T1' }),
      response({ next_cursor: null, server_time: 'T2' }),
    ]);

    const batches: { index: number; serverTime: string; nextCursor: string | null }[] = [];
    await runExport(fetchBatch, {
      since: null,
      onBatch: (b) => {
        batches.push({ index: b.index, serverTime: b.serverTime, nextCursor: b.nextCursor });
      },
    });

    expect(batches).toEqual([
      { index: 1, serverTime: 'T1', nextCursor: 'C1' },
      { index: 2, serverTime: 'T2', nextCursor: null },
    ]);
  });

  it('awaits onBatch before the next request, so vault writes stay serialized', async () => {
    const order: string[] = [];
    const responses = [
      response({ next_cursor: 'C1' }),
      response({ next_cursor: 'C2' }),
      response({ next_cursor: null }),
    ];
    let i = 0;
    const fetchBatch = async (): Promise<ExportResponse> => {
      order.push(`fetch:${i + 1}`);
      const next = responses[i++];
      if (!next) throw new Error('over-fetched');
      return next;
    };

    await runExport(fetchBatch, {
      since: null,
      onBatch: async (b) => {
        order.push(`write:start:${b.index}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(`write:end:${b.index}`);
      },
    });

    expect(order).toEqual([
      'fetch:1',
      'write:start:1',
      'write:end:1',
      'fetch:2',
      'write:start:2',
      'write:end:2',
      'fetch:3',
      'write:start:3',
      'write:end:3',
    ]);
  });

  it('stops the run when onBatch rejects, without fetching further batches', async () => {
    const { fetchBatch, queries } = scriptedFetch([
      response({ next_cursor: 'C1' }),
      response({ next_cursor: null }),
    ]);

    await expect(
      runExport(fetchBatch, {
        since: null,
        onBatch: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');

    // One request made; the caller keeps its old cursor and the batch is
    // re-delivered next run, which is safe because every write is idempotent.
    expect(queries).toHaveLength(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchBatch, queries } = scriptedFetch([response()]);

    await expect(
      runExport(fetchBatch, { since: null, signal: controller.signal, onBatch: () => {} }),
    ).rejects.toBeInstanceOf(SyncCancelledError);
    expect(queries).toHaveLength(0);
  });

  it('stops between batches when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const { fetchBatch, queries } = scriptedFetch([
      response({ next_cursor: 'C1' }),
      response({ next_cursor: null }),
    ]);

    await expect(
      runExport(fetchBatch, {
        since: null,
        signal: controller.signal,
        onBatch: () => controller.abort(),
      }),
    ).rejects.toBeInstanceOf(SyncCancelledError);
    expect(queries).toHaveLength(1);
  });

  it('refuses to page forever on a repeated cursor', async () => {
    const { fetchBatch } = scriptedFetch([
      response({ next_cursor: 'C1' }),
      response({ next_cursor: 'C1' }),
    ]);

    await expect(
      runExport(fetchBatch, { since: null, onBatch: () => {} }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('gives up after maxBatches when the cursor keeps changing', async () => {
    let n = 0;
    const fetchBatch = async (): Promise<ExportResponse> =>
      response({ pages: [], next_cursor: `C${n++}` });

    await expect(
      runExport(fetchBatch, { since: null, maxBatches: 5, onBatch: () => {} }),
    ).rejects.toBeInstanceOf(ProtocolError);
    expect(n).toBe(5);
  });

  it('counts rows across batches, tombstones included', async () => {
    const { fetchBatch } = scriptedFetch([
      response({ pages: [page(), page({ deleted_at: '2026-09-01T00:00:00Z' })], next_cursor: 'C1' }),
      response({ pages: [page()], next_cursor: null }),
    ]);

    const run = await runExport(fetchBatch, { since: null, onBatch: () => {} });
    expect(run.pages).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// JavisWikiApiClient — transport and auth are injected, so this is unit-testable
// ---------------------------------------------------------------------------

function fakeAuth(overrides: Partial<ApiAuth> = {}): ApiAuth & {
  calls: { getAccessToken: number; refresh: number };
} {
  const calls = { getAccessToken: 0, refresh: 0 };
  return {
    calls,
    getAccessToken: async () => {
      calls.getAccessToken += 1;
      return 'ACCESS-1';
    },
    refresh: async () => {
      calls.refresh += 1;
      return 'ACCESS-2';
    },
    ...overrides,
  };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify(body) };
}

describe('JavisWikiApiClient.fetchBatch', () => {
  it('sends the bearer token and requests JSON', async () => {
    const seen: HttpRequest[] = [];
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async (req) => {
      seen.push(req);
      return ok(response());
    });

    await client.fetchBatch({ since: '2026-09-01T00:00:00Z' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers?.['Authorization']).toBe('Bearer ACCESS-1');
    expect(seen[0]?.headers?.['Accept']).toBe('application/json');
    expect(seen[0]?.url).toContain('/wiki/export?since=');
  });

  it('applies the configured limit and clamps it', async () => {
    const seen: HttpRequest[] = [];
    const client = new JavisWikiApiClient(
      { baseUrl: BASE, limit: 100_000 },
      fakeAuth(),
      async (req) => {
        seen.push(req);
        return ok(response());
      },
    );

    await client.fetchBatch({});
    expect(new URL(seen[0]!.url).searchParams.get('limit')).toBe(String(MAX_PAGE_LIMIT));
  });

  it('returns the validated response', async () => {
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () =>
      ok(response({ next_cursor: 'C1' })),
    );
    const result = await client.fetchBatch({});
    expect(result.pages).toHaveLength(1);
    expect(result.next_cursor).toBe('C1');
  });

  it('refreshes once and retries the same request on a 401', async () => {
    const seen: HttpRequest[] = [];
    const auth = fakeAuth();
    const client = new JavisWikiApiClient({ baseUrl: BASE }, auth, async (req) => {
      seen.push(req);
      return seen.length === 1
        ? { status: 401, headers: {}, text: 'unauthorized' }
        : ok(response());
    });

    await client.fetchBatch({ since: '2026-09-01T00:00:00Z' });

    expect(auth.calls.refresh).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe(seen[1]?.url); // the SAME request, retried
    expect(seen[1]?.headers?.['Authorization']).toBe('Bearer ACCESS-2');
  });

  it('gives up with AuthExpiredError on a second 401, without refreshing twice', async () => {
    const auth = fakeAuth();
    const attempts = vi.fn(async (): Promise<HttpResponse> => ({
      status: 401,
      headers: {},
      text: 'unauthorized',
    }));
    const client = new JavisWikiApiClient({ baseUrl: BASE }, auth, attempts);

    await expect(client.fetchBatch({})).rejects.toBeInstanceOf(AuthExpiredError);
    expect(auth.calls.refresh).toBe(1);
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it('maps 429 to RateLimitedError with the delay the server named', async () => {
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () => ({
      status: 429,
      headers: { 'Retry-After': '12' },
      text: '{"error":"rate_limited"}',
    }));

    await expect(client.fetchBatch({})).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfterMs: 12_000,
    });
  });

  it('maps a 400 from a malformed cursor to a non-retryable HttpError', async () => {
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () => ({
      status: 400,
      headers: {},
      text: '{"error":"invalid_request","error_description":"bad cursor"}',
    }));

    const err = await client.fetchBatch({ cursor: 'garbage' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).retryable).toBe(false);
  });

  it('maps a transport failure to a retryable NetworkError', async () => {
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    const err = await client.fetchBatch({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).retryable).toBe(true);
  });

  it('lets an auth failure through unchanged instead of calling it a network problem', async () => {
    const auth = fakeAuth({
      getAccessToken: async () => {
        throw new AuthRevokedError('Reconnect your Javis account.');
      },
    });
    const client = new JavisWikiApiClient({ baseUrl: BASE }, auth, async () => ok(response()));

    await expect(client.fetchBatch({})).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it('raises ProtocolError on a 200 that is not the §B shape', async () => {
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () => ({
      status: 200,
      headers: {},
      text: '<html>hello</html>',
    }));
    await expect(client.fetchBatch({})).rejects.toBeInstanceOf(ProtocolError);

    const missingTime = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () =>
      ok({ pages: [], next_cursor: null }),
    );
    await expect(missingTime.fetchBatch({})).rejects.toBeInstanceOf(ProtocolError);
  });

  it('never puts the access token into an error', async () => {
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async () => {
      throw new Error('socket hang up');
    });

    const err = (await client.fetchBatch({}).catch((e: unknown) => e)) as Error;
    const serialized = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
    expect(serialized).not.toContain('ACCESS-1');
    expect(serialized).not.toContain('Bearer');
  });

  it('stops before the request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn(async () => ok(response()));
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), transport);

    await expect(client.fetchBatch({}, controller.signal)).rejects.toBeInstanceOf(
      SyncCancelledError,
    );
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('JavisWikiApiClient.exportAll', () => {
  it('pages to exhaustion over HTTP and returns the first batch server_time', async () => {
    const urls: string[] = [];
    const bodies = [
      response({ pages: [page({ slug: 'A' })], next_cursor: 'C1', server_time: 'T1' }),
      response({ pages: [page({ slug: 'B' })], next_cursor: null, server_time: 'T2' }),
    ];
    let i = 0;
    const client = new JavisWikiApiClient({ baseUrl: BASE }, fakeAuth(), async (req) => {
      urls.push(req.url);
      return ok(bodies[i++]);
    });

    const slugs: string[] = [];
    const run = await client.exportAll({
      since: '2026-09-01T00:00:00Z',
      onBatch: (batch) => {
        for (const p of batch.pages) slugs.push(p.slug);
      },
    });

    expect(slugs).toEqual(['A', 'B']);
    expect(run).toEqual({ serverTime: 'T1', batches: 2, pages: 2 });
    expect(new URL(urls[0]!).searchParams.get('cursor')).toBeNull();
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('C1');
  });
});
