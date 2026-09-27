/**
 * The §F.2 loop: one delta, paged to exhaustion, written into the vault.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md §F.
 *
 * This module composes and does not decide. Every branch of §F.2 —
 * tombstone / create / adopted-skip / unchanged-skip / replace — is already a
 * pure function in `src/core/reconcile.ts`, and every byte written into a note
 * comes from `render`, `replaceMarkerBlock`, `applyTombstone` or
 * `tombstoneFrontmatter`. Nothing here re-derives a path, re-reads a revision,
 * or re-implements a skip rule: `decideAction` asks `reconcile` and
 * `applyAction` carries out the verdict. That is the whole design of §G, and it
 * is what lets the loop be tested against a fake `VaultAdapter`.
 *
 * Three properties this file is responsible for, none of which live in the core:
 *
 * 1. **The cursor.** `cachedCursor ?? max(javis_rev over the vault) ?? null`
 *    (§F.1), and the value persisted afterwards is the FIRST batch's
 *    `server_time` — never the last, never the client's clock. `ExportRun`
 *    hands that up already computed; this module only decides whether the run
 *    earned the right to advance it.
 * 2. **Failure isolation.** One note the vault refuses to write is one line in
 *    `SyncResult.failures`, not a dead run. But a run with any failure does NOT
 *    advance the cursor, so the next run re-delivers those rows — and when the
 *    cursor came from the §F.1 vault rescan rather than from `data.json`,
 *    holding it back is not enough, so the run also raises
 *    `SyncResult.pendingFullResync`. Every write in §F.2 is idempotent, which
 *    is what makes re-delivery free.
 * 3. **Never unlink a note.** The only removal `VaultAdapter` (contracts.ts)
 *    exposes is `removeFolderIfEmpty`, used after the 0.2.x layout move to drop
 *    an emptied root wiki folder; it refuses any folder with children, so no
 *    file is ever deleted or trashed.
 */

import { replaceMarkerBlock } from '../core/markers';
import { isWikiPageText } from '../core/note-text';
import { legacyDestination, planLayoutMove, type LayoutCandidate, type LayoutMove } from '../core/layout-move';
import { reconcile } from '../core/reconcile';
import { applyTombstone, tombstoneFrontmatter } from '../core/render';
import { pathForPage } from '../core/slug';
import type {
  ExportBatch,
  ServerPage,
  SyncAction,
  SyncDeps,
  SyncResult,
  VaultAdapter,
} from './contracts';
import { HttpError, SyncCancelledError, VaultWriteError, isJavisError } from './errors';
import { maxRevision, parentFolder } from './vault';

/**
 * The §F.1 cursor.
 *
 * `data.json` is a speed-up and nothing more: when `cachedCursor` is absent the
 * vault itself carries the answer, because every synced note holds the server's
 * `updated_at` verbatim in `javis_rev`. That is the property that makes losing,
 * corrupting, or git-conflicting `data.json` cost "a rescan and nothing else".
 *
 * An empty string is treated as absent. `?since=` with an empty value is a 400
 * from the server, and an empty string is what a hand-edited or half-written
 * `data.json` produces.
 *
 * The rescan has one blind spot, and `pendingFullResync` is the patch over it:
 * `max(javis_rev)` is computed from the notes that ARE in the vault, so a note
 * a previous run failed to write is invisible to it while its neighbours from
 * the same batch push the maximum past it. See `SyncResult.pendingFullResync`.
 */
export async function resolveCursor(
  vault: VaultAdapter,
  cachedCursor: string | null,
  pendingFullResync = false,
): Promise<string | null> {
  // `pendingFullResync` outranks both. A previous run failed on a note while
  // the rescan was the cursor, and the rescan cannot get back to it: the notes
  // that DID land raised `max(javis_rev)` above the one that did not. Only a
  // full export re-delivers it.
  if (pendingFullResync) return null;
  if (typeof cachedCursor === 'string' && cachedCursor !== '') return cachedCursor;
  return maxRevision(await vault.listMarkdownFiles());
}

