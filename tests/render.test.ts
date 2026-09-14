import { describe, expect, it } from 'vitest';

import { mergeAliases, mergeServerKeys, serializeFrontmatter, toList } from '../src/core/frontmatter';
import { MARKER_END, MARKER_START } from '../src/core/markers';
import { TOMBSTONE_BANNER, applyTombstone, render } from '../src/core/render';
import type { ServerPage } from '../src/core/types';

function page(overrides: Partial<ServerPage> = {}): ServerPage {
  return {
    page_type: 'concept',
    slug: 'Agent-Builder',
    title: 'Agent Builder',
    updated_at: '2026-09-13T04:12:00Z',
    frontmatter: {},
    body: 'Body markdown, with [[Concepts/Foo]] passed through verbatim.',
    deleted_at: null,
    ...overrides,
  };
}

describe('render', () => {
  it('produces the note the spec shows in §E', () => {
    expect(render(page())).toBe(
      [
        '---',
        'title: Agent Builder',
        'aliases:',
        '  - Agent-Builder',
        'javis_type: concept',
        'javis_slug: Agent-Builder',
        'javis_rev: "2026-09-13T04:12:00Z"',
        'javis_sync: true',
        '---',
        '',
        MARKER_START,
        'Body markdown, with [[Concepts/Foo]] passed through verbatim.',
        MARKER_END,
        '',
      ].join('\n'),
    );
  });

  it('quotes javis_rev so it stays a string', () => {
    // Unquoted, js-yaml's default schema resolves an ISO8601 scalar to a Date,
    // and a Date never compares equal to the string the server sent — every
    // sync would then rewrite every note forever.
    expect(render(page())).toContain('javis_rev: "2026-09-13T04:12:00Z"');
  });

  it('coerces scalar tags, aliases and cssclasses to lists (§E rule 2)', () => {
    const out = render(
      page({ frontmatter: { tags: 'wiki', cssclasses: 'narrow', aliases: 'Other Name' } }),
    );

    expect(out).toContain('tags:\n  - wiki');
    expect(out).toContain('cssclasses:\n  - narrow');
    expect(out).toContain('aliases:\n  - Other Name\n  - Agent-Builder');
    expect(out).not.toContain('tags: wiki');
  });

  it('quotes a wikilink written into frontmatter (§E rule 3)', () => {
    const out = render(page({ frontmatter: { source: '[[Sources/Gmail-2026-09-01]]' } }));

    expect(out).toContain('source: "[[Sources/Gmail-2026-09-01]]"');
    expect(out).not.toContain('source: [[');
  });

  it('quotes a wikilink inside a list value too', () => {
    const out = render(page({ frontmatter: { related: ['[[Concepts/Foo]]', '[[Concepts/Bar]]'] } }));
    expect(out).toContain('related:\n  - "[[Concepts/Foo]]"\n  - "[[Concepts/Bar]]"');
  });

  it('passes the body through verbatim, wikilinks and all', () => {
    const body = 'See [[Concepts/Foo]] and [[Topics/Bar|Bar]].\n\n- a list\n- of items';
    const out = render(page({ body }));
    expect(out).toContain(`${MARKER_START}\n${body}\n${MARKER_END}`);
  });

  it('is idempotent: re-rendering an unchanged page is byte-identical', () => {
    expect(render(page())).toBe(render(page()));
  });
});

/** Spec §H: "`render` unions aliases." */
describe('alias union', () => {
  it('keeps a file-only alias, adds a server-only alias, and duplicates neither', () => {
    const existing = { aliases: ['File Only', 'Shared'] };
    const p = page({ frontmatter: { aliases: ['Shared', 'Server Only'] } });

    expect(mergeAliases(existing, p)).toEqual([
      'File Only',
      'Shared',
      'Server Only',
      'Agent-Builder',
    ]);
  });

  it('never drops an alias the plugin finds in the file, even when the server sends none', () => {
    expect(mergeAliases({ aliases: ['Hand Written'] }, page())).toEqual([
      'Hand Written',
      'Agent-Builder',
    ]);
  });

  it('adds the original slug when sanitization changed it (§E rule 4)', () => {
    // `Is RAG dead?` becomes `Is RAG dead` on disk, so links written against
    // the raw slug only keep resolving because of this alias.
    const p = page({ page_type: 'question', slug: 'Is RAG dead?' });
    expect(mergeAliases({}, p)).toContain('Is RAG dead?');
  });

  it('coerces a scalar alias on either side', () => {
    expect(mergeAliases({ aliases: 'From File' }, page({ frontmatter: { aliases: 'From Server' } }))).toEqual([
      'From File',
      'From Server',
      'Agent-Builder',
    ]);
  });
});

