// test/backup.test.js — the history-backup helpers, pulled straight out of
// index.html the same way the intake engine is (see _extract-engine.js), and
// driven against a scripted stand-in for matrix-js-sdk's crypto API.
//
// What this can and can't prove: it proves this app asks the SDK for the
// right things in the right order, hands back what the SDK asks for, reads
// its state back from the server rather than assuming success, and fails
// with something a person can act on. It does NOT prove the homeserver
// accepts any of it — that needs one live run, on a real account.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const RecoveryKey = require("../vendor/recovery-key.js");

// The three helpers live in one contiguous block in index.html, between the
// banner comment that introduces them and the entry-point comment that
// follows. Text-anchored so a shape change fails loudly here rather than
// leaving this testing a stale copy.
const START_MARKER = "async function keyBackupStatus(client) {";
const END_MARKER = "function downloadRecoveryKey(recoveryKey, userId) {";

function loadBackup() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf-8");
  const start = html.indexOf(START_MARKER);
  if (start === -1) throw new Error("backup test: keyBackupStatus not found — index.html shape changed");
  const end = html.indexOf(END_MARKER, start);
  if (end === -1) throw new Error("backup test: downloadRecoveryKey not found — index.html shape changed");

  const context = vm.createContext({
    RecoveryKey,
    console: { warn() {}, error() {}, log() {} },
  });
  vm.runInContext(html.slice(start, end), context, { filename: "index.html#backup" });
  return context;
}

// A scripted stand-in for the SDK's CryptoApi that records what it was asked.
function fakeClient({ backupVersion = "3", count = 41, active = "3", encoded = true, restoreResult = { imported: 7, total: 9 } } = {}) {
  const calls = [];
  const crypto = {
    checkKeyBackupAndEnable: async () => {
      calls.push("check");
      return backupVersion ? { backupInfo: { version: backupVersion, count }, trustInfo: { trusted: true } } : null;
    },
    getActiveSessionBackupVersion: async () => { calls.push("active"); return active; },
    isSecretStorageReady: async () => { calls.push("secretStorage"); return true; },
    createRecoveryKeyFromPassphrase: async () => {
      calls.push("createKey");
      const privateKey = new Uint8Array(32).fill(7);
      return encoded ? { privateKey, encodedPrivateKey: "ENCODED-BY-SDK" } : { privateKey };
    },
    bootstrapSecretStorage: async (opts) => {
      calls.push("bootstrap");
      calls.push("setupNewKeyBackup=" + opts.setupNewKeyBackup);
      const generated = await opts.createSecretStorageKey();
      calls.push("keyHandedBack=" + (generated.privateKey.length === 32));
    },
    restoreKeyBackup: async () => { calls.push("restore"); return restoreResult; },
  };
  return { calls, client: { getCrypto: () => crypto, cryptoCallbacks: {} } };
}

test("status is read back from the server, not inferred from a call not throwing", async () => {
  const { keyBackupStatus } = loadBackup();
  const { client } = fakeClient();
  const s = await keyBackupStatus(client);
  assert.equal(s.serverVersion, "3");
  assert.equal(s.keyCount, 41);
  assert.equal(s.activeHere, "3");
  assert.equal(s.secretStorage, true);
});

test("a server that refuses the read surfaces the error instead of reading as 'no backup, all fine'", async () => {
  const { keyBackupStatus } = loadBackup();
  const client = { getCrypto: () => ({
    checkKeyBackupAndEnable: async () => { throw new Error("server said no"); },
    getActiveSessionBackupVersion: async () => null,
    isSecretStorageReady: async () => false,
  }) };
  const s = await keyBackupStatus(client);
  assert.equal(s.error, "server said no");
  assert.equal(s.serverVersion, null);
});

test("a browser with no encryption at all says so rather than crashing", async () => {
  const { keyBackupStatus } = loadBackup();
  const s = await keyBackupStatus({ getCrypto: () => null });
  assert.equal(s.available, false);
  assert.match(s.reason, /Encryption isn't set up/);
});

test("setup creates a key, bootstraps a new backup with it, and reads the result back", async () => {
  const { setUpKeyBackup } = loadBackup();
  const { calls, client } = fakeClient();
  const r = await setUpKeyBackup(client);
  assert.ok(calls.includes("createKey"));
  assert.ok(calls.includes("bootstrap"));
  assert.ok(calls.includes("setupNewKeyBackup=true"), "a backup version has to actually be created");
  assert.ok(calls.includes("keyHandedBack=true"), "the SDK must receive the generated key");
  assert.equal(r.recoveryKey, "ENCODED-BY-SDK");
  assert.equal(r.status.serverVersion, "3", "the reported state comes from a fresh read");
});

test("where the SDK hands back no printable key, our own codec produces the real one", async () => {
  const { setUpKeyBackup } = loadBackup();
  const { client } = fakeClient({ encoded: false });
  const r = await setUpKeyBackup(client);
  assert.ok(RecoveryKey.looksValid(r.recoveryKey), r.recoveryKey);
  assert.ok(RecoveryKey.decode(r.recoveryKey).every((b) => b === 7), "it encodes the key the SDK generated");
});

test("restore checks the server, restores, and reports how much actually came back", async () => {
  const { restoreFromRecoveryKey } = loadBackup();
  const { calls, client } = fakeClient();
  const r = await restoreFromRecoveryKey(client, RecoveryKey.encode(new Uint8Array(32).fill(3)));
  assert.ok(calls.includes("check"));
  assert.ok(calls.includes("restore"));
  assert.equal(r.imported, 7);
  assert.equal(r.total, 9);
});

test("the SDK is handed [keyId, key bytes] when it asks, and the key doesn't outlive the restore", async () => {
  const { restoreFromRecoveryKey } = loadBackup();
  let handed = null;
  const crypto = {
    checkKeyBackupAndEnable: async () => ({ backupInfo: { version: "9", count: 1 }, trustInfo: {} }),
    getActiveSessionBackupVersion: async () => "9",
    isSecretStorageReady: async () => true,
    restoreKeyBackup: async () => {
      handed = await client.cryptoCallbacks.getSecretStorageKey({ keys: { KEYID: {} } });
      return { imported: 1, total: 1 };
    },
  };
  const client = { getCrypto: () => crypto, cryptoCallbacks: {} };
  await restoreFromRecoveryKey(client, RecoveryKey.encode(new Uint8Array(32).fill(9)));
  assert.ok(Array.isArray(handed));
  assert.equal(handed[0], "KEYID");
  assert.ok(handed[1].every((b) => b === 9), "the decoded recovery key itself");
  assert.equal(client.cryptoCallbacks.getSecretStorageKey, undefined, "no key callback left installed afterwards");
});

test("a mistyped key and a missing backup each fail with a sentence someone can act on", async () => {
  const { restoreFromRecoveryKey } = loadBackup();
  const { client } = fakeClient();
  await assert.rejects(() => restoreFromRecoveryKey(client, "obviously not a key"), /recovery key/i);

  const none = fakeClient({ backupVersion: null });
  await assert.rejects(() => restoreFromRecoveryKey(none.client, RecoveryKey.encode(new Uint8Array(32).fill(1))), /no history backup/i);
  assert.equal(none.client.cryptoCallbacks.getSecretStorageKey, undefined, "a failure cleans up after itself too");
});
