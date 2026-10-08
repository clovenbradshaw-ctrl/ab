// resync-bot.mjs — server-side resync: log in as the office, restore the key
// backup, decrypt every room, and mirror the plaintext into the append-only
// database. Runs on the VM so the database fills without any browser or
// family device needing to be online, and without relying on cached pages.
//
// Reuses the same trust model as the office's own devices: the account
// password unlocks server-side secret storage, which holds the key-backup key,
// which holds every megolm room key the office has ever backed up. The bot is
// just another office device — read-only, it never sends into any room.
//
// Env:
//   AB_HOMESERVER            (default https://hyphae.social)
//   AB_OFFICE_USER           (default @planetary_nebula996083:hyphae.social)
//   AB_OFFICE_PASSWORD       the office's typed password (or AB_OFFICE_PASSWORD_FILE)
//   AB_OFFICE_PASSWORD_FILE  path to a 0600 file holding the password
//   AB_DB_URL                (default http://127.0.0.1:8788)
//   AB_INTERVAL_MS           mirror cadence (default 30000)
//   AB_NUDGE_MS              room-key re-request cadence, 0 = off (default 0)
//   AB_DEVICE_NAME           (default "AB Resync Bot")

import { readFileSync } from "node:fs";
import { createClient } from "matrix-js-sdk";
import {
  EVENT_TYPE, collectEvents, buildPayload, signature,
} from "./mirror.js";

const HS = (process.env.AB_HOMESERVER || "https://hyphae.social").replace(/\/+$/, "");
const OFFICE_USER = process.env.AB_OFFICE_USER || "@planetary_nebula996083:hyphae.social";
const DB_URL = (process.env.AB_DB_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const INTERVAL_MS = Number(process.env.AB_INTERVAL_MS || 30000);
const NUDGE_MS = Number(process.env.AB_NUDGE_MS || 0); // 0 = disabled
const DEVICE_NAME = process.env.AB_DEVICE_NAME || "AB Resync Bot";

const OFFICE_LOGIN_SALT = "ab/office-login/v1:";

function passwordFromEnv() {
  if (process.env.AB_OFFICE_PASSWORD) return process.env.AB_OFFICE_PASSWORD;
  if (process.env.AB_OFFICE_PASSWORD_FILE) {
    return readFileSync(process.env.AB_OFFICE_PASSWORD_FILE, "utf8").trim();
  }
  throw new Error("set AB_OFFICE_PASSWORD or AB_OFFICE_PASSWORD_FILE");
}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

function base64UrlOf(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesOfBase64(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64"));
}

async function pbkdf2Bytes(secret, salt, iterations, hash, bits) {
  const base = await subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash, salt: enc.encode(salt), iterations }, base, bits));
}

async function officeLoginSecret(password, userId) {
  return "ab1." + base64UrlOf(await pbkdf2Bytes(password, OFFICE_LOGIN_SALT + userId, 310000, "SHA-256", 256));
}

// The account password is the derived secret once the office signed in with
// this build; the typed password before that. Try derived, fall back to typed.
async function loginAsOffice(tmp, userId, password) {
  const attempt = (pw) => tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user: userId }, password: pw,
  });
  const secret = await officeLoginSecret(password, userId);
  try { return { res: await attempt(secret), viaSecret: true }; }
  catch (e) { if (e?.errcode !== "M_FORBIDDEN") throw e; }
  return { res: await attempt(password), viaSecret: false };
}

// Rebuild a passphrase-based secret-storage key exactly as the SDK/app does
// (m.pbkdf2: PBKDF2-SHA-512 over the passphrase and the stored salt).
async function passphraseStorageKey(passphrase, { salt, iterations, bits = 256 }) {
  return pbkdf2Bytes(passphrase, salt, iterations, "SHA-512", bits);
}
async function storageKeyFromPassword(client, password, keyId, info) {
  if (info?.passphrase?.algorithm !== "m.pbkdf2") return null;
  const key = await passphraseStorageKey(password, info.passphrase);
  return (await client.secretStorage.checkKey(key, info)) ? key : null;
}

