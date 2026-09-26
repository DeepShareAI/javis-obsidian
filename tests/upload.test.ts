/**
 * Tests for src/shell/upload.ts — `uploadOnce` against a fake vault and a fake
 * sources API. No Obsidian, no network, no real clock: the run's `now`, the
 * sleep, the ids and the read timeout are all injected.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEBOUNCE_MS } from '../src/core/upload';
import type { ServerSource } from '../src/core/upload';
import { contentKey, noteHash, readSourceId, uploadText } from '../src/core/note-text';
import type {
  DeleteOutcome,
  PutOutcome,
  PutSourceBody,
  SourcesApi,
  SourcesListing,
  UploadDeps,
  UploadVault,
} from '../src/shell/contracts';
import {
  AuthRevokedError,
  HttpError,
  InsufficientScopeError,
  NetworkError,
  OriginChangedError,
  ProtocolError,
  RateLimitedError,
} from '../src/shell/errors';
import {
  describeNote,
  lenientSourceId,
  nextPendingReupload,
  nextRemovedIds,
  summarizeUpload,
  uploadOnce,
  uploadReport,
} from '../src/shell/upload';

const T0 = 1_800_000_000_000;

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeUploadVault implements UploadVault {
  readonly files = new Map<string, string>();
  readonly log: string[] = [];
  /** Paths whose read never resolves (an evicted iCloud file). */
  readonly hang = new Set<string>();
  /** Paths whose read rejects. */
  readonly fail = new Set<string>();
  /** Per-path `javis_source_id` from the metadata cache (D-PLAN-3); null when absent. */
  readonly cached = new Map<string, string>();
  /** Simulates another device's write landing between our read and our process. */
  beforeProcess: ((path: string) => void) | null = null;

  constructor(files: Record<string, string> = {}) {
    for (const [p, t] of Object.entries(files)) this.files.set(p, t);
  }

  async listNotesIn(folders: readonly string[]) {
    return [...this.files.keys()]
      .filter((p) => folders.some((f) => p.startsWith(`${f}/`)))
      .sort()
      .map((path) => ({ path, cachedSourceId: this.cached.get(path) ?? null }));
  }

  readFresh(path: string): Promise<string> {
    this.log.push(`read ${path}`);
    if (this.hang.has(path)) return new Promise(() => {});
    if (this.fail.has(path)) return Promise.reject(new Error('EIO'));
    return Promise.resolve(this.files.get(path)!);
  }

  async processText(path: string, transform: (c: string) => string): Promise<string> {
    this.beforeProcess?.(path);
    this.log.push(`process ${path}`);
    const next = transform(this.files.get(path)!);
    this.files.set(path, next);
    return next;
  }

  configDir(): string {
    return '.obsidian';
  }
}

type Scripted<T> = T | Error;

class FakeSourcesApi implements SourcesApi {
  readonly calls: string[] = [];
  readonly bodies = new Map<string, PutSourceBody>();
  listing: SourcesListing = { sources: [], counts: {} };
  listError: Error | null = null;
  /** Per-id scripted PUT responses, consumed in order; default 202. */
  readonly putScript = new Map<string, Scripted<PutOutcome>[]>();
  readonly deleteScript = new Map<string, Scripted<DeleteOutcome>[]>();
  /** Scripted for every PUT regardless of id, consumed first. */
  readonly anyPut: Scripted<PutOutcome>[] = [];
  onPut: ((id: string) => void) | null = null;

  constructor(private readonly log: string[] = []) {}

  async list(): Promise<SourcesListing> {
    this.calls.push('list');
    if (this.listError) throw this.listError;
    return this.listing;
  }

  async put(sourceId: string, body: PutSourceBody): Promise<PutOutcome> {
    this.calls.push(`put ${sourceId}`);
    this.log.push(`put ${sourceId}`);
    this.bodies.set(sourceId, body);
    this.onPut?.(sourceId);
    const next = this.anyPut.shift() ?? this.putScript.get(sourceId)?.shift() ?? { kind: 'accepted' };
    if (next instanceof Error) throw next;
    return next;
  }

  async delete(sourceId: string): Promise<DeleteOutcome> {
    this.calls.push(`delete ${sourceId}`);
    const next = this.deleteScript.get(sourceId)?.shift() ?? { kind: 'gone' };
    if (next instanceof Error) throw next;
    return next;
  }
}

function row(sourceId: string, vault_path: string, text: string, over: Partial<ServerSource> = {}): ServerSource {
  return {
    source_id: sourceId,
    vault_path,
    body_hash: noteHash(text),
    status: 'done',
    deleted: false,
    last_error: null,
    undo_report: null,
    ...over,
  };
}

function stamped(n: number, body = `note ${n}\n`): string {
  return `---\njavis_source_id: ${id(n)}\n---\n${body}`;
}

function setup(files: Record<string, string>, over: Partial<UploadDeps> = {}) {
  const vault = new FakeUploadVault(files);
  const api = new FakeSourcesApi(vault.log);
  let next = 100;
  const marks: string[] = [];
  const sleep = vi.fn(async (_ms: number) => {});
  const deps = (more: Partial<UploadDeps> = {}): UploadDeps => ({
    api,
    vault,
    folders: ['Journal'],
    memory: {},
    now: () => T0,
    newId: () => id(next++),
    reuploadAll: false,
    release: [],
    sleep,
    selfWrites: {
      mark: (path) => {
        marks.push(path);
        vault.log.push(`mark ${path}`);
      },
    },
    readTimeoutMs: 20,
    ...over,
    ...more,
  });
  return { vault, api, deps, marks, sleep };
}

// ---------------------------------------------------------------------------
// The stamp and the PUT
// ---------------------------------------------------------------------------

