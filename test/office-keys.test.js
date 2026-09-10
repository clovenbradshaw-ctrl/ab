"use strict";
// Pulls the office-password key helpers straight out of index.html and checks
// them against Node's own PBKDF2, so a change to either derivation fails here
// instead of silently locking the office out of its history.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

function loadOfficeKeys() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf-8");
  const start = html.indexOf("const CRYPTO_CALLBACKS = {};");
  const end = html.indexOf("function reportOfficeHistory(");
  if (start === -1 || end === -1) throw new Error("office key helpers not found — index.html shape changed");
  const sandbox = { crypto: globalThis.crypto, TextEncoder, btoa, atob, Uint8Array, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(`${html.slice(start, end)}
    exports.officeLoginSecret = officeLoginSecret;
    exports.passphraseStorageKey = passphraseStorageKey;
    exports.bytesOfBase64 = bytesOfBase64;
    exports.setUpOfficeHistory = setUpOfficeHistory;
    exports.CRYPTO_CALLBACKS = CRYPTO_CALLBACKS;
    exports.OFFICE_LOGIN_SALT = OFFICE_LOGIN_SALT;`, sandbox);
  return sandbox.exports;
}

// A scripted stand-in for the client: records every SDK call, and treats a
// secret-storage key as correct when it equals `storedKey`.
function fakeOffice({ storage = null, storedKey = null, backupVersion = "4", backupSecret = "AQIDBA", identityReady = true, backupMatches = true, masterSigned = false } = {}) {
  const calls = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  let ready = identityReady;
  const backupInfo = backupVersion && {
    version: backupVersion, algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    auth_data: { public_key: "PK", signatures: { [USER]: masterSigned ? { "ed25519:MASTER": "old" } : { "ed25519:OTHERDEVICE": "d" } } },
  };
  const crypto = {
    bootstrapCrossSigning: async () => { calls.push("bootstrapCrossSigning"); },
    bootstrapSecretStorage: async (opts) => { calls.push({ bootstrapSecretStorage: opts, generated: await opts.createSecretStorageKey() }); },
    checkKeyBackupAndEnable: async () => { calls.push("checkKeyBackupAndEnable"); return backupInfo ? { backupInfo } : null; },
    resetKeyBackup: async () => { calls.push("resetKeyBackup"); },
    storeSessionBackupPrivateKey: async (key, version) => { calls.push({ storeSessionBackupPrivateKey: [...key], version }); },
    isCrossSigningReady: async () => ready,
    userHasCrossSigningKeys: async () => true,
    crossSignDevice: async (id) => { calls.push("crossSignDevice:" + id); },
    getCrossSigningKeyId: async () => "MASTER",
    isKeyBackupTrusted: async () => ({ matchesDecryptionKey: backupMatches, trusted: false }),
    signObject: async (obj) => { obj.signatures = { [USER]: { "ed25519:MASTER": "new", "ed25519:THISDEVICE": "d2" } }; },
    olmMachine: { importCrossSigningKeys: async (...keys) => { calls.push({ importCrossSigningKeys: keys }); ready = true; } },
  };
  const client = {
    getUserId: () => USER,
    getDeviceId: () => "THISDEVICE",
    getCrypto: () => crypto,
    secretStorage: {
      getKey: async () => storage,
      checkKey: async (key) => same([...key], storedKey && [...storedKey]),
      get: async (name) => { calls.push("get:" + name); return name === "m.megolm_backup.v1" ? backupSecret : "secret:" + name; },
    },
    http: { authedRequest: async (method, path, query, body) => { calls.push({ [method]: path, body }); return {}; } },
    restoreKeyBackupWithCache: async () => { calls.push("restore"); return { imported: 5, total: 6 }; },
  };
  return { calls, client };
}

const keys = loadOfficeKeys();
const USER = "@office:example.org";

test("the login secret is stable, per-account, and never the password itself", async () => {
  const a = await keys.officeLoginSecret("correct horse", USER);
  assert.equal(a, await keys.officeLoginSecret("correct horse", USER));
  assert.notEqual(a, await keys.officeLoginSecret("correct horse", "@other:example.org"));
  assert.notEqual(a, await keys.officeLoginSecret("correct horsf", USER));
  assert.ok(a.startsWith("ab1."));
  assert.ok(!a.includes("correct horse"));
});

test("the login secret is PBKDF2-SHA-256 over the password with the account-bound salt", async () => {
  const expected = nodeCrypto.pbkdf2Sync("pw", keys.OFFICE_LOGIN_SALT + USER, 310000, 32, "sha256").toString("base64url");
  assert.equal(await keys.officeLoginSecret("pw", USER), "ab1." + expected);
});

test("the secret-storage key is rebuilt exactly as the SDK's m.pbkdf2 made it", async () => {
  const info = { salt: "0123456789abcdefghijklmnopqrstuv", iterations: 1000 };
  const got = await keys.passphraseStorageKey("the office password", info);
  const expected = nodeCrypto.pbkdf2Sync("the office password", info.salt, 1000, 32, "sha512");
  assert.deepEqual(Buffer.from(got), expected);
});

test("a first sign-in creates cross-signing, then password-locked secret storage with a new backup", async () => {
  const { calls, client } = fakeOffice({ storage: null });
  const r = await keys.setUpOfficeHistory(client, "office pw");
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(calls[0], "bootstrapCrossSigning");
  const boot = calls.find((c) => c.bootstrapSecretStorage);
  assert.equal(boot.bootstrapSecretStorage.setupNewSecretStorage, true);
  assert.equal(boot.bootstrapSecretStorage.setupNewKeyBackup, true);
  const { passphrase } = boot.generated.keyInfo;
  assert.equal(passphrase.algorithm, "m.pbkdf2");
  assert.equal(passphrase.salt.length, 32);
  const expected = nodeCrypto.pbkdf2Sync("office pw", passphrase.salt, passphrase.iterations, 32, "sha512");
  assert.deepEqual(Buffer.from(boot.generated.privateKey), expected, "the stored key is the one the password rebuilds");
});

