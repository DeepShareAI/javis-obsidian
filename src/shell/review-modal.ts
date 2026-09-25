/**
 * "Review pending changes": the held uploads and removals, and one button that
 * sends them.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §F.3.6 ("Held actions surface as one Notice and a **Review pending
 *       changes** command, which lists them and sends them on confirmation").
 * Plan: D-PLAN-14 — confirming hands the hold KEYS to the next run, which
 * re-plans from scratch; only what is still held then is released. A file that
 * came back in the meantime is simply no longer a pending change.
 *
 * Obsidian UI; not unit-tested (vitest.config.ts).
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

import type { HeldAction } from '../core/upload';

const REASON_TEXT: Record<HeldAction['reason'], string> = {
  'mass-change': 'more changes at once than the safety limit allows',
  'vanished-folder': 'its folder currently lists no notes',
  'unreadable-ambiguous': 'a note in your folders could not be read, and might be this one',
};

/** One line per held change, for the modal and the settings tab. */
export function describeHeld(held: HeldAction): string {
  const verb = held.action.kind === 'delete' ? 'Remove from Javis' : 'Upload (it is now nearly empty)';
  return `${verb}: ${held.action.path} — held because ${REASON_TEXT[held.reason]}`;
}

export class ReviewPendingModal extends Modal {
  constructor(
    app: App,
    private readonly held: readonly HeldAction[],
    private readonly onConfirm: (keys: string[]) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('Javis: pending changes');
    contentEl.createEl('p', {
      text:
        'These changes were held back as a precaution. Sending them uploads the listed notes, ' +
        'and removes the listed notes from your Javis wiki (their text is deleted from the ' +
        'server). Nothing in this vault is deleted either way.',
    });
    const list = contentEl.createEl('ul');
    for (const held of this.held) list.createEl('li', { text: describeHeld(held) });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Send these changes')
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm(this.held.map((h) => h.key));
          }),
      )
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
