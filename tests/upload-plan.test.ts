/**
 * Tests for src/core/upload.ts — `planUpload`, every action and guard in spec
 * §F.1 and §F.3, following the Plugin bullets of §H.
 *
 * Fixtures are built with four helpers so each test states only what it is
 * about: `note()` (a readable, stamped note), `row()` (a live server row that
 * matches it), `mem()` and `settings()`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEBOUNCE_MS,
  MAX_UPLOAD_BYTES,
  massChangeThreshold,
  planUpload,
  type LocalNote,
  type MemoryEntry,
  type PlanSettings,
  type ServerSource,
  type UploadMemory,
} from '../src/core/upload';

const T0 = 1_800_000_000_000;

/** A deterministic uuid from a small number, so ids read as `id(3)`. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function hashOf(tag: string): string {
  return tag.padEnd(64, '0').slice(0, 64);
}

function note(path: string, sourceId: string | null, over: Partial<LocalNote> = {}): LocalNote {
  return {
    path,
    sourceId,
    hash: hashOf(`h${path.length}`),
    bytes: 1000,
    bodyBytes: 1000,
    contentKey: null,
    readable: true,
    blank: false,
    invalidChars: false,
    invalidId: false,
    malformed: false,
    ...over,
  };
}

function row(sourceId: string, vault_path: string, over: Partial<ServerSource> = {}): ServerSource {
  return {
    source_id: sourceId,
    vault_path,
    body_hash: hashOf(`h${vault_path.length}`),
    status: 'done',
    deleted: false,
    last_error: null,
    undo_report: null,
    ...over,
  };
}

function mem(path: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { path, hash: null, bytes: 1000, bodyBytes: 1000, missingSince: null, ...over };
}

function settings(over: Partial<PlanSettings> = {}): PlanSettings {
  return {
    folders: ['Journal', 'Inbox'],
    configDir: '.obsidian',
    now: T0,
    reuploadAll: false,
    release: [],
    ...over,
  };
}

/** A note and its matching live row, i.e. an in-sync source. */
function synced(n: number, folder = 'Journal'): { note: LocalNote; row: ServerSource } {
  const path = `${folder}/n${n}.md`;
  return { note: note(path, id(n)), row: row(id(n), path) };
}

/** N in-sync sources, as parallel lists. */
function syncedMany(count: number, folder = 'Journal', from = 1): { notes: LocalNote[]; rows: ServerSource[] } {
  const notes: LocalNote[] = [];
  const rows: ServerSource[] = [];
  for (let i = from; i < from + count; i += 1) {
    const s = synced(i, folder);
    notes.push(s.note);
    rows.push(s.row);
  }
  return { notes, rows };
}

/** Memory in which every given row went missing long enough ago to be past the debounce. */
function missingLongAgo(rows: readonly ServerSource[]): UploadMemory {
  const out: UploadMemory = {};
  for (const r of rows) out[r.source_id] = mem(r.vault_path, { missingSince: T0 - DEBOUNCE_MS });
  return out;
}

const kinds = (plan: ReturnType<typeof planUpload>) => plan.actions.map((a) => a.kind);

// ---------------------------------------------------------------------------
// Task 5: stamp, restamp, put, skips
// ---------------------------------------------------------------------------

describe('planUpload: stamp and skips', () => {
  it('stamps a readable note that has no id', () => {
    const plan = planUpload([note('Journal/new.md', null)], [], {}, settings());
    expect(plan.actions).toEqual([{ kind: 'stamp', path: 'Journal/new.md' }]);
  });

  it('skips a blank new note instead of stamping it (D-PLAN-9)', () => {
    const plan = planUpload([note('Journal/Untitled.md', null, { blank: true, bytes: 0 })], [], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'Journal/Untitled.md', reason: 'blank' }]);
  });

  it('skips unreadable, oversize, invalid-id, invalid-chars and unstampable notes', () => {
    const plan = planUpload(
      [
        note('Journal/a.md', null, { readable: false, hash: null }),
        note('Journal/b.md', null, { bytes: MAX_UPLOAD_BYTES + 1 }),
        note('Journal/c.md', null, { invalidId: true }),
        note('Journal/d.md', null, { invalidChars: true }),
        note('Journal/e.md', null, { malformed: true }),
      ],
      [],
      {},
      settings(),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([
      { path: 'Journal/a.md', reason: 'unreadable' },
      { path: 'Journal/b.md', reason: 'oversize' },
      { path: 'Journal/c.md', reason: 'invalid-id' },
      { path: 'Journal/d.md', reason: 'invalid-chars' },
      { path: 'Journal/e.md', reason: 'unstampable' },
    ]);
  });

  it('allows exactly 256 KiB', () => {
    const plan = planUpload([note('Journal/a.md', null, { bytes: MAX_UPLOAD_BYTES })], [], {}, settings());
    expect(kinds(plan)).toEqual(['stamp']);
  });

  it('never stamps an oversize note, even one with an id and a changed hash', () => {
    const s = synced(1);
    const plan = planUpload([{ ...s.note, hash: hashOf('new'), bytes: MAX_UPLOAD_BYTES + 1 }], [s.row], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([{ path: s.note.path, reason: 'oversize' }]);
  });
});

