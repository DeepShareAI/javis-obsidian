/**
 * `src/shell/sync.ts` — the §F.2 loop, against a fake vault and a fake client.
 *
 * This is the module §G's purity boundary was built to make testable: it takes
 * a `JavisApiClient` and a `VaultAdapter` and nothing else, so every branch of
 * the sync algorithm can be driven here without an Obsidian runtime and without
 * a network. `ObsidianVaultAdapter` is the part §H exempts from unit tests; the
 * orchestration is not, and it is where a mistake costs the user's notes.
 */

import { describe, expect, it, vi } from 'vitest';

import { JAVIS_DELETED, JAVIS_REV, JAVIS_SYNC } from '../src/core/types';
import { MARKER_END, MARKER_START } from '../src/core/markers';
import { TOMBSTONE_BANNER } from '../src/core/render';
import type {
  ExportBatch,
  ExportRun,
  ExportResponse,
  Frontmatter,
  JavisApiClient,
  ServerPage,
  SyncDeps,
  VaultAdapter,
  VaultNote,
} from '../src/shell/contracts';
import { HttpError, SyncCancelledError, VaultWriteError, AuthRevokedError } from '../src/shell/errors';
import { applyAction, decideAction, resolveCursor, summarize, syncOnce } from '../src/shell/sync';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeFile {
  content: string;
  frontmatter: Frontmatter | null;
}

class FakeVault implements VaultAdapter {
  readonly files = new Map<string, FakeFile>();
  /** Every mutation, in order — the loop's write sequence is part of the contract. */
  readonly calls: string[] = [];
  /** Paths whose next write throws, to exercise per-note failure isolation. */
  readonly failWrites = new Set<string>();

  seed(path: string, frontmatter: Frontmatter | null, content = ''): void {
    this.files.set(path, { content, frontmatter });
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path)?.content ?? null;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readFrontmatter(path: string): Promise<Frontmatter | null> {
    const file = this.files.get(path);
    return file === undefined ? null : file.frontmatter;
  }

  async create(path: string, content: string): Promise<void> {
    this.calls.push(`create ${path}`);
    this.#guard(path);
    this.files.set(path, { content, frontmatter: {} });
  }

  async process(path: string, transform: (content: string) => string): Promise<void> {
    this.calls.push(`process ${path}`);
    this.#guard(path);
    const file = this.files.get(path);
    if (file === undefined) throw new VaultWriteError(path, `No note at ${path}`);
    file.content = transform(file.content);
  }

  async writeFrontmatter(path: string, next: Frontmatter): Promise<void> {
    this.calls.push(`frontmatter ${path}`);
    this.#guard(path);
    const file = this.files.get(path);
    if (file === undefined) throw new VaultWriteError(path, `No note at ${path}`);
    // Replacement, not merge — the same semantics ObsidianVaultAdapter gives.
    file.frontmatter = { ...next };
  }

  async listMarkdownFiles(): Promise<readonly VaultNote[]> {
    return [...this.files.entries()].map(([path, file]) => ({
      path,
      frontmatter: file.frontmatter,
    }));
  }

  #guard(path: string): void {
    if (this.failWrites.has(path)) {
      throw new VaultWriteError(path, `Could not write ${path}: disk on fire`);
    }
  }
}

interface FakeBatch {
  pages: ServerPage[];
  serverTime: string;
}

class FakeApi implements JavisApiClient {
  /** `since` of every `exportAll` call, in order. */
  readonly sinceSeen: (string | null)[] = [];
  /** Thrown instead of running, once per entry, oldest first. */
  readonly throwQueue: unknown[] = [];

  constructor(private readonly batches: FakeBatch[]) {}

  async fetchBatch(): Promise<ExportResponse> {
    throw new Error('fetchBatch is not used by syncOnce');
  }

  async exportAll(opts: {
    since: string | null;
    limit?: number;
    signal?: AbortSignal;
    onBatch: (batch: ExportBatch) => Promise<void> | void;
  }): Promise<ExportRun> {
    this.sinceSeen.push(opts.since);
    const queued = this.throwQueue.shift();
    if (queued !== undefined) throw queued;

    let pages = 0;
    let index = 0;
    for (const batch of this.batches) {
      index += 1;
      pages += batch.pages.length;
      await opts.onBatch({
        pages: batch.pages,
        index,
        nextCursor: index === this.batches.length ? null : `cursor-${index}`,
        serverTime: batch.serverTime,
      });
    }
    return {
      serverTime: this.batches[0]?.serverTime ?? '1970-01-01T00:00:00Z',
      batches: index,
      pages,
    };
  }
}