describe('uploadOnce: stamp before PUT (§F.2)', () => {
  it('marks, stamps, then PUTs the id that is now in the file', async () => {
    const { vault, api, deps } = setup({ 'Journal/new.md': '# New\nhello\n' });
    const result = await uploadOnce(deps());

    expect(vault.log.filter((l) => !l.startsWith('read'))).toEqual([
      'mark Journal/new.md',
      'process Journal/new.md',
      `put ${id(100)}`,
    ]);
    const text = vault.files.get('Journal/new.md')!;
    expect(readSourceId(text)).toEqual({ id: id(100), valid: true });
    const body = api.bodies.get(id(100))!;
    expect(body).toEqual({
      vault_path: 'Journal/new.md',
      title: 'new',
      text: uploadText(text),
      body_hash: noteHash(text),
    });
    // The stamp is invisible to the hash: the sent text is the note as written.
    expect(body.text).toBe('# New\nhello\n');
    expect(result).toMatchObject({ uploaded: 1, stamped: 1, failures: [], stoppedBy: null });
    expect(result.nextMemory[id(100)]).toEqual({
      path: 'Journal/new.md',
      hash: noteHash(text),
      bytes: 12,
      bodyBytes: 12, // no frontmatter left after the javis_* line: the whole note is body
      contentKey: contentKey(text),
      missingSince: null,
    });
  });

  it('adopts another device\'s stamp that landed before ours (D-STAMP-3)', async () => {
    const { vault, api, deps } = setup({ 'Journal/new.md': 'hello\n' });
    vault.beforeProcess = (path) => vault.files.set(path, stamped(7, 'hello\n'));
    await uploadOnce(deps());
    expect(api.calls).toEqual(['list', `put ${id(7)}`]);
    expect(vault.files.get('Journal/new.md')).toBe(stamped(7, 'hello\n'));
  });

  it('an interrupted run leaves the id on disk, and the next run reuses it (obsync #181)', async () => {
    const { vault, api, deps } = setup({ 'Journal/new.md': 'hello\n' });
    api.anyPut.push(new NetworkError('offline'));
    const first = await uploadOnce(deps());
    expect(first.stoppedBy?.code).toBe('network');
    expect(readSourceId(vault.files.get('Journal/new.md')!)?.id).toBe(id(100));

    api.calls.length = 0;
    const second = await uploadOnce(deps({ memory: first.nextMemory }));
    expect(api.calls).toEqual(['list', `put ${id(100)}`]);
    expect(second.stamped).toBe(0);
    expect(second.uploaded).toBe(1);
  });

  it('restamps a copy with a fresh id and uploads it as a new source', async () => {
    const original = stamped(1);
    const { vault, api, deps } = setup({ 'Journal/a.md': original, 'Journal/b.md': original });
    api.listing = { sources: [row(id(1), 'Journal/a.md', original)], counts: {} };
    const result = await uploadOnce(deps());
    expect(readSourceId(vault.files.get('Journal/b.md')!)?.id).toBe(id(100));
    expect(vault.files.get('Journal/a.md')).toBe(original);
    expect(api.calls).toEqual(['list', `put ${id(100)}`]);
    expect(result.stamped).toBe(1);
  });
});

