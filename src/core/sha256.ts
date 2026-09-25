/**
 * SHA-256, pure and synchronous.
 *
 * Spec: javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md
 *       §E (the PUT is rejected when `sha256(text) != body_hash`), §F.1 (the
 *       hash is the change signal `planUpload` compares).
 * Plan: docs/plans/2026-09-24-upload-half.md, D-HASH-3.
 *
 * Why a hand-written implementation instead of a library or the platform:
 *
 * 1. **`src/core` is pure.** No Obsidian, no Node built-ins, no clock. `node:crypto`
 *    would tie the core to Node (Obsidian's renderer has it on desktop only, and
 *    the core is meant to be testable without either), and a bundled package
 *    would be the plugin's first runtime dependency for ~80 lines of FIPS 180-4.
 * 2. **`planUpload` is synchronous.** Web Crypto's `subtle.digest` is async;
 *    threading a Promise through the one function every guard lives in would
 *    turn a pure decision into a sequence of awaits for no gain.
 * 3. **The bytes are UTF-8 from `TextEncoder`,** which is also what `JSON.stringify`
 *    followed by an HTTP body produces on the wire, so the server's
 *    `hashlib.sha256(text.encode('utf-8'))` sees the same bytes we hashed. The
 *    one place the two disagree (a lone surrogate) is excluded upstream, see
 *    `hasLoneSurrogate` in note-text.ts and plan D-HASH-5.
 *
 * Cross-checked against `node:crypto` in tests/sha256.test.ts over NIST vectors,
 * every block boundary, and ~200 seeded mixed-script strings.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value: fractional parts of the square roots of the first 8 primes. */
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of raw bytes, as 64 lowercase hex characters. */
export function sha256HexBytes(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  // Message + 0x80 + zero padding + 8-byte big-endian length, to a multiple of 64.
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // A JS number holds lengths far past anything a note can be; split into two
  // 32-bit words because DataView has no setUint64 for plain numbers.
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = H0.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

/** SHA-256 of `text` encoded as UTF-8, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  return sha256HexBytes(new TextEncoder().encode(text));
}
