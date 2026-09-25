/**
 * Tests for src/shell/upload.ts — `uploadOnce` against a fake vault and a fake
 * sources API. No Obsidian, no network, no real clock: the run's `now`, the
 * sleep, the ids and the read timeout are all injected.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEBOUNCE_MS } from '../src/core/upload';
import type { ServerSource } from '../src/core/upload';
import { noteHash, readSourceId, uploadText } from '../src/core/note-text';
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
  ProtocolError,
  RateLimitedError,
} from '../src/shell/errors';
import { describeNote, lenientSourceId, summarizeUpload, uploadOnce } from '../src/shell/upload';

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
  /** Simulates another device's write landing between our read and our process. */
  beforeProcess: ((path: string) => void) | null = null;

  constructor(files: Record<string, string> = {}) {
    for (const [p, t] of Object.entries(files)) this.files.set(p, t);
  }

  async listNotesIn(folders: readonly string[]) {
    return [...this.files.keys()]
      .filter((p) => folders.some((f) => p.startsWith(`${f}/`)))
      .sort()
      .map((path) => ({ path, cachedSourceId: null }));
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
    now: T0,
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
    const result = await uploadOnce(deps());
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
    const result = await uploadOnce(deps());
    expect(api.calls).toEqual(['list']);
    expect(result.failures).toHaveLength(1);
    expect(readSourceId(vault.files.get('Journal/a.md')!)?.id).toBe(id(9));
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

  it('without a stepUp (background) a token that cannot write makes no request', async () => {
    const { api, deps } = setup({ 'Journal/a.md': stamped(1) });
    const result = await uploadOnce(deps({ lacksWriteGrant: () => true }));
    expect(result.stoppedBy).toMatchObject({ code: 'insufficient-scope', needsUserAction: true });
    expect(api.calls).toEqual([]);
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

  it('reports undo reports and counts from the listing', async () => {
    const report = { pages_tombstoned: 1, pages_rebuilt: 3, pages_marked_stale: 2, pages_skipped_adopted: 0 };
    const { api, deps } = setup({});
    api.listing = {
      sources: [row(id(5), 'Journal/old.md', 'x', { deleted: true, status: 'deleted', undo_report: report })],
      counts: { deleted: 1 },
    };
    const result = await uploadOnce(deps());
    expect(result.undoReports).toEqual([{ path: 'Journal/old.md', report }]);
    expect(result.counts).toEqual({ deleted: 1 });
  });
});

describe('uploadOnce: nothing to do without a valid selection', () => {
  it('no folders -> no API call at all (D-RUN-2)', async () => {
    const { api, deps } = setup({ 'Journal/a.md': 'x' });
    const result = await uploadOnce(deps({ folders: [] }));
    expect(api.calls).toEqual([]);
    expect(result.ran).toBe(false);
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
    counts: {},
    nextMemory: {},
    stoppedBy: null,
    ran: true,
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
