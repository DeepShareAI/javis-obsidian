/**
 * Tests for src/core/note-text.ts: the frontmatter scanner, the normalization
 * that produces the PUT's `text`, the hash, and the id/title readers.
 *
 * The property the upload half rests on (§F.1: "Stamping never looks like an
 * edit") is asserted at the bottom over a fixture set, once the stamp exists.
 */

import { describe, expect, it } from 'vitest';

import {
  frontmatterRange,
  hasLoneSurrogate,
  isUuid,
  MAX_TITLE_CHARS,
  noteHash,
  noteTitle,
  readSourceId,
  uploadText,
  utf8Bytes,
} from '../src/core/note-text';
import { sha256Hex } from '../src/core/sha256';
import { restampText, stampText } from '../src/core/stamp';
import { extractFrontmatterBlock } from '../src/shell/vault';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BOM = '﻿';

// ---------------------------------------------------------------------------
// frontmatterRange
// ---------------------------------------------------------------------------

describe('frontmatterRange', () => {
  /** The block text the core scanner finds, normalized the way the shell's is. */
  function coreBlock(text: string): string | null {
    const r = frontmatterRange(text);
    if (r.kind !== 'block') return null;
    const inner = text.slice(r.openEnd, r.closeStart).replace(/\r\n/g, '\n');
    // extractFrontmatterBlock returns the lines between fences joined by \n,
    // i.e. without the final line break.
    return inner.endsWith('\n') ? inner.slice(0, -1) : inner;
  }

  const cases: [string, string][] = [
    ['no fence', 'hello\nworld\n'],
    ['closed fence', '---\ntitle: x\n---\nbody\n'],
    ['unclosed fence', '---\ntitle: x\nbody\n'],
    ['rule later in the note', 'intro\n---\nnot: fm\n---\n'],
    ['BOM', `${BOM}---\na: 1\n---\nb\n`],
    ['CRLF', '---\r\na: 1\r\n---\r\nbody\r\n'],
    ['exactly ---', '---'],
    ['empty block', '---\n---\nbody'],
    ['close without trailing EOL', '---\na: 1\n---'],
    ['indented close is not a close', '---\na: 1\n ---\nb\n'],
    ['close with trailing space is not a close', '---\na: 1\n--- \nb\n'],
  ];

  for (const [name, text] of cases) {
    it(`agrees with extractFrontmatterBlock: ${name}`, () => {
      expect(coreBlock(text)).toBe(extractFrontmatterBlock(text));
    });
  }

  it('reports an opening fence with no close as malformed, not as none', () => {
    expect(frontmatterRange('---\ntitle: x\n').kind).toBe('malformed');
    expect(frontmatterRange('---').kind).toBe('malformed');
    expect(frontmatterRange('title: x\n').kind).toBe('none');
  });

  it('returns offsets into the ORIGINAL string (CRLF and BOM kept)', () => {
    const text = `${BOM}---\r\na: 1\r\n---\r\nbody`;
    const r = frontmatterRange(text);
    if (r.kind !== 'block') throw new Error('expected a block');
    expect(r.start).toBe(1);
    expect(text.slice(r.start, r.openEnd)).toBe('---\r\n');
    expect(text.slice(r.openEnd, r.closeStart)).toBe('a: 1\r\n');
    expect(text.slice(r.closeStart, r.closeEnd)).toBe('---\r\n');
    expect(r.eol).toBe('\r\n');
  });
});

// ---------------------------------------------------------------------------
// uploadText and noteHash
// ---------------------------------------------------------------------------

