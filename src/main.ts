/**
 * The plugin entry point: wiring, triggers, and exactly one sync at a time.
 *
 * Spec: docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md
 *
 * Everything this class does is composition. The §F.2 loop is `syncOnce`, the
 * OAuth dance is `JavisOAuth`, the HTTP is `JavisWikiApiClient`, the disk is
 * `ObsidianVaultAdapter`, and every decision about what a note should contain
 * is a pure function in `src/core`. What lives here and nowhere else is the
 * part that is genuinely about being a plugin: the object graph, the three
 * §F.4 triggers, the single-flight guard, and turning a thrown error into a
 * sentence a user can act on.
 *
 * Two invariants worth stating at the top, because they are the ones a future
 * edit could quietly break:
 *
 * - **No token is ever passed to `saveData`.** Both live in the OS keychain via
 *   `ObsidianSecretStore`; `JavisSettings` has no field for one and contracts.ts
 *   fails the build if a token-shaped key is added. `data.json` is inside the
 *   vault and replicates everywhere the vault does (§D).
 * - **Exactly one sync runs at a time.** Three triggers plus a settings button
 *   can otherwise land two runs on `vault.process` for the same file, which is
 *   the write race §F.2 exists to avoid. `#running` is the whole mechanism, and
 *   every entry point goes through `syncNow`.
 *
 * Since 0.2.0 (spec javis-server/docs/superpowers/specs/2026-09-24-obsidian-
 * notes-ingest-design.md §F.4) a run is the download followed by the upload,
 * inside the same guard, each half running even when the other fails. The
 * upload half does nothing — no request at all — until the user selects a
 * folder, so an install that never opts in behaves exactly like 0.1.x.
 */

import { Notice, Plugin, TFile } from 'obsidian';

import { isUnderFolder } from './core/folders';
import { JavisWikiApiClient, obsidianTransport } from './shell/api';
import { JavisOAuth, connectOptionsFor, isLegacyAudience, lacksWriteGrant } from './shell/auth';
import type {
  ConnectOptions,
  JavisSettings,
  SyncResult,
  SyncTrigger,
  UploadResult,
} from './shell/contracts';
import { DEFAULT_SETTINGS } from './shell/contracts';
import { isJavisError } from './shell/errors';
import { ReviewPendingModal } from './shell/review-modal';
import { JavisSettingTab, describe } from './shell/settings';
import {
  MISSING_SINCE_STORAGE_KEY,
  joinMissing,
  sanitizeMissing,
  sanitizeSettings,
  splitMissing,
} from './shell/settings-load';
import { JavisSourcesApiClient } from './shell/sources-api';
import { summarize, syncOnce } from './shell/sync';
import {
  EDIT_DEBOUNCE_MS,
  SelfWriteTracker,
  createTrailingDebounce,
  nextPendingReupload,
  runDownloadThenUpload,
  summarizeUpload,
  uploadOnce,
  uploadReport,
} from './shell/upload';
import { ObsidianSecretStore, ObsidianVaultAdapter } from './shell/vault';

/**
 * How long after layout-ready the vault-open sync waits.
 *
 * Obsidian fires a storm of `create` events while it loads a vault, and the
 * metadata cache is still filling during it. `listMarkdownFiles` reads that
 * cache for the §F.1 rescan, so starting immediately can compute a cursor from
 * a half-populated vault. Two seconds costs nothing and lets the cache settle.
 */
const VAULT_OPEN_DELAY_MS = 2_000;

const MINUTE_MS = 60_000;

/** Triggers a person just initiated: they get Notices, and may open the browser for a step-up. */
const INTERACTIVE: ReadonlySet<SyncTrigger> = new Set<SyncTrigger>(['command', 'settings', 'review']);

/** Options for one run. All optional; `syncNow(trigger)` alone is the 0.1.x run plus the upload. */
export interface SyncOptions {
  /** Hold keys confirmed in "Review pending changes" (D-PLAN-14). */
  release?: string[];
  /** "Re-upload all" (D-PLAN-15). */
  reuploadAll?: boolean;
  /** Skip the download: the edit trigger and the review command. */
  uploadOnly?: boolean;
}