/**
 * Ask `reconcile` what to do with one exported row.
 *
 * The path is computed once, by the same `pathForPage` that `reconcile` uses,
 * because the file's frontmatter has to be read before `reconcile` can be
 * called and reading it requires knowing where the file is. An unknown
 * `page_type` yields no path at all; passing `null` as `existing` lets
 * `reconcile` return its own `unknown-type` skip rather than this module
 * inventing a second copy of that rule.
 *
 * The frontmatter read is per-row and deliberately not a whole-vault scan: a
 * delta touches a handful of notes, and `VaultAdapter.readFrontmatter` parses
 * the file's own `---` block rather than consulting the metadata cache, which
 * lags a write and would make the loop rewrite the note it just wrote.
 *
 * EXISTENCE AND FRONTMATTER ARE TWO QUESTIONS. §F.2 branches on
 * `vault.getFileByPath(path)`; `readFrontmatter` answers null for three
 * different situations — no file, a file with no `---` block, and a file whose
 * YAML will not parse — and only the first of them means `create`. Reading the
 * other two as "absent" aims `create` at an occupied path: the adapter rejects
 * it, the row lands in `SyncResult.failures`, and nothing about the note ever
 * changes, so it fails again on every run forever. So `exists` decides the
 * branch and `{}` stands in for a file whose frontmatter we could not read —
 * which sends it down `replace`, appending a marker block BELOW whatever the
 * user wrote and leaving their text where it is, exactly as §F.2 prescribes.
 */
export async function decideAction(
  vault: VaultAdapter,
  page: ServerPage,
): Promise<SyncAction> {
  const path = pathForPage(page.page_type, page.slug);
  if (path === null) return reconcile(page, null);
  const existing = (await vault.exists(path))
    ? ((await vault.readFrontmatter(path)) ?? {})
    : null;
  return reconcile(page, existing);
}

/**
 * Carry out one verdict. No decision, no fallback, no recovery.
 *
 * `replace` is two writes and the order is not arbitrary: `vault.process`
 * first, because it is Obsidian's atomic read-modify-write and takes the
 * editor's lock, then `writeFrontmatter`, which REPLACES the property block
 * rather than merging into it. The replacement is the point — `mergeServerKeys`
 * signals a resurrection by omitting `javis_deleted`, and a merge would leave a
 * page that came back flagged deleted forever.
 *
 * `tombstone` carries only a path (the verdict has no body and no frontmatter),
 * so the file's own frontmatter is read here and `javis_deleted: true` is added
 * to it. Setting that flag is what makes the loop idempotent: it is the single
 * signal `reconcile`'s `already-tombstoned` skip reads, and without it the
 * banner would be re-applied on every delta whose `since` predates the
 * deletion. `javis_rev` is deliberately left at its old value — a tombstoned
 * note is a note that stopped being updated.
 */
export async function applyAction(vault: VaultAdapter, action: SyncAction): Promise<void> {
  switch (action.kind) {
    case 'skip':
      return;

    case 'create':
      await vault.create(action.path, action.content);
      return;

    case 'replace': {
      const { path, body, frontmatter } = action;
      await vault.process(path, (content) => replaceMarkerBlock(content, body));
      await vault.writeFrontmatter(path, frontmatter);
      return;
    }

    case 'tombstone': {
      const existing = (await vault.readFrontmatter(action.path)) ?? {};
      await vault.process(action.path, applyTombstone);
      await vault.writeFrontmatter(action.path, tombstoneFrontmatter(existing));
      return;
    }
  }
}

/** Mutable tally, collapsed into the immutable `SyncResult` at the end. */
interface RunState {
  created: number;
  replaced: number;
  tombstoned: number;
  skipped: number;
  scanned: number;
  failures: { path: string; message: string }[];
}

function emptyState(): RunState {
  return { created: 0, replaced: 0, tombstoned: 0, skipped: 0, scanned: 0, failures: [] };
}

function record(state: RunState, kind: SyncAction['kind']): void {
  switch (kind) {
    case 'create':
      state.created += 1;
      return;
    case 'replace':
      state.replaced += 1;
      return;
    case 'tombstone':
      state.tombstoned += 1;
      return;
    case 'skip':
      state.skipped += 1;
      return;
  }
}

/** Where a failed action was aimed, for the failure list. */
function targetOf(action: SyncAction, page: ServerPage): string {
  return action.kind === 'skip' ? `${page.page_type}/${page.slug}` : action.path;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncCancelledError('Sync was cancelled.');
}

/** What the layout move did, for the notices in src/main.ts. */
export interface LayoutMoveResult {
  moved: number;
  conflicts: readonly LayoutMove[];
}