function page(over: Partial<ServerPage> = {}): ServerPage {
  return {
    page_type: 'concept',
    slug: 'Agent-Builder',
    title: 'Agent Builder',
    updated_at: '2026-09-13T04:12:00Z',
    frontmatter: {},
    body: 'Body with [[Concepts/Foo]].',
    deleted_at: null,
    ...over,
  };
}

function deps(over: Partial<SyncDeps> & Pick<SyncDeps, 'api' | 'vault'>): SyncDeps {
  return { cachedCursor: null, trigger: 'command', ...over };
}

const CONCEPT_PATH = 'Concepts/Agent-Builder.md';

// ---------------------------------------------------------------------------
// resolveCursor — §F.1
// ---------------------------------------------------------------------------

describe('resolveCursor', () => {
  it('prefers the cached cursor and does not scan the vault', async () => {
    const vault = new FakeVault();
    const spy = vi.spyOn(vault, 'listMarkdownFiles');
    expect(await resolveCursor(vault, '2026-09-13T04:12:00Z')).toBe('2026-09-13T04:12:00Z');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to max(javis_rev) across the vault when data.json is gone', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-10T00:00:00Z' });
    vault.seed('Concepts/B.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    vault.seed('Concepts/C.md', { [JAVIS_REV]: '2026-09-11T00:00:00Z' });
    expect(await resolveCursor(vault, null)).toBe('2026-09-12T00:00:00Z');
  });

  it('treats an empty cached cursor as absent', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-10T00:00:00Z' });
    expect(await resolveCursor(vault, '')).toBe('2026-09-10T00:00:00Z');
  });

  it('is null on a vault that has never synced', async () => {
    expect(await resolveCursor(new FakeVault(), null)).toBeNull();
  });

  it('forces a full export while pendingFullResync is set, ignoring both cursors', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    const spy = vi.spyOn(vault, 'listMarkdownFiles');

    expect(await resolveCursor(vault, '2026-09-13T04:12:00Z', true)).toBeNull();
    expect(await resolveCursor(vault, null, true)).toBeNull();
    // Nothing to scan for: a full export is a full export.
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// decideAction — every branch routes through reconcile
// ---------------------------------------------------------------------------

describe('decideAction', () => {
  it('creates when no file is at the page path', async () => {
    const action = await decideAction(new FakeVault(), page());
    expect(action.kind).toBe('create');
    expect(action).toMatchObject({ path: CONCEPT_PATH });
  });

  it('skips an adopted page even though the revision differs', async () => {
    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, { [JAVIS_SYNC]: false, [JAVIS_REV]: '2020-01-01T00:00:00Z' });
    expect(await decideAction(vault, page())).toEqual({ kind: 'skip', reason: 'adopted' });
  });

  it('skips a matching revision', async () => {
    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, { [JAVIS_REV]: '2026-09-13T04:12:00Z' });
    expect(await decideAction(vault, page())).toEqual({ kind: 'skip', reason: 'unchanged' });
  });

  it('skips an unknown page type without touching the vault', async () => {
    const vault = new FakeVault();
    const spy = vi.spyOn(vault, 'readFrontmatter');
    expect(await decideAction(vault, page({ page_type: 'transcript' }))).toEqual({
      kind: 'skip',
      reason: 'unknown-type',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('tombstones a deleted row that has a file, and skips one that does not', async () => {
    const deleted = page({ deleted_at: '2026-09-13T05:00:00Z' });
    expect(await decideAction(new FakeVault(), deleted)).toEqual({
      kind: 'skip',
      reason: 'deleted-absent',
    });

    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, { [JAVIS_REV]: '2026-09-13T04:12:00Z' });
    expect(await decideAction(vault, deleted)).toEqual({ kind: 'tombstone', path: CONCEPT_PATH });
  });

  it('sanitizes the slug into the path it reads and writes', async () => {
    const vault = new FakeVault();
    const exists = vi.spyOn(vault, 'exists');
    const read = vi.spyOn(vault, 'readFrontmatter');
    vault.seed('Questions/Is RAG dead.md', { [JAVIS_REV]: 'ancient' });

    await decideAction(vault, page({ page_type: 'question', slug: 'Is RAG dead?' }));

    expect(exists).toHaveBeenCalledWith('Questions/Is RAG dead.md');
    expect(read).toHaveBeenCalledWith('Questions/Is RAG dead.md');
  });

  it('asks whether the FILE exists, not whether it has frontmatter we can read', async () => {
    // A note the user wrote by hand at a path we own, or one whose frontmatter
    // YAML no longer parses: `readFrontmatter` answers null for both, and
    // `create` against an occupied path fails on every run forever.
    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, null, 'Notes I wrote myself.\n');

    const action = await decideAction(vault, page());

    expect(action.kind).toBe('replace');
    if (action.kind !== 'replace') throw new Error('unreachable');
    expect(action.path).toBe(CONCEPT_PATH);
  });

  it('still creates when nothing is at the path, however empty the vault is', async () => {
    const vault = new FakeVault();
    const read = vi.spyOn(vault, 'readFrontmatter');
    expect((await decideAction(vault, page())).kind).toBe('create');
    // No file, so no frontmatter read to make: existence settled it.
    expect(read).not.toHaveBeenCalled();
  });

  it('tombstones a deleted row whose file has no readable frontmatter', async () => {
    // §F.2 branches on the file: `if file: blank the block, prepend a banner`.
    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, null, 'Notes I wrote myself.\n');
    expect(await decideAction(vault, page({ deleted_at: '2026-09-13T05:00:00Z' }))).toEqual({
      kind: 'tombstone',
      path: CONCEPT_PATH,
    });
  });
});

