/**
 * Tests for src/core/sha256.ts.
 *
 * The core hash must agree with the server's `hashlib.sha256` byte for byte,
 * because §E rejects a PUT whose `sha256(text) != body_hash` with a 400. The
 * NIST vectors pin the algorithm; the `node:crypto` cross-check (test-only
 * import, never in src/) pins the UTF-8 encoding across every shape of string
 * a vault can hold.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex, sha256HexBytes } from '../src/core/sha256';

function nodeSha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A tiny deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'Z', '0', ' ', '\n', '\r\n', '---', 'é', '中', '文', '😀', '𝄞', '\t', ':', '"'];

function randomString(rand: () => number, length: number): string {
  let out = '';
  while (out.length < length) {
    out += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
  }
  return out;
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 / NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with node:crypto at every block boundary', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const s = 'x'.repeat(n);
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
  });

  it('agrees with node:crypto on ~200 seeded strings of mixed scripts and line endings', () => {
    const rand = mulberry32(20260924);
    for (let i = 0; i < 200; i += 1) {
      const s = randomString(rand, Math.floor(rand() * 5000));
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
  });

  it('is 64 lowercase hex', () => {
    expect(sha256Hex('whatever')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes raw bytes identically to the string path', () => {
    const bytes = new TextEncoder().encode('中文 😀');
    expect(sha256HexBytes(bytes)).toBe(nodeSha('中文 😀'));
  });
});