/**
 * Move whatever the 0.2.x root layout left behind into `Javis-wiki/`
 * (spec 2026-09-27). Runs at the start of every sync and is a folder listing
 * once nothing is left to move.
 *
 * Frontmatter comes from `readFrontmatter` (the file), not from
 * `listMarkdownFiles` (the metadata cache): on the vault-open sync the cache
 * may not have indexed a note yet, and a Javis note missed here would be
 * re-created at its new path by the download, leaving a permanent conflict.
 *
 * A root note whose frontmatter will not parse (`readFrontmatter` is null) but
 * whose text still has a top-level `javis_slug:`/`javis_type:` line is a Javis
 * note the user broke by hand. It cannot be planned, and skipping it would let
 * the download fork it into a second copy, so it counts as a failed move.
 *
 * Every move is attempted. If any failed, this throws AFTER the rest, so the
 * caller downloads nothing this run: a download would `create` the unmoved
 * page at its new path. The next sync retries the move.
 *
 * A root note that cannot be read at all (no permission, a cloud placeholder
 * that will not download) is logged and skipped: most notes in these folders
 * are the user's own, and one unreadable file must not stop every sync.
 *
 * Only a root folder that lost a note this run is offered to
 * `removeFolderIfEmpty`; a failure there is logged and ignored.
 *
 * `onMoved` receives the result before this returns or throws, so the moves
 * that succeeded are still reported when another one failed.
 */