async function unlockSecretStorage(client, password, cryptoCallbacks) {
  const opened = new Map();
  cryptoCallbacks.getSecretStorageKey = async ({ keys }) => {
    for (const [keyId, info] of Object.entries(keys || {})) {
      if (!opened.has(keyId)) opened.set(keyId, await storageKeyFromPassword(client, password, keyId, info));
      if (opened.get(keyId)) return [keyId, opened.get(keyId)];
    }
    return null;
  };
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("db append " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

const seen = new Map(); // roomId -> signature
async function mirrorRoom(dbUrl, token, room, me) {
  const roomId = room.roomId;
  const events = collectEvents(room.getLiveTimeline().getEvents());
  if (!events.length) return;
  const sig = signature(events);
  if (seen.get(roomId) === sig) return;
  seen.set(roomId, sig);
  const payload = buildPayload(roomId, events, me);
  try {
    await postJson(`${dbUrl}/append`, token, payload);
  } catch (e) {
    seen.delete(roomId); // retry next pass
    throw e;
  }
}

async function backfill(client, room, { maxPages = 50, limit = 200 } = {}) {
  let timeline = room.getLiveTimeline();
  for (let page = 0; page < maxPages && timeline.getPaginationToken?.("b"); page++) {
    let more = false;
    try { more = await client.paginateEventTimeline(timeline, { backwards: true, limit }); }
    catch (e) { console.warn("[bot] pagination stopped for", room.roomId, e?.message || e); break; }
    timeline = room.getLiveTimeline();
    if (!more) break;
  }
}

async function mirrorAll(client, token) {
  const me = client.getUserId();
  const rooms = client.getRooms();
  for (const room of rooms) {
    if (room.getMyMembership?.() === "invite") continue;
    // The shared question-set room is deliberately UNENCRYPTED (so any family
    // can read the questions); every answer room is encrypted. Skipping
    // unencrypted rooms is what keeps the question set out of the office's
    // submissions list — same rule the app applies via configStore.roomId.
    if (room.hasEncryptionStateEvent?.() === false) continue;
    try {
      await mirrorRoom(DB_URL, token, room, me);
    } catch (e) {
      console.warn("[bot] mirror failed for", room.roomId, e?.message || e);
    }
  }
}

// Re-issue room-key requests for anything still undecryptable, on a cadence.
// The SDK sends a request once, when an event *first* fails to decrypt; if the
// device holding that key was offline then, the request can go unanswered for
// good. Calling decryptEventIfNeeded again keeps a fresh request outstanding,
// so the key is pulled the moment the holder comes back online.
let _nudging = false;
async function nudgeMissingKeys(client) {
  if (_nudging) return;
  _nudging = true;
  let nudged = 0;
  try {
    for (const room of client.getRooms()) {
      if (room.hasEncryptionStateEvent?.() === false) continue;
      for (const e of room.getLiveTimeline().getEvents()) {
        if (!e.isEncrypted?.() || !e.isDecryptionFailure?.()) continue;
        try { await client.decryptEventIfNeeded?.(e); nudged++; } catch {}
      }
    }
  } finally {
    _nudging = false;
  }
  if (nudged) console.log(`[bot] nudged ${nudged} undecryptable event(s) for room keys`);
  return nudged;
}

async function main() {
  const password = passwordFromEnv();

  const tmp = createClient({ baseUrl: HS });
  const { res } = await loginAsOffice(tmp, OFFICE_USER, password);
  const { access_token: accessToken, user_id: userId, device_id: deviceId } = res;

  const cryptoCallbacks = {};
  const client = createClient({
    baseUrl: HS, accessToken, userId, deviceId, useAuthorizationHeader: true, cryptoCallbacks,
  });

  await client.initRustCrypto({ useIndexedDB: false });
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("no crypto backend after init");

  unlockSecretStorage(client, password, cryptoCallbacks);

  // Restore every room key the office has ever backed up, so this fresh
  // device can decrypt all history.
  await crypto.checkKeyBackupAndEnable().catch((e) => console.warn("[bot] checkKeyBackupAndEnable:", e?.message || e));
  await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  await crypto.restoreKeyBackup({ progressCallback: (p) => {
    if (p.total && p.imported % 1000 === 0) console.log(`[bot] key restore ${p.imported}/${p.total}`);
  } });

  try { await client.setDeviceDetails(deviceId, { display_name: DEVICE_NAME }); } catch {}

  client.on("Room.timeline", (_event, room) => {
    if (_event?.getType?.() !== EVENT_TYPE) return;
    mirrorRoom(DB_URL, accessToken, room, userId).catch(() => {});
  });

  await client.startClient({ initialSyncLimit: 100, lazyLoadMembers: true });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), 60000);
    client.once("sync", (state) => { if (state === "PREPARED" || state === "SYNCING") { clearTimeout(t); resolve(); } });
  });

  console.log("[bot] signed in as", userId, "device", deviceId, "— mirroring to", DB_URL);

  // Full history once, then keep up via the intervals + timeline listener.
  for (const room of client.getRooms()) await backfill(client, room).catch(() => {});
  await mirrorAll(client, accessToken);
  console.log("[bot] initial mirror complete");

  // Optional room-key nudging (off by default). The primary recovery is a
  // family's device flushing straight to the DB on its next visit; set
  // AB_NUDGE_MS to re-request keys for anything still undecryptable.
  if (NUDGE_MS > 0) {
    await nudgeMissingKeys(client);
    setInterval(() => {
      nudgeMissingKeys(client)
        .then((n) => { if (n) return mirrorAll(client, accessToken); })
        .catch((e) => console.warn("[bot] nudge tick:", e?.message || e));
    }, NUDGE_MS);
  }
  setInterval(() => { mirrorAll(client, accessToken).catch((e) => console.warn("[bot] mirror tick:", e?.message || e)); }, INTERVAL_MS);
}

main().catch((e) => {
  console.error("[bot] fatal:", e?.message || e);
  process.exit(1);
});