export default class JavisWikiSyncPlugin extends Plugin {
  settings: JavisSettings = { ...DEFAULT_SETTINGS };
  auth!: JavisOAuth;

  #vault!: ObsidianVaultAdapter;
  #api!: JavisWikiApiClient;
  #sources!: JavisSourcesApiClient;
  /** Paths the upload just stamped; their `modify` must not schedule an upload (§F.2). */
  readonly #selfWrites = new SelfWriteTracker(() => Date.now());
  #editDebounce: { poke(): void; cancel(): void } | null = null;

  /** The single-flight guard. Never written anywhere but `syncNow`. */
  #running = false;
  /** Aborts the in-flight run when the plugin unloads. */
  #abort: AbortController | null = null;

  #intervalId: number | null = null;
  #openTimeoutId: number | null = null;
  #statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.#vault = new ObsidianVaultAdapter(this.app);

    // One `requestUrl` adapter for the whole plugin. It passes `throw: false`,
    // which is load-bearing for auth: without it every 4xx arrives as a thrown
    // Error, the `invalid_grant` that drives the reconnect notice is
    // misclassified as a network blip, and the user is never told to reconnect.
    this.auth = new JavisOAuth({
      baseUrl: () => this.settings.baseUrl,
      secrets: new ObsidianSecretStore(this.app),
      http: obsidianTransport,
      getClient: () => this.settings.oauthClient,
      setClient: async (client) => {
        this.settings.oauthClient = client;
        await this.saveSettings();
      },
      // The authorize URL must open in the SYSTEM browser: /oauth/authorize
      // redirects through Clerk and the callback page reads the user's existing
      // Clerk cookies, which live there and not in an Electron popup.
      openBrowser: (url) => {
        window.open(url, '_blank');
      },
    });

