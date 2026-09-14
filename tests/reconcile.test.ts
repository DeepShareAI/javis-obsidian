import { describe, expect, it } from 'vitest';

import { reconcile } from '../src/core/reconcile';
import type { ServerPage } from '../src/core/types';

function page(overrides: Partial<ServerPage> = {}): ServerPage {
  return {
    page_type: 'concept',
    slug: 'Agent-Builder',
    title: 'Agent Builder',
    updated_at: '2026-09-13T04:12:00Z',
    frontmatter: {},
    body: 'generated body',
    deleted_at: null,
    ...overrides,
  };
}

/** The five branches of the §F.2 loop, as verdicts over plain data. */
describe('reconcile', () => {
  it('creates a note when no file exists at the page path', () => {
    const action = reconcile(page(), null);

    expect(action.kind).toBe('create');
    if (action.kind !== 'create') throw new Error('unreachable');
    expect(action.path).toBe('Concepts/Agent-Builder.md');
    expect(action.content).toContain('generated body');
    expect(action.content).toContain('javis_slug: Agent-Builder');
  });

  it('skips when javis_rev already matches updated_at', () => {
    expect(reconcile(page(), { javis_rev: '2026-09-13T04:12:00Z' })).toEqual({
      kind: 'skip',
      reason: 'unchanged',
    });
  });

  it('skips on a file-local javis_sync: false even when javis_rev differs', () => {
    // The release valve (§F.3). This branch reads the FILE's frontmatter, not
    // the server's, which is why adopting a page takes effect the moment the
    // user types the line and needs no write-back.
    expect(
      reconcile(page({ updated_at: '2026-09-14T09:00:00Z' }), {
        javis_sync: false,
        javis_rev: '2026-09-13T04:12:00Z',
      }),
    ).toEqual({ kind: 'skip', reason: 'adopted' });
  });

  it('honours javis_sync: false on a file that has never been synced', () => {
    expect(reconcile(page(), { javis_sync: false })).toEqual({ kind: 'skip', reason: 'adopted' });
  });

  it('does not treat a truthy non-false javis_sync as adoption', () => {
    const action = reconcile(page({ updated_at: '2026-09-14T09:00:00Z' }), {
      javis_sync: true,
      javis_rev: '2026-09-13T04:12:00Z',
    });
    expect(action.kind).toBe('replace');
  });

  it('replaces when the revisions differ', () => {
    const action = reconcile(page({ updated_at: '2026-09-14T09:00:00Z' }), {
      javis_rev: '2026-09-13T04:12:00Z',
      'my-rating': 5,
    });

    expect(action.kind).toBe('replace');
    if (action.kind !== 'replace') throw new Error('unreachable');
    expect(action.path).toBe('Concepts/Agent-Builder.md');
    expect(action.body).toBe('generated body');
    expect(action.frontmatter['javis_rev']).toBe('2026-09-14T09:00:00Z');
    expect(action.frontmatter['my-rating']).toBe(5);
  });

  it('replaces when the file carries no javis_rev at all', () => {
    // A file the user created by hand at a path we own, or one whose
    // frontmatter was mangled. Adoption is the explicit opt-out; a missing
    // revision is not one.
    expect(reconcile(page(), { title: 'Mine' }).kind).toBe('replace');
    expect(reconcile(page(), { javis_rev: 42 }).kind).toBe('replace');
  });

  it('tombstones a deleted row that has a file', () => {
    expect(reconcile(page({ deleted_at: '2026-09-14T00:00:00Z' }), { javis_rev: 'x' })).toEqual({
      kind: 'tombstone',
      path: 'Concepts/Agent-Builder.md',
    });
  });

  it('tombstones a deleted row even when javis_rev still matches', () => {
    expect(
      reconcile(page({ deleted_at: '2026-09-14T00:00:00Z' }), {
        javis_rev: '2026-09-13T04:12:00Z',
      }).kind,
    ).toBe('tombstone');
  });

  it('skips a deleted row whose file already records the tombstone', () => {
    // Deleted rows stay in every delta whose `since` predates the deletion, so
    // without this the banner would be re-prepended on every sync.
    expect(
      reconcile(page({ deleted_at: '2026-09-14T00:00:00Z' }), { javis_deleted: true }),
    ).toEqual({ kind: 'skip', reason: 'already-tombstoned' });
  });

  it('never creates a file for a row that was deleted before we first saw it', () => {
    expect(reconcile(page({ deleted_at: '2026-09-14T00:00:00Z' }), null)).toEqual({
      kind: 'skip',
      reason: 'deleted-absent',
    });
  });

  it('skips a page type it has no folder for rather than guessing one', () => {
    expect(reconcile(page({ page_type: 'transcript' }), null)).toEqual({
      kind: 'skip',
      reason: 'unknown-type',
    });
  });

  it('never returns a verdict that deletes anything', () => {
    const verdicts = [
      reconcile(page(), null),
      reconcile(page(), {}),
      reconcile(page({ deleted_at: '2026-09-14T00:00:00Z' }), {}),
      reconcile(page({ deleted_at: '2026-09-14T00:00:00Z' }), null),
    ].map((a) => a.kind);

    expect(verdicts).toEqual(['create', 'replace', 'tombstone', 'skip']);
    expect(verdicts).not.toContain('delete');
  });

  it('routes each page type to its own vault-root folder', () => {
    const cases: Array<[string, string]> = [
      ['source', 'Sources/Agent-Builder.md'],
      ['entity', 'Entities/Agent-Builder.md'],
      ['concept', 'Concepts/Agent-Builder.md'],
      ['topic', 'Topics/Agent-Builder.md'],
      ['comparison', 'Comparisons/Agent-Builder.md'],
      ['question', 'Questions/Agent-Builder.md'],
      ['synthesis', 'Syntheses/Agent-Builder.md'],
      ['decision', 'Decisions/Agent-Builder.md'],
      ['gap', 'Gaps/Agent-Builder.md'],
    ];
    for (const [type, path] of cases) {
      const action = reconcile(page({ page_type: type }), null);
      if (action.kind !== 'create') throw new Error(`expected create for ${type}`);
      expect(action.path).toBe(path);
    }
  });

  it('is stable: the note it creates is the note that then reports unchanged', () => {
    const p = page();
    const created = reconcile(p, null);
    if (created.kind !== 'create') throw new Error('unreachable');
    // The frontmatter the create wrote is what the next sync reads back.
    expect(created.content).toContain(`javis_rev: "${p.updated_at}"`);
    expect(reconcile(p, { javis_rev: p.updated_at })).toEqual({ kind: 'skip', reason: 'unchanged' });
  });
});