export async function moveLegacyLayout(
  vault: VaultAdapter,
  onMoved?: (result: LayoutMoveResult) => void,
): Promise<LayoutMoveResult> {
  const listed = await vault.listMarkdownFiles();
  const candidates: LayoutCandidate[] = [];
  const failures: { path: string; message: string }[] = [];
  for (const note of listed) {
    if (legacyDestination(note.path) === null) continue;
    let frontmatter: LayoutCandidate['frontmatter'];
    let brokenWikiPage: boolean;
    try {
      frontmatter = await vault.readFrontmatter(note.path);
      brokenWikiPage = frontmatter === null && isWikiPageText((await vault.read(note.path)) ?? '');
    } catch (error) {
      // Most notes here are the user's own; one unreadable file must not stop every sync.
      console.warn(`Javis: could not read ${note.path} to check whether it is a Javis note; skipped`, error);
      continue;
    }
    if (brokenWikiPage) {
      failures.push({ path: note.path, message: 'its properties (YAML) do not parse; fix them so it can move' });
      continue;
    }
    candidates.push({ path: note.path, frontmatter });
  }
  const plan = planLayoutMove(candidates, new Set(listed.map((note) => note.path)));

  let moved = 0;
  const emptied = new Set<string>();
  for (const move of plan.moves) {
    try {
      await vault.rename(move.from, move.to);
      moved += 1;
      emptied.add(parentFolder(move.from)!);
    } catch (error) {
      failures.push({ path: move.from, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const folder of emptied) {
    try {
      await vault.removeFolderIfEmpty(folder);
    } catch (error) {
      console.warn(`Javis: could not remove the emptied folder ${folder}`, error);
    }
  }

  const result: LayoutMoveResult = { moved, conflicts: plan.conflicts };
  onMoved?.(result);

  if (failures.length > 0) {
    const first = failures[0]!;
    throw new VaultWriteError(
      first.path,
      `Could not move ${failures.length} ${failures.length === 1 ? 'note' : 'notes'} into Javis-wiki/ ` +
        `(${first.path}: ${first.message}). Nothing was downloaded; the next sync retries.`,
    );
  }
  return result;
}

/**
 * Run the §F.2 loop once.
 *
 * ### What advances the cursor
 *
 * `ExportRun.serverTime` — the first batch's `server_time`, which the server
 * reads from the database clock before the row SELECT and holds back 60s, so
 * it is a watermark every row in the run is at or above. It becomes
 * `SyncResult.nextCursor` only when nothing failed. `null` means "keep the
 * cursor you had", and the caller must honour that literally: persisting a
 * watermark past a row the vault never received is the one way this design can
 * lose an update permanently.
 *
 * ### Auth
 *
 * A 401 is handled a layer down, inside `JavisApiClient`: one `auth.refresh()`
 * and one retry of the same request. An `AuthExpiredError` reaching this
 * function therefore means a freshly minted token was itself rejected, and a
 * second refresh-and-retry here would re-present the same new token, burn two
 * more requests against the 60/min bucket, and fail identically. So auth errors
 * propagate untouched, with the distinction §D step 6 depends on intact:
 * `AuthRequiredError` (never connected) and `AuthRevokedError` (reconnect) each
 * reach `main.ts` as themselves, and the run stops having written nothing more.
 *
 * ### A 400 invalidates the cursor
 *
 * The server answers 400 for a malformed `since` or `cursor`, and retrying the
 * same request cannot help — which means a bad `cachedCursor` (a truncated
 * `data.json`, a hand edit, a value from a different server) would otherwise
 * wedge the plugin permanently: every run would send the same bad cursor and
 * fail. Exactly once per run, a 400 on a non-null cursor falls back to the
 * §F.1 rescan, and to a full export when the rescan yields the same value or
 * nothing. The retry restarts the tally, so the summary describes the attempt
 * that actually ran.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const { api, vault, signal, onProgress } = deps;

  let state = emptyState();

  const consume = async (batch: ExportBatch): Promise<void> => {
    for (const page of batch.pages) {
      throwIfAborted(signal);
      state.scanned += 1;

      const action = await decideAction(vault, page);
      try {
        await applyAction(vault, action);
        record(state, action.kind);
      } catch (error) {
        // Auth, network, protocol and cancellation are run-level: they will
        // recur on every remaining note, so failing fast is both faster and
        // more honest than a thousand identical failure lines. Anything else —
        // a `VaultWriteError` from the adapter, or an unexpected throw — is one
        // note's problem (§ SyncResult.failures) and the run continues.
        if (isJavisError(error) && error.code !== 'vault-write') throw error;
        state.failures.push({
          path: targetOf(action, page),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      onProgress?.(state.scanned, action.kind);
    }
  };

  // Did the cursor this run actually sent come out of `data.json`, or out of the
  // vault? It decides whether withholding `nextCursor` is enough to re-deliver
  // a row that failed, and it is re-answered on the 400 retry below because the
  // retry's cursor never comes from `data.json`.
  let cursorFromCache =
    deps.pendingFullResync !== true &&
    typeof deps.cachedCursor === 'string' &&
    deps.cachedCursor !== '';

  const attempt = (since: string | null): Promise<string> => {
    state = emptyState();
    return api
      .exportAll({
        since,
        ...(deps.limit === undefined ? {} : { limit: deps.limit }),
        ...(signal === undefined ? {} : { signal }),
        onBatch: consume,
      })
      .then((run) => run.serverTime);
  };

  throwIfAborted(signal);
  // Before the cursor: the rescan and every `decideAction` must see the notes
  // where `pathForPage` now puts them (spec 2026-09-27). `onLayoutMoved` hears
  // about the move here, before the download or a cancel can throw it away.
  const layout = await moveLegacyLayout(vault, deps.onLayoutMoved);
  throwIfAborted(signal);
  const since = await resolveCursor(vault, deps.cachedCursor, deps.pendingFullResync);

  let serverTime: string;
  try {
    serverTime = await attempt(since);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 400 && since !== null)) throw error;
    // The cursor we sent is unusable. Re-derive it from the vault, and if that
    // is the same unusable value (or the vault has nothing to say), fall back
    // to a full export. A full export omits tombstones by design (§C), so a
    // deletion that happened while this cursor was broken is learned on the
    // next delta instead — an acceptable price for un-wedging the plugin.
    const rescanned = maxRevision(await vault.listMarkdownFiles());
    cursorFromCache = false;
    serverTime = await attempt(rescanned === since ? null : rescanned);
  }

  return {
    trigger: deps.trigger,
    created: state.created,
    replaced: state.replaced,
    tombstoned: state.tombstoned,
    skipped: state.skipped,
    scanned: state.scanned,
    // A run that could not write every row it was handed has not consumed the
    // watermark, so it does not get to move it.
    nextCursor: state.failures.length === 0 ? serverTime : null,
    // Withholding the watermark only re-delivers a failed row when the cursor
    // came from `data.json`, because that value is what the next run sends
    // again. When the cursor came from the vault instead, the next run
    // recomputes `max(javis_rev)` — and the rows that DID land in this run have
    // raised it past the row that did not, so the failed row is never asked for
    // again. §F.1's "a rescan and nothing else" is only true of a run that
    // wrote everything it was handed. This is the flag that makes it true of
    // the rest.
    pendingFullResync: state.failures.length > 0 && !cursorFromCache,
    moved: layout.moved,
    moveConflicts: layout.conflicts,
    failures: state.failures,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** One line for a Notice and the settings tab. Never mentions a token or a URL. */
export function summarize(result: SyncResult): string {
  const parts: string[] = [];
  if (result.created) parts.push(`${result.created} created`);
  if (result.replaced) parts.push(`${result.replaced} updated`);
  if (result.tombstoned) parts.push(`${result.tombstoned} marked deleted`);
  if (result.skipped) parts.push(`${result.skipped} unchanged`);
  if (parts.length === 0) parts.push('nothing to do');
  if (result.failures.length > 0) parts.push(`${result.failures.length} failed`);
  return parts.join(', ');
}
