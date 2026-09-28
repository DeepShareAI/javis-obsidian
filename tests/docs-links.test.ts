import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The move goes through `Vault.rename`, not `FileManager.renameFile`, so
// Obsidian never rewrites or prompts about links to moved notes: with
// "Automatically update internal links" off, renameFile would open a blocking
// "Update links?" modal per moved page (review). Links keep resolving by
// suffix (spec D4). User-facing docs must not tie the move to that setting.
const DOCS = ['README.md', 'docs/pr-drafts/0.3.0-javis-wiki-root.md'];

describe('user-facing docs on link rewriting during the 0.3.0 move', () => {
  for (const doc of DOCS) {
    const text = (): string => readFileSync(join(__dirname, '..', doc), 'utf8').replace(/\s+/g, ' ');

    it(`${doc} says links keep resolving by suffix`, () => {
      expect(text()).toMatch(/\[\[Concepts\/Foo\]\]/);
      expect(text()).toMatch(/plugin never rewrites links/i);
    });

    it(`${doc} does not say the move is subject to Obsidian's link-update setting`, () => {
      expect(text()).not.toMatch(/Automatically update internal links/);
    });
  }
});

// 0.3.0 moves 0.2.x root wiki notes into Javis-wiki/ with `Vault.rename`, so
// the README must not promise the plugin never renames a file (review).
describe('README "What it does not do" and the 0.3.0 move', () => {
  const readme = (): string =>
    readFileSync(join(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

  it('does not claim the plugin never renames a file', () => {
    expect(readme()).not.toMatch(/Delete, trash, or rename a file/);
  });

  it('names the one-time move as the only rename', () => {
    expect(readme()).toMatch(/rename one \(apart from the one-time move of 0\.2\.x wiki notes into `Javis-wiki\/`/);
  });
});