describe('uploadText', () => {
  it('strips the BOM and normalizes CRLF and lone CR', () => {
    expect(uploadText(`${BOM}a\r\nb\rc\n`)).toBe('a\nb\nc\n');
  });

  it('removes top-level javis_* lines and keeps everything else byte for byte', () => {
    const text = [
      '---',
      'title: "Foo: bar"   # a comment',
      `javis_source_id: ${ID}`,
      "tags: [a, b]",
      'javis_type: x',
      '---',
      'body mentions javis_source_id: keep',
      '',
    ].join('\n');
    expect(uploadText(text)).toBe(
      ['---', 'title: "Foo: bar"   # a comment', 'tags: [a, b]', '---', 'body mentions javis_source_id: keep', ''].join(
        '\n',
      ),
    );
  });

  it('removes a javis_* key together with its continuation lines', () => {
    const text = '---\na: 1\njavis_foo:\n  - x\n  - y\n- z\nb: 2\n---\nbody\n';
    expect(uploadText(text)).toBe('---\na: 1\nb: 2\n---\nbody\n');
  });

  it('keeps an indented javis_ key that belongs to another key', () => {
    const text = '---\nouter:\n  javis_x: 1\n---\nbody\n';
    expect(uploadText(text)).toBe(text);
  });

  it('keeps a blank line that follows a removed key when real content follows it', () => {
    const text = '---\njavis_x: 1\n\na: 1\n---\n';
    expect(uploadText(text)).toBe('---\n\na: 1\n---\n');
  });

  it('drops a block that is empty after removal, fences included (D-HASH-2)', () => {
    expect(uploadText(`---\njavis_source_id: ${ID}\n---\nbody\n`)).toBe('body\n');
  });

  it('drops a block that was empty to begin with (D-HASH-2)', () => {
    expect(uploadText('---\n---\nbody\n')).toBe('body\n');
    expect(uploadText('---\n\n---\nbody\n')).toBe('body\n');
    expect(uploadText('---\n---')).toBe('');
  });

  it('only EOL-normalizes a malformed note, because it has no block to edit', () => {
    expect(uploadText('---\r\njavis_source_id: x\r\nbody\r\n')).toBe('---\njavis_source_id: x\nbody\n');
  });

  it('leaves a note with no frontmatter alone', () => {
    expect(uploadText('# Title\n\nbody\n')).toBe('# Title\n\nbody\n');
  });
});

describe('noteHash', () => {
  it('is sha256 of the normalized text', () => {
    const text = `---\r\njavis_source_id: ${ID}\r\ntitle: x\r\n---\r\nbody`;
    expect(noteHash(text)).toBe(sha256Hex(uploadText(text)));
  });

  it('ignores line-ending style', () => {
    expect(noteHash('a\r\nb\r\n')).toBe(noteHash('a\nb\n'));
  });
});

// ---------------------------------------------------------------------------
// readSourceId
// ---------------------------------------------------------------------------

describe('readSourceId', () => {
  it('reads a plain id', () => {
    expect(readSourceId(`---\njavis_source_id: ${ID}\n---\n`)).toEqual({ id: ID, valid: true });
  });

  it('strips one layer of quotes, trailing space and a comment; lowercases', () => {
    expect(readSourceId(`---\njavis_source_id: '${ID}'\n---\n`)).toEqual({ id: ID, valid: true });
    expect(readSourceId(`---\njavis_source_id: "${ID.toUpperCase()}"   \n---\n`)).toEqual({
      id: ID,
      valid: true,
    });
    expect(readSourceId(`---\njavis_source_id: ${ID} # mine\n---\n`)).toEqual({ id: ID, valid: true });
  });

  it('reads CRLF files', () => {
    expect(readSourceId(`---\r\njavis_source_id: ${ID}\r\n---\r\n`)).toEqual({ id: ID, valid: true });
  });

  it('ignores the body, indented keys and malformed notes', () => {
    expect(readSourceId(`---\na: 1\n---\njavis_source_id: ${ID}\n`)).toBeNull();
    expect(readSourceId(`---\nx:\n  javis_source_id: ${ID}\n---\n`)).toBeNull();
    expect(readSourceId(`---\njavis_source_id: ${ID}\n`)).toBeNull();
    expect(readSourceId('no frontmatter')).toBeNull();
  });

  it('takes the first of two lines', () => {
    expect(readSourceId(`---\njavis_source_id: ${ID}\njavis_source_id: ${ID2}\n---\n`)?.id).toBe(ID);
  });

  it('reports a non-uuid value as invalid rather than absent', () => {
    expect(readSourceId('---\njavis_source_id: hello\n---\n')).toEqual({ id: 'hello', valid: false });
    expect(readSourceId('---\njavis_source_id:\n---\n')).toEqual({ id: '', valid: false });
  });
});

