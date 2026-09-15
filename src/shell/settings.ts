/**
 * The settings tab: connection, triggers, and the last run's outcome.
 *
 * Spec §D (auth), §F.4 (triggers). This is UI over state that lives elsewhere —
 * every value it edits is a field of `JavisSettings` (persisted through
 * `loadData`/`saveData`), and every action it offers is a method on
 * `JavisWikiSyncPlugin` or `JavisAuth`. It holds no state of its own beyond the
 * unsubscribe handle for the auth listener.
 *
 * **No token ever reaches this file.** `JavisSettings` has no field for one —
 * contracts.ts fails the build if anybody adds a token-shaped key — and both
 * tokens live in `SecretStore`, i.e. the OS keychain. `data.json` sits inside
 * the vault and replicates to every device the vault syncs to, which is exactly
 * why §D forbids putting a refresh token in it.
 *
 * This module imports `obsidian` because `PluginSettingTab` is an Obsidian
 * class; §G's purity rule governs `src/core`, which is where every decision in
 * the design actually lives. Nothing here decides anything.
 */

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

import type { AuthStatus } from './contracts';
import { DEFAULT_BASE_URL, DEFAULT_SETTINGS } from './contracts';
import { isJavisError } from './errors';
import type JavisWikiSyncPlugin from '../main';

/** Bounds on the interval field. Below a minute the plugin is a busy-loop. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;

/** What the three connection states say, and what the button does next. */
const STATUS_TEXT: Record<AuthStatus, string> = {
  disconnected: 'Not connected. Connect to sign in with your Javis account.',
  connected: 'Connected. Your wiki pages sync into this vault, one way.',
  'needs-reconnect':
    'The saved sign-in was rejected. Reconnect to sign in again — no notes have been changed.',
};

export class JavisSettingTab extends PluginSettingTab {
  private readonly plugin: JavisWikiSyncPlugin;
  private unsubscribe: (() => void) | null = null;

  constructor(app: App, plugin: JavisWikiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Redraw on every auth transition so a connect or a revocation discovered
    // mid-sync is reflected without the user reopening the tab.
    //
    // Subscribed at most once, and the redraw is deferred, for two separate
    // reasons that both end in a hang. `JavisOAuth.emit` iterates a `Set`, and
    // a `Set` visits entries added while it is being iterated: resubscribing
    // from inside `display()` would hand the same emit loop a fresh listener
    // forever. And redrawing synchronously inside `emit` would call
    // `containerEl.empty()` underneath the button handler that triggered it.
    if (this.unsubscribe === null) {
      this.unsubscribe = this.plugin.auth.onStatusChange(() => {
        window.setTimeout(() => {
          if (this.containerEl.isShown()) this.display();
        }, 0);
      });
    }

    this.renderConnection(containerEl);
    this.renderTriggers(containerEl);
    this.renderStatus(containerEl);
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.hide();
  }

  // -- connection -----------------------------------------------------------

  private renderConnection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Connection').setHeading();

