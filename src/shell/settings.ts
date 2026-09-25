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

import { normalizeFolder, validateFolders } from '../core/folders';
import type { AuthStatus, LastUploadReport } from './contracts';
import { DEFAULT_BASE_URL, DEFAULT_SETTINGS } from './contracts';
import { isJavisError } from './errors';
import { FolderSuggest } from './folder-suggest';
import { describeHeld } from './review-modal';
import type JavisWikiSyncPlugin from '../main';

/** D-UI-2: each list in the Upload section shows at most this many entries. */
const LIST_LIMIT = 10;

/** Spec 2026-09-24 §D.4 / §F.4, plan D-UI-4. */
export const LIMITATION_SENTENCE =
  'When a note leaves the selected folders, Javis rebuilds the pages it fed from their other ' +
  "sources. Pages created before provenance tracking can't be rebuilt, so they are marked and " +
  'may still mention it.';

const SKIP_TEXT: Record<string, string> = {
  unreadable: 'could not be read (it may be stored only in the cloud); left alone',
  oversize: 'larger than 256 KB; not uploaded',
  unstampable: 'its properties block has no closing ---; not uploaded',
  'invalid-id': 'its javis_source_id is not a valid id; not uploaded',
  'invalid-chars': 'contains invalid characters; not uploaded',
  blank: 'empty; not uploaded',
};

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
    this.renderUpload(containerEl);
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
    // §C.3: a grant from before 0.2.0 names the old audience, which the server
    // accepts for one more release. Only a new sign-in moves it; the Upload
    // section has its own, stronger prompt when uploads are on.
    if (status === 'connected' && this.plugin.needsAudienceReconnect() && !this.plugin.needsUploadReconnect()) {
      containerEl.createEl('p', {
        text:
          'This device signed in with an older version of the plugin. Disconnect and connect ' +
          'again once, so syncing keeps working after the next Javis server update.',
        cls: 'setting-item-description',
      });
    }

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
              // The /wiki resource always (§C.3); with an upload folder
              // selected, the write scope up front too (§C.7).
              await this.plugin.auth.connect(this.plugin.uploadConnectOptions());
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

  // -- 2026-09-24 §F.4: the upload half ------------------------------------

  private renderUpload(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setName('Upload your notes').setHeading();

    // §F.5: the disclosure, short; the README has the full version.
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Optional, and off until you choose a folder. The full text of every note in the folders ' +
        'you choose is sent to your Javis server, stored there, and turned into wiki pages by an ' +
        'AI model on the server. The plugin adds one line, javis_source_id, to each uploaded ' +
        "note's properties so a rename is not mistaken for a new note. Removing a note from these " +
        'folders deletes its stored text from the server; nothing in this vault is ever deleted.',
    });

    // 1. The folder picker and the removable list.
    let pending = '';
    new Setting(containerEl)
      .setName('Add a folder')
      .setDesc('Every note inside it, including subfolders, is uploaded. The wiki folders cannot be chosen.')
      .addText((text) => {
        text.setPlaceholder('Journal').onChange((value) => {
          pending = value;
        });
        new FolderSuggest(this.app, text.inputEl, () => this.plugin.settings.uploadFolders);
      })
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          const folder = normalizeFolder(pending);
          const next = [...settings.uploadFolders, folder];
          const { errors } = validateFolders(next, this.app.vault.configDir);
          if (errors.length > 0) {
            new Notice(`Javis: ${errors.map((e) => e.reason).join(' ')}`, 8_000);
            return;
          }
          if (this.app.vault.getFolderByPath(folder) === null) {
            new Notice(`Javis: there is no folder named ${folder} in this vault.`);
            return;
          }
          const wasEmpty = settings.uploadFolders.length === 0;
          settings.uploadFolders = next;
          await this.plugin.saveSettings();
          if (wasEmpty && this.plugin.needsUploadReconnect()) {
            new Notice('Javis: reconnect once to allow uploads — see the button in the Upload section.', 10_000);
          }
          this.display();
        }),
      );

    for (const folder of settings.uploadFolders) {
      new Setting(containerEl)
        .setName(folder)
        .setDesc(
          // D-PLAN-13: deselecting is moving the notes out.
          'Removing this folder removes its notes from Javis after the usual safety checks.',
        )
        .addExtraButton((button) =>
          button
            .setIcon('x')
            .setTooltip('Stop uploading this folder')
            .onClick(async () => {
              settings.uploadFolders = settings.uploadFolders.filter((f) => f !== folder);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

    // 2. D-AUTH-3: a read-only connection prompts one reconnect.
    if (this.plugin.needsUploadReconnect()) {
      new Setting(containerEl)
        .setName('Allow uploads')
        .setDesc("This device's sign-in does not allow uploads. Reconnect once to let Javis store notes you upload.")
        .addButton((button) =>
          button
            .setButtonText('Reconnect to allow uploads')
            .setCta()
            .onClick(async () => {
              button.setDisabled(true).setButtonText('Waiting for your browser…');
              try {
                await this.plugin.auth.connect(this.plugin.uploadConnectOptions());
                await this.plugin.saveSettings();
                new Notice(
                  this.plugin.needsUploadReconnect()
                    ? 'Javis: connected, but uploads were not allowed.'
                    : 'Javis: uploads allowed.',
                );
              } catch (error) {
                new Notice(`Javis: ${describe(error)}`, 10_000);
              } finally {
                this.display();
              }
            }),
        );
    }

    // 3. Upload on edit.
    new Setting(containerEl)
      .setName('Upload when a note is edited')
      .setDesc('Off by default. Uploads 2 minutes after you stop typing; otherwise notes upload on each sync.')
      .addToggle((toggle) =>
        toggle.setValue(settings.uploadOnEdit).onChange(async (value) => {
          settings.uploadOnEdit = value;
          await this.plugin.saveSettings();
        }),
      );

    // 4. The last run: counts, failures, skipped notes.
    const last = settings.lastUpload;
    if (last !== null) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: `Last upload ${new Date(last.at).toLocaleString()} — ${last.summary}`,
      });
      const counts = Object.entries(last.counts);
      if (counts.length > 0) {
        containerEl.createEl('p', {
          cls: 'setting-item-description',
          text: `On the server: ${counts.map(([status, n]) => `${n} ${status}`).join(', ')}`,
        });
      }
      renderList(
        containerEl,
        'Folders that need attention',
        last.invalidFolders.map((e) => `${e.folder || '(vault root)'}: ${e.reason}`),
      );
      renderList(containerEl, 'Failed', last.failures.map((f) => `${f.path}: ${f.message}`));
      for (const reason of ['oversize', 'unreadable', 'unstampable', 'invalid-id', 'invalid-chars'] as const) {
        const title = {
          oversize: 'Too large',
          unreadable: 'Unreadable',
          unstampable: 'Unstampable',
          'invalid-id': 'Invalid id',
          'invalid-chars': 'Invalid characters',
        }[reason];
        renderList(
          containerEl,
          title,
          last.skipped.filter((n) => n.reason === reason).map((n) => `${n.path}: ${SKIP_TEXT[reason]}`),
        );
      }

      // 5. Held changes, waiting removals, undo reports.
      renderList(containerEl, 'Held changes', last.held.map(describeHeld));
      if (last.held.length > 0) {
        new Setting(containerEl)
          .setName('Review pending changes')
          .setDesc('Also available from the command palette.')
          .addButton((button) => button.setButtonText('Review').onClick(() => this.plugin.openReview()));
      }
      renderList(
        containerEl,
        'Will be removed from Javis if still missing',
        last.waiting.map((w) => `${w.path}: after ${new Date(w.eligibleAt).toLocaleTimeString()}`),
      );
      renderList(
        containerEl,
        'Recently removed',
        last.undoReports.map((u) => describeUndo(u.path, u.report)),
      );
    }

    // 6. Re-upload all.
    new Setting(containerEl)
      .setName('Re-upload all')
      .setDesc('Sends every note in the selected folders again, even unchanged ones. The safety checks still apply.')
      .addButton((button) =>
        button.setButtonText('Re-upload all').onClick(async () => {
          if (settings.uploadFolders.length === 0) {
            new Notice('Javis: choose a folder to upload first.');
            return;
          }
          button.setDisabled(true);
          settings.pendingReuploadAll = true;
          await this.plugin.saveSettings();
          try {
            await this.plugin.syncNow('settings', { uploadOnly: true, reuploadAll: true });
          } finally {
            this.display();
          }
        }),
      );

    // 7. The §D.4 limitation, stated where the choice is made.
    containerEl.createEl('p', { cls: 'setting-item-description', text: LIMITATION_SENTENCE });
  }
}

/** "a, b, c and N more" style list of at most `LIST_LIMIT` lines under a heading. */
function renderList(containerEl: HTMLElement, title: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  const wrap = containerEl.createDiv({ cls: 'setting-item-description' });
  wrap.createEl('strong', { text: `${title} (${lines.length})` });
  const list = wrap.createEl('ul');
  for (const line of lines.slice(0, LIST_LIMIT)) list.createEl('li', { text: line });
  if (lines.length > LIST_LIMIT) list.createEl('li', { text: `and ${lines.length - LIST_LIMIT} more` });
}

/** §D.4: "removed from 4 pages; 2 older pages may still mention it". */
export function describeUndo(path: string, report: LastUploadReport['undoReports'][number]['report']): string {
  const removed = report.pages_tombstoned + report.pages_rebuilt;
  let line = `${path}: removed from ${removed} page${removed === 1 ? '' : 's'}`;
  if (report.pages_marked_stale > 0) {
    line += `; ${report.pages_marked_stale} older page${report.pages_marked_stale === 1 ? '' : 's'} may still mention it`;
  }
  return line;
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
