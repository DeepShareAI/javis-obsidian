/**
 * The upload half: enumerate, read, plan, stamp, PUT, DELETE.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §F.2 (the doing, and the stamp), §F.4 (triggers), §E (the routes),
 *       §C.7 (step-up), §G ("shell/upload.ts owns enumeration, reads, stamp,
 *       HTTP").
 * Plan: docs/plans/2026-09-24-upload-half.md, D-RUN-1..10, D-TRIG-1..2.
 *
 * `uploadOnce` decides nothing. It gathers the inputs `planUpload` needs, and
 * carries out exactly the actions that come back. The rules it does own:
 *
 * 1. **The stamp is on disk before its PUT** (§F.2). A reload or crash between
 *    the two leaves a note whose id the next run reuses, so it can never become
 *    a second source (obsync #181/#148). And the PUT sends the text
 *    `vault.process` returned — if another device's stamp landed between our
 *    read and our write, the transform is a no-op and we adopt THAT id
 *    (D-STAMP-3, D-RUN-9).
 * 2. **Reads are `vault.read` with a 10-second timeout** (§F.2, §F.3.2). An
 *    evicted iCloud file can block forever; a read that times out makes the
 *    note unreadable, which is "unknown", never "deleted".
 * 3. **Cancellation is checked between notes**, because `requestUrl` cannot
 *    abort a request in flight (§F.2).
 * 4. **Per-note failures are collected; run-level failures stop the run**
 *    (D-RUN-4). Auth, a failed step-up, the network, and rate limiting after
 *    backoff would recur on every remaining note, so they stop it; a 400, 409,
 *    413, other 4xx/5xx, or one note's vault error does not.
 * 5. **It never throws** (D-RUN-7). Whatever happens, the caller gets
 *    `nextMemory` back and persists it, so the debounce clock and every
 *    successful PUT/DELETE survive a run that stopped halfway.
 * 6. **No folder selected and nothing remembered → no request at all**
 *    (D-RUN-2). A 0.2.0 install that never opts in makes exactly the 0.1.x
 *    requests. With remembered uploads the run goes on, so deselecting the
 *    last folder removes its notes like deselecting any other (D-PLAN-13).
 * 7. **No write grant → step up (or stop) before the first request**, so no
 *    note is stamped by a run that cannot upload it (review of §C.7).
 * 8. **Only in the account this vault uploaded to** (review). Upload memory,
 *    the stamped ids and the holds describe rows in one account; nothing
 *    tied them to it, so a reconnect or a step-up in a browser signed in to
 *    someone else PUT every selected note's full text into that account and
 *    stranded the originals where no plugin path could remove them. With a
 *    bound account (`expectedAccount`), a run in any other account — or one
 *    whose account cannot be read — stops before its first request, and a
 *    mid-run step-up that returns as anyone else stops the run before the
 *    plan built from the old listing is carried out.
 */

import { validateFolders } from '../core/folders';
import {
  bodyText,
  contentKey,
  frontmatterRange,
  hasInvalidChars,
  isUuid,
  isWikiPageText,
  noteHash,
  noteTitle,
  readSourceId,
  uploadText,
  utf8Bytes,
} from '../core/note-text';
import { restampText, stampText } from '../core/stamp';
import { planUpload } from '../core/upload';
import type { LocalNote, UploadAction } from '../core/upload';
import type {
  LastUploadReport,
  SourcesListing,
  UploadDeps,
  UploadMemory,
  UploadResult,
  UploadVault,
} from './contracts';
import { REMOVED_IDS_CAP } from './contracts';
import {
  AccountChangedError,
  InsufficientScopeError,
  RateLimitedError,
  SyncCancelledError,
  isJavisError,
} from './errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Shown for a `failed` row whose `last_error` is null. */
export const SERVER_FAILURE_FALLBACK = 'the server could not add it to the wiki';

/** §F.2: each read has a 10-second timeout. */
export const READ_TIMEOUT_MS = 10_000;

