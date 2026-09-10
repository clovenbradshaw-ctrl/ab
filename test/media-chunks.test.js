"use strict";
// The chunked encrypted-media path, pulled straight out of index.html and
// run against an in-memory media store: large files round-trip, small ones
// keep the single-piece format older records use, and pieces can't be
// reordered or dropped without failing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMedia() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf-8");
  const slice = (from, to) => {
    const a = html.indexOf(from), b = html.indexOf(to, a);
    if (a === -1 || b === -1) throw new Error(`media test: "${from}" block not found — index.html shape changed`);
    return html.slice(a, b);
  };
  const code = slice("const toB64 = ", "// Removed: ensureRoomKey")
    + slice("const MEDIA_CHUNK_BYTES", "// docview.js");
  const sandbox = { crypto: globalThis.crypto, Blob, TextEncoder, btoa, atob, setTimeout, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(`${code}
    exports.putEncryptedMedia = putEncryptedMedia;
    exports.getDecryptedMedia = getDecryptedMedia;
    exports.decryptBytes = decryptBytes;`, sandbox);
  return sandbox.exports;
}

const m = loadMedia();

function memoryMedia({ failFirst = 0 } = {}) {
  const blobs = new Map();
  let failures = failFirst;
  return {
    blobs,
    async put(id, ciphertext) {
      if (failures-- > 0) { const e = new Error("slow down"); e.httpStatus = 429; e.data = { retry_after_ms: 1 }; throw e; }
      blobs.set("mxc://t/" + id, ciphertext);
      return "mxc://t/" + id;
    },
    async get(url) { if (!blobs.has(url)) throw new Error("missing " + url); return blobs.get(url); },
  };
}

const bytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) % 251; return b; };
const joined = async (pieces) => new Uint8Array(await new Blob(pieces).arrayBuffer());

test("a file bigger than one piece goes up in pieces and comes back byte for byte", async () => {
  const media = memoryMedia();
  const original = bytes(3500);
  const progress = [];
  const rec = await m.putEncryptedMedia(new Blob([original]), media, "doc1", { chunkBytes: 1000, onProgress: (n, t) => progress.push(`${n}/${t}`) });
  assert.equal(rec.parts.length, 4);
  assert.deepEqual(progress, ["1/4", "2/4", "3/4", "4/4"]);
  assert.equal(media.blobs.size, 4);
  assert.deepEqual(await joined(await m.getDecryptedMedia(rec, media)), original);
});

test("a file that fits in one piece keeps the single-upload format older readers expect", async () => {
  const media = memoryMedia();
  const original = bytes(500);
  const rec = await m.putEncryptedMedia(new Blob([original]), media, "doc2", { chunkBytes: 1000 });
  assert.equal(rec.parts, undefined);
  assert.ok(rec.url && rec.iv && rec.hash && rec.key);
  const plain = await m.decryptBytes(await media.get(rec.url), rec.key, rec.iv, rec.hash);
  assert.deepEqual(new Uint8Array(plain), original);
});

test("pieces put back in the wrong order don't decrypt", async () => {
  const media = memoryMedia();
  const rec = await m.putEncryptedMedia(new Blob([bytes(2500)]), media, "doc3", { chunkBytes: 1000 });
  const swapped = { ...rec, parts: [rec.parts[1], rec.parts[0], rec.parts[2]] };
  await assert.rejects(() => m.getDecryptedMedia(swapped, media));
});

test("a dropped piece is caught, not silently truncated", async () => {
  const media = memoryMedia();
  const rec = await m.putEncryptedMedia(new Blob([bytes(2500)]), media, "doc4", { chunkBytes: 1000 });
  await assert.rejects(() => m.getDecryptedMedia({ ...rec, parts: rec.parts.slice(0, 2) }, media));
});

test("a piece the server alters fails its integrity check", async () => {
  const media = memoryMedia();
  const rec = await m.putEncryptedMedia(new Blob([bytes(2500)]), media, "doc5", { chunkBytes: 1000 });
  const url = rec.parts[1].url;
  const tampered = new Uint8Array(media.blobs.get(url)); tampered[0] ^= 1;
  media.blobs.set(url, tampered.buffer);
  await assert.rejects(() => m.getDecryptedMedia(rec, media), /integrity/);
});

test("a rate-limited piece is retried rather than failing the whole file", async () => {
  const media = memoryMedia({ failFirst: 2 });
  const original = bytes(1500);
  const rec = await m.putEncryptedMedia(new Blob([original]), media, "doc6", { chunkBytes: 1000 });
  assert.deepEqual(await joined(await m.getDecryptedMedia(rec, media)), original);
});