describe('mergeServerKeys', () => {
  it('leaves keys only the user has alone', () => {
    const merged = mergeServerKeys(page(), { 'my-rating': 5, status: 'reading' });
    expect(merged['my-rating']).toBe(5);
    expect(merged['status']).toBe('reading');
  });

  it('preserves a file-local javis_sync: false and never clears it', () => {
    expect(mergeServerKeys(page(), { javis_sync: false })['javis_sync']).toBe(false);
    expect(mergeServerKeys(page(), {})['javis_sync']).toBe(true);
    expect(mergeServerKeys(page(), { javis_sync: true })['javis_sync']).toBe(true);
  });

  it('refuses to let the server frontmatter forge a javis_ key', () => {
    const merged = mergeServerKeys(
      page({ frontmatter: { javis_rev: 'forged', javis_sync: true, javis_deleted: true } }),
      { javis_sync: false },
    );
    expect(merged['javis_rev']).toBe('2026-09-13T04:12:00Z');
    expect(merged['javis_sync']).toBe(false);
    expect(merged['javis_deleted']).toBeUndefined();
  });

  it('carries identity in the frontmatter, not the path (§E rule 1)', () => {
    const merged = mergeServerKeys(page({ page_type: 'question', slug: 'Is RAG dead?' }), {});
    expect(merged['javis_type']).toBe('question');
    expect(merged['javis_slug']).toBe('Is RAG dead?');
  });

  it('flags a deleted row and un-flags one that came back', () => {
    expect(mergeServerKeys(page({ deleted_at: '2026-09-14T00:00:00Z' }), {})['javis_deleted']).toBe(true);
    expect(mergeServerKeys(page(), { javis_deleted: true })['javis_deleted']).toBeUndefined();
  });
});

describe('toList', () => {
  it('coerces scalars, drops empties, and passes lists through', () => {
    expect(toList('one')).toEqual(['one']);
    expect(toList(['one', 'two'])).toEqual(['one', 'two']);
    expect(toList(null)).toEqual([]);
    expect(toList(undefined)).toEqual([]);
    expect(toList('')).toEqual([]);
    expect(toList([null, 'one', ''])).toEqual(['one']);
    expect(toList(42)).toEqual(['42']);
  });
});

describe('serializeFrontmatter', () => {
  it('emits an empty list and an empty map without breaking YAML', () => {
    expect(serializeFrontmatter({ aliases: [], meta: {} })).toBe('aliases: []\nmeta: {}\n');
  });

  it('emits a null value as a bare key', () => {
    expect(serializeFrontmatter({ note: null })).toBe('note:\n');
  });

  it('quotes values that would otherwise change type', () => {
    expect(serializeFrontmatter({ a: 'true', b: '42', c: 'no', d: 'a: b', e: '#tag' })).toBe(
      ['a: "true"', 'b: "42"', 'c: "no"', 'd: "a: b"', 'e: "#tag"', ''].join('\n'),
    );
  });

  it('escapes quotes and backslashes', () => {
    expect(serializeFrontmatter({ t: 'say "hi"\\' })).toBe('t: "say \\"hi\\"\\\\"\n');
  });

  it('nests a plain object', () => {
    expect(serializeFrontmatter({ meta: { kind: 'thread', count: 3 } })).toBe(
      'meta:\n  kind: thread\n  count: 3\n',
    );
  });
});

describe('applyTombstone', () => {
  const live = `---\ntitle: Agent Builder\n---\n\nMy own notes.\n\n${MARKER_START}\ngenerated body\n${MARKER_END}\n`;

  it('blanks the generated block and keeps everything the user wrote', () => {
    const out = applyTombstone(live);

    expect(out).not.toContain('generated body');
    expect(out).toContain('My own notes.');
    expect(out).toContain('title: Agent Builder');
    expect(out).toContain(TOMBSTONE_BANNER);
    expect(out).toContain(`${MARKER_START}\n${MARKER_END}`);
  });

  it('puts the banner above the generated block', () => {
    const out = applyTombstone(live);
    expect(out.indexOf(TOMBSTONE_BANNER)).toBeLessThan(out.indexOf(MARKER_START));
  });

  it('is idempotent — a tombstoned row reappears in every later delta', () => {
    const once = applyTombstone(live);
    expect(applyTombstone(once)).toBe(once);
    expect(applyTombstone(applyTombstone(once))).toBe(once);
  });

  it('never truncates a file that has no marker block', () => {
    const out = applyTombstone('Entirely hand-written.\n');
    expect(out).toContain('Entirely hand-written.');
    expect(out).toContain(TOMBSTONE_BANNER);
  });
});