describe('uploadOnce: reads', () => {
  it('a read that never resolves is unreadable: no put, no delete', async () => {
    const text = stamped(1);
    const { vault, api, deps } = setup({ 'Journal/a.md': text });
    vault.hang.add('Journal/a.md');
    api.listing = { sources: [row(id(1), 'Journal/a.md', text)], counts: {} };
    const result = await uploadOnce(deps({ memory: { [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 10, missingSince: T0 - DEBOUNCE_MS } } }));
    expect(api.calls).toEqual(['list']);
    expect(result.skipped).toEqual([{ path: 'Journal/a.md', reason: 'unreadable' }]);
  });

  it('a failing read is unreadable too', async () => {
    const { vault, api, deps } = setup({ 'Journal/a.md': 'x' });
    vault.fail.add('Journal/a.md');
    const result = await uploadOnce(deps());
    expect(api.calls).toEqual(['list']);
    expect(result.skipped).toEqual([{ path: 'Journal/a.md', reason: 'unreadable' }]);
  });

  it('an unreadable note keeps its row present through the metadataCache id (D-PLAN-3, review)', async () => {
    // Another device renamed a.md (id 1) to b.md; here b.md is dataless and
    // its read hangs, but the cache still knows its id. Row 1 is not missing,
    // and b.md does not count as an unexplained unknown that holds deletes.
    const { vault, api, deps } = setup({ 'Journal/b.md': stamped(1), 'Journal/c.md': stamped(3) });
    vault.hang.add('Journal/b.md');
    vault.cached.set('Journal/b.md', id(1));
    api.listing = {
      sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(3), 'Journal/c.md', stamped(3)), row(id(9), 'Journal/gone.md', 'x')],
      counts: {},
    };
    const memory = {
      [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 10, missingSince: null },
      [id(3)]: { path: 'Journal/c.md', hash: null, bytes: 10, missingSince: null },
      [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS },
    };
    const result = await uploadOnce(deps({ memory }));
    expect(result.nextMemory[id(1)]!.missingSince).toBeNull();
    expect(result.waiting).toEqual([]);
    expect(result.held).toEqual([]);
    // With no ambiguity, the unrelated delete goes out.
    expect(api.calls).toEqual(['list', `delete ${id(9)}`]);
  });

  it('a malformed note falls back to the metadataCache id when the lenient scan finds none (review)', async () => {
    // The fence was broken while the metadata cache still holds the note's
    // properties from before, id included; the text itself shows no id line.
    const broken = `---\ntitle: moved\nno close\n`;
    const { vault, api, deps } = setup({ 'Journal/b.md': broken, 'Journal/c.md': stamped(3) });
    vault.cached.set('Journal/b.md', id(1));
    api.listing = {
      sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(3), 'Journal/c.md', stamped(3)), row(id(9), 'Journal/gone.md', 'x')],
      counts: {},
    };
    const memory = {
      [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 10, missingSince: null },
      [id(3)]: { path: 'Journal/c.md', hash: null, bytes: 10, missingSince: null },
      [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS },
    };
    const result = await uploadOnce(deps({ memory }));
    expect(result.nextMemory[id(1)]!.missingSince).toBeNull();
    expect(result.waiting).toEqual([]);
    expect(result.held).toEqual([]);
    expect(api.calls).toEqual(['list', `delete ${id(9)}`]);
    expect(vault.files.get('Journal/b.md')).toBe(broken);
  });

  it('describeNote flags malformed notes and finds their id leniently', () => {
    const n = describeNote('Journal/a.md', `---\njavis_source_id: ${id(3)}\nno close\n`, null);
    expect(n).toMatchObject({ malformed: true, sourceId: id(3) });
    expect(lenientSourceId('nothing')).toBeNull();
    expect(describeNote('Journal/b.md', '---\njavis_source_id: nope\n---\n', null)).toMatchObject({
      invalidId: true,
      sourceId: null,
    });
    expect(describeNote('Journal/c.md', '\n  \n', null).blank).toBe(true);
    expect(describeNote('Journal/d.md', 'bad \ud800', null)).toMatchObject({ invalidChars: true, hash: null });
    // NUL: the server refuses it in text and title with a 400 (contract
    // review), so it is a skip the user can see, not a PUT that fails every run.
    expect(describeNote('Journal/e.md', 'bad \u0000 byte', null)).toMatchObject({ invalidChars: true, hash: null });
    expect(describeNote('Journal/f.md', '---\ntitle: a\u0000b\n---\nbody\n', null)).toMatchObject({
      invalidChars: true,
      hash: null,
    });
  });

  it('describeNote: a malformed note with a damaged id line is invalid-id, one with none is not (review)', () => {
    // A damaged id inside an unclosed fence could be any tracked note: it must
    // stay identity-unknown, or the planner would treat it as a plain new note.
    expect(describeNote('J/a.md', '---\njavis_source_id: 12ab\nno close\n', null)).toMatchObject({
      malformed: true,
      invalidId: true,
      sourceId: null,
    });
    // A horizontal rule at the top, no id line anywhere: fully read, carries no identity.
    expect(describeNote('J/b.md', '---\nIdeas\n- a\n', null)).toMatchObject({
      malformed: true,
      invalidId: false,
      sourceId: null,
    });
  });
});

describe('uploadOnce: cancellation and failures', () => {
  it('stops between notes when the signal aborts', async () => {
    const controller = new AbortController();
    const { vault, api, deps } = setup({ 'Journal/a.md': stamped(1, 'a\n'), 'Journal/b.md': stamped(2, 'b\n') });
    api.onPut = () => controller.abort();
    const result = await uploadOnce(deps({ signal: controller.signal }));
    expect(api.calls).toEqual(['list', `put ${id(1)}`]);
    expect(result.stoppedBy?.code).toBe('cancelled');
    expect(result.uploaded).toBe(1);
    expect(vault.files.get('Journal/b.md')).toBe(stamped(2, 'b\n'));
  });

  it('stops during the reads when the signal aborts, and reads nothing more (review)', async () => {
    const controller = new AbortController();
    const files = { 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2), 'Journal/c.md': stamped(3) };
    const { vault, api, deps } = setup(files);
    for (const path of Object.keys(files)) vault.hang.add(path);
    const readFresh = vault.readFresh.bind(vault);
    vault.readFresh = (path: string) => {
      // The plugin unloads while the first (dataless) read is blocked.
      controller.abort();
      return readFresh(path);
    };
    const result = await uploadOnce(deps({ signal: controller.signal }));
    expect(result.stoppedBy?.code).toBe('cancelled');
    expect(vault.log.filter((l) => l.startsWith('read'))).toEqual(['read Journal/a.md']);
    expect(api.calls).toEqual(['list']);
    expect(result.planned).toBe(false);
  });

  it('a bare 403 stops the run without a step-up: it will be the same for every note (D-AUTH-4, review)', async () => {
    const stepUp = vi.fn(async () => {});
    const { api, deps } = setup({ 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2) });
    api.anyPut.push(new HttpError(403, 'forbidden'));
    const result = await uploadOnce(deps({ stepUp }));
    expect(result.stoppedBy?.code).toBe('http');
    expect(api.calls).toEqual(['list', `put ${id(1)}`]);
    expect(stepUp).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
  });

  it('a server URL that is not the tokens\' origin stops the run at the first request (review)', async () => {
    const { api, deps } = setup({ 'Journal/b.md': stamped(2), 'Journal/c.md': stamped(3) });
    api.anyPut.push(new OriginChangedError('https://mcp.javis.is', 'https://attacker.example'));
    const result = await uploadOnce(deps());
    expect(result.stoppedBy).toMatchObject({ code: 'origin-changed', needsUserAction: true });
    expect(api.calls).toEqual(['list', `put ${id(2)}`]);
    expect(result.failures).toEqual([]);
  });

  it('a refused DELETE is a failure, and the id stays remembered (review)', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listing = { sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(9), 'Journal/gone.md', 'x')], counts: {} };
    api.deleteScript.set(id(9), [{ kind: 'rejected', message: 'row is busy' }]);
    const memory = { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS } };
    const result = await uploadOnce(deps({ memory }));
    expect(api.calls).toEqual(['list', `delete ${id(9)}`]);
    expect(result.removed).toBe(0);
    expect(result.failures).toEqual([{ path: 'Journal/gone.md', message: 'could not be removed: row is busy' }]);
    expect(result.nextMemory[id(9)]).toBeDefined();
    expect(summarizeUpload(result)).toBe('1 failed');
  });

  it('collects a 400 per note and carries on; memory only for the success', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1, 'a\n'), 'Journal/b.md': stamped(2, 'b\n') });
    api.putScript.set(id(1), [{ kind: 'rejected', message: 'body_hash does not match text' }]);
    const result = await uploadOnce(deps());
    expect(api.calls).toEqual(['list', `put ${id(1)}`, `put ${id(2)}`]);
    expect(result.failures).toEqual([{ path: 'Journal/a.md', message: 'body_hash does not match text' }]);
    expect(Object.keys(result.nextMemory)).toEqual([id(2)]);
  });

  it('a 5xx is one note\'s failure, not the run\'s', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1, 'a\n'), 'Journal/b.md': stamped(2, 'b\n') });
    api.putScript.set(id(1), [new HttpError(502, 'bad gateway')]);
    const result = await uploadOnce(deps());
    expect(result.failures).toHaveLength(1);
    expect(result.uploaded).toBe(1);
    expect(result.stoppedBy).toBeNull();
  });

  it('an auth failure stops the run, and memory still carries missingSince', async () => {
    const gone = row(id(9), 'Journal/gone.md', 'x');
    const { api, deps } = setup({ 'Journal/a.md': stamped(1, 'a\n'), 'Journal/b.md': stamped(2, 'b\n') });
    api.listing = { sources: [gone], counts: {} };
    api.anyPut.push(new AuthRevokedError('Reconnect.'));
    const result = await uploadOnce(
      deps({ memory: { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: null, missingSince: null } } }),
    );
    expect(api.calls).toEqual(['list', `put ${id(1)}`]);
    expect(result.stoppedBy).toEqual({ code: 'auth-revoked', message: 'Reconnect.', needsUserAction: true });
    expect(result.nextMemory[id(9)]!.missingSince).toBe(T0);
  });

  it('409 is a per-note failure that says it will come back (D-RUN-6); 413 is oversize', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1, 'a\n'), 'Journal/b.md': stamped(2, 'b\n') });
    api.putScript.set(id(1), [{ kind: 'conflict-deleted' }]);
    api.putScript.set(id(2), [{ kind: 'oversize' }]);
    const result = await uploadOnce(deps());
    expect(result.failures).toEqual([{ path: 'Journal/a.md', message: expect.stringMatching(/removed from Javis/) }]);
    expect(result.skipped).toEqual([{ path: 'Journal/b.md', reason: 'oversize' }]);
  });
});

