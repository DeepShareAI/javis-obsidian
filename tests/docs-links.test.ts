import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The move goes through fileManager.renameFile, so Obsidian's "Automatically
// update internal links" setting may rewrite links to moved notes (spec,
// "Links elsewhere in the vault"). User-facing docs must not promise otherwise.
const DOCS = ['README.md', 'docs/pr-drafts/0.3.0-javis-wiki-root.md'];

describe('user-facing docs on link rewriting during the 0.3.0 move', () => {
  for (const doc of DOCS) {
    it(`${doc} does not claim no link is ever rewritten`, () => {
      const text = readFileSync(join(__dirname, '..', doc), 'utf8').replace(/\s+/g, ' ');
      expect(text).not.toMatch(/no link is rewritten|nothing is rewritten/i);
    });

    it(`${doc} mentions Obsidian's link-update setting`, () => {
      const text = readFileSync(join(__dirname, '..', doc), 'utf8').replace(/\s+/g, ' ');
      expect(text).toMatch(/Automatically update internal links/);
      expect(text).toMatch(/plugin never rewrites links/i);
    });
  }
});
