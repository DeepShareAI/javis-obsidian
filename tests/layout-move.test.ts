/**
 * Tests for src/core/layout-move.ts — moving 0.2.x's root-level wiki tree
 * under Javis-wiki/ (spec 2026-09-27).
 */

import { describe, expect, it } from 'vitest';

import { legacyDestination, planLayoutMove, type LayoutCandidate } from '../src/core/layout-move';
import { TYPE_TO_PLURAL, WIKI_ROOT } from '../src/core/slug';
import {
  JAVIS_DELETED,
  JAVIS_REV,
  JAVIS_SLUG,
  JAVIS_SYNC,
  JAVIS_TYPE,
  type Frontmatter,
} from '../src/core/types';

function javis(type = 'concept', slug: unknown = 'Foo', extra: Frontmatter = {}): Frontmatter {
  return { [JAVIS_TYPE]: type, [JAVIS_SLUG]: slug, [JAVIS_REV]: '2026-09-13T04:12:00Z', ...extra };
}

function note(path: string, frontmatter: Frontmatter | null): LayoutCandidate {
  return { path, frontmatter };
}

describe('WIKI_ROOT', () => {
  it('is the fixed Javis-wiki folder', () => {
    expect(WIKI_ROOT).toBe('Javis-wiki');
  });
});

describe('legacyDestination', () => {
  it('maps a direct child of each of the nine root folders under Javis-wiki', () => {
    for (const plural of Object.values(TYPE_TO_PLURAL)) {
      expect(legacyDestination(`${plural}/Foo.md`)).toBe(`Javis-wiki/${plural}/Foo.md`);
    }
  });

  it('matches the folder in any case and writes the canonical spelling', () => {
    expect(legacyDestination('concepts/Foo.md')).toBe('Javis-wiki/Concepts/Foo.md');
    expect(legacyDestination('SOURCES/x.md')).toBe('Javis-wiki/Sources/x.md');
  });

  it('ignores nested, root-level, non-markdown, already-moved and unrelated paths', () => {
    for (const path of [
      'Concepts/sub/x.md',
      'x.md',
      'Concepts.md',
      'Concepts/x.canvas',
      'Javis-wiki/Concepts/x.md',
      'Journal/x.md',
      'Conceptsfoo/x.md',
    ]) {
      expect(legacyDestination(path)).toBeNull();
    }
  });
});

describe('planLayoutMove', () => {
  it('moves every Javis note to its canonical destination, keeping the file name', () => {
    const plan = planLayoutMove(
      [note('Concepts/Foo.md', javis()), note('topics/Bar Baz.md', javis('topic', 'Bar Baz'))],
      new Set(['Concepts/Foo.md', 'topics/Bar Baz.md']),
    );
    expect(plan).toEqual({
      moves: [
        { from: 'Concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' },
        { from: 'topics/Bar Baz.md', to: 'Javis-wiki/Topics/Bar Baz.md' },
      ],
      conflicts: [],
    });
  });

  it('leaves notes without both javis_type and javis_slug where they are', () => {
    const plan = planLayoutMove(
      [
        note('Concepts/a.md', null),
        note('Concepts/b.md', {}),
        note('Concepts/c.md', { [JAVIS_TYPE]: 'concept' }),
        note('Concepts/d.md', { [JAVIS_SLUG]: 'd' }),
        note('Concepts/e.md', { [JAVIS_TYPE]: '', [JAVIS_SLUG]: 'e' }),
        note('Concepts/f.md', { [JAVIS_TYPE]: 'concept', [JAVIS_SLUG]: null }),
      ],
      new Set(),
    );
    expect(plan).toEqual({ moves: [], conflicts: [] });
  });

  it('leaves an upload-tracked note (javis_source_id) where it is, even with javis_type/javis_slug (review)', () => {
    // A user's tracked note in a selected root `Concepts/` folder that gained the
    // wiki keys (pasted properties, a template). Moving it out of the upload
    // selection would make its source go missing and get deleted on the server.
    const plan = planLayoutMove(
      [
        note('Concepts/Idea.md', javis('concept', 'Idea', { javis_source_id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b' })),
        note('Concepts/Odd.md', javis('concept', 'Odd', { javis_source_id: 'not-a-uuid' })),
      ],
      new Set(),
    );
    expect(plan).toEqual({ moves: [], conflicts: [] });
  });

  it('moves a note whose javis_slug YAML-parsed as a number (Review Focus 1)', () => {
    const plan = planLayoutMove([note('Topics/2024.md', javis('topic', 2024))], new Set());
    expect(plan.moves).toEqual([{ from: 'Topics/2024.md', to: 'Javis-wiki/Topics/2024.md' }]);
  });

  it('moves adopted and tombstoned notes like any other', () => {
    const plan = planLayoutMove(
      [
        note('Concepts/Adopted.md', javis('concept', 'Adopted', { [JAVIS_SYNC]: false })),
        note('Concepts/Gone.md', javis('concept', 'Gone', { [JAVIS_DELETED]: true })),
      ],
      new Set(),
    );
    expect(plan.moves.map((m) => m.to)).toEqual([
      'Javis-wiki/Concepts/Adopted.md',
      'Javis-wiki/Concepts/Gone.md',
    ]);
  });

  it('reports an existing destination, in any case, as a conflict and does not move it', () => {
    const plan = planLayoutMove(
      [note('Concepts/Foo.md', javis()), note('Gaps/G.md', javis('gap', 'G'))],
      new Set(['javis-wiki/concepts/foo.md']),
    );
    expect(plan.conflicts).toEqual([{ from: 'Concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' }]);
    expect(plan.moves).toEqual([{ from: 'Gaps/G.md', to: 'Javis-wiki/Gaps/G.md' }]);
  });

  it('turns the second of two case-variant sources into a conflict (Review Focus 2)', () => {
    const plan = planLayoutMove(
      [note('Concepts/Foo.md', javis()), note('concepts/Foo.md', javis())],
      new Set(),
    );
    expect(plan.moves).toEqual([{ from: 'Concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' }]);
    expect(plan.conflicts).toEqual([{ from: 'concepts/Foo.md', to: 'Javis-wiki/Concepts/Foo.md' }]);
  });

  it('plans nothing once its moves are applied', () => {
    const first = planLayoutMove([note('Concepts/Foo.md', javis())], new Set(['Concepts/Foo.md']));
    const after = first.moves.map((m) => note(m.to, javis()));
    expect(planLayoutMove(after, new Set(after.map((n) => n.path)))).toEqual({ moves: [], conflicts: [] });
  });
});