    const status = this.plugin.auth.status();
    containerEl.createEl('p', {
      text: STATUS_TEXT[status],
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Javis server')
      .setDesc(
        'The Javis MCP origin. Change this only to point the plugin at a different ' +
          'deployment; doing so disconnects the current sign-in.',
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_BASE_URL)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            const next = value.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
            if (next === this.plugin.settings.baseUrl) return;
            // Disconnect BEFORE the field moves. The OAuth registration and both
            // tokens belong to the old origin — keeping them would send this
            // user's bearer to a different server — and `JavisOAuth` reads
            // `baseUrl` live, so revoking after the swap would post the old
            // origin's refresh token to the new one.
            if (this.plugin.auth.isConnected()) await this.plugin.auth.disconnect();
            this.plugin.settings.baseUrl = next;
            this.plugin.settings.cachedCursor = null;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(status === 'connected' ? 'Disconnect' : 'Connect')
      .setDesc(
        status === 'connected'
          ? 'Sign out and remove the saved tokens from the system keychain. Your notes stay.'
          : 'Opens your browser to sign in. Tokens are stored in the system keychain, ' +
            'never in the vault.',
      )
      .addButton((button) => {
        if (status === 'connected') {
          button
            .setButtonText('Disconnect')
            .setWarning()
            .onClick(async () => {
              button.setDisabled(true);
              await this.plugin.auth.disconnect();
              await this.plugin.saveSettings();
              new Notice('Javis: disconnected.');
              this.display();
            });
          return;
        }
        button
          .setButtonText(status === 'needs-reconnect' ? 'Reconnect' : 'Connect')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText('Waiting for your browser…');
            try {
              await this.plugin.auth.connect();
              await this.plugin.saveSettings();
              new Notice('Javis: connected.');
            } catch (error) {
              new Notice(`Javis: ${describe(error)}`, 10_000);
            } finally {
              this.display();
            }
          });
      });
  }

  // -- §F.4 triggers --------------------------------------------------------

  private renderTriggers(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Syncing').setHeading();

    new Setting(containerEl)
      .setName('Sync when the vault opens')
      .setDesc('Runs once, shortly after Obsidian finishes loading this vault.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnVaultOpen).onChange(async (value) => {
          this.plugin.settings.syncOnVaultOpen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync on a timer')
      .setDesc(
        'Off by default. The plugin only runs while Obsidian is open, so a timer is a ' +
          'convenience rather than a guarantee.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.intervalEnabled).onChange(async (value) => {
          this.plugin.settings.intervalEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.restartInterval();
          this.display();
        }),
      );

    if (this.plugin.settings.intervalEnabled) {
      new Setting(containerEl)
        .setName('Minutes between syncs')
        .setDesc(`Between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`)
        .addText((text) =>
          text
            .setPlaceholder(String(DEFAULT_SETTINGS.intervalMinutes))
            .setValue(String(this.plugin.settings.intervalMinutes))
            .onChange(async (value) => {
              const minutes = clampMinutes(value, this.plugin.settings.intervalMinutes);
              if (minutes === this.plugin.settings.intervalMinutes) return;
              this.plugin.settings.intervalMinutes = minutes;
              await this.plugin.saveSettings();
              this.plugin.restartInterval();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Also available from the command palette.')
      .addButton((button) =>
        button.setButtonText('Sync now').onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.syncNow('settings');
          } finally {
            this.display();
          }
        }),
      );
  }

  // -- last run -------------------------------------------------------------

  private renderStatus(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Last sync').setHeading();

    const { lastSyncAt, lastSyncSummary } = this.plugin.settings;
    containerEl.createEl('p', {
      text: lastSyncAt
        ? `${new Date(lastSyncAt).toLocaleString()} — ${lastSyncSummary ?? 'done'}`
        : 'This vault has not synced yet.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Resync everything')
      .setDesc(
        'Forgets the saved position and re-reads every page. Safe at any time: the ' +
          'plugin only ever replaces the text between its own markers, and never ' +
          'deletes a file.',
      )
      .addButton((button) =>
        button.setButtonText('Forget position').onClick(async () => {
          // Both, and never only the cursor. Clearing `cachedCursor` alone
          // hands the next run to the §F.1 rescan, which re-derives
          // `max(javis_rev)` from the vault and asks for rows newer than the
          // newest note already in it — the opposite of what this button's
          // description promises, and no help at all to the user whose vault is
          // missing a page a failed run skipped past.
          this.plugin.settings.cachedCursor = null;
          this.plugin.settings.pendingFullResync = true;
          await this.plugin.saveSettings();
          new Notice('Javis: the next sync will re-read every page.');
          this.display();
        }),
      );
  }
}

/** Keep a typo out of `setInterval`. A blank or absurd value keeps the old one. */
export function clampMinutes(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < MIN_INTERVAL_MINUTES) return MIN_INTERVAL_MINUTES;
  if (parsed > MAX_INTERVAL_MINUTES) return MAX_INTERVAL_MINUTES;
  return parsed;
}

/**
 * The sentence to show the user.
 *
 * A `JavisError` already carries one written for a human — `AuthRequiredError`
 * says "connect", `AuthRevokedError` says "reconnect", and keeping them
 * distinct is the whole point of §D step 6. Anything else is a bug and says so
 * rather than pretending to be a network problem.
 */
export function describe(error: unknown): string {
  if (isJavisError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