/** D-RUN-5: retries of one request after a 429, and the backoff ceiling. */
export const MAX_RATE_LIMIT_RETRIES = 4;
export const MAX_BACKOFF_MS = 60_000;

/** D-TRIG-2: how long a self-write mark suppresses the `modify` it raises. */
export const SELF_WRITE_WINDOW_MS = 10_000;

/** D-TRIG-1: upload-on-edit waits this long after the last `modify` (§F.4). */
export const EDIT_DEBOUNCE_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class ReadTimeoutError extends Error {}

/**
 * `promise`, or a rejection after `ms`. A read that completes late is simply
 * ignored (D-RUN-8): the note was already classified unreadable for this run.
 */
export function readWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeoutError(`read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A sleep that rejects with `SyncCancelledError` when the signal aborts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SyncCancelledError('Upload was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SyncCancelledError('Upload was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A `javis_source_id` line anywhere near the top of a malformed note (an
 * opening fence with no close). A hint for presence only: such a note is never
 * stamped or uploaded, but if it was a tracked note before the user broke its
 * fence, its row must not look missing.
 */
export function lenientSourceId(text: string): string | null {
  const match = /^javis_source_id\s*:\s*["']?([0-9a-fA-F-]{36})["']?\s*$/m.exec(text);
  if (!match) return null;
  const id = match[1]!.toLowerCase();
  return isUuid(id) ? id : null;
}

/** Any `javis_source_id:` line, however damaged its value. */
const ANY_SOURCE_ID_LINE = /^\s*["']?javis_source_id["']?\s*:/m;

/** A readable note's text as `planUpload` sees it. */
export function describeNote(path: string, text: string, cachedSourceId: string | null): LocalNote {
  const malformed = frontmatterRange(text).kind === 'malformed';
  const read = readSourceId(text);
  const invalidChars = hasInvalidChars(text);
  const sent = uploadText(text);
  const body = bodyText(text);
  let sourceId: string | null = read?.valid ? read.id : null;
  let invalidId = read !== null && !read.valid;
  if (malformed) {
    const lenient = lenientSourceId(text);
    sourceId = lenient ?? cachedSourceId;
    // `readSourceId` sees nothing in an unclosed block. A `javis_source_id`
    // line that the lenient scan cannot read is a damaged id: the note may
    // be any tracked note, and the planner must treat it as hiding one
    // (review). A malformed note with no such line at all hides nothing.
    if (lenient === null && ANY_SOURCE_ID_LINE.test(text)) invalidId = true;
  }
  return {
    path,
    sourceId,
    hash: invalidChars ? null : noteHash(text),
    bytes: utf8Bytes(sent),
    bodyBytes: utf8Bytes(body),
    contentKey: invalidChars ? null : contentKey(text),
    readable: true,
    blank: body.trim() === '',
    invalidChars,
    invalidId,
    malformed,
    wikiPage: isWikiPageText(text),
  };
}

function unreadable(path: string, cachedSourceId: string | null): LocalNote {
  return {
    path,
    sourceId: cachedSourceId,
    hash: null,
    bytes: 0,
    bodyBytes: 0,
    contentKey: null,
    readable: false,
    blank: false,
    invalidChars: false,
    invalidId: false,
    malformed: false,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * D-RUN-4: the failures that would recur on every remaining note. Anything
 * else is one note's problem.
 */
function isRunLevel(error: unknown): boolean {
  if (!isJavisError(error)) return false;
  switch (error.code) {
    case 'auth-required':
    case 'auth-expired':
    case 'auth-revoked':
    case 'insufficient-scope':
    // The URL is not the tokens' origin, or the account is not this vault's
    // (review): the same answer for every note, and nothing may be sent.
    case 'origin-changed':
    case 'account-changed':
    case 'cancelled':
    case 'network':
    case 'rate-limited':
    case 'protocol':
      return true;
    case 'http':
      // A 403 that is not insufficient_scope is an authorization problem
      // (D-AUTH-4); it will be the same answer for the next note.
      return (error as { status?: number }).status === 403;
    default:
      return false;
  }
}

function stopReason(error: unknown): NonNullable<UploadResult['stoppedBy']> {
  if (isJavisError(error)) {
    return { code: error.code, message: error.message, needsUserAction: error.needsUserAction };
  }
  return { code: 'unknown', message: messageOf(error), needsUserAction: false };
}

// ---------------------------------------------------------------------------
// uploadOnce
// ---------------------------------------------------------------------------

/** One upload run. Never throws (rule 5). */
export async function uploadOnce(deps: UploadDeps): Promise<UploadResult> {
  const result: UploadResult = {
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
    nextMemory: cloneMemory(deps.memory),
    stoppedBy: null,
    ran: false,
    planned: false,
    account: null,
  };

  // Rule 6. "Never opted in" is no folder AND no remembered upload: with
  // memory left over, the last folder was deselected, and its rows still have
  // to be removed (D-PLAN-13), so the run goes on with an empty selection.
  if (deps.folders.length === 0 && Object.keys(deps.memory).length === 0) return result;
  result.ran = true;

  // An invalid selection makes no request either: nothing it could learn would
  // be acted on (D-PLAN-11).
  let configDir: string;
  try {
    configDir = deps.vault.configDir();
  } catch (error) {
    result.stoppedBy = stopReason(error);
    return result;
  }
  const validation = validateFolders(deps.folders, configDir);
  if (validation.errors.length > 0) {
    result.invalidFolders = validation.errors;
    return result;
  }

  // The run's one step-up (D-AUTH-4), shared by the pre-flight below and by
  // every request's 403 handling in `retrying`. `account` is the identity
  // the run checked before its first request; a mid-run step-up that comes
  // back as anyone else stops the run (rule 8).
  const budget = { steppedUp: false, account: null as string | null };
  const call = retrying(deps, budget);
  const signal = deps.signal;

  // Rule 7. A token that visibly cannot write is fixed (or the run stops)
  // before any request and any stamp. Waiting for the server's 403 would put
  // a `javis_source_id` into the first note ahead of its PUT (rule 1), and a
  // user who then declines `wiki:write` is left with an edited file and
  // nothing uploaded. It also reaches the step-up for a pre-0.2.0
  // `/mcp`-audience token, which the upload routes answer with a 401 — read
  // by the client as expiry, never as the 403 that `retrying` steps up on.
  if (deps.lacksWriteGrant?.()) {
    if (!deps.stepUp) {
      result.stoppedBy = stopReason(new InsufficientScopeError());
      return result;
    }
    budget.steppedUp = true;
    try {
      await deps.stepUp();
    } catch (error) {
      result.stoppedBy = stopReason(new InsufficientScopeError(undefined, { cause: error }));
      return result;
    }
    // The consent screen lets the user grant read and decline write (§C.2).
    if (deps.lacksWriteGrant()) {
      result.stoppedBy = stopReason(new InsufficientScopeError());
      return result;
    }
  }

  // Rule 8. After the pre-flight, because a step-up is exactly where the
  // browser's Clerk session can turn out to be somebody else's.
  if (deps.account) {
    const current = deps.account();
    if (deps.expectedAccount != null && current !== deps.expectedAccount) {
      result.stoppedBy = stopReason(new AccountChangedError());
      return result;
    }
    budget.account = current;
    result.account = current;
  }

  let listing: SourcesListing | null = null;
  try {
    // 1. The server's list. Nothing can be decided without it: a note the
    //    server does not know looks new, and a row we cannot see cannot be
    //    guarded (rule 2 of sources-api.ts).
    listing = await call(() => deps.api.list(signal));
    result.counts = listing.counts;

    // 2. Enumerate and read.
    const texts = new Map<string, string>();
    const { notes, observedAt } = await readNotes(deps.vault, validation.ok, deps, texts);

    // 3. Decide.
    const plan = planUpload(notes, listing.sources, deps.memory, {
      folders: validation.ok,
      configDir,
      now: observedAt,
      reuploadAll: deps.reuploadAll,
      reuploadIds: deps.reuploadIds ?? [],
      release: deps.release,
    });
    result.planned = true;
    result.nextMemory = plan.nextMemory;
    result.serverFailures = listing.sources
      .filter((row) => row.status === 'failed' && !row.deleted && plan.nextMemory[row.source_id.toLowerCase()])
      .map((row) => ({ path: row.vault_path, message: row.last_error ?? SERVER_FAILURE_FALLBACK }));
    // Undo reports are filled in below, once this run's deletes are known.
    result.held = plan.held;
    result.waiting = plan.waiting;
    result.skipped = [...plan.skipped];
    result.invalidFolders = plan.invalidFolders;

    // 4. Do.
    let done = 0;
    for (const action of plan.actions) {
      if (signal?.aborted) throw new SyncCancelledError('Upload was cancelled.');
      try {
        await execute(action, deps, texts, result, call);
      } catch (error) {
        if (isRunLevel(error)) throw error;
        result.failures.push({ path: action.path, message: messageOf(error) });
        if (action.kind === 'put' && action.reason === 'reupload') result.retryIds.push(action.sourceId);
      }
      done += 1;
      deps.onProgress?.(done, plan.actions.length);
    }
  } catch (error) {
    result.stoppedBy = stopReason(error);
  }
  if (listing !== null && result.planned) result.undoReports = ownUndoReports(listing, deps, result);
  return result;
}

/**
 * The listing's undo reports that are THIS vault's (review; see
 * `UploadResult.undoReports`): the row was in upload memory before or after
 * the run, this run removed it, or an earlier run did (`deps.removedIds`).
 * Only computed after planning, because before it nothing says which rows are
 * this vault's; an unplanned run keeps the previous run's list
 * (`uploadReport`).
 */
function ownUndoReports(listing: SourcesListing, deps: UploadDeps, result: UploadResult): UploadResult['undoReports'] {
  const own = new Set<string>([
    ...Object.keys(deps.memory),
    ...Object.keys(result.nextMemory),
    ...result.removedIds,
    ...(deps.removedIds ?? []).map((i) => i.toLowerCase()),
  ]);
  return listing.sources
    .filter((row) => row.undo_report !== null && own.has(row.source_id.toLowerCase()))
    .map((row) => ({ path: row.vault_path, report: row.undo_report! }));
}

function cloneMemory(memory: UploadMemory): UploadMemory {
  const out: UploadMemory = {};
  for (const [id, entry] of Object.entries(memory)) out[id] = { ...entry };
  return out;
}

async function readNotes(
  vault: UploadVault,
  folders: readonly string[],
  deps: UploadDeps,
  texts: Map<string, string>,
): Promise<{ notes: LocalNote[]; observedAt: number }> {
  // Nothing selected: nothing to list (and nothing a listing could return).
  // The server listing has already been fetched, so "now" is when the
  // selection was found empty.
  if (folders.length === 0) return { notes: [], observedAt: deps.now() };
  const listed = await vault.listNotesIn(folders);
  // The clock is read HERE, when the vault was observed: after any step-up
  // and the server listing, before the reads (which can each take the full
  // timeout on a dataless iCloud file). A row missing from `listed` was
  // missing at this moment, and that is the time §F.3.3 has to measure the
  // five minutes from (see `UploadDeps.now`).
  const observedAt = deps.now();
  const notes: LocalNote[] = [];
  for (const { path, cachedSourceId } of listed) {
    if (deps.signal?.aborted) throw new SyncCancelledError('Upload was cancelled.');
    let text: string;
    try {
      text = await readWithTimeout(vault.readFresh(path), deps.readTimeoutMs ?? READ_TIMEOUT_MS);
    } catch {
      // §F.3.2: unreadable is unknown. Neither a put nor a delete.
      notes.push(unreadable(path, cachedSourceId));
      continue;
    }
    texts.set(path, text);
    notes.push(describeNote(path, text, cachedSourceId));
  }
  return { notes, observedAt };
}

/**
 * Wrap an API call with the 429 backoff (D-RUN-5) and the once-per-run
 * step-up (D-AUTH-4). The step-up budget is shared by every call in the run:
 * after one re-authorization, a second `insufficient_scope` stops the run.
 */
function retrying(
  deps: UploadDeps,
  budget: { steppedUp: boolean; account: string | null },
): <T>(fn: () => Promise<T>) => Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  return async function call<T>(fn: () => Promise<T>): Promise<T> {
    let rateLimited = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof RateLimitedError && rateLimited < MAX_RATE_LIMIT_RETRIES) {
          const wait = error.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** rateLimited);
          rateLimited += 1;
          await sleep(Math.min(wait, MAX_BACKOFF_MS), deps.signal);
          continue;
        }
        if (error instanceof InsufficientScopeError && deps.stepUp && !budget.steppedUp) {
          budget.steppedUp = true;
          try {
            await deps.stepUp();
          } catch (stepUpError) {
            throw new InsufficientScopeError(undefined, { cause: stepUpError });
          }
          // Rule 8: the plan was built from the previous account's listing.
          // Retrying under another account would carry it out there.
          if (deps.account && deps.account() !== budget.account) throw new AccountChangedError();
          continue;
        }
        throw error;
      }
    }
  };
}

/** Carry out one planned action. Throws; the caller classifies (rule 4). */
async function execute(
  action: UploadAction,
  deps: UploadDeps,
  texts: Map<string, string>,
  result: UploadResult,
  call: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  if (action.kind === 'delete') {
    const outcome = await call(() => deps.api.delete(action.sourceId, deps.signal));
    if (outcome.kind === 'rejected') {
      result.failures.push({ path: action.path, message: `could not be removed: ${outcome.message}` });
      return;
    }
    result.removed += 1;
    result.removedIds.push(action.sourceId);
    delete result.nextMemory[action.sourceId];
    return;
  }

  let text: string;
  let sourceId: string;
  if (action.kind === 'put' && action.adopt === true) {
    // The note lost its id line but sits at this source's path: write the
    // SAME id back before the PUT (rule 1), so it stays one source rather
    // than being deleted and re-ingested as a new one (D-PLAN-4, review).
    const want = action.sourceId;
    deps.selfWrites?.mark(action.path);
    text = await deps.vault.processText(action.path, (content) => {
      const r = stampText(content, want);
      return r.kind === 'ok' ? r.text : content;
    });
    const written = readSourceId(text);
    if (written === null || !written.valid) {
      result.skipped.push({ path: action.path, reason: written === null ? 'unstampable' : 'invalid-id' });
      return;
    }
    if (written.id !== want) {
      // Another device stamped it between our read and our write. Its id is
      // on disk now; the next run plans from that, one decision per run.
      result.failures.push({
        path: action.path,
        message: 'another device gave this note an id first; it will be sorted out on the next sync',
      });
      return;
    }
    sourceId = want;
    result.stamped += 1;
  } else if (action.kind === 'put') {
    const read = texts.get(action.path);
    if (read === undefined) throw new Error('the note was not read in this run');
    text = read;
    sourceId = action.sourceId;
  } else {
    // stamp / restamp: write the id to disk FIRST (rule 1).
    const newId = deps.newId().toLowerCase();
    const transform =
      action.kind === 'stamp'
        ? (content: string) => {
            const r = stampText(content, newId);
            return r.kind === 'ok' ? r.text : content;
          }
        : (content: string) => {
            const r = restampText(content, newId);
            return r.kind === 'ok' ? r.text : content;
          };
    deps.selfWrites?.mark(action.path);
    text = await deps.vault.processText(action.path, transform);
    const written = readSourceId(text);
    if (written === null || !written.valid) {
      // The note changed under us into something the stamp refuses (its fence
      // was opened and not closed, most likely). Nothing was written.
      result.skipped.push({ path: action.path, reason: written === null ? 'unstampable' : 'invalid-id' });
      return;
    }
    if (action.kind === 'restamp' && written.id === action.oldId) {
      throw new Error('could not give this copy a new id');
    }
    sourceId = written.id; // ours, or another device's that got there first
    result.stamped += 1;
  }

  const sent = uploadText(text);
  const outcome = await call(() =>
    deps.api.put(
      sourceId,
      { vault_path: action.path, title: noteTitle(text, action.path), text: sent, body_hash: noteHash(text) },
      deps.signal,
    ),
  );
  switch (outcome.kind) {
    case 'accepted':
    case 'unchanged':
      if (outcome.kind === 'accepted') result.uploaded += 1;
      else result.unchanged += 1;
      result.sentIds.push(sourceId);
      result.nextMemory[sourceId] = {
        path: action.path,
        hash: noteHash(text),
        bytes: utf8Bytes(sent),
        bodyBytes: utf8Bytes(bodyText(text)),
        contentKey: contentKey(text),
        missingSince: null,
      };
      return;
    case 'rejected':
      result.failures.push({ path: action.path, message: outcome.message });
      return;
    case 'conflict-deleted':
      // D-RUN-6: the next run's listing shows the row deleted, and the plan
      // restamps the note then. One decision per run, from the plan.
      result.failures.push({
        path: action.path,
        message: 'was removed from Javis; it will be uploaded again as a new note on the next sync',
      });
      return;
    case 'oversize':
      result.skipped.push({ path: action.path, reason: 'oversize' });
      return;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The ids still owed a re-send after this run (review): the previous owed
 * ids, minus every id that went out, plus every re-send that failed in a way
 * worth retrying — restricted to ids this vault still remembers, so a
 * deleted note is not owed for ever.
 */
export function nextPendingReupload(
  previous: readonly string[],
  result: Pick<UploadResult, 'sentIds' | 'retryIds' | 'nextMemory'>,
): string[] {
  const owed = new Set(previous);
  for (const id of result.sentIds) owed.delete(id);
  for (const id of result.retryIds) owed.add(id);
  return [...owed].filter((id) => result.nextMemory[id] !== undefined).sort();
}

/** One line for the status bar: "3 uploaded, 1 unchanged, 2 removed, 4 held, 1 failed". */
export function summarizeUpload(result: UploadResult): string {
  if (!result.ran) return 'no upload folders';
  if (result.invalidFolders.length > 0) return 'upload folders need attention';
  const parts: string[] = [];
  if (result.uploaded) parts.push(`${result.uploaded} uploaded`);
  if (result.unchanged) parts.push(`${result.unchanged} unchanged`);
  if (result.removed) parts.push(`${result.removed} removed`);
  if (result.held.length) parts.push(`${result.held.length} held`);
  if (result.failures.length) parts.push(`${result.failures.length} failed`);
  let line = parts.length > 0 ? parts.join(', ') : 'nothing to upload';
  if (result.stoppedBy && result.stoppedBy.code !== 'cancelled') line += `; stopped: ${result.stoppedBy.message}`;
  return line;
}

/**
 * `settings.uploadRemovedIds` after this run: the previous ids plus the ones
 * this run removed, de-duplicated, most recent last, keeping the last
 * `REMOVED_IDS_CAP`. A report older than that many deletes drops out of
 * "Recently removed", which is what "recently" means.
 */
export function nextRemovedIds(previous: readonly string[], removed: readonly string[]): string[] {
  const fresh = new Set(removed);
  return [...previous.filter((id) => !fresh.has(id)), ...fresh].slice(-REMOVED_IDS_CAP);
}

/** How many entries of each list the persisted report keeps (the tab shows 10). */
export const REPORT_LIST_CAP = 100;

/**
 * The persisted, capped copy of a run for `data.json` (D-UI-2 shows 10 of
 * each; `held` is kept whole for the review). Memory is never part of it.
 *
 * A run that stopped before planning — a network error on the listing, a
 * missing write grant — decided nothing, so its empty `held`, `skipped` and
 * `waiting` say nothing about what is pending. Keeping the previous run's
 * lists then is what lets "Review pending changes" still show the 12 deletes
 * held an hour ago, and keeps the next run's held-Notice de-duplication from
 * treating them as new (review). The summary, time, stop reason and counters
 * are this run's.
 */
export function uploadReport(
  previous: LastUploadReport | null,
  result: UploadResult,
  summary: string,
  at: string,
): LastUploadReport {
  const { nextMemory: _memory, ...rest } = result;
  const keep = !result.planned && previous !== null;
  return {
    ...rest,
    held: keep ? previous.held : rest.held,
    skipped: (keep ? previous.skipped : rest.skipped).slice(0, REPORT_LIST_CAP),
    waiting: (keep ? previous.waiting : rest.waiting).slice(0, REPORT_LIST_CAP),
    failures: rest.failures.slice(0, REPORT_LIST_CAP),
    serverFailures: (keep ? previous.serverFailures : rest.serverFailures).slice(0, REPORT_LIST_CAP),
    undoReports: (keep && rest.undoReports.length === 0 ? previous.undoReports : rest.undoReports).slice(
      0,
      REPORT_LIST_CAP,
    ),
    counts: keep && Object.keys(rest.counts).length === 0 ? previous.counts : rest.counts,
    at,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Self-write suppression, the edit debounce, download-then-upload
// ---------------------------------------------------------------------------

/**
 * Remembers the paths the plugin just stamped, so the `modify` each stamp
 * raises does not schedule an upload-on-edit (D-TRIG-2, §F.2). One consume per
 * mark, and marks expire, so a real edit a few seconds later still counts.
 */
export class SelfWriteTracker {
  readonly #marks = new Map<string, number>();

  constructor(
    private readonly clock: () => number,
    private readonly windowMs = SELF_WRITE_WINDOW_MS,
  ) {}

  mark(path: string): void {
    this.#marks.set(path, this.clock());
  }

  /** True (and forgets the mark) for the first `modify` within the window. */
  consume(path: string): boolean {
    const at = this.#marks.get(path);
    if (at === undefined) return false;
    this.#marks.delete(path);
    return this.clock() - at <= this.windowMs;
  }
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * A trailing debounce: `poke()` restarts the wait; `fn` runs `ms` after the
 * last poke. If `busy()` is true when it fires (a sync is running), it re-arms
 * rather than being dropped — the edit it stands for has not been uploaded.
 */
export function createTrailingDebounce(
  fn: () => void,
  ms: number,
  busy: () => boolean = () => false,
  timers: TimerApi = { setTimeout: (f, t) => setTimeout(f, t), clearTimeout: (h) => clearTimeout(h as never) },
): { poke(): void; cancel(): void } {
  let handle: unknown = null;
  const arm = (): void => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      handle = null;
      if (busy()) {
        arm();
        return;
      }
      fn();
    }, ms);
  };
  return {
    poke: arm,
    cancel(): void {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface RunOutcome<D, U> {
  /** null when skipped (`uploadOnly`). */
  download: Settled<D> | null;
  /** null when skipped (the download was cancelled). */
  upload: Settled<U> | null;
}

/**
 * Download, then upload, each running even when the other fails (§F.2
 * "Failures"; D-RUN-1). Two exceptions, both deliberate: a cancelled download
 * (the plugin is unloading) skips the upload, and `uploadOnly` (the edit
 * trigger and the review command) skips the download.
 */
export async function runDownloadThenUpload<D, U>(steps: {
  download: () => Promise<D>;
  upload: () => Promise<U>;
  uploadOnly?: boolean;
}): Promise<RunOutcome<D, U>> {
  const outcome: RunOutcome<D, U> = { download: null, upload: null };
  if (!steps.uploadOnly) {
    try {
      outcome.download = { ok: true, value: await steps.download() };
    } catch (error) {
      outcome.download = { ok: false, error };
      if (isJavisError(error) && error.code === 'cancelled') return outcome;
    }
  }
  try {
    outcome.upload = { ok: true, value: await steps.upload() };
  } catch (error) {
    outcome.upload = { ok: false, error };
  }
  return outcome;
}
