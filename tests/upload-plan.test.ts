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
  return { path, hash: null, bytes: 1000, missingSince: null, ...over };
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

  it('restamps a readable copy when the keeper at the server path is unreadable', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload(
      [note('Journal/a.md', id(1), { readable: false, hash: null }), note('Journal/b.md', id(1))],
      [r],
      {},
      settings(),
    );
    expect(plan.actions).toEqual([{ kind: 'restamp', path: 'Journal/b.md', oldId: id(1), reason: 'copy' }]);
    expect(plan.skipped).toEqual([{ path: 'Journal/a.md', reason: 'unreadable' }]);
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

  it('an ignored note does not count as present', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Elsewhere/a.md', id(1))], [r], {}, settings());
    expect(plan.waiting).toMatchObject([{ sourceId: id(1) }]);
  });

  it('an invalid folder plans nothing at all (D-PLAN-11)', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/b.md', null)], [r], missingLongAgo([r]), settings({ folders: ['Journal', 'Concepts'] }));
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.invalidFolders).toMatchObject([{ folder: 'Concepts' }]);
    expect(plan.nextMemory).toEqual(missingLongAgo([r]));
  });

  it('no folder selected plans nothing, even with live rows', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([], [r], missingLongAgo([r]), settings({ folders: [] }));
    expect(plan.actions).toEqual([]);
    expect(plan.waiting).toEqual([]);
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

  it('a move out of the selection deletes only after two misses 5+ minutes apart', () => {
    const run1 = planUpload([keep.note], [r, keep.row], {}, settings({ now: T0 }));
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

  it('one miss holds nothing back but deletes nothing, even with memory lost', () => {
    const plan = planUpload([keep.note], [r, keep.row], {}, settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.nextMemory[id(1)]).toEqual({ path: 'Outside/a.md', hash: r.body_hash, bytes: null, missingSince: T0 });
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
      missingLongAgo([gone]),
      settings(),
    );
    expect(plan.actions).toEqual([{ kind: 'delete', sourceId: id(1), path: 'Journal/a.md' }]);
  });

  it('a hand-mangled id is as unknown as an unreadable note', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/x.md', null, { invalidId: true })], [r], missingLongAgo([r]), settings());
    expect(plan.held).toMatchObject([{ reason: 'unreadable-ambiguous' }]);
  });

  it('a malformed note with a scanned id counts that row present', () => {
    const r = row(id(1), 'Journal/a.md');
    const plan = planUpload([note('Journal/a2.md', id(1), { malformed: true })], [r], missingLongAgo([r]), settings());
    expect(plan.actions).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'Journal/a2.md', reason: 'unstampable' }]);
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
    expect(plan.held.find((h) => h.action.kind === 'put')).toMatchObject({ key: `put:${id(10)}`, reason: 'mass-change' });
  });

  it('an empty note alone, under the threshold, is sent (D-PLAN-8)', () => {
    const s = synced(1);
    const plan = planUpload([{ ...s.note, hash: hashOf('blank'), bytes: 0, blank: true }], [s.row], {}, settings());
    expect(plan.actions).toMatchObject([{ kind: 'put', reason: 'changed' }]);
    expect(plan.held).toEqual([]);
  });

  it('an 80% shrink is suspicious: 199 of 1000 bytes is, 200 is not, and no memory is not', () => {
    const all = syncedMany(10);
    const goneRows = all.rows.slice(0, 5);
    const shrunk = (bytes: number) => ({ ...all.notes[9]!, hash: hashOf('shrunk'), bytes });
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