    this.#api = new JavisWikiApiClient(
      { baseUrl: this.settings.baseUrl },
      this.auth,
      obsidianTransport,
    );
    // Reads `baseUrl` live, unlike the export client above (plan D-API-2).
    this.#sources = new JavisSourcesApiClient(
      { baseUrl: () => this.settings.baseUrl },
      this.auth,
      obsidianTransport,
    );
    this.#editDebounce = createTrailingDebounce(
      () => {
        void this.syncNow('edit', { uploadOnly: true });
      },
      EDIT_DEBOUNCE_MS,
      () => this.#running,
    );

    this.#statusBar = this.addStatusBarItem();
    this.#setStatus(this.settings.lastSyncSummary ?? 'Javis: idle');

    this.addSettingTab(new JavisSettingTab(this.app, this));

    // §F.4 trigger (c): the command palette. Obsidian prefixes the plugin name,
    // so this renders as "Javis Wiki Sync: Sync now" — the spec's
    // "Javis: Sync now" is the intent, and naming it that would double up.
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => {
        void this.syncNow('command');
      },
    });

    this.addRibbonIcon('refresh-cw', 'Javis: sync now', () => {
      void this.syncNow('command');
    });

    // Spec 2026-09-24 §F.3.6: the held changes, listed, sent on confirmation.
    this.addCommand({
      id: 'review-pending-changes',
      name: 'Review pending changes',
      callback: () => this.openReview(),
    });

    // §F.4 trigger (a): vault open, debounced. Inside `onLayoutReady` so the
    // initial vault-load event storm is behind us before anything runs. For
    // the upload half this run is also the reconcile that catches edits made
    // while Obsidian was closed, which raise no events (2026-09-24 §F.4).
    this.app.workspace.onLayoutReady(() => {
      // Registered here and not earlier: `create`/`modify` storms fire while a
      // vault loads (2026-09-24 §L.2), and none of them is an edit.
      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (!this.settings.uploadOnEdit) return;
          if (!(file instanceof TFile) || file.extension !== 'md') return;
          if (!this.settings.uploadFolders.some((folder) => isUnderFolder(file.path, folder))) return;
          // Our own stamp raised this modify. Ignoring it is what stops two
          // devices from looping on each other's writes (obsync #179).
          if (this.#selfWrites.consume(file.path)) return;
          this.#editDebounce?.poke();
        }),
      );

      if (!this.settings.syncOnVaultOpen) return;
      this.#openTimeoutId = window.setTimeout(() => {
        this.#openTimeoutId = null;
        void this.syncNow('vault-open');
      }, VAULT_OPEN_DELAY_MS);
    });

    // §F.4 trigger (b): the interval. Off by default.
    this.restartInterval();
  }

  onunload(): void {
    // Cancel the in-flight run rather than letting it write into a vault the
    // plugin no longer belongs to. `requestUrl` has no cancellation, so one
    // request may still be in the air; the run stops before its next write.
    this.#abort?.abort();
    this.#editDebounce?.cancel();
    this.#clearInterval();
    if (this.#openTimeoutId !== null) {
      window.clearTimeout(this.#openTimeoutId);
      this.#openTimeoutId = null;
    }
  }

  // -- settings -------------------------------------------------------------

  async loadSettings(): Promise<void> {
    // Every field checked against its type, and a malformed upload memory
    // entry repaired toward "unknown", which can only delay a delete
    // (settings-load.ts). A hand-edited or foreign `data.json` must not be
    // able to put a nonsense value into `setInterval` or `planUpload`.
    this.settings = sanitizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // -- §F.4 trigger (b) -----------------------------------------------------

  /** Called by the settings tab whenever the interval toggle or minutes change. */
  restartInterval(): void {
    this.#clearInterval();
    if (!this.settings.intervalEnabled) return;
    const ms = this.settings.intervalMinutes * MINUTE_MS;
    // `registerInterval` hands the id to Obsidian so it is cleared on unload
    // even if `onunload` never runs; `#intervalId` is kept so a settings change
    // can replace it without waiting for a reload.
    this.#intervalId = this.registerInterval(
      window.setInterval(() => {
        void this.syncNow('interval');
      }, ms),
    );
  }

  #clearInterval(): void {
    if (this.#intervalId === null) return;
    window.clearInterval(this.#intervalId);
    this.#intervalId = null;
  }

  // -- the run --------------------------------------------------------------

  /**
   * Run one sync, unless one is already running.
   *
   * Never rejects: every trigger calls it fire-and-forget, so an unhandled
   * rejection here would surface as a console error the user cannot act on
   * instead of a Notice they can. The outcome always reaches the user twice —
   * once in the status bar, once in `settings.lastSyncSummary`.
   *
   * A manual sync that arrives during an interval sync is refused with a
   * Notice, not queued. Queueing would mean a second run starting the moment
   * the first one ends, which is the same double-write with a delay in front of
   * it, and there is nothing a second immediate run would learn.
   */
  async syncNow(trigger: SyncTrigger, opts: SyncOptions = {}): Promise<SyncResult | null> {
    const interactive = INTERACTIVE.has(trigger);
    if (this.#running) {
      if (interactive) {
        new Notice('Javis: a sync is already running.');
      }
      return null;
    }
    if (!this.auth.isConnected()) {
      if (interactive) {
        new Notice('Javis: connect your account in the plugin settings first.');
      }
      return null;
    }

    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#setStatus('Javis: syncing…');

    try {
      const outcome = await runDownloadThenUpload({
        uploadOnly: opts.uploadOnly,
        download: () => this.#download(trigger, signal),
        upload: () => this.#upload(trigger, opts, signal),
      });

      let downloadLine = this.settings.lastSyncSummary ?? 'idle';
      let downloadResult: SyncResult | null = null;
      if (outcome.download?.ok) {
        downloadResult = outcome.download.value;
        downloadLine = summarize(downloadResult);
      } else if (outcome.download && !outcome.download.ok) {
        await this.#reportFailure(outcome.download.error, trigger);
        if (isJavisError(outcome.download.error) && outcome.download.error.code === 'cancelled') {
          return null;
        }
        downloadLine = 'sync failed';
      }

      let uploadLine: string | null = null;
      if (outcome.upload?.ok && outcome.upload.value !== null) {
        uploadLine = outcome.upload.value;
      } else if (outcome.upload && !outcome.upload.ok) {
        // `uploadOnce` never throws, so this is a bug in the wiring; say so
        // rather than leaving the status bar on "syncing…".
        uploadLine = `failed: ${describe(outcome.upload.error)}`;
      }

      this.#setStatus(
        opts.uploadOnly
          ? `Javis: upload: ${uploadLine ?? 'nothing to upload'}`
          : `Javis: ${downloadLine}${uploadLine === null ? '' : ` · upload: ${uploadLine}`}`,
      );
      return downloadResult;
    } finally {
      this.#running = false;
      this.#abort = null;
    }
  }

  /**
   * The Phase 1 download, as it was: the body of 0.1.x `syncNow`, moved into a
   * method so the upload can follow it. Throws on failure; `syncNow` reports.
   */
  async #download(trigger: SyncTrigger, signal: AbortSignal): Promise<SyncResult> {
    const result = await syncOnce({
      api: this.#api,
      vault: this.#vault,
      cachedCursor: this.settings.cachedCursor,
      pendingFullResync: this.settings.pendingFullResync,
      trigger,
      signal,
      onProgress: (done) => this.#setStatus(`Javis: syncing… ${done}`),
    });

    // `nextCursor` is null when the run wrote nothing it was handed, or
    // could not write part of it. Keeping the old cursor re-delivers those
    // rows next time, and every write in §F.2 is idempotent.
    if (result.nextCursor !== null) this.settings.cachedCursor = result.nextCursor;
    // Keeping the cursor is not enough when the cursor came from the vault:
    // `max(javis_rev)` has moved past the note that failed. The run says so,
    // and a clean run says the opposite, so this is assigned and never OR-ed.
    this.settings.pendingFullResync = result.pendingFullResync;

    const summary = summarize(result);
    this.settings.lastSyncAt = result.finishedAt;
    this.settings.lastSyncSummary = summary;
    await this.saveSettings();

    this.#setStatus(`Javis: ${summary}`);
    if (INTERACTIVE.has(trigger)) {
      new Notice(`Javis: ${summary}.`);
    }
    if (result.failures.length > 0) {
      // Named, not counted: "3 failed" is not something a user can fix.
      const listed = result.failures
        .slice(0, 5)
        .map((failure) => `• ${failure.path}: ${failure.message}`)
        .join('\n');
      new Notice(`Javis could not write some notes:\n${listed}`, 12_000);
    }
    return result;
  }

  /**
   * The upload half (2026-09-24 §F.2). Returns the status-bar line, or null
   * when there is nothing to say (no folder selected, nothing left to remove).
   * Never throws past
   * `uploadOnce`, which never throws.
   */
  async #upload(trigger: SyncTrigger, opts: SyncOptions, signal: AbortSignal): Promise<string | null> {
    if (!this.#uploadsActive()) return null; // D-RUN-2
    const interactive = INTERACTIVE.has(trigger);

    // D-RUN-3: a background run with a token that visibly cannot write (no
    // `wiki:write`, or the pre-0.2.0 audience) does not try, and does not open
    // a browser. An undecodable token is tried, and a 403 decides. An
    // interactive run passes the same check to `uploadOnce`, which steps up
    // before it stamps anything (its rule 7).
    if (!interactive && this.#lacksWriteGrant()) {
      return 'paused; reconnect in settings to allow uploads';
    }

    const reuploadAll = opts.reuploadAll === true || this.settings.pendingReuploadAll;
    const previousHeld = new Set((this.settings.lastUpload?.held ?? []).map((h) => h.key));

    const result = await uploadOnce({
      api: this.#sources,
      vault: this.#vault,
      folders: this.settings.uploadFolders,
      // The synced memory with THIS device's debounce clocks (§F.3.3, review).
      memory: joinMissing(this.settings.uploadMemory, this.#loadMissing()),
      // A clock, not a time: `uploadOnce` reads it after any step-up, when it
      // enumerates the vault (review; see `UploadDeps.now`).
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      reuploadAll,
      reuploadIds: this.settings.pendingReuploadIds,
      release: opts.release ?? [],
      signal,
      // D-AUTH-4: only a person who just clicked may be sent to the browser.
      stepUp: interactive ? () => this.auth.connect(this.uploadConnectOptions()) : undefined,
      lacksWriteGrant: () => this.#lacksWriteGrant(),
      selfWrites: this.#selfWrites,
      onProgress: (done, total) => this.#setStatus(`Javis: uploading… ${done}/${total}`),
    });

    const summary = summarizeUpload(result);
    // D-RUN-10: memory is persisted whatever happened — the clocks on this
    // device, everything else in data.json.
    const { synced, missing } = splitMissing(result.nextMemory);
    this.settings.uploadMemory = synced;
    this.#saveMissing(missing);
    this.settings.lastUpload = uploadReport(this.settings.lastUpload, result, summary, new Date().toISOString());
    // A run that did not stop has tried every note once; the notes whose
    // re-send failed stay owed by id, so clearing the flag no longer drops
    // them (review).
    if (result.stoppedBy === null && result.invalidFolders.length === 0) this.settings.pendingReuploadAll = false;
    else if (opts.reuploadAll) this.settings.pendingReuploadAll = true;
    this.settings.pendingReuploadIds = nextPendingReupload(this.settings.pendingReuploadIds, result);
    await this.saveSettings();

    this.#noticeUpload(result, summary, interactive, previousHeld);
    return summary;
  }

  /**
   * This device's `missingSince` clocks. Never throws: storage that is
   * unavailable reads as "no clocks", which restarts the debounce — a later
   * delete, never an earlier one.
   */
  #loadMissing(): Record<string, number> {
    try {
      return sanitizeMissing(this.app.loadLocalStorage(MISSING_SINCE_STORAGE_KEY));
    } catch {
      return {};
    }
  }

  #saveMissing(missing: Record<string, number>): void {
    try {
      this.app.saveLocalStorage(MISSING_SINCE_STORAGE_KEY, Object.keys(missing).length > 0 ? missing : null);
    } catch {
      // Lost clocks only delay deletes.
    }
  }

  #noticeUpload(result: UploadResult, summary: string, interactive: boolean, previousHeld: Set<string>): void {
    if (result.stoppedBy?.code === 'cancelled') return;
    if (interactive) new Notice(`Javis upload: ${summary}.`);

    if (result.invalidFolders.length > 0) {
      const listed = result.invalidFolders.map((e) => `• ${e.folder || '(vault root)'}: ${e.reason}`).join('\n');
      new Notice(`Javis uploads are off until the folder list is fixed:\n${listed}`, 12_000);
    }

    // D-UI-1: at most one held Notice per run, and only when the set changed,
    // so an interval run does not repeat the same warning every 30 minutes.
    const heldKeys = new Set(result.held.map((h) => h.key));
    const changed = heldKeys.size !== previousHeld.size || [...heldKeys].some((k) => !previousHeld.has(k));
    if (result.held.length > 0 && (changed || interactive)) {
      new Notice(
        `Javis held ${result.held.length} change${result.held.length === 1 ? '' : 's'} as a precaution. ` +
          'Run "Review pending changes" to see and send them.',
        12_000,
      );
    }

    if (result.failures.length > 0) {
      const listed = result.failures
        .slice(0, 5)
        .map((failure) => `• ${failure.path}: ${failure.message}`)
        .join('\n');
      new Notice(`Javis could not upload some notes:\n${listed}`, 12_000);
    }

    // Like #reportFailure: a background run that needs the user still says so.
    if (result.stoppedBy && (interactive || result.stoppedBy.needsUserAction)) {
      new Notice(`Javis upload stopped: ${result.stoppedBy.message}`, 10_000);
    }
  }

  // -- the upload's OAuth and review surface --------------------------------

  /**
   * What `connect` should ask for (§C.3, §C.7): the `/wiki` resource always,
   * and the union scope once an upload folder is selected. See
   * `connectOptionsFor` for why the resource is no longer conditional.
   */
  uploadConnectOptions(): ConnectOptions {
    return connectOptionsFor(this.settings.baseUrl, this.#uploadsActive());
  }

  /**
   * True while the upload half has work: a folder is selected, or none is but
   * notes uploaded earlier are still remembered, i.e. the last folder was
   * deselected and its sources still have to be removed (D-PLAN-13). False
   * only for an install that never opted in, or has finished cleaning up —
   * which then makes exactly the 0.1.x requests (D-RUN-2).
   */
  #uploadsActive(): boolean {
    return this.settings.uploadFolders.length > 0 || Object.keys(this.settings.uploadMemory).length > 0;
  }

  /**
   * True when this device's token visibly cannot write (D-AUTH-3): its scope
   * lacks `wiki:write`, or its audience is the pre-0.2.0 `/mcp` resource the
   * upload routes refuse. Only asked while uploads are on.
   */
  #lacksWriteGrant(): boolean {
    return lacksWriteGrant(this.auth.grantedScopes(), this.auth.grantedAudiences(), this.settings.baseUrl);
  }

  /** True when a folder is selected but this device's token cannot write (D-AUTH-3). */
  needsUploadReconnect(): boolean {
    if (this.settings.uploadFolders.length === 0 || !this.auth.isConnected()) return false;
    return this.#lacksWriteGrant();
  }

  /**
   * True when a read-only device still holds a pre-0.2.0 `/mcp`-audience
   * grant. The download keeps working for now — `/wiki/export` accepts that
   * audience for one release (§C.3) — but a refresh can never move it to
   * `/wiki`, so the settings tab asks for one reconnect before the window
   * closes. Not a Notice: nothing is broken yet.
   */
  needsAudienceReconnect(): boolean {
    if (!this.auth.isConnected()) return false;
    return isLegacyAudience(this.auth.grantedAudiences(), this.settings.baseUrl);
  }

  /** The "Review pending changes" command. */
  openReview(): void {
    const held = this.settings.lastUpload?.held ?? [];
    if (held.length === 0) {
      new Notice('Javis: there are no pending changes to review.');
      return;
    }
    new ReviewPendingModal(this.app, held, (keys) => {
      void this.syncNow('review', { release: keys, uploadOnly: true });
    }).open();
  }

  /**
   * Turn a thrown error into one sentence and one stored summary.
   *
   * The error classes already carry the right sentence — that is why they
   * exist. `AuthRequiredError` says connect, `AuthRevokedError` says reconnect
   * (§D step 6: notify and STOP, never retry), `RateLimitedError` says wait.
   * Nothing is retried here; the next trigger is the retry, and the cursor was
   * not advanced, so it resumes from where this run started.
   */
  async #reportFailure(error: unknown, trigger: SyncTrigger): Promise<void> {
    if (isJavisError(error) && error.code === 'cancelled') {
      this.#setStatus('Javis: sync cancelled');
      return;
    }

    const message = describe(error);
    this.settings.lastSyncAt = new Date().toISOString();
    this.settings.lastSyncSummary = `Failed: ${message}`;
    await this.saveSettings();
    this.#setStatus('Javis: sync failed');

    // A background trigger that fails on something the user must act on still
    // has to say so — otherwise a revoked connection is silent forever.
    const mustTell =
      trigger === 'command' ||
      trigger === 'settings' ||
      (isJavisError(error) && error.needsUserAction);
    if (mustTell) new Notice(`Javis: ${message}`, 10_000);
  }

  #setStatus(text: string): void {
    this.#statusBar?.setText(text);
  }
}
