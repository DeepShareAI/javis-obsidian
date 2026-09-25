/**
 * Tests for src/shell/sources-api.ts against a recording fake transport.
 * The server (PR 3) does not exist yet; these pin the §E contract as plan
 * D-WIRE-1..4 fixes it.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ApiAuth, HttpRequest, HttpResponse } from '../src/shell/api';
import {
  AuthExpiredError,
  HttpError,
  InsufficientScopeError,
  NetworkError,
  ProtocolError,
  RateLimitedError,
  SyncCancelledError,
} from '../src/shell/errors';
import {
  JavisSourcesApiClient,
  buildSourcesUrl,
  parseWwwAuthenticate,
  validateSourcesResponse,
} from '../src/shell/sources-api';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const HASH = 'a'.repeat(64);
const TOKEN = 'secret-access-token-xyz';

function goodRow(over: Record<string, unknown> = {}) {
  return {
    source_id: ID,
    vault_path: 'Journal/a.md',
    body_hash: HASH,
    status: 'done',
    deleted: false,
    last_error: null,
    undo_report: null,
    ...over,
  };
}

function harness(responses: (HttpResponse | Error)[], base = 'https://mcp.javis.is/') {
  const calls: HttpRequest[] = [];
  const transport = vi.fn(async (req: HttpRequest) => {
    calls.push(req);
    const next = responses.shift();
    if (next === undefined) throw new Error('no scripted response');
    if (next instanceof Error) throw next;
    return next;
  });
  const auth: ApiAuth & { refresh: ReturnType<typeof vi.fn> } = {
    getAccessToken: vi.fn(async () => TOKEN),
    refresh: vi.fn(async () => `${TOKEN}-2`),
  };
  const client = new JavisSourcesApiClient({ baseUrl: () => base }, auth, transport);
  return { client, calls, auth };
}

const res = (status: number, body: unknown = '', headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

const putBody = { vault_path: 'Journal/a.md', title: 'A', text: 'hello\n', body_hash: HASH };

describe('URLs and headers', () => {
  it('builds the three routes and tolerates a trailing slash', () => {
    expect(buildSourcesUrl('https://mcp.javis.is/')).toBe('https://mcp.javis.is/wiki/sources/obsidian');
    expect(buildSourcesUrl('https://mcp.javis.is', ID)).toBe(`https://mcp.javis.is/wiki/sources/obsidian/${ID}`);
    expect(buildSourcesUrl('https://x', 'a/b')).toBe('https://x/wiki/sources/obsidian/a%2Fb');
    expect(() => buildSourcesUrl('')).toThrow();
    expect(() => buildSourcesUrl('ftp://x')).toThrow();
  });

  it('refuses cleartext http except to this machine: note text and a write bearer ride on it (review)', () => {
    expect(() => buildSourcesUrl('http://javis.example.com')).toThrow(/https/);
    expect(() => buildSourcesUrl('http://10.0.0.5:8000')).toThrow(/https/);
    expect(buildSourcesUrl('http://localhost:8000')).toBe('http://localhost:8000/wiki/sources/obsidian');
    expect(buildSourcesUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/wiki/sources/obsidian');
    expect(buildSourcesUrl('http://[::1]:8000')).toBe('http://[::1]:8000/wiki/sources/obsidian');
  });

  it('an http server stops the run at the listing, before any bearer is sent', async () => {
    const h = harness([res(200, { sources: [] })], 'http://javis.example.com');
    await expect(h.client.list()).rejects.toThrow(/https/);
    expect(h.calls).toEqual([]);
  });

  it('GET sends the bearer and nothing else', async () => {
    const h = harness([res(200, { sources: [] })]);
    await h.client.list();
    expect(h.calls[0]).toMatchObject({
      url: 'https://mcp.javis.is/wiki/sources/obsidian',
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(h.calls[0]!.body).toBeUndefined();
  });

  it('PUT sends JSON with exactly the four §E keys', async () => {
    const h = harness([res(202)]);
    await h.client.put(ID, { ...putBody, extra: 'nope' } as typeof putBody);
    const call = h.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`https://mcp.javis.is/wiki/sources/obsidian/${ID}`);
    expect(call.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual(putBody);
    expect(Object.keys(JSON.parse(call.body!))).toEqual(['vault_path', 'title', 'text', 'body_hash']);
  });

  it('reads baseUrl live on every request (D-API-2)', async () => {
    let base = 'https://one.example';
    const calls: HttpRequest[] = [];
    const client = new JavisSourcesApiClient(
      { baseUrl: () => base },
      { getAccessToken: async () => TOKEN, refresh: async () => TOKEN },
      async (req) => {
        calls.push(req);
        return res(204);
      },
    );
    await client.delete(ID);
    base = 'https://two.example';
    await client.delete(ID);
    expect(calls.map((c) => new URL(c.url).origin)).toEqual(['https://one.example', 'https://two.example']);
  });
});

describe('listing validation (D-WIRE-1)', () => {
  it('accepts the happy path, lowercases ids and hashes, and defaults counts', () => {
    const listing = validateSourcesResponse({
      sources: [goodRow({ source_id: ID.toUpperCase(), body_hash: HASH.toUpperCase(), status: 'something-new' })],
    });
    expect(listing.sources[0]).toMatchObject({ source_id: ID, body_hash: HASH, status: 'something-new' });
    expect(listing.counts).toEqual({});
  });

  it('keeps an undo report and counts', () => {
    const report = { pages_tombstoned: 1, pages_rebuilt: 3, pages_marked_stale: 2, pages_skipped_adopted: 0 };
    const listing = validateSourcesResponse({ sources: [goodRow({ undo_report: report })], counts: { done: 1 } });
    expect(listing.sources[0]!.undo_report).toEqual(report);
    expect(listing.counts).toEqual({ done: 1 });
  });

  it('rejects the whole response on any bad row', () => {
    expect(() => validateSourcesResponse({})).toThrow(ProtocolError);
    expect(() => validateSourcesResponse({ sources: [goodRow({ body_hash: undefined })] })).toThrow(ProtocolError);
    expect(() => validateSourcesResponse({ sources: [goodRow({ body_hash: 'short' })] })).toThrow(ProtocolError);
    expect(() => validateSourcesResponse({ sources: [goodRow({ deleted: 'no' })] })).toThrow(ProtocolError);
    expect(() => validateSourcesResponse({ sources: [goodRow({ undo_report: { pages_rebuilt: 1 } })] })).toThrow(
      ProtocolError,
    );
    expect(() => validateSourcesResponse({ sources: [], counts: { done: 'x' } })).toThrow(ProtocolError);
  });

  it('a non-JSON 200 is a ProtocolError', async () => {
    const h = harness([res(200, '<html>')]);
    await expect(h.client.list()).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe('PUT and DELETE outcomes', () => {
  it('maps every PUT status §E names', async () => {
    const h = harness([
      res(200),
      res(202),
      res(400, { detail: 'body_hash does not match text' }),
      res(409),
      res(413),
    ]);
    await expect(h.client.put(ID, putBody)).resolves.toEqual({ kind: 'unchanged' });
    await expect(h.client.put(ID, putBody)).resolves.toEqual({ kind: 'accepted' });
    await expect(h.client.put(ID, putBody)).resolves.toEqual({
      kind: 'rejected',
      message: 'body_hash does not match text',
    });
    await expect(h.client.put(ID, putBody)).resolves.toEqual({ kind: 'conflict-deleted' });
    await expect(h.client.put(ID, putBody)).resolves.toEqual({ kind: 'oversize' });
  });

  it('throws on 5xx (retryable) and 429 (with Retry-After)', async () => {
    const h = harness([res(500, 'boom'), res(429, '', { 'Retry-After': '3' })]);
    const e500 = await h.client.put(ID, putBody).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(HttpError);
    expect((e500 as HttpError).retryable).toBe(true);
    const e429 = await h.client.put(ID, putBody).catch((e: unknown) => e);
    expect(e429).toBeInstanceOf(RateLimitedError);
    expect((e429 as RateLimitedError).retryAfterMs).toBe(3000);
  });

  it('maps DELETE 202 and 204', async () => {
    const h = harness([res(202), res(204)]);
    await expect(h.client.delete(ID)).resolves.toEqual({ kind: 'deleting' });
    await expect(h.client.delete(ID)).resolves.toEqual({ kind: 'gone' });
    expect(h.calls[0]!.method).toBe('DELETE');
  });
});

describe('auth sequence', () => {
  it('401 -> exactly one refresh and one retry with the new token', async () => {
    const h = harness([res(401), res(202)]);
    await expect(h.client.put(ID, putBody)).resolves.toEqual({ kind: 'accepted' });
    expect(h.auth.refresh).toHaveBeenCalledTimes(1);
    expect(h.calls[1]!.headers?.['Authorization']).toBe(`Bearer ${TOKEN}-2`);
  });

  it('a second 401 is AuthExpiredError', async () => {
    const h = harness([res(401), res(401)]);
    await expect(h.client.list()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(h.auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('403 insufficient_scope is InsufficientScopeError; a bare 403 is HttpError', async () => {
    const challenge =
      'Bearer error="insufficient_scope", scope="mcp:read wiki:write", resource_metadata="https://mcp.javis.is/.well-known/oauth-protected-resource/wiki"';
    const h = harness([res(403, '', { 'www-authenticate': challenge }), res(403, 'forbidden')]);
    await expect(h.client.put(ID, putBody)).rejects.toBeInstanceOf(InsufficientScopeError);
    const bare = await h.client.put(ID, putBody).catch((e: unknown) => e);
    expect(bare).toBeInstanceOf(HttpError);
    expect((bare as HttpError).status).toBe(403);
  });
});

describe('parseWwwAuthenticate', () => {
  it('handles quoted commas and case', () => {
    const parsed = parseWwwAuthenticate('BEARER Error="insufficient_scope", scope="a, b", realm=x');
    expect(parsed).toEqual({ scheme: 'bearer', params: { error: 'insufficient_scope', scope: 'a, b', realm: 'x' } });
  });

  it('is null for no header', () => {
    expect(parseWwwAuthenticate(null)).toBeNull();
  });
});

describe('failures without a response', () => {
  it('a transport throw is NetworkError, and the token is never in the message', async () => {
    const h = harness([new Error('ECONNREFUSED')]);
    const err = await h.client.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('no error carries the token', async () => {
    const h = harness([res(500, 'x'), res(401), res(401)]);
    for (const p of [h.client.list(), h.client.list()]) {
      const err = await p.catch((e: unknown) => e);
      expect(String(err)).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
    }
  });

  it('an aborted signal stops before the request', async () => {
    const h = harness([res(200, { sources: [] })]);
    const controller = new AbortController();
    controller.abort();
    await expect(h.client.list(controller.signal)).rejects.toBeInstanceOf(SyncCancelledError);
    expect(h.calls).toHaveLength(0);
  });
});