describe('uploadOnce: 429 backoff (D-RUN-5)', () => {
  it('backs off 1s, then 2s, and succeeds', async () => {
    const { api, deps, sleep } = setup({ 'Journal/a.md': stamped(1) });
    api.anyPut.push(new RateLimitedError(null), new RateLimitedError(null));
    const result = await uploadOnce(deps());
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(result.uploaded).toBe(1);
  });

  it('honours Retry-After', async () => {
    const { api, deps, sleep } = setup({ 'Journal/a.md': stamped(1) });
    api.anyPut.push(new RateLimitedError(7000));
    await uploadOnce(deps());
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7000]);
  });

  it('five 429s in a row stop the run', async () => {
    const { api, deps, sleep } = setup({ 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2) });
    for (let i = 0; i < 5; i += 1) api.anyPut.push(new RateLimitedError(null));
    const result = await uploadOnce(deps());
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(result.stoppedBy?.code).toBe('rate-limited');
    expect(api.calls).not.toContain(`put ${id(2)}`);
  });
});

describe('uploadOnce: step-up once (§C.7, D-AUTH-4)', () => {
  it('re-authorizes once and retries the request', async () => {
    const stepUp = vi.fn(async () => {});
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.anyPut.push(new InsufficientScopeError());
    const result = await uploadOnce(deps({ stepUp }));
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(api.calls).toEqual(['list', `put ${id(1)}`, `put ${id(1)}`]);
    expect(result.uploaded).toBe(1);
  });

  it('a second 403 stops the run, and step-up is not tried again', async () => {
    const stepUp = vi.fn(async () => {});
    const { api, deps } = setup({ 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2) });
    api.anyPut.push(new InsufficientScopeError(), new InsufficientScopeError());
    const result = await uploadOnce(deps({ stepUp }));
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy?.code).toBe('insufficient-scope');
    expect(api.calls).not.toContain(`put ${id(2)}`);
  });

  it('without a stepUp (a background trigger) the first 403 stops the run', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.anyPut.push(new InsufficientScopeError());
    const result = await uploadOnce(deps());
    expect(result.stoppedBy).toMatchObject({ code: 'insufficient-scope', needsUserAction: true });
  });

  it('a step-up the user abandons stops the run with the reconnect sentence', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.anyPut.push(new InsufficientScopeError());
    const result = await uploadOnce(deps({ stepUp: async () => Promise.reject(new Error('closed tab')) }));
    expect(result.stoppedBy?.code).toBe('insufficient-scope');
  });
});

