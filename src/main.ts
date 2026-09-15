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
 */

import { Notice, Plugin } from 'obsidian';

import { JavisWikiApiClient, obsidianTransport } from './shell/api';
import { JavisOAuth } from './shell/auth';
import type { JavisSettings, SyncResult, SyncTrigger } from './shell/contracts';
import { DEFAULT_SETTINGS } from './shell/contracts';
import { isJavisError } from './shell/errors';
import { JavisSettingTab, clampMinutes, describe } from './shell/settings';
import { summarize, syncOnce } from './shell/sync';
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

export default class JavisWikiSyncPlugin extends Plugin {
  settings: JavisSettings = { ...DEFAULT_SETTINGS };
  auth!: JavisOAuth;

  #vault!: ObsidianVaultAdapter;
  #api!: JavisWikiApiClient;

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

    // §F.4 trigger (a): vault open, debounced. Inside `onLayoutReady` so the
    // initial vault-load event storm is behind us before anything runs.
    this.app.workspace.onLayoutReady(() => {
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
    this.#clearInterval();
    if (this.#openTimeoutId !== null) {
      window.clearTimeout(this.#openTimeoutId);
      this.#openTimeoutId = null;
    }
  }

  // -- settings -------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<JavisSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    // A `data.json` edited by hand, or written by an older version, must not be
    // able to put a nonsense value into `setInterval`.
    this.settings.intervalMinutes = clampMinutes(
      String(this.settings.intervalMinutes),
      DEFAULT_SETTINGS.intervalMinutes,
    );
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
  async syncNow(trigger: SyncTrigger): Promise<SyncResult | null> {
    if (this.#running) {
      if (trigger === 'command' || trigger === 'settings') {
        new Notice('Javis: a sync is already running.');
      }
      return null;
    }
    if (!this.auth.isConnected()) {
      if (trigger === 'command' || trigger === 'settings') {
        new Notice('Javis: connect your account in the plugin settings first.');
      }
      return null;
    }

    this.#running = true;
    this.#abort = new AbortController();
    this.#setStatus('Javis: syncing…');

    try {
      const result = await syncOnce({
        api: this.#api,
        vault: this.#vault,
        cachedCursor: this.settings.cachedCursor,
        pendingFullResync: this.settings.pendingFullResync,
        trigger,
        signal: this.#abort.signal,
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
      if (trigger === 'command' || trigger === 'settings') {
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
    } catch (error) {
      await this.#reportFailure(error, trigger);
      return null;
    } finally {
      this.#running = false;
      this.#abort = null;
    }
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
