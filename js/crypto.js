// crypto.js — client-side encryption for content uploaded to the media store.
//
// Every file is encrypted with its own random AES-256-GCM key *before* it
// leaves the browser. The ciphertext is what gets uploaded to the media
// store (js/media.js) — the store itself never sees plaintext. The key, IV,
// and a SHA-256 of the ciphertext travel alongside the upload as metadata on
// the document's INS record in the room event log, never inside the upload
// itself. Anyone who can read that event (the uploader, and whoever else is
// in the room — e.g. the admin, see config.js) can decrypt; the storage
// layer only ever holds ciphertext. This mirrors Matrix's own encrypted
// attachment scheme (m.file / EncryptedFile), simplified to AES-GCM so one
// SubtleCrypto call gives both confidentiality and integrity.

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

export async function sha256B64(buf) {
  return toB64(await crypto.subtle.digest("SHA-256", buf));
}

// plaintext ArrayBuffer -> { ciphertext: ArrayBuffer, key: JsonWebKey, iv: base64, hash: base64 }
export async function encryptBytes(plainBuf) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuf);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { ciphertext, key: jwk, iv: toB64(iv), hash: await sha256B64(ciphertext) };
}

// The inverse: ciphertext + the key/iv/hash recorded on the document event -> plaintext ArrayBuffer.
export async function decryptBytes(ciphertext, jwk, ivB64, expectHashB64) {
  if (expectHashB64) {
    const actual = await sha256B64(ciphertext);
    if (actual !== expectHashB64) throw new Error("integrity check failed — ciphertext doesn't match the recorded hash");
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, ciphertext);
}