describe('uploadOnce: an id-less note at a tracked path gets its id back (D-PLAN-4, review)', () => {
  it('writes the row id into the note, then PUTs that id', async () => {
    const body = 'note 1\n';
    const { vault, api, deps } = setup({ 'Journal/a.md': body });
    api.listing = { sources: [row(id(1), 'Journal/a.md', body)], counts: {} };
    const result = await uploadOnce(deps({ memory: { [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 7, missingSince: T0 - DEBOUNCE_MS } } }));
    expect(readSourceId(vault.files.get('Journal/a.md')!)).toEqual({ id: id(1), valid: true });
    expect(api.calls).toEqual(['list', `put ${id(1)}`]);
    expect(result.stamped).toBe(1);
    expect(result.nextMemory[id(1)]!.missingSince).toBeNull();
  });

  it('leaves a 0-byte file alone and deletes nothing', async () => {
    const { vault, api, deps } = setup({ 'Journal/a.md': '' });
    api.listing = { sources: [row(id(1), 'Journal/a.md', 'note 1\n')], counts: {} };
    const result = await uploadOnce(deps({ memory: { [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 5000, missingSince: T0 - DEBOUNCE_MS } } }));
    expect(api.calls).toEqual(['list']);
    expect(vault.files.get('Journal/a.md')).toBe('');
    expect(result.skipped).toEqual([{ path: 'Journal/a.md', reason: 'blank' }]);
  });

  it('does not PUT when another device wrote a different id first', async () => {
    const body = 'note 1\n';
    const { vault, api, deps } = setup({ 'Journal/a.md': body });
    api.listing = { sources: [row(id(1), 'Journal/a.md', body)], counts: {} };
    vault.beforeProcess = (path) => vault.files.set(path, stamped(9, body));
    const result = await uploadOnce(deps({ memory: { [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 7, missingSince: null } } }));
    expect(api.calls).toEqual(['list']);
    expect(result.failures).toHaveLength(1);
    expect(readSourceId(vault.files.get('Journal/a.md')!)?.id).toBe(id(9));
  });
});

describe('describeNote: wiki pages (§A, review)', () => {
  it('flags a note carrying the download\'s javis_slug or javis_type', () => {
    expect(describeNote('J/a.md', '---\ntitle: A\njavis_type: concept\njavis_slug: a\n---\nbody\n', null).wikiPage).toBe(true);
    expect(describeNote('J/a.md', '---\njavis_slug: a\n---\n', null).wikiPage).toBe(true);
    expect(describeNote('J/a.md', '---\ntitle: A\n---\njavis_slug: in the body\n', null).wikiPage).toBe(false);
    expect(describeNote('J/a.md', stamped(1), null).wikiPage).toBe(false);
  });
});

describe('uploadOnce: step-up before anything is written (review of §C.7)', () => {
  it('a token that visibly cannot write steps up before the first request, so no note is stamped first', async () => {
    let canWrite = false;
    const stepUp = vi.fn(async () => {
      canWrite = true;
    });
    const { vault, api, deps } = setup({ 'Journal/new.md': '# New\nhello\n' });
    vault.log.length = 0;
    const result = await uploadOnce(deps({ stepUp, lacksWriteGrant: () => !canWrite }));
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy).toBeNull();
    expect(api.calls[0]).toBe('list');
    expect(result.uploaded).toBe(1);
  });

  it('a declined or abandoned step-up stops the run before any stamp or request', async () => {
    const { vault, api, deps } = setup({ 'Journal/new.md': '# New\nhello\n' });
    const declined = await uploadOnce(deps({ stepUp: async () => {}, lacksWriteGrant: () => true }));
    expect(declined.stoppedBy).toMatchObject({ code: 'insufficient-scope', needsUserAction: true });
    const abandoned = await uploadOnce(
      deps({ stepUp: async () => Promise.reject(new Error('closed tab')), lacksWriteGrant: () => true }),
    );
    expect(abandoned.stoppedBy?.code).toBe('insufficient-scope');
    expect(api.calls).toEqual([]);
    expect(vault.files.get('Journal/new.md')).toBe('# New\nhello\n');
    expect(vault.log.filter((l) => l.startsWith('process'))).toEqual([]);
  });

  it('the pre-flight step-up spends the run budget: a later 403 stops the run', async () => {
    let canWrite = false;
    const stepUp = vi.fn(async () => {
      canWrite = true;
    });
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.anyPut.push(new InsufficientScopeError());
    const result = await uploadOnce(deps({ stepUp, lacksWriteGrant: () => !canWrite }));
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy?.code).toBe('insufficient-scope');
  });

  it('dates a miss after the step-up, so two runs a minute apart cannot delete (§F.3.3, review)', async () => {
    // T0: Sync now with a read-only token. The user spends 8 minutes on the
    // consent screen; only then is the vault listed and gone.md found missing.
    let clock = T0;
    let canWrite = false;
    const stepUp = vi.fn(async () => {
      clock = T0 + 8 * 60_000;
      canWrite = true;
    });
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listing = { sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(9), 'Journal/gone.md', 'x')], counts: {} };
    const memory = { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: null } };
    const first = await uploadOnce(deps({ memory, now: () => clock, stepUp, lacksWriteGrant: () => !canWrite }));
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(first.nextMemory[id(9)]!.missingSince).toBe(T0 + 8 * 60_000);

    // One minute later the note is still missing: that is one minute between
    // the two misses, not nine, so the delete waits.
    clock = T0 + 9 * 60_000;
    api.calls.length = 0;
    const second = await uploadOnce(deps({ memory: first.nextMemory, now: () => clock }));
    expect(api.calls).toEqual(['list']);
    expect(second.waiting).toEqual([{ sourceId: id(9), path: 'Journal/gone.md', eligibleAt: T0 + 8 * 60_000 + DEBOUNCE_MS }]);
  });

  it('without a stepUp (background) a token that cannot write makes no request', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps({ lacksWriteGrant: () => true }));
    expect(result.stoppedBy).toMatchObject({ code: 'insufficient-scope', needsUserAction: true });
    expect(api.calls).toEqual([]);
  });
});