describe('isUuid', () => {
  it('accepts canonical 8-4-4-4-12 hex in either case', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid(ID.toUpperCase())).toBe(true);
    expect(isUuid(`{${ID}}`)).toBe(false);
    expect(isUuid(ID.replace(/-/g, ''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// noteTitle
// ---------------------------------------------------------------------------

describe('noteTitle', () => {
  it('reads the title property, quotes stripped', () => {
    expect(noteTitle('---\ntitle: Foo\n---\n', 'J/a.md')).toBe('Foo');
    expect(noteTitle('---\ntitle: "Foo: bar"\n---\n', 'J/a.md')).toBe('Foo: bar');
    expect(noteTitle("---\ntitle: 'It''s'\n---\n", 'J/a.md')).toBe("It''s");
  });

  it('falls back to the filename without .md', () => {
    expect(noteTitle('body', 'Journal/2026/My note.md')).toBe('My note');
    expect(noteTitle('---\ntitle:\n---\n', 'J/a.md')).toBe('a');
    expect(noteTitle('---\ntitle: |\n  multi\n---\n', 'J/a.md')).toBe('a');
    // Only a lowercase `.md` is stripped, matching the server's _clean_title.
    expect(noteTitle('body', 'J/Readme.MD')).toBe('Readme.MD');
  });

  it(`truncates to ${MAX_TITLE_CHARS} characters without splitting a surrogate pair`, () => {
    const long = '😀'.repeat(600);
    const title = noteTitle(`---\ntitle: ${long}\n---\n`, 'J/a.md');
    expect([...title].length).toBe(MAX_TITLE_CHARS);
    expect(hasLoneSurrogate(title)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bytes and surrogates
// ---------------------------------------------------------------------------

describe('utf8Bytes and hasLoneSurrogate', () => {
  it('counts UTF-8 bytes', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
    expect(utf8Bytes('')).toBe(0);
  });

  it('finds lone surrogates only', () => {
    expect(hasLoneSurrogate('\ud800')).toBe(true);
    expect(hasLoneSurrogate('a\udc00b')).toBe(true);
    expect(hasLoneSurrogate('😀')).toBe(false);
    expect(hasLoneSurrogate('plain')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The invariant: stamping never looks like an edit (§F.1, D-HASH-2)
// ---------------------------------------------------------------------------

const HASH_FIXTURES: string[] = [
  '',
  'plain body\n',
  'no trailing newline',
  '# Heading\n\n- list\n',
  '---\n---\n',
  '---\n---',
  '---\n\n---\nbody\n',
  '---\ntitle: x\n---\nbody\n',
  '---\ntitle: x\n---',
  [
    '---',
    '# a comment',
    "single: 'quoted'",
    'double: "quoted: yes"',
    'tags: [a, b]',
    'date: 2026-09-24',
    'odd: !!str 123',
    '',
    'aliases:',
    '  - one',
    '  - two',
    '---',
    'Body with --- inside',
    '---',
    'and a rule',
    '',
  ].join('\n'),
  '---\r\ntitle: crlf\r\n---\r\nbody\r\n',
  '﻿---\ntitle: bom\n---\nbody\n',
  '﻿bom no fm\n',
  'crlf no fm\r\nline 2\r\n',
  '---\njavis_type: concept\njavis_foo:\n  - a\n---\nbody\n',
  '---\ndesc: |\n  multi\n  line\n---\n',
  '---\ntags:\n- a\n- b\n---\n',
  '中文笔记\n😀\n',
  '---\n\n\n---\n',
  'intro\n---\nnot fm\n---\n',
  '---\ntitle: x\n---\n\n\n',
  '   \n',
  '---\nkey: value\n# trailing comment\n---\nbody',
  '---\r\n---\r\nbody',
  '\n---\nnot: fm\n---\n',
  '---\nnested:\n  deep:\n    javis_x: 1\n---\nb\n',
];

describe('stamping never looks like an edit', () => {
  for (const [i, text] of HASH_FIXTURES.entries()) {
    it(`fixture ${i}: noteHash(stamp(t)) === noteHash(t), and restamp keeps it`, () => {
      const stamped = stampText(text, ID);
      expect(stamped.kind).toBe('ok');
      if (stamped.kind !== 'ok') return;
      expect(noteHash(stamped.text)).toBe(noteHash(text));
      const restamped = restampText(stamped.text, ID2);
      expect(restamped.kind).toBe('ok');
      if (restamped.kind !== 'ok') return;
      expect(noteHash(restamped.text)).toBe(noteHash(text));
      expect(readSourceId(restamped.text)).toEqual({ id: ID2, valid: true });
    });
  }
});