describe('planUpload: put', () => {
  it('puts a stamped note the server has never seen', () => {
    const n = note('Journal/a.md', id(1));
    const plan = planUpload([n], [], {}, settings());
    expect(plan.actions).toEqual([
      { kind: 'put', path: 'Journal/a.md', sourceId: id(1), hash: n.hash, bytes: 1000, reason: 'new' },
    ]);
  });

  it('puts when the hash differs', () => {
    const s = synced(1);
    const plan = planUpload([{ ...s.note, hash: hashOf('edited') }], [s.row], {}, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put', reason: 'changed', sourceId: id(1) }]);
  });

  it('puts a rename within the selection, and deletes nothing', () => {
    const s = synced(1);
    const plan = planUpload([{ ...s.note, path: 'Journal/renamed.md', hash: s.row.body_hash }], [s.row], {}, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put', reason: 'moved', path: 'Journal/renamed.md' }]);
  });

  it('puts a move between selected folders as one put, no delete', () => {
    const s = synced(1);
    const plan = planUpload([{ ...s.note, path: 'Inbox/n1.md', hash: s.row.body_hash }], [s.row], {}, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put', reason: 'moved', path: 'Inbox/n1.md' }]);
    expect(plan.waiting).toEqual([]);
  });

  it('does nothing when hash and path are equal', () => {
    const s = synced(1);
    const plan = planUpload([s.note], [s.row], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it('re-upload all sends unchanged notes, and nothing else changes (D-PLAN-15)', () => {
    const s = synced(1);
    const plan = planUpload([s.note], [s.row], {}, settings({ reuploadAll: true }));
    expect(plan.actions).toMatchObject([{ kind: 'put', reason: 'reupload' }]);
  });

  it('re-sends only the unchanged notes whose ids are still owed a re-upload (review)', () => {
    const a = synced(1);
    const b = synced(2);
    const plan = planUpload([a.note, b.note], [a.row, b.row], {}, settings({ reuploadIds: [id(2)] }));
    expect(plan.actions).toMatchObject([{ kind: 'put', sourceId: id(2), reason: 'reupload' }]);
  });

  it('skips a blank note with an id and no server row', () => {
    const plan = planUpload([note('Journal/a.md', id(1), { blank: true })], [], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'Journal/a.md', reason: 'blank' }]);
  });
});

describe('planUpload: restamp', () => {
  it('restamps a copy; the note at the server path keeps the id (D-PLAN-10)', () => {
    const r = row(id(1), 'Journal/b.md');
    const a = note('Journal/a.md', id(1));
    const b = note('Journal/b.md', id(1));
    const plan = planUpload([a, b], [r], {}, settings());
    expect(plan.actions).toEqual([{ kind: 'restamp', path: 'Journal/a.md', oldId: id(1), reason: 'copy' }]);
  });

  it('falls back to the remembered path when the server has no row', () => {
    const plan = planUpload(
      [note('Journal/a.md', id(1)), note('Journal/b.md', id(1))],
      [],
      { [id(1)]: mem('Journal/b.md') },
      settings(),
    );
    expect(plan.actions).toMatchObject([
      { kind: 'restamp', path: 'Journal/a.md' },
      { kind: 'put', path: 'Journal/b.md', reason: 'new' },
    ]);
  });

  it('the server path beats the remembered path when they name different carriers (§F.1, review)', () => {
    // Memory re-learned b.md after a move whose PUT then failed; the server
    // still has a.md. The note the server knows keeps the id.
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload(
      [note('Journal/a.md', id(1)), note('Journal/b.md', id(1))],
      [r],
      { [id(1)]: mem('Journal/b.md') },
      settings(),
    );
    expect(plan.actions).toEqual([{ kind: 'restamp', path: 'Journal/b.md', oldId: id(1), reason: 'copy' }]);
  });

  it('falls back to the smallest path, deterministically', () => {
    const plan = planUpload([note('Journal/z.md', id(1)), note('Journal/a.md', id(1))], [], {}, settings());
    expect(plan.actions).toMatchObject([
      { kind: 'put', path: 'Journal/a.md' },
      { kind: 'restamp', path: 'Journal/z.md', reason: 'copy' },
    ]);
  });

  it('restamps every carrier of an id the server deleted', () => {
    const r = row(id(1), 'Journal/a.md', { deleted: true, status: 'deleted' });
    const plan = planUpload([note('Journal/a.md', id(1)), note('Journal/b.md', id(1))], [r], {}, settings());
    expect(plan.actions).toEqual([
      { kind: 'restamp', path: 'Journal/a.md', oldId: id(1), reason: 'deleted' },
      { kind: 'restamp', path: 'Journal/b.md', oldId: id(1), reason: 'deleted' },
    ]);
  });

  it('an unreadable keeper at the server path plans nothing for its id this run (review)', () => {
    // The id on a.md is only a metadataCache hint, which may be stale (a
    // rename from another device, a.md a lingering placeholder). It must not
    // make the readable b.md, which really carries the id, a restamped copy.
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload(
      [note('Journal/a.md', id(1), { readable: false, hash: null }), note('Journal/b.md', id(1))],
      [r],
      { [id(1)]: mem('Journal/a.md') },
      settings(),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'Journal/a.md', reason: 'unreadable' }]);
    // The row stays present: no miss is recorded.
    expect(plan.nextMemory[id(1)]!.missingSince).toBeNull();
    expect(plan.waiting).toEqual([]);
  });

  it('an unknown keeper found by memory path also plans nothing (review)', () => {
    const plan = planUpload(
      [note('Journal/a.md', id(1), { malformed: true }), note('Journal/b.md', id(1))],
      [],
      { [id(1)]: mem('Journal/a.md') },
      settings(),
    );
    expect(plan.actions).toEqual([]);
  });
});

describe('planUpload: defensive filters', () => {
  it('ignores notes outside the selection or not markdown (D-PLAN-12)', () => {
    const plan = planUpload(
      [note('Elsewhere/a.md', null), note('Journal/b.canvas', null), note('Concepts/c.md', null)],
      [],
      {},
      settings(),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('ignores an upper-case .MD extension, which the server refuses (contract review)', () => {
    const plan = planUpload([note('Journal/a.MD', null), note('Journal/b.Md', null)], [], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('an ignored note does not count as present', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Elsewhere/a.md', id(1))], [r], { [id(1)]: mem('Journal/a.md') }, settings());
    expect(plan.waiting).toMatchObject([{ sourceId: id(1) }]);
  });

  it('an invalid folder plans nothing at all (D-PLAN-11)', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/b.md', null)], [r], missingLongAgo([r]), settings({ folders: ['Journal', 'Javis-wiki/Concepts'] }));
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.invalidFolders).toMatchObject([{ folder: 'Javis-wiki/Concepts' }]);
    expect(plan.nextMemory).toEqual(missingLongAgo([r]));
  });

  it('deselecting one of two folders removes its notes after the debounce (D-PLAN-13)', () => {
    const inbox = synced(1, 'Inbox');
    const journal = synced(2, 'Journal');
    // The user removed Inbox; its note is still in the vault but no longer listed.
    const uploaded = { [id(1)]: mem(inbox.row.vault_path), [id(2)]: mem(journal.row.vault_path) };
    const run1 = planUpload([journal.note], [inbox.row, journal.row], uploaded, settings({ folders: ['Journal'] }));
    expect(run1.actions).toEqual([]);
    expect(run1.waiting).toMatchObject([{ sourceId: id(1) }]);
    const run2 = planUpload(
      [journal.note],
      [inbox.row, journal.row],
      run1.nextMemory,
      settings({ folders: ['Journal'], now: T0 + DEBOUNCE_MS }),
    );
    expect(run2.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: inbox.row.vault_path }]);
  });

  it('deselecting the LAST folder removes its notes too, behind the same debounce and cap (D-PLAN-13)', () => {
    const r = row(id(1), 'Journal/a.md');
    const run1 = planUpload([], [r], { [id(1)]: mem('Journal/a.md') }, settings({ folders: [] }));
    expect(run1.actions).toEqual([]);
    expect(run1.waiting).toMatchObject([{ sourceId: id(1) }]);
    const run2 = planUpload([], [r], run1.nextMemory, settings({ folders: [], now: T0 + DEBOUNCE_MS }));
    expect(run2.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/a.md' }]);
    // Many at once: the mass cap still asks first.
    const many = syncedMany(6);
    const held = planUpload([], many.rows, missingLongAgo(many.rows), settings({ folders: [] }));
    expect(held.actions).toEqual([]);
    expect(held.held).toHaveLength(6);
    expect(held.held.every((h) => h.reason === 'mass-change')).toBe(true);
  });

  it('with nothing selected, memory for rows that are no longer live is dropped', () => {
    const dead = row(id(1), 'Journal/a.md', { deleted: true, status: 'deleted' });
    const plan = planUpload([], [dead], { [id(1)]: mem('Journal/a.md'), [id(2)]: mem('Journal/b.md') }, settings({ folders: [] }));
    expect(plan.nextMemory).toEqual({});
  });

  it('orders writes by path, then deletes by id (D-PLAN-16)', () => {
    const gone = [row(id(9), 'Journal/gone9.md'), row(id(8), 'Journal/gone8.md')];
    const plan = planUpload(
      [note('Journal/z.md', null), note('Inbox/a.md', id(1)), note('Journal/keep.md', id(7))],
      [...gone, row(id(7), 'Journal/keep.md')],
      missingLongAgo(gone),
      settings(),
    );
    expect(plan.actions.map((a) => (a.kind === 'delete' ? `delete ${a.sourceId}` : `${a.kind} ${a.path}`))).toEqual([
      'put Inbox/a.md',
      'stamp Journal/z.md',
      `delete ${id(8)}`,
      `delete ${id(9)}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 6: deletes, debounce, unreadable
// ---------------------------------------------------------------------------

describe('planUpload: the two-scan debounce (§F.3.3)', () => {
  const r = row(id(1), 'Outside/a.md');
  const keep = synced(2);

  const uploaded = { [id(1)]: mem('Outside/a.md') };

  it('a move out of the selection deletes only after two misses 5+ minutes apart', () => {
    const run1 = planUpload([keep.note], [r, keep.row], uploaded, settings({ now: T0 }));
    expect(kinds(run1)).toEqual([]);
    expect(run1.waiting).toEqual([{ sourceId: id(1), path: 'Outside/a.md', eligibleAt: T0 + DEBOUNCE_MS }]);
    expect(run1.nextMemory[id(1)]!.missingSince).toBe(T0);

    const run2 = planUpload([keep.note], [r, keep.row], run1.nextMemory, settings({ now: T0 + DEBOUNCE_MS - 1000 }));
    expect(kinds(run2)).toEqual([]);
    expect(run2.waiting).toHaveLength(1);
    expect(run2.nextMemory[id(1)]!.missingSince).toBe(T0);

    const run3 = planUpload([keep.note], [r, keep.row], run2.nextMemory, settings({ now: T0 + DEBOUNCE_MS }));
    expect(run3.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Outside/a.md' }]);
    expect(run3.waiting).toEqual([]);
  });

  it('one miss holds nothing back but deletes nothing', () => {
    const plan = planUpload([keep.note], [r, keep.row], uploaded, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.nextMemory[id(1)]).toEqual({ ...mem('Outside/a.md'), missingSince: T0 });
  });

  it('with memory lost, a row whose note is still here is re-learned; a row with no note here is left alone', () => {
    const plan = planUpload([keep.note], [r, keep.row], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.waiting).toEqual([]);
    expect(plan.nextMemory).toEqual({
      [id(2)]: {
        path: keep.note.path, hash: keep.row.body_hash, bytes: keep.note.bytes,
        bodyBytes: keep.note.bodyBytes, contentKey: keep.note.contentKey, missingSince: null,
      },
    });
    // Re-learned: once its note goes, it is an ordinary delete again.
    const gone = planUpload([], [r, keep.row], plan.nextMemory, settings({ folders: ['Journal', 'Inbox'] }));
    expect(gone.nextMemory[id(2)]!.missingSince).toBe(T0);
  });

  it('a row that reappears resets missingSince', () => {
    const memory = { [id(2)]: mem(keep.note.path, { missingSince: T0 - 1000 }) };
    const plan = planUpload([keep.note], [keep.row], memory, settings());
    expect(plan.nextMemory[id(2)]!.missingSince).toBeNull();
  });

  it('never makes a deleted row a delete candidate', () => {
    const dead = row(id(3), 'Journal/dead.md', { deleted: true, status: 'deleted' });
    const plan = planUpload([keep.note], [dead, keep.row], missingLongAgo([dead]), settings());
    expect(plan.actions).toEqual([]);
    expect(plan.waiting).toEqual([]);
  });
});

describe('planUpload: unreadable is unknown (§F.3.2)', () => {
  it('an unreadable note at the row path: no put, no delete', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/a.md', null, { readable: false, hash: null })], [r], missingLongAgo([r]), settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.waiting).toEqual([]);
  });

  it('an unreadable note with a cached id elsewhere: no delete', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload(
      [note('Journal/renamed.md', id(1), { readable: false, hash: null })],
      [r],
      missingLongAgo([r]),
      settings(),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it('an unattributed unreadable note holds a missing row elsewhere (D-PLAN-4)', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload(
      [note('Journal/mystery.md', null, { readable: false, hash: null })],
      [r],
      missingLongAgo([r]),
      settings(),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([
      { key: `delete:${id(1)}`, action: { kind: 'delete', sourceId: id(1), path: 'Journal/a.md' }, reason: 'unreadable-ambiguous' },
    ]);
  });

  it('an unreadable note attributed to another row by path lets the missing row go', () => {
    const gone = row(id(1), 'Journal/a.md');
    const other = row(id(2), 'Journal/b.md');
    const plan = planUpload(
      [note('Journal/b.md', null, { readable: false, hash: null })],
      [gone, other],
      { ...missingLongAgo([gone]), [id(2)]: mem('Journal/b.md') },
      settings(),
    );
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/a.md' }]);
  });

  it('a hand-mangled id is as unknown as an unreadable note', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/x.md', null, { invalidId: true })], [r], missingLongAgo([r]), settings());
    expect(plan.held).toMatchObject([{ reason: 'unreadable-ambiguous' }]);
  });

  it('a fully read malformed note with no id line holds nothing: it cannot be a tracked note (review)', () => {
    const gone = row(id(1), 'Journal/old.md');
    const draft = note('Journal/draft.md', null, { malformed: true });
    const plan = planUpload([draft], [gone], missingLongAgo([gone]), settings());
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/old.md' }]);
    expect(plan.held).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'Journal/draft.md', reason: 'unstampable' }]);
    // The same for a readable note with a lone surrogate and no id line.
    const odd = note('Journal/odd.md', null, { invalidChars: true, hash: null });
    expect(planUpload([odd], [gone], missingLongAgo([gone]), settings()).held).toEqual([]);
  });

  it('a malformed note with a damaged id line still holds deletes', () => {
    const gone = row(id(1), 'Journal/old.md');
    const plan = planUpload(
      [note('Journal/draft.md', null, { malformed: true, invalidId: true })],
      [gone],
      missingLongAgo([gone]),
      settings(),
    );
    expect(plan.held).toMatchObject([{ key: `delete:${id(1)}`, reason: 'unreadable-ambiguous' }]);
  });

  it('swap: an unreadable note at a path whose row another note carries is ambiguous (review)', () => {
    // a.md -> z.md, then y.md -> a.md on another device; a.md is dataless here.
    const z = row(id(26), 'Journal/a.md');
    const y = row(id(25), 'Journal/y.md');
    const plan = planUpload(
      [note('Journal/z.md', id(26), { hash: z.body_hash }), note('Journal/a.md', null, { readable: false, hash: null })],
      [z, y],
      { [id(26)]: mem('Journal/a.md'), [id(25)]: mem('Journal/y.md', { missingSince: T0 - DEBOUNCE_MS }) },
      settings(),
    );
    expect(plan.actions).toMatchObject([{ kind: 'put', sourceId: id(26), reason: 'moved' }]);
    expect(plan.held).toMatchObject([{ key: `delete:${id(25)}`, reason: 'unreadable-ambiguous' }]);
  });

  it('an unreadable note at a DELETED row path is ambiguous (review)', () => {
    const dead = row(id(1), 'Journal/old.md', { deleted: true, status: 'deleted' });
    const y = row(id(2), 'Journal/y.md');
    const plan = planUpload(
      [note('Journal/old.md', null, { readable: false, hash: null })],
      [dead, y],
      { [id(1)]: mem('Journal/old.md'), ...missingLongAgo([y]) },
      settings(),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.held).toMatchObject([{ key: `delete:${id(2)}`, reason: 'unreadable-ambiguous' }]);
  });

  it('one uncarried row explains at most one unknown note', () => {
    const b = row(id(2), 'Journal/b.md');
    const gone = row(id(1), 'Journal/a.md');
    // Two unreadable notes, one at b's server path, one at b's remembered path.
    const plan = planUpload(
      [note('Journal/b.md', null, { readable: false, hash: null }), note('Journal/b2.md', null, { readable: false, hash: null })],
      [gone, b],
      { ...missingLongAgo([gone]), [id(2)]: mem('Journal/b2.md') },
      settings(),
    );
    expect(plan.held).toMatchObject([{ key: `delete:${id(1)}`, reason: 'unreadable-ambiguous' }]);
  });

  it('a malformed note with a scanned id counts that row present', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/a2.md', id(1), { malformed: true })], [r], missingLongAgo([r]), settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'Journal/a2.md', reason: 'unstampable' }]);
  });
});

describe('planUpload: never uploads the wiki back (§A, review)', () => {
  it('skips a note the download wrote, never stamps it, and it vouches for no unrelated row', () => {
    const r = row(id(1), 'Journal/gone.md');
    const keep = synced(2);
    const plan = planUpload(
      [keep.note, note('Journal/page.md', null, { wikiPage: true }), note('Journal/stamped-page.md', id(9), { wikiPage: true })],
      [r, keep.row],
      missingLongAgo([r]),
      settings(),
    );
    expect(plan.skipped).toEqual([
      { path: 'Journal/page.md', reason: 'wiki-page' },
      { path: 'Journal/stamped-page.md', reason: 'wiki-page' },
    ]);
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/gone.md' }]);
  });

  it('a tracked note that gains javis_type is skipped but still present: no put, no delete (review)', () => {
    const r = row(id(1), 'Journal/Meeting.md');
    // Carries the live id, anywhere in the selection.
    const carried = planUpload(
      [note('Journal/Renamed.md', id(1), { wikiPage: true, hash: hashOf('x') })],
      [r],
      missingLongAgo([r]),
      settings(),
    );
    expect(carried.actions).toEqual([]);
    expect(carried.held).toEqual([]);
    expect(carried.waiting).toEqual([]);
    expect(carried.skipped).toEqual([{ path: 'Journal/Renamed.md', reason: 'wiki-page' }]);
    expect(carried.nextMemory[id(1)]!.missingSince).toBeNull();
    // Carries no id, but sits at the live row's path.
    const atPath = planUpload([note('Journal/Meeting.md', null, { wikiPage: true })], [r], missingLongAgo([r]), settings());
    expect(atPath.actions).toEqual([]);
    expect(atPath.waiting).toEqual([]);
  });
});

describe('planUpload: an id-less note at a tracked path is that source (D-PLAN-4, review)', () => {
  const r = row(id(1), 'Journal/a.md');
  const memory = { [id(1)]: mem('Journal/a.md', { bytes: 5000 }) };

  it('a 0-byte file at the row path is neither a delete nor a stamp, however long it stays', () => {
    const zero = note('Journal/a.md', null, { blank: true, bytes: 0, hash: hashOf('empty') });
    const run1 = planUpload([zero], [r], memory, settings({ now: T0 }));
    const run2 = planUpload([zero], [r], run1.nextMemory, settings({ now: T0 + 10 * DEBOUNCE_MS }));
    for (const plan of [run1, run2]) {
      expect(plan.actions).toEqual([]);
      expect(plan.held).toEqual([]);
      expect(plan.waiting).toEqual([]);
      expect(plan.skipped).toEqual([{ path: 'Journal/a.md', reason: 'blank' }]);
    }
    expect(run2.nextMemory[id(1)]!.missingSince).toBeNull();
  });

  it('a note whose id line was removed gets the SAME id back, with no delete and no new source', () => {
    const stripped = note('Journal/a.md', null, { hash: r.body_hash });
    const plan = planUpload([stripped], [r], missingLongAgo([r]), settings());
    expect(plan.actions).toEqual([
      { kind: 'put', path: 'Journal/a.md', sourceId: id(1), hash: r.body_hash, bytes: 1000, reason: 'restore-id', adopt: true },
    ]);
    expect(plan.waiting).toEqual([]);
    expect(plan.nextMemory[id(1)]!.missingSince).toBeNull();
  });

  it('an id-less edit at the path is a changed put of that source, and a shrink is still suspicious', () => {
    const edited = note('Journal/a.md', null, { hash: hashOf('new'), bytes: 4000, bodyBytes: 4000 });
    expect(planUpload([edited], [r], memory, settings()).actions).toMatchObject([
      { kind: 'put', sourceId: id(1), reason: 'changed', adopt: true },
    ]);
    // Shrunk below 20%, with deletes up to the threshold: held with them.
    const shrunk = note('Journal/a.md', null, { hash: hashOf('tiny'), bytes: 100, bodyBytes: 100 });
    const gone = syncedMany(5, 'Inbox', 10);
    const plan = planUpload([shrunk], [r, ...gone.rows], { ...memory, ...missingLongAgo(gone.rows) }, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held.map((h) => h.key)).toContain(`put:${id(1)}`);
    expect(plan.held.find((h) => h.key === `put:${id(1)}`)!.action).toMatchObject({ adopt: true });
  });

  it('matches the remembered path too, when the server path is older', () => {
    const moved = row(id(1), 'Journal/old.md');
    const plan = planUpload(
      [note('Journal/a.md', null, { hash: moved.body_hash })],
      [moved],
      { [id(1)]: mem('Journal/a.md', { missingSince: T0 - DEBOUNCE_MS }) },
      settings(),
    );
    expect(plan.actions).toMatchObject([{ kind: 'put', sourceId: id(1), reason: 'moved', adopt: true }]);
  });

  it('does not adopt when another listed note carries the id: that one is the source, this one is new', () => {
    const plan = planUpload(
      [note('Journal/a.md', null), note('Journal/renamed.md', id(1), { hash: r.body_hash })],
      [r],
      {},
      settings(),
    );
    expect(plan.actions).toEqual([
      { kind: 'stamp', path: 'Journal/a.md' },
      { kind: 'put', path: 'Journal/renamed.md', sourceId: id(1), hash: r.body_hash, bytes: 1000, reason: 'moved' },
    ]);
  });

  it('a note carrying a DIFFERENT id at the path does not keep the old row alive', () => {
    const newer = row(id(2), 'Journal/a.md');
    const plan = planUpload(
      [note('Journal/a.md', id(2), { hash: newer.body_hash })],
      [r, newer],
      missingLongAgo([r]),
      settings(),
    );
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/a.md' }]);
  });

  it('never adopts a deleted row: the note is stamped as new', () => {
    const dead = row(id(1), 'Journal/a.md', { deleted: true, status: 'deleted' });
    expect(planUpload([note('Journal/a.md', null)], [dead], {}, settings()).actions).toEqual([
      { kind: 'stamp', path: 'Journal/a.md' },
    ]);
  });
});

describe('planUpload: rows another vault uploaded (review)', () => {
  // Work vault (Work/) and personal vault (Journal/) on one Javis account.
  const personal = syncedMany(3, 'Journal', 10);
  const work = syncedMany(2, 'Work', 1);
  const workSettings = settings({ folders: ['Work'] });
  const workMemory: UploadMemory = { [id(1)]: mem('Work/n1.md'), [id(2)]: mem('Work/n2.md') };

  it('never waits on, deletes, or counts a row this vault did not upload', () => {
    const run1 = planUpload(work.notes, [...work.rows, ...personal.rows], workMemory, workSettings);
    expect(run1.actions).toEqual([]);
    expect(run1.waiting).toEqual([]);
    expect(Object.keys(run1.nextMemory).sort()).toEqual([id(1), id(2)]);
    const later = planUpload(work.notes, [...work.rows, ...personal.rows], run1.nextMemory, { ...workSettings, now: T0 + 60 * DEBOUNCE_MS });
    expect(later.actions).toEqual([]);
    expect(later.held).toEqual([]);
    expect(later.threshold).toBe(5);
  });

  it('this vault still deletes its own rows beside foreign ones', () => {
    const plan = planUpload(
      [work.notes[1]!],
      [...work.rows, ...personal.rows],
      { ...workMemory, [id(1)]: mem('Work/n1.md', { missingSince: T0 - DEBOUNCE_MS }) },
      workSettings,
    );
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Work/n1.md' }]);
  });

  it('with nothing selected, only remembered rows are removed', () => {
    const plan = planUpload([], [...work.rows, ...personal.rows], { [id(1)]: mem('Work/n1.md') }, settings({ folders: [] }));
    expect(plan.waiting.map((w) => w.sourceId)).toEqual([id(1)]);
  });

  it('never adopts a foreign row at the same path, and a foreign row explains no unknown note', () => {
    const foreign = row(id(50), 'Work/shared.md');
    const plan = planUpload([note('Work/shared.md', null, { hash: foreign.body_hash })], [foreign], {}, workSettings);
    expect(plan.actions).toEqual([{ kind: 'stamp', path: 'Work/shared.md' }]);

    const mine = row(id(1), 'Work/n1.md');
    const held = planUpload(
      [note('Work/shared.md', null, { readable: false, hash: null })],
      [foreign, mine],
      { [id(1)]: mem('Work/n1.md', { missingSince: T0 - DEBOUNCE_MS }) },
      workSettings,
    );
    expect(held.held).toMatchObject([{ key: `delete:${id(1)}`, reason: 'unreadable-ambiguous' }]);
  });
});

// ---------------------------------------------------------------------------
// Task 7: vanished folder, mass cap, suspicious edits, release
// ---------------------------------------------------------------------------

describe('planUpload: vanished folder (§F.3.4)', () => {
  it('holds every delete under a folder that lists nothing', () => {
    const inbox = syncedMany(3, 'Inbox', 100);
    const journal = syncedMany(10, 'Journal', 1);
    const goneJournal = journal.rows[0]!;
    const plan = planUpload(
      journal.notes.slice(1),
      [...inbox.rows, ...journal.rows],
      missingLongAgo([...inbox.rows, goneJournal]),
      settings(),
    );
    expect(plan.held.map((h) => [h.action.sourceId, h.reason])).toEqual(
      inbox.rows.map((r) => [r.source_id, 'vanished-folder']),
    );
    // Journal's delete is under the cap (4 <= 5) and is sent.
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: goneJournal.source_id, path: goneJournal.vault_path }]);
  });

  it('a folder holding only unreadable notes has not vanished', () => {
    const inbox = syncedMany(2, 'Inbox', 10);
    const plan = planUpload(
      [note('Inbox/n10.md', id(10), { readable: false, hash: null })],
      inbox.rows,
      missingLongAgo([inbox.rows[1]!]),
      settings(),
    );
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(11), path: 'Inbox/n11.md' }]);
  });
});

describe('planUpload: mass-change cap (§F.3.5)', () => {
  function deletesOf(total: number, gone: number) {
    const all = syncedMany(total);
    const goneRows = all.rows.slice(0, gone);
    return planUpload(all.notes.slice(gone), all.rows, missingLongAgo(goneRows), settings());
  }

  it('computes min(50, max(5, 20%))', () => {
    expect(massChangeThreshold(0)).toBe(5);
    expect(massChangeThreshold(10)).toBe(5);
    expect(massChangeThreshold(100)).toBe(20);
    expect(massChangeThreshold(1000)).toBe(50);
    expect(massChangeThreshold(5000)).toBe(50);
  });

  it('the cap at 5: 5 deletes are sent, 6 are all held', () => {
    expect(kinds(deletesOf(10, 5))).toEqual(Array(5).fill('delete'));
    const six = deletesOf(10, 6);
    expect(six.actions).toEqual([]);
    expect(six.held).toHaveLength(6);
    expect(six.held.every((h) => h.reason === 'mass-change')).toBe(true);
  });

  it('the cap at 20%: 100 live rows -> 20 sent, 21 held', () => {
    expect(kinds(deletesOf(100, 20))).toHaveLength(20);
    const over = deletesOf(100, 21);
    expect(over.actions).toEqual([]);
    expect(over.held).toHaveLength(21);
  });

  it('the cap at 50: 1000 live rows -> 50 sent, 51 held (not 200)', () => {
    expect(kinds(deletesOf(1000, 50))).toHaveLength(50);
    const over = deletesOf(1000, 51);
    expect(over.actions).toEqual([]);
    expect(over.held).toHaveLength(51);
    expect(over.threshold).toBe(50);
  });

  it('deletes held for a vanished folder count toward the cap (D-PLAN-7)', () => {
    const inbox = syncedMany(3, 'Inbox', 100);
    const journal = syncedMany(10, 'Journal', 1);
    const goneJournal = journal.rows.slice(0, 3);
    const plan = planUpload(
      journal.notes.slice(3),
      [...inbox.rows, ...journal.rows],
      missingLongAgo([...inbox.rows, ...goneJournal]),
      settings(),
    );
    // 6 candidates > 5: the three Journal deletes are held too.
    expect(plan.actions).toEqual([]);
    expect(plan.held.filter((h) => h.reason === 'mass-change')).toHaveLength(3);
    expect(plan.held.filter((h) => h.reason === 'vanished-folder')).toHaveLength(3);
  });
});

describe('planUpload: suspicious edits (§F.3.5)', () => {
  it('an empty note counts with the deletes, and T+1 holds the put and every delete', () => {
    const all = syncedMany(10);
    const blanked = { ...all.notes[9]!, hash: hashOf('blank'), bytes: 0, blank: true };
    const goneRows = all.rows.slice(0, 5); // 5 deletes = T, plus the blank put = 6
    const plan = planUpload([...all.notes.slice(5, 9), blanked], all.rows, missingLongAgo(goneRows), settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toHaveLength(6);
    expect(plan.held.find((h) => h.action.kind === 'put')).toMatchObject({ key: `put:${id(10)}`, reason: 'suspicious-edit' });
    expect(plan.held.filter((h) => h.reason === 'mass-change')).toHaveLength(5);
  });

  it('an empty note alone, under the threshold, is still held (D-PLAN-8, review)', () => {
    const s = synced(1);
    const plan = planUpload([{ ...s.note, hash: hashOf('blank'), bytes: 0, blank: true }], [s.row], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toMatchObject([{ key: `put:${id(1)}`, reason: 'suspicious-edit', action: { kind: 'put', reason: 'changed' } }]);
  });

  it('a single >80% shrink, under the threshold, is held; a release sends it', () => {
    const s = synced(1);
    const truncated = { ...s.note, hash: hashOf('trunc'), bytes: 150, bodyBytes: 150 };
    const memory = { [id(1)]: mem(s.note.path, { bytes: 1000 }) };
    const plan = planUpload([truncated], [s.row], memory, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toMatchObject([{ key: `put:${id(1)}`, reason: 'suspicious-edit' }]);
    const released = planUpload([truncated], [s.row], memory, settings({ release: [`put:${id(1)}`] }));
    expect(released.actions).toMatchObject([{ kind: 'put', sourceId: id(1), reason: 'changed' }]);
    expect(released.held).toEqual([]);
  });

  it('an 80% shrink is suspicious: 199 of 1000 bytes is, 200 is not, and no memory is not', () => {
    const all = syncedMany(10);
    const goneRows = all.rows.slice(0, 5);
    const shrunk = (bytes: number) => ({ ...all.notes[9]!, hash: hashOf('shrunk'), bytes, bodyBytes: bytes });
    const memory = { ...missingLongAgo(goneRows), [id(10)]: mem(all.notes[9]!.path, { bytes: 1000 }) };

    const at199 = planUpload([...all.notes.slice(5, 9), shrunk(199)], all.rows, memory, settings());
    expect(at199.held.some((h) => h.key === `put:${id(10)}`)).toBe(true);

    const at200 = planUpload([...all.notes.slice(5, 9), shrunk(200)], all.rows, memory, settings());
    expect(at200.actions.filter((a) => a.kind === 'put')).toHaveLength(1);
    expect(at200.actions.filter((a) => a.kind === 'delete')).toHaveLength(5);

    const noMemory = planUpload([...all.notes.slice(5, 9), shrunk(10)], all.rows, missingLongAgo(goneRows), settings());
    expect(noMemory.actions).toHaveLength(6);
  });
});

describe('planUpload: holds are re-derived and released (§F.3.6)', () => {
  it('restoring the files clears the hold and plans no delete', () => {
    const all = syncedMany(10);
    const goneRows = all.rows.slice(0, 6);
    const memory = missingLongAgo(goneRows);
    expect(planUpload(all.notes.slice(6), all.rows, memory, settings()).held).toHaveLength(6);

    const restored = planUpload(all.notes, all.rows, memory, settings());
    expect(restored.held).toEqual([]);
    expect(restored.actions).toEqual([]);
    for (const r of goneRows) expect(restored.nextMemory[r.source_id]!.missingSince).toBeNull();
  });

  it('a released key is emitted; the rest stay held', () => {
    const all = syncedMany(10);
    const goneRows = all.rows.slice(0, 6);
    const plan = planUpload(
      all.notes.slice(6),
      all.rows,
      missingLongAgo(goneRows),
      settings({ release: [`delete:${id(1)}`] }),
    );
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/n1.md' }]);
    expect(plan.held).toHaveLength(5);
  });

  it('a release for something no longer held does nothing', () => {
    const s = synced(1);
    const plan = planUpload([s.note], [s.row], {}, settings({ release: [`delete:${id(1)}`, `put:${id(1)}`] }));
    expect(plan.actions).toEqual([]);
  });

  it('a release overrides a vanished-folder hold too', () => {
    const inbox = syncedMany(1, 'Inbox', 10);
    const plan = planUpload([], inbox.rows, missingLongAgo(inbox.rows), settings({ release: [`delete:${id(10)}`] }));
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(10), path: 'Inbox/n10.md' }]);
  });
});


describe('E2E runbook D2/F3: content key and body-based guards', () => {
  it('D2: a frontmatter reorder (same contentKey, server holds our last upload) is no put', () => {
    const s = synced(1);
    const reordered = { ...s.note, hash: hashOf('reordered'), contentKey: 'k1' };
    const memory = { [id(1)]: mem(s.note.path, { hash: s.row.body_hash, contentKey: 'k1' }) };
    const plan = planUpload([reordered], [s.row], memory, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it('D2: a real change (different contentKey) is still a put', () => {
    const s = synced(1);
    const edited = { ...s.note, hash: hashOf('edited'), contentKey: 'k2' };
    const memory = { [id(1)]: mem(s.note.path, { hash: s.row.body_hash, contentKey: 'k1' }) };
    const plan = planUpload([edited], [s.row], memory, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put', sourceId: id(1), reason: 'changed' }]);
  });

  it('D2: without a remembered contentKey the hash decides, as before', () => {
    const s = synced(1);
    const edited = { ...s.note, hash: hashOf('edited'), contentKey: 'k1' };
    const plan = planUpload([edited], [s.row], { [id(1)]: mem(s.note.path, { hash: s.row.body_hash }) }, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put', reason: 'changed' }]);
  });

  it('D2: the key only counts while the server still holds our last upload', () => {
    const s = synced(1);
    const n = { ...s.note, hash: hashOf('x'), contentKey: 'k1' };
    const memory = { [id(1)]: mem(s.note.path, { hash: hashOf('someone-else'), contentKey: 'k1' }) };
    expect(planUpload([n], [s.row], memory, settings()).actions).toMatchObject([{ kind: 'put' }]);
  });

  it('F3: a >80% BODY shrink is held even though the whole file shrank less', () => {
    const s = synced(1);
    const cut = { ...s.note, hash: hashOf('cut'), bytes: 271, bodyBytes: 10 };
    const memory = { [id(1)]: mem(s.note.path, { bytes: 375, bodyBytes: 104 }) };
    const plan = planUpload([cut], [s.row], memory, settings());
    expect(plan.held).toMatchObject([{ key: `put:${id(1)}`, reason: 'suspicious-edit' }]);
  });

  it('F3: an old memory entry without bodyBytes never causes a shrink hold', () => {
    const s = synced(1);
    const cut = { ...s.note, hash: hashOf('cut'), bytes: 90, bodyBytes: 10 };
    const memory = { [id(1)]: { path: s.note.path, hash: null, bytes: 1000, missingSince: null } as MemoryEntry };
    const plan = planUpload([cut], [s.row], memory, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put' }]);
  });
});