describe('uploadOnce: only in the account this vault uploaded to (rule 8, review)', () => {
  const A = 'https://mcp.javis.is user_a';
  const B = 'https://mcp.javis.is user_b';

  it('a run in the bound account goes ahead and reports it', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps({ account: () => A, expectedAccount: A }));
    expect(result.stoppedBy).toBeNull();
    expect(result.account).toBe(A);
    expect(api.calls).toEqual(['list', `put ${id(1)}`]);
  });

  it('the first run binds: no expected account, the current one is reported', async () => {
    const { deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps({ account: () => B, expectedAccount: null }));
    expect(result.account).toBe(B);
  });

  it('another account stops the run before any request, stamp or delete', async () => {
    const { vault, api, deps } = setup({ 'Journal/new.md': 'hello\n', 'Journal/a.md': stamped(1) });
    const memory = { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS } };
    const result = await uploadOnce(deps({ memory, account: () => B, expectedAccount: A }));
    expect(result.stoppedBy).toMatchObject({ code: 'account-changed', needsUserAction: true });
    expect(api.calls).toEqual([]);
    expect(vault.log).toEqual([]);
    expect(result.nextMemory).toEqual(memory);
    expect(result.account).toBeNull();
  });

  it('an account that cannot be read is not the bound one', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps({ account: () => null, expectedAccount: A }));
    expect(result.stoppedBy?.code).toBe('account-changed');
    expect(api.calls).toEqual([]);
  });

  it('the pre-flight step-up signing in as someone else stops the run', async () => {
    let who = A;
    let canWrite = false;
    const stepUp = vi.fn(async () => {
      who = B;
      canWrite = true;
    });
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(
      deps({ stepUp, lacksWriteGrant: () => !canWrite, account: () => who, expectedAccount: A }),
    );
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy?.code).toBe('account-changed');
    expect(api.calls).toEqual([]);
  });

  it('a mid-run step-up that returns as someone else drops the plan', async () => {
    let who = A;
    const stepUp = vi.fn(async () => {
      who = B;
    });
    const { api, deps } = setup({ 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2) });
    api.listing = { sources: [row(id(9), 'Journal/gone.md', 'x')], counts: {} };
    api.anyPut.push(new InsufficientScopeError());
    const memory = { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS } };
    const result = await uploadOnce(deps({ memory, stepUp, account: () => who, expectedAccount: A }));
    expect(result.stoppedBy?.code).toBe('account-changed');
    // The 403'd PUT is not retried in the new account, and nothing after it runs.
    expect(api.calls).toEqual(['list', `put ${id(1)}`]);
  });

  it('without an account reader (tests, old wiring) nothing is checked', async () => {
    const { deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps({ expectedAccount: A }));
    expect(result.stoppedBy).toBeNull();
  });
});

describe('uploadOnce: deletes and holds', () => {
  it('deletes a row missing past the debounce and forgets it', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    const a = row(id(1), 'Journal/a.md', stamped(1));
    const gone = row(id(9), 'Journal/gone.md', 'x');
    api.listing = { sources: [a, gone], counts: {} };
    const memory = { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS } };
    const result = await uploadOnce(deps({ memory }));
    expect(api.calls).toEqual(['list', `delete ${id(9)}`]);
    expect(result.removed).toBe(1);
    expect(result.nextMemory[id(9)]).toBeUndefined();
  });

  it('holds a mass change and sends nothing; a release sends the released one', async () => {
    const files: Record<string, string> = {};
    const sources: ServerSource[] = [];
    const memory: UploadDeps['memory'] = {};
    for (let n = 1; n <= 10; n += 1) {
      const path = `Journal/n${n}.md`;
      sources.push(row(id(n), path, stamped(n)));
      if (n > 6) files[path] = stamped(n);
      else memory[id(n)] = { path, hash: null, bytes: 10, missingSince: T0 - DEBOUNCE_MS };
    }
    const { api, deps } = setup(files);
    api.listing = { sources, counts: {} };
    const held = await uploadOnce(deps({ memory }));
    expect(api.calls).toEqual(['list']);
    expect(held.held).toHaveLength(6);

    api.calls.length = 0;
    const released = await uploadOnce(deps({ memory, release: [`delete:${id(3)}`] }));
    expect(api.calls).toEqual(['list', `delete ${id(3)}`]);
    expect(released.held).toHaveLength(5);
  });

  it('reports this vault\'s undo reports and the counts from the listing', async () => {
    const report = { pages_tombstoned: 1, pages_rebuilt: 3, pages_marked_stale: 2, pages_skipped_adopted: 0 };
    const { api, deps } = setup({});
    api.listing = {
      sources: [row(id(5), 'Journal/old.md', 'x', { deleted: true, status: 'deleted', undo_report: report })],
      counts: { deleted: 1 },
    };
    // An earlier run of this vault removed id 5; the report arrives now.
    const result = await uploadOnce(deps({ removedIds: [id(5)] }));
    expect(result.undoReports).toEqual([{ path: 'Journal/old.md', report }]);
    expect(result.counts).toEqual({ deleted: 1 });
  });

  it('never reports another vault\'s undo reports: the listing is per account (review)', async () => {
    const report = { pages_tombstoned: 1, pages_rebuilt: 0, pages_marked_stale: 0, pages_skipped_adopted: 0 };
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listing = {
      sources: [
        row(id(1), 'Journal/a.md', stamped(1)),
        // A row this vault still remembers, whose undo already ran.
        row(id(2), 'Journal/b.md', 'x', { deleted: true, status: 'deleted', undo_report: report }),
        // Removed by this vault on an earlier run.
        row(id(3), 'Journal/c.md', 'x', { deleted: true, status: 'deleted', undo_report: report }),
        // The user's other vault.
        row(id(4), 'Personal/Health/therapy.md', 'x', { deleted: true, status: 'deleted', undo_report: report }),
      ],
      counts: {},
    };
    const memory = { [id(2)]: { path: 'Journal/b.md', hash: null, bytes: 1, missingSince: null } };
    const result = await uploadOnce(deps({ memory, removedIds: [id(3)] }));
    expect(result.undoReports.map((u) => u.path)).toEqual(['Journal/b.md', 'Journal/c.md']);
  });

  it('a run that removes a row lists its id for the next run to recognise the undo report', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listing = { sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(9), 'Journal/gone.md', 'x')], counts: {} };
    const memory = { [id(9)]: { path: 'Journal/gone.md', hash: null, bytes: 1, missingSince: T0 - DEBOUNCE_MS } };
    const result = await uploadOnce(deps({ memory }));
    expect(result.removedIds).toEqual([id(9)]);
    expect(nextRemovedIds([id(3), id(9)], result.removedIds)).toEqual([id(3), id(9)]);
    expect(nextRemovedIds([id(9), id(3)], result.removedIds)).toEqual([id(3), id(9)]);
    const many = Array.from({ length: 250 }, (_, i) => id(1000 + i));
    expect(nextRemovedIds(many, [id(9)])).toHaveLength(200);
    expect(nextRemovedIds(many, [id(9)]).at(-1)).toBe(id(9));
  });

  it('names this vault\'s rows the server gave up distilling, with their error (§D.5, review)', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listing = {
      sources: [
        row(id(1), 'Journal/a.md', stamped(1), { status: 'failed', last_error: 'model output was not valid JSON' }),
        row(id(2), 'Journal/b.md', 'x', { status: 'failed', last_error: null }),
        // Another vault's failed row is not this vault's to report.
        row(id(3), 'Work/c.md', 'x', { status: 'failed', last_error: 'boom' }),
      ],
      counts: { failed: 3 },
    };
    const memory = { [id(2)]: { path: 'Journal/b.md', hash: null, bytes: null, missingSince: null } };
    const result = await uploadOnce(deps({ memory }));
    expect(result.serverFailures).toEqual([
      { path: 'Journal/a.md', message: 'model output was not valid JSON' },
      { path: 'Journal/b.md', message: 'the server could not add it to the wiki' },
    ]);
  });
});