// ---------------------------------------------------------------------------
// applyAction — the doing
// ---------------------------------------------------------------------------

describe('applyAction', () => {
  it('create writes the rendered note', async () => {
    const vault = new FakeVault();
    await applyAction(vault, { kind: 'create', path: CONCEPT_PATH, content: 'rendered' });
    expect(vault.files.get(CONCEPT_PATH)?.content).toBe('rendered');
    expect(vault.calls).toEqual([`create ${CONCEPT_PATH}`]);
  });

  it('replace swaps the marker block and leaves the rest of the file alone', async () => {
    const vault = new FakeVault();
    vault.seed(
      CONCEPT_PATH,
      { [JAVIS_REV]: 'old' },
      `My own notes.\n\n${MARKER_START}\nold body\n${MARKER_END}\n\nMore of mine.\n`,
    );

    await applyAction(vault, {
      kind: 'replace',
      path: CONCEPT_PATH,
      body: 'new body',
      frontmatter: { [JAVIS_REV]: 'new' },
    });

    const content = vault.files.get(CONCEPT_PATH)?.content ?? '';
    expect(content).toContain('My own notes.');
    expect(content).toContain('More of mine.');
    expect(content).toContain('new body');
    expect(content).not.toContain('old body');
    // The block write takes Obsidian's lock first, then the properties.
    expect(vault.calls).toEqual([`process ${CONCEPT_PATH}`, `frontmatter ${CONCEPT_PATH}`]);
  });

  it('replace REPLACES frontmatter, so a resurrection clears javis_deleted', async () => {
    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, { [JAVIS_DELETED]: true, [JAVIS_REV]: 'old' }, `${MARKER_START}\n${MARKER_END}\n`);
    await applyAction(vault, {
      kind: 'replace',
      path: CONCEPT_PATH,
      body: 'back',
      frontmatter: { [JAVIS_REV]: 'new' },
    });
    expect(vault.files.get(CONCEPT_PATH)?.frontmatter).toEqual({ [JAVIS_REV]: 'new' });
  });

  it('tombstone blanks the block, banners the note, and never removes the file', async () => {
    const vault = new FakeVault();
    vault.seed(
      CONCEPT_PATH,
      { [JAVIS_REV]: '2026-09-13T04:12:00Z', title: 'Agent Builder' },
      `${MARKER_START}\nserver prose\n${MARKER_END}\n`,
    );

    await applyAction(vault, { kind: 'tombstone', path: CONCEPT_PATH });

    const file = vault.files.get(CONCEPT_PATH);
    expect(file).toBeDefined();
    expect(file?.content).toContain(TOMBSTONE_BANNER);
    expect(file?.content).not.toContain('server prose');
    // The flag, not the revision, is what stops the banner restacking.
    expect(file?.frontmatter?.[JAVIS_DELETED]).toBe(true);
    expect(file?.frontmatter?.[JAVIS_REV]).toBe('2026-09-13T04:12:00Z');
    expect(file?.frontmatter?.title).toBe('Agent Builder');
  });

  it('skip touches nothing', async () => {
    const vault = new FakeVault();
    await applyAction(vault, { kind: 'skip', reason: 'unchanged' });
    expect(vault.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// syncOnce — the run
// ---------------------------------------------------------------------------

describe('syncOnce', () => {
  it('creates every page of a first sync and reports the first batch server_time', async () => {
    const vault = new FakeVault();
    const api = new FakeApi([
      { pages: [page(), page({ slug: 'RAG' })], serverTime: '2026-09-13T06:00:00Z' },
      { pages: [page({ slug: 'Agents' })], serverTime: '2026-09-13T06:05:00Z' },
    ]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.created).toBe(3);
    expect(result.scanned).toBe(3);
    expect(result.failures).toEqual([]);
    // The FIRST batch's watermark, never a later one: a later value would sit
    // above rows committed between batch 1 and batch N.
    expect(result.nextCursor).toBe('2026-09-13T06:00:00Z');
    expect(api.sinceSeen).toEqual([null]);
    expect([...vault.files.keys()]).toEqual([
      'Concepts/Agent-Builder.md',
      'Concepts/RAG.md',
      'Concepts/Agents.md',
    ]);
  });

  it('sends the cached cursor as since', async () => {
    const api = new FakeApi([{ pages: [], serverTime: '2026-09-13T06:00:00Z' }]);
    await syncOnce(deps({ api, vault: new FakeVault(), cachedCursor: '2026-09-13T04:00:00Z' }));
    expect(api.sinceSeen).toEqual(['2026-09-13T04:00:00Z']);
  });

  it('rescans the vault for the cursor when data.json has nothing', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    const api = new FakeApi([{ pages: [], serverTime: '2026-09-13T06:00:00Z' }]);
    await syncOnce(deps({ api, vault }));
    expect(api.sinceSeen).toEqual(['2026-09-12T00:00:00Z']);
  });

  it('counts each verdict separately', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/Unchanged.md', { [JAVIS_REV]: '2026-09-13T04:12:00Z' });
    vault.seed('Concepts/Adopted.md', { [JAVIS_SYNC]: false, [JAVIS_REV]: 'ancient' });
    vault.seed('Concepts/Stale.md', { [JAVIS_REV]: 'ancient' }, `${MARKER_START}\nold\n${MARKER_END}\n`);
    vault.seed('Concepts/Gone.md', { [JAVIS_REV]: 'ancient' }, `${MARKER_START}\nold\n${MARKER_END}\n`);

    const api = new FakeApi([
      {
        pages: [
          page({ slug: 'Unchanged' }),
          page({ slug: 'Adopted' }),
          page({ slug: 'Stale' }),
          page({ slug: 'Gone', deleted_at: '2026-09-13T05:00:00Z' }),
          page({ slug: 'New' }),
        ],
        serverTime: '2026-09-13T06:00:00Z',
      },
    ]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result).toMatchObject({
      created: 1,
      replaced: 1,
      tombstoned: 1,
      skipped: 2,
      scanned: 5,
      trigger: 'command',
    });
  });

  it('is idempotent: a second run over the same delta writes nothing new', async () => {
    const vault = new FakeVault();
    const pages = [page(), page({ slug: 'RAG' })];
    const first = new FakeApi([{ pages, serverTime: '2026-09-13T06:00:00Z' }]);
    await syncOnce(deps({ api: first, vault }));

    // A created note's frontmatter carries the revision the next run compares.
    for (const p of pages) {
      const path = `Concepts/${p.slug}.md`;
      vault.seed(path, { [JAVIS_REV]: p.updated_at }, vault.files.get(path)?.content ?? '');
    }
    vault.calls.length = 0;

    const second = new FakeApi([{ pages, serverTime: '2026-09-13T06:10:00Z' }]);
    const result = await syncOnce(deps({ api: second, vault }));

    expect(result.skipped).toBe(2);
    expect(vault.calls).toEqual([]);
  });

  it('records a per-note write failure and keeps going', async () => {
    const vault = new FakeVault();
    vault.failWrites.add('Concepts/Broken.md');
    const api = new FakeApi([
      { pages: [page({ slug: 'Broken' }), page({ slug: 'Fine' })], serverTime: '2026-09-13T06:00:00Z' },
    ]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.created).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe('Concepts/Broken.md');
    expect(vault.files.has('Concepts/Fine.md')).toBe(true);
  });

  it('does NOT advance the cursor when any note failed', async () => {
    const vault = new FakeVault();
    vault.failWrites.add('Concepts/Broken.md');
    const api = new FakeApi([{ pages: [page({ slug: 'Broken' })], serverTime: '2026-09-13T06:00:00Z' }]);

    const result = await syncOnce(deps({ api, vault }));

    // Advancing past a row the vault never received is how an update is lost
    // permanently; re-delivery is free because every write is idempotent.
    expect(result.nextCursor).toBeNull();
  });

  it('propagates an auth failure instead of burying it in failures', async () => {
    const api = new FakeApi([{ pages: [page()], serverTime: 'x' }]);
    api.throwQueue.push(new AuthRevokedError('Reconnect in the plugin settings.'));

    await expect(syncOnce(deps({ api, vault: new FakeVault() }))).rejects.toBeInstanceOf(
      AuthRevokedError,
    );
  });

  it('writes nothing when the run fails before the first batch', async () => {
    const vault = new FakeVault();
    const api = new FakeApi([{ pages: [page()], serverTime: 'x' }]);
    api.throwQueue.push(new AuthRevokedError('nope'));

    await expect(syncOnce(deps({ api, vault }))).rejects.toThrow();
    expect(vault.calls).toEqual([]);
  });

  it('recovers from a 400 by rescanning the vault for a cursor', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    const api = new FakeApi([{ pages: [page()], serverTime: '2026-09-13T06:00:00Z' }]);
    api.throwQueue.push(new HttpError(400, '{"error":"invalid_request"}'));

    const result = await syncOnce(deps({ api, vault, cachedCursor: 'not-a-timestamp' }));

    expect(api.sinceSeen).toEqual(['not-a-timestamp', '2026-09-12T00:00:00Z']);
    expect(result.created).toBe(1);
    expect(result.nextCursor).toBe('2026-09-13T06:00:00Z');
  });

  it('falls all the way back to a full export when the rescan repeats the bad cursor', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    const api = new FakeApi([{ pages: [], serverTime: '2026-09-13T06:00:00Z' }]);
    api.throwQueue.push(new HttpError(400, 'bad cursor'));

    await syncOnce(deps({ api, vault, cachedCursor: '2026-09-12T00:00:00Z' }));

    expect(api.sinceSeen).toEqual(['2026-09-12T00:00:00Z', null]);
  });

  it('does not retry a 400 on a full export, which has no cursor to blame', async () => {
    const api = new FakeApi([{ pages: [], serverTime: 'x' }]);
    api.throwQueue.push(new HttpError(400, 'bad limit'));

    await expect(syncOnce(deps({ api, vault: new FakeVault() }))).rejects.toBeInstanceOf(HttpError);
    expect(api.sinceSeen).toEqual([null]);
  });

  it('retries a 400 at most once', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    const api = new FakeApi([{ pages: [], serverTime: 'x' }]);
    api.throwQueue.push(new HttpError(400, 'one'), new HttpError(400, 'two'));

    await expect(
      syncOnce(deps({ api, vault, cachedCursor: 'bad' })),
    ).rejects.toMatchObject({ body: 'two' });
    expect(api.sinceSeen).toHaveLength(2);
  });

  it('stops on an aborted signal before the first request', async () => {
    const api = new FakeApi([{ pages: [page()], serverTime: 'x' }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      syncOnce(deps({ api, vault: new FakeVault(), signal: controller.signal })),
    ).rejects.toBeInstanceOf(SyncCancelledError);
    expect(api.sinceSeen).toEqual([]);
  });

  it('stops mid-batch when the signal aborts', async () => {
    const vault = new FakeVault();
    const controller = new AbortController();
    const api = new FakeApi([
      { pages: [page({ slug: 'First' }), page({ slug: 'Second' })], serverTime: 'x' },
    ]);

    await expect(
      syncOnce(
        deps({
          api,
          vault,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      ),
    ).rejects.toBeInstanceOf(SyncCancelledError);

    expect(vault.files.has('Concepts/First.md')).toBe(true);
    expect(vault.files.has('Concepts/Second.md')).toBe(false);
  });

  it('reports progress once per row, cumulatively, with the verdict', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/Known.md', { [JAVIS_REV]: '2026-09-13T04:12:00Z' });
    const api = new FakeApi([
      { pages: [page({ slug: 'Known' }), page({ slug: 'New' })], serverTime: 'x' },
    ]);
    const seen: [number, string][] = [];

    await syncOnce(deps({ api, vault, onProgress: (done, kind) => seen.push([done, kind]) }));

    expect(seen).toEqual([
      [1, 'skip'],
      [2, 'create'],
    ]);
  });

  it('brackets the run with timestamps and echoes the trigger', async () => {
    const api = new FakeApi([{ pages: [], serverTime: 'x' }]);
    const result = await syncOnce(deps({ api, vault: new FakeVault(), trigger: 'interval' }));
    expect(result.trigger).toBe('interval');
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it('never deletes a file, even for a run that is all tombstones', async () => {
    const vault = new FakeVault();
    vault.seed('Concepts/A.md', { [JAVIS_REV]: 'old' }, `${MARKER_START}\nx\n${MARKER_END}\n`);
    vault.seed('Concepts/B.md', { [JAVIS_REV]: 'old' }, `${MARKER_START}\ny\n${MARKER_END}\n`);
    const api = new FakeApi([
      {
        pages: [
          page({ slug: 'A', deleted_at: '2026-09-13T05:00:00Z' }),
          page({ slug: 'B', deleted_at: '2026-09-13T05:00:00Z' }),
        ],
        serverTime: 'x',
      },
    ]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.tombstoned).toBe(2);
    expect([...vault.files.keys()]).toEqual(['Concepts/A.md', 'Concepts/B.md']);
  });

  it('adopts a pre-existing note at a managed path instead of failing forever', async () => {
    // The note has no frontmatter — a file the user wrote by hand, or one whose
    // YAML broke. `create` against it fails on every run, permanently.
    const vault = new FakeVault();
    vault.seed(CONCEPT_PATH, null, 'My own notes about agent builders.\n');
    const api = new FakeApi([{ pages: [page()], serverTime: '2026-09-13T06:00:00Z' }]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.failures).toEqual([]);
    expect(result.replaced).toBe(1);
    expect(result.nextCursor).toBe('2026-09-13T06:00:00Z');

    const file = vault.files.get(CONCEPT_PATH);
    // The user's text is above the block, untouched, and the block is below it.
    expect(file?.content).toContain('My own notes about agent builders.');
    expect(file?.content).toContain(MARKER_START);
    expect(file?.content).toContain('Body with [[Concepts/Foo]].');
    expect(file?.frontmatter?.[JAVIS_REV]).toBe('2026-09-13T04:12:00Z');
  });

  it('raises pendingFullResync when a note fails while the cursor came from the vault', async () => {
    const vault = new FakeVault();
    // 'Broken' is the OLDER row and the one that fails; 'Stale' is newer and
    // lands, which is what drags max(javis_rev) past the row that did not.
    vault.failWrites.add('Concepts/Broken.md');
    vault.seed(
      'Concepts/Stale.md',
      { [JAVIS_REV]: 'ancient' },
      `${MARKER_START}\nold\n${MARKER_END}\n`,
    );
    const api = new FakeApi([
      {
        pages: [
          page({ slug: 'Broken', updated_at: '2026-09-13T01:00:00Z' }),
          page({ slug: 'Stale', updated_at: '2026-09-13T02:00:00Z' }),
        ],
        serverTime: '2026-09-13T06:00:00Z',
      },
    ]);

    const first = await syncOnce(deps({ api, vault }));

    expect(first.failures).toHaveLength(1);
    expect(first.nextCursor).toBeNull();
    expect(first.pendingFullResync).toBe(true);

    // Why withholding the cursor is not enough: the rescan now sits ABOVE the
    // row that failed, so a plain `since` would never ask for it again.
    expect(await resolveCursor(vault, null)).toBe('2026-09-13T02:00:00Z');

    // With the flag honoured, the next run asks for everything.
    const second = new FakeApi([{ pages: [], serverTime: '2026-09-13T07:00:00Z' }]);
    await syncOnce(deps({ api: second, vault, pendingFullResync: first.pendingFullResync }));
    expect(second.sinceSeen).toEqual([null]);
  });

  it('does NOT raise pendingFullResync when the failing run used the cached cursor', async () => {
    // Holding `cachedCursor` back already re-delivers the row; a full export
    // here would cost tombstones (§C) for nothing.
    const vault = new FakeVault();
    vault.failWrites.add('Concepts/Broken.md');
    const api = new FakeApi([
      { pages: [page({ slug: 'Broken' })], serverTime: '2026-09-13T06:00:00Z' },
    ]);

    const result = await syncOnce(deps({ api, vault, cachedCursor: '2026-09-13T04:00:00Z' }));

    expect(result.failures).toHaveLength(1);
    expect(result.pendingFullResync).toBe(false);
  });

  it('raises pendingFullResync when the 400 fallback rescan is the one that failed', async () => {
    // The cached cursor was rejected, so the cursor that actually ran came from
    // the vault — and the next run would send the same bad cursor and land back
    // on the same rescan.
    const vault = new FakeVault();
    vault.failWrites.add('Concepts/Broken.md');
    vault.seed('Concepts/A.md', { [JAVIS_REV]: '2026-09-12T00:00:00Z' });
    const api = new FakeApi([
      { pages: [page({ slug: 'Broken' })], serverTime: '2026-09-13T06:00:00Z' },
    ]);
    api.throwQueue.push(new HttpError(400, 'bad cursor'));

    const result = await syncOnce(deps({ api, vault, cachedCursor: 'not-a-timestamp' }));

    expect(result.failures).toHaveLength(1);
    expect(result.pendingFullResync).toBe(true);
  });

  it('clears pendingFullResync on the first clean run', async () => {
    const vault = new FakeVault();
    const api = new FakeApi([{ pages: [page()], serverTime: '2026-09-13T06:00:00Z' }]);

    const result = await syncOnce(deps({ api, vault, pendingFullResync: true }));

    expect(api.sinceSeen).toEqual([null]);
    expect(result.failures).toEqual([]);
    expect(result.pendingFullResync).toBe(false);
    expect(result.nextCursor).toBe('2026-09-13T06:00:00Z');
  });

  it('skips a tombstone the file already records, so the banner never stacks', async () => {
    const vault = new FakeVault();
    vault.seed(
      'Concepts/A.md',
      { [JAVIS_REV]: 'old', [JAVIS_DELETED]: true },
      `${TOMBSTONE_BANNER}\n\n${MARKER_START}\n${MARKER_END}\n`,
    );
    const api = new FakeApi([
      { pages: [page({ slug: 'A', deleted_at: '2026-09-13T05:00:00Z' })], serverTime: 'x' },
    ]);

    const result = await syncOnce(deps({ api, vault }));

    expect(result.skipped).toBe(1);
    expect(vault.calls).toEqual([]);
  });
});

describe('summarize', () => {
  const base = {
    trigger: 'command' as const,
    created: 0,
    replaced: 0,
    tombstoned: 0,
    skipped: 0,
    scanned: 0,
    nextCursor: null,
    pendingFullResync: false,
    failures: [],
    startedAt: '2026-09-13T06:00:00Z',
    finishedAt: '2026-09-13T06:00:01Z',
  };

  it('names only the buckets that happened', () => {
    expect(summarize({ ...base, created: 2, skipped: 7 })).toBe('2 created, 7 unchanged');
  });

  it('says so when there was nothing to do', () => {
    expect(summarize(base)).toBe('nothing to do');
  });

  it('always mentions failures', () => {
    expect(
      summarize({ ...base, created: 1, failures: [{ path: 'Concepts/A.md', message: 'boom' }] }),
    ).toBe('1 created, 1 failed');
  });
});
