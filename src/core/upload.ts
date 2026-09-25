/**
 * The upload decision, pure: what to stamp, what to send, what to remove, and
 * what to hold for the user.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §F.1 (the action table), §F.3 (every guard), §E (the server rows this
 *       reads), §G ("plugin core/upload.ts owns every decision and guard").
 * Plan: docs/plans/2026-09-24-upload-half.md, D-PLAN-1..17.
 *
 * `planUpload(local, server, memory, settings)` is to the upload what
 * `reconcile` is to the download: the shell lists, reads and hashes, calls
 * this, and then carries out exactly the actions it returns. Every rule that
 * could delete a user's source lives here, where it is tested without a vault,
 * a network, or a clock.
 *
 * The rules that matter most, because each one is the difference between a
 * vault glitch and a user's notes vanishing from their wiki:
 *
 * 1. **Only absence from the listing can count toward a delete** (§F.3.2). A
 *    note that is listed but could not be read — an iCloud "dataless" file, a
 *    read that timed out — is `skip-unreadable`: neither a put nor a delete. A
 *    listed note whose identity we cannot read (unreadable with no cached id,
 *    a hand-mangled id, an unclosed fence) might be ANY tracked note after a
 *    rename, so while one exists that sits at no known path, every delete is
 *    held (`unreadable-ambiguous`, D-PLAN-4).
 * 2. **Two misses at least five minutes apart** (§F.3.3). The first run that
 *    misses a row writes `missingSince` into `nextMemory`; only a later run at
 *    least `DEBOUNCE_MS` after that may plan the delete. Losing memory restarts
 *    the clock, which only delays a delete (§F.1).
 * 3. **A selected folder that lists nothing holds every delete under it**
 *    (§F.3.4) — an unmounted drive or a half-finished checkout, not a user who
 *    deleted a whole folder in one go.
 * 4. **More than `min(50, max(5, 20%))` changes holds them all** (§F.3.5).
 *    Suspicious edits (a note that now reads as blank, or shrank by more than
 *    80%) count toward the same threshold and are held with the deletes.
 * 5. **Holds are re-derived on every run** (§F.3.6). Nothing about a hold is
 *    persisted, so a hold disappears the moment its files come back, and a
 *    release (`settings.release`) only applies to what is still held now.
 * 6. **An invalid selection plans nothing** (D-PLAN-11). A folder that is the
 *    root, a wiki folder, or nested must not be able to produce deletes.
 * 7. **No clock.** `settings.now` is the only time this function knows.
 */

import { isUnderFolder, validateFolders } from './folders';
import type { FolderError } from './folders';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §E: the PUT is refused above 256 KiB. Counted in UTF-8 bytes of the sent text. */
export const MAX_UPLOAD_BYTES = 256 * 1024;

/** §F.3.3: a note must be missing on two runs at least this far apart. */
export const DEBOUNCE_MS = 5 * 60 * 1000;

/** §F.3.5: a note that shrank below this share of its last upload is suspicious. */
export const SHRINK_RATIO = 0.2;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One listed note, as the shell read it. The spec shape (§F.1) plus the flags
 * the core needs to tell apart outcomes the spec names separately.
 */
export interface LocalNote {
  /** Vault-relative, forward slashes, ends in `.md`. */
  path: string;
  /**
   * The note's `javis_source_id`, a lowercased uuid, or null. For a note that
   * could not be read, or whose fence is unclosed, the shell may fill this
   * from `metadataCache` or a lenient scan (D-PLAN-3): a hint that can only
   * PREVENT a delete, never cause a put.
   */
  sourceId: string | null;
  /** `noteHash` of the text; null when unreadable. */
  hash: string | null;
  /** UTF-8 length of the text that would be sent. */
  bytes: number;
  /** False when the read failed or timed out (§F.3.2). */
  readable: boolean;
  /** The sent text is whitespace-only (D-PLAN-2). */
  blank: boolean;
  /** The text holds a lone surrogate and cannot be hashed as sent (D-HASH-5). */
  invalidChars: boolean;
  /** A `javis_source_id` line is present but is not a uuid (D-ID-2). */
  invalidId: boolean;
  /** An opening `---` with no closing fence: the stamp refuses it (§F.2). */
  malformed: boolean;
}