describe('uploadOnce: nothing to do without a valid selection', () => {
  it('no folders and nothing ever uploaded -> no API call at all (D-RUN-2)', async () => {
    const { api, deps } = setup({ 'Journal/a.md': 'x' });
    const result = await uploadOnce(deps({ folders: [] }));
    expect(api.calls).toEqual([]);
    expect(result.ran).toBe(false);
  });

  it('no folders but remembered uploads -> the delete half still runs (D-PLAN-13)', async () => {
    const { vault, api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listing = { sources: [row(id(1), 'Journal/a.md', stamped(1))], counts: {} };
    const memory = { [id(1)]: { path: 'Journal/a.md', hash: null, bytes: 10, missingSince: T0 - DEBOUNCE_MS } };
    const result = await uploadOnce(deps({ folders: [], memory }));
    expect(result.ran).toBe(true);
    expect(api.calls).toEqual(['list', `delete ${id(1)}`]);
    expect(result.removed).toBe(1);
    expect(result.nextMemory).toEqual({});
    // Nothing in the vault is read or touched.
    expect(vault.log).toEqual([]);
  });

  it('invalid folders -> no API call, reported', async () => {
    const { api, deps } = setup({ 'Journal/a.md': 'x' });
    const result = await uploadOnce(deps({ folders: ['Journal', 'Concepts'] }));
    expect(api.calls).toEqual([]);
    expect(result.invalidFolders).toMatchObject([{ folder: 'Concepts' }]);
  });

  it('a GET failure means no PUT and no DELETE', async () => {
    const { vault, api, deps } = setup({ 'Journal/a.md': 'x' });
    api.listError = new ProtocolError('bad listing');
    const result = await uploadOnce(deps());
    expect(api.calls).toEqual(['list']);
    expect(vault.log).toEqual([]);
    expect(result.stoppedBy?.code).toBe('protocol');
  });
});

describe('Re-upload all survives a failed PUT (review)', () => {
  it('records which re-sends failed and which notes were sent', async () => {
    const files = { 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2), 'Journal/c.md': stamped(3) };
    const { api, deps } = setup(files);
    api.listing = { sources: [1, 2, 3].map((n) => row(id(n), `Journal/${'abc'[n - 1]}.md`, stamped(n))), counts: {} };
    api.putScript.set(id(2), [new HttpError(503, 'unavailable')]);
    api.putScript.set(id(3), [{ kind: 'rejected', message: 'bad path' }]);
    const result = await uploadOnce(deps({ reuploadAll: true }));
    expect(result.stoppedBy).toBeNull();
    expect(result.sentIds).toEqual([id(1)]);
    // A 5xx is worth retrying; a 400 is the note's own problem and is shown once.
    expect(result.retryIds).toEqual([id(2)]);
  });

  it('nextPendingReupload: keeps the failed ids until they go out, and forgets ones no longer remembered', () => {
    const memory = { [id(1)]: null, [id(2)]: null, [id(4)]: null } as unknown as Record<string, never>;
    expect(nextPendingReupload([id(4), id(9)], { retryIds: [id(2)], sentIds: [id(1)], nextMemory: memory })).toEqual([
      id(2),
      id(4),
    ]);
    expect(nextPendingReupload([id(2)], { retryIds: [], sentIds: [id(2)], nextMemory: memory })).toEqual([]);
  });

  it('a later run re-sends only the owed ids; the server answers 200 unchanged and the debt clears', async () => {
    // §E: an equal-hash PUT answers `200 unchanged`, and every re-send is
    // equal-hash by definition, so that is what the fake must say here.
    const { api, deps } = setup({ 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2) });
    api.listing = { sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(2), 'Journal/b.md', stamped(2))], counts: {} };
    api.putScript.set(id(2), [{ kind: 'unchanged' }]);
    const result = await uploadOnce(deps({ reuploadIds: [id(2)] }));
    expect(api.calls).toEqual(['list', `put ${id(2)}`]);
    expect(result.sentIds).toEqual([id(2)]);
    expect(result).toMatchObject({ uploaded: 0, unchanged: 1 });
    expect(nextPendingReupload([id(2)], result)).toEqual([]);
    expect(result.nextMemory[id(2)]).toMatchObject({ path: 'Journal/b.md', hash: noteHash(stamped(2)) });
  });

  it('Re-upload all against 200 unchanged: every id counts as sent, nothing stays owed', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1), 'Journal/b.md': stamped(2) });
    api.listing = { sources: [row(id(1), 'Journal/a.md', stamped(1)), row(id(2), 'Journal/b.md', stamped(2))], counts: {} };
    api.putScript.set(id(1), [{ kind: 'unchanged' }]);
    api.putScript.set(id(2), [{ kind: 'unchanged' }]);
    const result = await uploadOnce(deps({ reuploadAll: true }));
    expect(result.sentIds).toEqual([id(1), id(2)]);
    expect(result.unchanged).toBe(2);
    expect(nextPendingReupload([id(1), id(2)], result)).toEqual([]);
  });

  it('a rename answered 200 unchanged records the new path in memory', async () => {
    const { api, deps } = setup({ 'Journal/renamed.md': stamped(1) });
    api.listing = { sources: [row(id(1), 'Journal/old.md', stamped(1))], counts: {} };
    api.putScript.set(id(1), [{ kind: 'unchanged' }]);
    const memory = { [id(1)]: { path: 'Journal/old.md', hash: noteHash(stamped(1)), bytes: 7, missingSince: null } };
    const result = await uploadOnce(deps({ memory }));
    expect(api.bodies.get(id(1))!.vault_path).toBe('Journal/renamed.md');
    expect(result.sentIds).toEqual([id(1)]);
    expect(result.nextMemory[id(1)]).toMatchObject({ path: 'Journal/renamed.md', missingSince: null });
  });
});

