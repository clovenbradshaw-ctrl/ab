// test/recovery-key.test.js — the codec for the string an office writes down
// and types back in to recover encrypted history. Everything here is pure
// bytes-and-text, so it is testable exactly as it ships.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const RecoveryKey = require("../vendor/recovery-key.js");

function randomKey() {
  return new Uint8Array(crypto.randomBytes(32));
}

test("a key survives being written down and typed back", () => {
  for (let i = 0; i < 50; i++) {
    const key = randomKey();
    const text = RecoveryKey.encode(key);
    assert.deepEqual(RecoveryKey.decode(text), key);
  }
});

test("the written form is groups of four, in an alphabet that survives handwriting", () => {
  const text = RecoveryKey.encode(randomKey());
  const groups = text.split(" ");
  assert.ok(groups.length > 8, "a recovery key is not a short string");
  for (const g of groups.slice(0, -1)) assert.equal(g.length, 4, "every group but the last is four characters");
  // No 0/O or I/l: the characters people confuse when reading a key off paper.
  assert.ok(!/[0OIl]/.test(text), `ambiguous character in ${text}`);
});

test("however it was written down, it reads back the same", () => {
  const key = randomKey();
  const text = RecoveryKey.encode(key);
  const noSpaces = text.replace(/ /g, "");
  const newlines = text.replace(/ /g, "\n");
  const padded = `   ${text}  `;
  for (const variant of [noSpaces, newlines, padded]) {
    assert.deepEqual(RecoveryKey.decode(variant), key);
  }
});

test("a typo is caught by the check digit rather than silently decrypting nothing", () => {
  const text = RecoveryKey.encode(randomKey());
  const chars = text.replace(/ /g, "").split("");
  // Swap one character for a different valid one — the shape stays right and
  // only the parity byte can tell.
  const at = 10;
  const swap = RecoveryKey.ALPHABET[(RecoveryKey.ALPHABET.indexOf(chars[at]) + 1) % 58];
  chars[at] = swap;
  assert.throws(() => RecoveryKey.decode(chars.join("")), /typo|complete|recovery key/i);
});

test("a truncated or overlong key is refused, not padded into something plausible", () => {
  const text = RecoveryKey.encode(randomKey()).replace(/ /g, "");
  assert.throws(() => RecoveryKey.decode(text.slice(0, -2)), /complete recovery key/i);
  assert.throws(() => RecoveryKey.decode(text + "ab"), /complete recovery key/i);
});

test("something that isn't a recovery key at all says so", () => {
  assert.throws(() => RecoveryKey.decode(""), /Enter the recovery key/i);
  assert.throws(() => RecoveryKey.decode("   "), /Enter the recovery key/i);
  // A character outside the alphabet (0 and l are deliberately not in it).
  assert.throws(() => RecoveryKey.decode("EsTd Bxs0 llll"), /not part of a recovery key/i);
  // Right alphabet, right length, wrong prefix: a base58 string of the same
  // size that was never a recovery key.
  const notAKey = RecoveryKey.ALPHABET[5].repeat(48);
  assert.throws(() => RecoveryKey.decode(notAKey), /recovery key|complete/i);
});

test("looksValid answers the same question without throwing", () => {
  const text = RecoveryKey.encode(randomKey());
  assert.equal(RecoveryKey.looksValid(text), true);
  assert.equal(RecoveryKey.looksValid(text.replace(/ /g, "")), true);
  assert.equal(RecoveryKey.looksValid("not a key"), false);
  assert.equal(RecoveryKey.looksValid(""), false);
  assert.equal(RecoveryKey.looksValid(null), false);
});

test("encode refuses anything that isn't a 32-byte key, rather than making one up", () => {
  assert.throws(() => RecoveryKey.encode(new Uint8Array(16)), /32 bytes/);
  assert.throws(() => RecoveryKey.encode([]), /32 bytes/);
});

test("an all-zero key still round-trips (leading zero bytes are not dropped)", () => {
  const zeros = new Uint8Array(32);
  assert.deepEqual(RecoveryKey.decode(RecoveryKey.encode(zeros)), zeros);
});

test("the arithmetic agrees with an independent base58 implementation", () => {
  // Same spec, different algorithm: long division over bytes here versus one
  // BigInt there. They must agree on every input, including the leading-zero
  // cases that base58 handles specially.
  const ALPHABET = RecoveryKey.ALPHABET;
  const viaBigInt = (bytes) => {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) + BigInt(b);
    let out = "";
    while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    let lead = "";
    for (const b of bytes) { if (b !== 0) break; lead += ALPHABET[0]; }
    return lead + out;
  };
  const framed = (key) => {
    const g = new Uint8Array(35);
    g.set([0x8b, 0x01], 0);
    g.set(key, 2);
    let p = 0;
    for (let i = 0; i < 34; i++) p ^= g[i];
    g[34] = p;
    return g;
  };
  for (let i = 0; i < 200; i++) {
    const key = randomKey();
    if (i < 20) key.fill(0, 0, i % 5); // exercise leading zeros
    assert.equal(RecoveryKey.encode(key).replace(/ /g, ""), viaBigInt(framed(key)));
  }
});