/** The last undo report the server recorded for a row (§D.4). */
export interface UndoReport {
  pages_tombstoned: number;
  pages_rebuilt: number;
  pages_marked_stale: number;
  pages_skipped_adopted: number;
}

/** One row of `GET /wiki/sources/obsidian` (§E; D-WIRE-1). */
export interface ServerSource {
  source_id: string;
  vault_path: string;
  body_hash: string;
  status: string;
  /** True for `deleting` and `deleted`: an id that is never resurrected. */
  deleted: boolean;
  last_error: string | null;
  undo_report: UndoReport | null;
}

/** What the plugin remembers about one source between runs (§F.1). */
export interface MemoryEntry {
  /** The path last uploaded, or the server path when the entry was created by a miss. */
  path: string;
  /** The hash last uploaded; null when unknown. */
  hash: string | null;
  /** Bytes last uploaded; null when unknown (then only the blank test applies). */
  bytes: number | null;
  /** Epoch ms of the first run that found this row missing; null while present. */
  missingSince: number | null;
}

export type UploadMemory = Record<string, MemoryEntry>;

export interface PlanSettings {
  /** The selected upload folders, as stored. */
  folders: readonly string[];
  /** `app.vault.configDir`. */
  configDir: string;
  /** The injected clock, epoch ms. */
  now: number;
  /** "Re-upload all": send notes whose hash and path are unchanged (D-PLAN-15). */
  reuploadAll: boolean;
  /** Hold keys the user confirmed in "Review pending changes" (D-PLAN-14). */
  release: readonly string[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type PutReason = 'new' | 'changed' | 'moved' | 'reupload' | 'restore-id';

export type UploadAction =
  /** Give the note an id, then upload it as a new source. */
  | { kind: 'stamp'; path: string }
  /**
   * Replace the note's id, then upload it as a new source: it is a copy of
   * another note, or its id was deleted on the server and an id is never
   * resurrected (§E 409).
   */
  | { kind: 'restamp'; path: string; oldId: string; reason: 'copy' | 'deleted' }
  | {
      kind: 'put';
      path: string;
      sourceId: string;
      hash: string;
      bytes: number;
      reason: PutReason;
      /**
       * The note carries no id, but sits at this live row's path: write
       * `sourceId` back into it before the PUT (D-PLAN-4, review). Present
       * only when true.
       */
      adopt?: true;
    }
  /** `path` is the server's last known path, for display. */
  | { kind: 'delete'; sourceId: string; path: string };

export type HoldReason = 'mass-change' | 'vanished-folder' | 'unreadable-ambiguous';

export interface HeldAction {
  /** `put:<id>` or `delete:<id>`: what a release names. */
  key: string;
  action: Extract<UploadAction, { kind: 'put' | 'delete' }>;
  reason: HoldReason;
}

export type SkipReason = 'unreadable' | 'oversize' | 'blank' | 'invalid-id' | 'invalid-chars' | 'unstampable';

export interface SkippedNote {
  path: string;
  reason: SkipReason;
}

/** A delete inside the debounce window: shown as "will be removed after …". */
export interface WaitingDelete {
  sourceId: string;
  path: string;
  /** Epoch ms from which the delete may be planned. */
  eligibleAt: number;
}

export interface UploadPlan {
  actions: UploadAction[];
  held: HeldAction[];
  skipped: SkippedNote[];
  waiting: WaitingDelete[];
  /**
   * `memory` with this run's `missingSince` bookkeeping applied. The shell
   * merges successful PUT/DELETE outcomes into it and persists it.
   */
  nextMemory: UploadMemory;
  /** Non-empty only when the selection is invalid; then nothing else is planned. */
  invalidFolders: FolderError[];
  /** The mass-change threshold this run used, for the review UI. */
  threshold: number;
}

/** `min(50, max(5, floor(20% of live)))` (§F.3.5; D-PLAN-7). */
export function massChangeThreshold(live: number): number {
  return Math.min(50, Math.max(5, Math.floor(0.2 * live)));
}

export function holdKey(action: Extract<UploadAction, { kind: 'put' | 'delete' }>): string {
  return `${action.kind}:${action.sourceId}`;
}

// ---------------------------------------------------------------------------
// planUpload
// ---------------------------------------------------------------------------

/** Readable, hashable, uploadable if nothing else says otherwise. */
function isKnown(note: LocalNote): boolean {
  return note.readable && !note.invalidChars && !note.invalidId && !note.malformed;
}

/** Why a known note still cannot be sent, or null. */
function unsendable(note: LocalNote): SkipReason | null {
  if (!note.readable) return 'unreadable';
  if (note.invalidChars) return 'invalid-chars';
  if (note.invalidId) return 'invalid-id';
  if (note.malformed) return 'unstampable';
  if (note.bytes > MAX_UPLOAD_BYTES) return 'oversize';
  return null;
}

/**
 * The note that keeps a shared id (D-PLAN-10): the one at the server's path,
 * else the one at memory's path, else the smallest path — deterministic, so
 * two devices planning over the same vault pick the same keeper.
 */
function chooseKeeper(
  carriers: readonly LocalNote[],
  row: ServerSource | undefined,
  entry: MemoryEntry | undefined,
): LocalNote {
  const at = (path: string | undefined) => (path === undefined ? undefined : carriers.find((n) => n.path === path));
  return at(row?.vault_path) ?? at(entry?.path) ?? [...carriers].sort((a, b) => (a.path < b.path ? -1 : 1))[0]!;
}

export function planUpload(
  local: readonly LocalNote[],
  server: readonly ServerSource[],
  memory: UploadMemory,
  settings: PlanSettings,
): UploadPlan {
  const nextMemory: UploadMemory = {};
  for (const [id, entry] of Object.entries(memory)) nextMemory[id] = { ...entry };

  const empty = (invalidFolders: FolderError[], threshold = 0): UploadPlan => ({
    actions: [],
    held: [],
    skipped: [],
    waiting: [],
    nextMemory,
    invalidFolders,
    threshold,
  });

  // Rule 6. An empty selection plans nothing either: the shell does not run the
  // upload half then (D-RUN-2), and a caller that did must not get "every row
  // is missing" out of it.
  const validation = validateFolders(settings.folders, settings.configDir);
  if (validation.errors.length > 0) return empty(validation.errors);
  const folders = validation.ok;
  if (folders.length === 0) return empty([]);

  // D-PLAN-12: the core does not trust the listing. A note outside the
  // selection or not markdown is treated as unlisted, so it cannot count as
  // present either.
  const listed = local.filter(
    (n) => n.path.toLowerCase().endsWith('.md') && folders.some((f) => isUnderFolder(n.path, f)),
  );

  const rows = new Map<string, ServerSource>();
  for (const row of server) rows.set(row.source_id.toLowerCase(), row);
  const liveRows = server.filter((r) => !r.deleted);
  const threshold = massChangeThreshold(liveRows.length);
  const release = new Set(settings.release);

  const actions: UploadAction[] = [];
  const skipped: SkippedNote[] = [];
  const suspicious: Extract<UploadAction, { kind: 'put' }>[] = [];

  // -- presence ------------------------------------------------------------
  // A row is present when a listed note carries its id (hints included), or
  // when a listed note that carries no readable id of its own sits at the
  // row's server path or remembered path (D-PLAN-4: "any listed note
  // (readable or not)"). Two kinds of note do that:
  //
  // - one whose identity we could not read at all (unreadable, hand-mangled
  //   id, unclosed fence): it might be the row's note, so the row stays;
  // - a readable note with NO id line — a sync glitch that left a 0-byte file,
  //   a select-all-delete, another plugin rewriting the frontmatter without
  //   our line. Before review this counted as absent: the row went missing,
  //   the debounce ran out, and the note's source was deleted (an undo), then
  //   re-ingested as a brand-new source once its text came back — exactly
  //   the truncated-file failure §F.3.5 exists to stop. Now such a note is
  //   taken to BE that source: its id is written back (`adopt`) and the edit
  //   goes through the ordinary put path, shrink guard included.
  //
  // A note carrying a different valid id does not vouch for a row at its
  // path: it is that other source, and letting it vouch would keep a row
  // whose note was deleted and replaced alive for ever.
  const presentIds = new Set<string>();
  const unknownPaths = new Set<string>();
  for (const note of listed) {
    if (note.sourceId !== null) presentIds.add(note.sourceId);
    if (!isKnown(note)) unknownPaths.add(note.path);
  }
  const carried = new Set(presentIds);
  const knownPaths = new Set<string>();
  for (const row of server) knownPaths.add(row.vault_path);
  for (const entry of Object.values(memory)) knownPaths.add(entry.path);
  for (const row of liveRows) {
    const id = row.source_id.toLowerCase();
    if (unknownPaths.has(row.vault_path) || (memory[id] && unknownPaths.has(memory[id]!.path))) presentIds.add(id);
  }
  // path of an id-less readable note → the uncarried live row it stands for.
  // A server-path match beats a memory-path match; ties go to the smallest
  // id, so two devices over the same vault adopt the same row.
  const adoptAt = new Map<string, string>();
  const idLess = new Set(listed.filter((n) => isKnown(n) && n.sourceId === null).map((n) => n.path));
  const adoptable = liveRows
    .map((row) => row.source_id.toLowerCase())
    .filter((id) => !carried.has(id))
    .sort();
  const adopted = new Set<string>();
  for (const pass of ['server', 'memory'] as const) {
    for (const id of adoptable) {
      if (adopted.has(id)) continue;
      const path = pass === 'server' ? rows.get(id)!.vault_path : memory[id]?.path;
      if (path === undefined || !idLess.has(path) || adoptAt.has(path)) continue;
      adoptAt.set(path, id);
      adopted.add(id);
      presentIds.add(id);
    }
  }
  // Rule 1: an unidentified note at no known path could be any row, renamed.
  const ambiguous = listed.some(
    (n) => !isKnown(n) && (n.sourceId === null || n.invalidId) && !knownPaths.has(n.path),
  );

  // -- per-note decisions --------------------------------------------------
  const byId = new Map<string, LocalNote[]>();
  for (const note of listed) {
    if (note.sourceId === null || !isKnown(note)) {
      const reason = unsendable(note);
      if (reason !== null) {
        skipped.push({ path: note.path, reason });
        continue;
      }
      // Known, readable, no id.
      if (note.blank) {
        // D-PLAN-9: stamping every fresh Untitled.md is an unrequested write,
        // and uploading nothing costs an LLM call. At a tracked row's path
        // this is also the 0-byte sync glitch: the row stays present (above),
        // the file is not touched, and nothing is sent until text returns.
        skipped.push({ path: note.path, reason: 'blank' });
        continue;
      }
      const adoptId = adoptAt.get(note.path);
      if (adoptId !== undefined) {
        const row = rows.get(adoptId)!;
        const hash = note.hash!;
        const changed = hash !== row.body_hash;
        const moved = note.path !== row.vault_path;
        const put: Extract<UploadAction, { kind: 'put' }> = {
          kind: 'put',
          path: note.path,
          sourceId: adoptId,
          hash,
          bytes: note.bytes,
          reason: changed ? 'changed' : moved ? 'moved' : 'restore-id',
          adopt: true,
        };
        // D-PLAN-8, as for any put against a live row (blank was handled above).
        const entry = memory[adoptId];
        const shrank = entry?.bytes != null && note.bytes < SHRINK_RATIO * entry.bytes;
        if (changed && shrank) suspicious.push(put);
        else actions.push(put);
        continue;
      }
      actions.push({ kind: 'stamp', path: note.path });
      continue;
    }
    const group = byId.get(note.sourceId) ?? [];
    group.push(note);
    byId.set(note.sourceId, group);
  }

  // Unreadable (or otherwise unknown) carriers still take part in choosing a
  // keeper: if the note at the server's path is evicted, a readable copy
  // elsewhere is still a copy.
  for (const note of listed) {
    if (note.sourceId !== null && !isKnown(note)) {
      const group = byId.get(note.sourceId);
      if (group) group.push(note);
    }
  }

  for (const [id, carriers] of byId) {
    const row = rows.get(id);
    const entry = memory[id];
    if (entry && entry.missingSince !== null && nextMemory[id]) nextMemory[id]!.missingSince = null;

    if (row?.deleted) {
      for (const note of carriers) {
        if (!isKnown(note)) continue; // already reported as skipped
        const reason = unsendable(note) ?? (note.blank ? 'blank' : null);
        if (reason !== null) skipped.push({ path: note.path, reason });
        else actions.push({ kind: 'restamp', path: note.path, oldId: id, reason: 'deleted' });
      }
      continue;
    }

    const keeper = chooseKeeper(carriers, row, entry);
    for (const note of carriers) {
      if (!isKnown(note)) continue;
      if (note !== keeper) {
        const reason = unsendable(note) ?? (note.blank ? 'blank' : null);
        if (reason !== null) skipped.push({ path: note.path, reason });
        else actions.push({ kind: 'restamp', path: note.path, oldId: id, reason: 'copy' });
        continue;
      }
      const reason = unsendable(note);
      if (reason !== null) {
        skipped.push({ path: note.path, reason });
        continue;
      }
      const hash = note.hash!;
      if (!row) {
        if (note.blank) {
          skipped.push({ path: note.path, reason: 'blank' });
          continue;
        }
        actions.push({ kind: 'put', path: note.path, sourceId: id, hash, bytes: note.bytes, reason: 'new' });
        continue;
      }
      const changed = hash !== row.body_hash;
      const moved = note.path !== row.vault_path;
      if (!changed && !moved && !settings.reuploadAll) continue;
      const put: Extract<UploadAction, { kind: 'put' }> = {
        kind: 'put',
        path: note.path,
        sourceId: id,
        hash,
        bytes: note.bytes,
        reason: changed ? 'changed' : moved ? 'moved' : 'reupload',
      };
      // D-PLAN-8: suspicious only against a live row whose content changed.
      const shrank = entry?.bytes != null && note.bytes < SHRINK_RATIO * entry.bytes;
      if (changed && (note.blank || shrank)) suspicious.push(put);
      else actions.push(put);
    }
  }

  // -- deletes -------------------------------------------------------------
  const waiting: WaitingDelete[] = [];
  const candidates: { action: Extract<UploadAction, { kind: 'delete' }>; hold: HoldReason | null }[] = [];
  const emptyFolders = folders.filter((f) => !listed.some((n) => isUnderFolder(n.path, f)));

  for (const row of liveRows) {
    const id = row.source_id.toLowerCase();
    if (presentIds.has(id)) {
      if (nextMemory[id]) nextMemory[id]!.missingSince = null;
      continue;
    }
    let entry = nextMemory[id];
    if (!entry) {
      entry = { path: row.vault_path, hash: row.body_hash, bytes: null, missingSince: null };
      nextMemory[id] = entry;
    }
    if (entry.missingSince === null) entry.missingSince = settings.now;
    const eligibleAt = entry.missingSince + DEBOUNCE_MS;
    if (settings.now < eligibleAt) {
      waiting.push({ sourceId: id, path: row.vault_path, eligibleAt });
      continue;
    }
    const action = { kind: 'delete' as const, sourceId: id, path: row.vault_path };
    let hold: HoldReason | null = null;
    if (emptyFolders.some((f) => isUnderFolder(row.vault_path, f))) hold = 'vanished-folder';
    else if (ambiguous) hold = 'unreadable-ambiguous';
    candidates.push({ action, hold });
  }

  // -- the mass-change cap ---------------------------------------------------
  // Every delete past the debounce counts, including ones already held for
  // another reason: the stricter count (D-PLAN-7).
  const tripped = candidates.length + suspicious.length > threshold;
  const held: HeldAction[] = [];
  const emitOrHold = (action: Extract<UploadAction, { kind: 'put' | 'delete' }>, hold: HoldReason | null): void => {
    const key = holdKey(action);
    if (hold === null || release.has(key)) actions.push(action);
    else held.push({ key, action, reason: hold });
  };
  for (const put of suspicious) emitOrHold(put, tripped ? 'mass-change' : null);
  for (const { action, hold } of candidates) emitOrHold(action, hold ?? (tripped ? 'mass-change' : null));

  // D-PLAN-16: writes first (by path), then deletes (by id).
  const rank = (a: UploadAction): number => (a.kind === 'delete' ? 1 : 0);
  actions.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ka = a.kind === 'delete' ? a.sourceId : a.path;
    const kb = b.kind === 'delete' ? b.sourceId : b.path;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  held.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { actions, held, skipped, waiting, nextMemory, invalidFolders: [], threshold };
}