describe('summarizeUpload', () => {
  const base = {
    uploaded: 0,
    unchanged: 0,
    removed: 0,
    stamped: 0,
    failures: [],
    skipped: [],
    held: [],
    waiting: [],
    invalidFolders: [],
    undoReports: [],
    serverFailures: [],
    sentIds: [],
    removedIds: [],
    retryIds: [],
    counts: {},
    nextMemory: {},
    stoppedBy: null,
    ran: true,
    planned: true,
    account: null,
  };

  it('lists the non-zero parts', () => {
    const held = Array(4).fill({ key: 'k', action: { kind: 'delete', sourceId: 'x', path: 'p' }, reason: 'mass-change' });
    expect(
      summarizeUpload({ ...base, uploaded: 3, unchanged: 1, removed: 2, held, failures: [{ path: 'a', message: 'm' }] }),
    ).toBe('3 uploaded, 1 unchanged, 2 removed, 4 held, 1 failed');
  });

  it('says so when there was nothing to do, or no folder', () => {
    expect(summarizeUpload(base)).toBe('nothing to upload');
    expect(summarizeUpload({ ...base, ran: false })).toBe('no upload folders');
  });

  it('appends why a run stopped', () => {
    expect(
      summarizeUpload({ ...base, stoppedBy: { code: 'network', message: 'offline', needsUserAction: false } }),
    ).toBe('nothing to upload; stopped: offline');
  });
});

describe('uploadReport: a run that never planned keeps the last lists (review)', () => {
  const heldDelete = { key: `delete:${id(1)}`, action: { kind: 'delete' as const, sourceId: id(1), path: 'J/a.md' }, reason: 'mass-change' as const };

  it('a GET failure keeps the held, skipped and waiting lists, and updates the rest', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    api.listError = new NetworkError('offline');
    const result = await uploadOnce(deps());
    expect(result.planned).toBe(false);
    const previous = uploadReport(
      null,
      { ...result, planned: true, stoppedBy: null, held: [heldDelete], serverFailures: [{ path: 'J/f.md', message: 'e' }], skipped: [{ path: 'J/b.md', reason: 'oversize' }], waiting: [{ sourceId: id(2), path: 'J/c.md', eligibleAt: T0 }] },
      'earlier',
      '2026-09-24T00:00:00.000Z',
    );
    const next = uploadReport(previous, result, 'stopped', '2026-09-24T01:00:00.000Z');
    expect(next.held).toEqual([heldDelete]);
    expect(next.serverFailures).toEqual([{ path: 'J/f.md', message: 'e' }]);
    expect(next.skipped).toEqual(previous.skipped);
    expect(next.waiting).toEqual(previous.waiting);
    expect(next.summary).toBe('stopped');
    expect(next.at).toBe('2026-09-24T01:00:00.000Z');
    expect(next.stoppedBy?.code).toBe('network');
  });

  it('a run that planned replaces the lists, even with empty ones', async () => {
    const { deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps());
    expect(result.planned).toBe(true);
    const previous = uploadReport(null, { ...result, held: [heldDelete] }, 'earlier', 'x');
    expect(uploadReport(previous, result, 'now', 'y').held).toEqual([]);
  });

  it('caps the lists and never persists memory', async () => {
    const { deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps());
    const skipped = Array.from({ length: 150 }, (_, i) => ({ path: `J/${i}.md`, reason: 'oversize' as const }));
    const report = uploadReport(null, { ...result, skipped }, 's', 'x');
    expect(report.skipped).toHaveLength(100);
    expect('nextMemory' in report).toBe(false);
  });
});