test("a password that can't open existing secret storage never replaces it", async () => {
  const info = { passphrase: { algorithm: "m.pbkdf2", salt: "S".repeat(32), iterations: 1000 } };
  const storedKey = nodeCrypto.pbkdf2Sync("the real one", info.passphrase.salt, 1000, 32, "sha512");
  const { calls, client } = fakeOffice({ storage: ["KEY", info], storedKey });
  const r = await keys.setUpOfficeHistory(client, "a different one");
  assert.equal(r.ok, false);
  assert.match(r.reason, /locked with something other than this password/);
  assert.deepEqual(calls, [], "nothing was bootstrapped, reset, or written");
});

test("the right password opens storage, caches the backup key, and restores", async () => {
  const info = { passphrase: { algorithm: "m.pbkdf2", salt: "S".repeat(32), iterations: 1000 } };
  const storedKey = nodeCrypto.pbkdf2Sync("the real one", info.passphrase.salt, 1000, 32, "sha512");
  const { calls, client } = fakeOffice({ storage: ["KEY", info], storedKey });
  const r = await keys.setUpOfficeHistory(client, "the real one");
  assert.equal(r.ok, true);
  assert.equal(r.restored, 5);
  assert.ok(calls.includes("bootstrapCrossSigning"), "cross-signing keys come out of storage");
  assert.ok(!calls.some((c) => c.bootstrapSecretStorage), "existing storage is never recreated");
  assert.ok(!calls.includes("resetKeyBackup"), "an existing backup is kept");
  const stored = calls.find((c) => c.storeSessionBackupPrivateKey);
  assert.deepEqual(stored.storeSessionBackupPrivateKey, [1, 2, 3, 4]);
  assert.equal(stored.version, "4");
  assert.ok(calls.includes("restore"));
  const handed = await keys.CRYPTO_CALLBACKS.getSecretStorageKey({ keys: { KEY: info } });
  assert.equal(handed[0], "KEY", "the SDK gets the key when it asks for it");
});

test("unlocking puts the office identity's signature on a backup whose key matches storage", async () => {
  const info = { passphrase: { algorithm: "m.pbkdf2", salt: "S".repeat(32), iterations: 1000 } };
  const storedKey = nodeCrypto.pbkdf2Sync("pw", info.passphrase.salt, 1000, 32, "sha512");
  const { calls, client } = fakeOffice({ storage: ["KEY", info], storedKey });
  await keys.setUpOfficeHistory(client, "pw");
  const put = calls.find((c) => c.PUT);
  assert.equal(put.PUT, "/room_keys/version/4");
  const sigs = put.body.auth_data.signatures[USER];
  assert.equal(sigs["ed25519:MASTER"], "new", "signed by the office identity");
  assert.equal(sigs["ed25519:OTHERDEVICE"], "d", "the creating device's signature is kept");
  assert.equal(put.body.auth_data.public_key, "PK");
});

test("a backup whose key doesn't match storage is never signed", async () => {
  const info = { passphrase: { algorithm: "m.pbkdf2", salt: "S".repeat(32), iterations: 1000 } };
  const storedKey = nodeCrypto.pbkdf2Sync("pw", info.passphrase.salt, 1000, 32, "sha512");
  const { calls, client } = fakeOffice({ storage: ["KEY", info], storedKey, backupMatches: false });
  await keys.setUpOfficeHistory(client, "pw");
  assert.ok(!calls.some((c) => c.PUT), "nothing was uploaded");
});

test("a device holding an older identity takes the office's current one from storage", async () => {
  const info = { passphrase: { algorithm: "m.pbkdf2", salt: "S".repeat(32), iterations: 1000 } };
  const storedKey = nodeCrypto.pbkdf2Sync("pw", info.passphrase.salt, 1000, 32, "sha512");
  const { calls, client } = fakeOffice({ storage: ["KEY", info], storedKey, identityReady: false });
  await keys.setUpOfficeHistory(client, "pw");
  const imported = calls.find((c) => c.importCrossSigningKeys);
  assert.deepEqual(imported.importCrossSigningKeys, ["secret:m.cross_signing.master", "secret:m.cross_signing.self_signing", "secret:m.cross_signing.user_signing"]);
  assert.ok(calls.includes("crossSignDevice:THISDEVICE"));
});

test("a device that already has the current identity doesn't re-import it", async () => {
  const info = { passphrase: { algorithm: "m.pbkdf2", salt: "S".repeat(32), iterations: 1000 } };
  const storedKey = nodeCrypto.pbkdf2Sync("pw", info.passphrase.salt, 1000, 32, "sha512");
  const { calls, client } = fakeOffice({ storage: ["KEY", info], storedKey, masterSigned: true });
  await keys.setUpOfficeHistory(client, "pw");
  assert.ok(!calls.some((c) => c.importCrossSigningKeys));
  assert.ok(!calls.some((c) => c.PUT), "already signed by the office — left as is");
});

test("unpadded and URL-safe base64 both decode", () => {
  assert.deepEqual([...keys.bytesOfBase64("AQID")], [1, 2, 3]);
  assert.deepEqual([...keys.bytesOfBase64("AQ")], [1]);
  assert.deepEqual([...keys.bytesOfBase64("-_8")], [251, 255]);
});
