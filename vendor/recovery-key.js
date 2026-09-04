// recovery-key.js — the "recovery key" a Matrix account's encrypted history
// hangs on, encoded and decoded.
//
// Why this file exists at all: the app needs to hand someone a recovery key
// when key backup is set up, and to read one back when a new office device
// has to restore history. matrix-js-sdk's own encode/decode for this format
// is not exported by the bundle this app ships (vendor/matrix-sdk-bundle.js),
// so the codec lives here — a small, fully testable piece of string and byte
// work, rather than a guess made inside a UI handler.
//
// The format is the one every Matrix client displays (MSC1946 / the "Security
// Key" in Element), so a key produced here can be typed into another client
// and one produced elsewhere can be typed into this app:
//
//   bytes = [0x8B, 0x01] ++ key(32 bytes) ++ [parity]
//   parity = XOR of every preceding byte
//   text   = base58(bytes), in groups of four characters
//
// The parity byte is what makes a mistyped key fail loudly here instead of
// quietly decrypting nothing later — worth having when the alternative is an
// office concluding their history is gone.
//
// Loaded two ways from one file, same as vendor/steer.js: a <script src> in
// the browser (attaches window.RecoveryKey), require() in the Node tests.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RecoveryKey = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Bitcoin's base58 alphabet: the digits and letters that survive being read
  // aloud, written down, and typed back — no 0/O, no I/l.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const PREFIX = [0x8b, 0x01];
  const KEY_BYTES = 32;
  const TOTAL_BYTES = PREFIX.length + KEY_BYTES + 1; // + parity
  const GROUP = 4;

  function base58Encode(bytes) {
    // Straight long division by 58 over the byte array. Fine at this size —
    // 35 bytes, once, when a person clicks a button.
    const digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i] << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    // A leading zero byte carries no value through the division, so it has to
    // be re-added by hand — that is what the "1" prefix means in base58.
    let leading = "";
    for (const byte of bytes) {
      if (byte !== 0) break;
      leading += ALPHABET[0];
    }
    return leading + digits.reverse().map((d) => ALPHABET[d]).join("");
  }

  function base58Decode(text) {
    const bytes = [0];
    for (const ch of text) {
      const value = ALPHABET.indexOf(ch);
      if (value < 0) throw new Error(`"${ch}" is not part of a recovery key.`);
      let carry = value;
      for (let i = 0; i < bytes.length; i++) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    let leading = 0;
    for (const ch of text) {
      if (ch !== ALPHABET[0]) break;
      leading++;
    }
    const out = new Uint8Array(leading + bytes.length);
    out.set(bytes.reverse(), leading);
    return out;
  }

  function parityOf(bytes) {
    let parity = 0;
    for (const b of bytes) parity ^= b;
    return parity;
  }

  // encode(key) -> "EsTd Bxs3 …" — the string a person writes down.
  function encode(key) {
    const bytes = key instanceof Uint8Array ? key : Uint8Array.from(key || []);
    if (bytes.length !== KEY_BYTES) {
      throw new Error(`A recovery key is made from ${KEY_BYTES} bytes, not ${bytes.length}.`);
    }
    const framed = new Uint8Array(TOTAL_BYTES);
    framed.set(PREFIX, 0);
    framed.set(bytes, PREFIX.length);
    framed[TOTAL_BYTES - 1] = parityOf(framed.subarray(0, TOTAL_BYTES - 1));
    const text = base58Encode(framed);
    return (text.match(new RegExp(`.{1,${GROUP}}`, "g")) || []).join(" ");
  }

  // decode(text) -> Uint8Array(32). Throws with a sentence a person can act
  // on, because every failure here is someone typing a key off a piece of
  // paper and needing to know whether to look again or start over.
  function decode(text) {
    const stripped = (text ?? "").toString().replace(/\s+/g, "");
    if (!stripped) throw new Error("Enter the recovery key that was saved when backup was set up.");
    const bytes = base58Decode(stripped);
    if (bytes.length !== TOTAL_BYTES) {
      throw new Error("That doesn't look like a complete recovery key — check for a missing or extra character.");
    }
    if (bytes[0] !== PREFIX[0] || bytes[1] !== PREFIX[1]) {
      throw new Error("That isn't a recovery key. It should be around 48 characters in groups of four.");
    }
    if (parityOf(bytes) !== 0) {
      throw new Error("That recovery key has a typo in it — the check digit doesn't match.");
    }
    return bytes.slice(PREFIX.length, PREFIX.length + KEY_BYTES);
  }

  // True for anything decode() would accept — for enabling a button without
  // making the failure a thrown error.
  function looksValid(text) {
    try { decode(text); return true; } catch { return false; }
  }

  return { encode, decode, looksValid, ALPHABET, KEY_BYTES };
});
