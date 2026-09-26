/**
 * The upload folder picker: type-ahead over the vault's folders.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §F.4 ("the folder picker, built on `AbstractInputSuggest` over
 *       `getAllFolders()` (there is no built-in multi-folder widget) plus a
 *       removable list"), §F.3.1 (what may be selected).
 *
 * Only folders that would pass `validateFolders` together with the current
 * selection are offered, so the picker cannot suggest the vault root, the
 * config folder, a wiki folder, a hidden folder, or a folder that nests with
 * one already chosen. The Add button validates again (the user can type a
 * path by hand), so this filter is a convenience, not the guard.
 *
 * Obsidian UI; not unit-tested, like settings.ts (vitest.config.ts).
 */

import { AbstractInputSuggest } from 'obsidian';
import type { App, TFolder } from 'obsidian';

import { validateFolders } from '../core/folders';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly selected: () => readonly string[],
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): TFolder[] {
    const q = query.trim().toLowerCase();
    const current = this.selected();
    const configDir = this.app.vault.configDir;
    return this.app.vault
      .getAllFolders(false)
      .filter((folder) => folder.path.toLowerCase().includes(q))
      .filter((folder) => validateFolders([...current, folder.path], configDir).errors.length === 0)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.inputEl.dispatchEvent(new Event('input'));
    this.close();
  }
}
