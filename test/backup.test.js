// test/backup.test.js — the history-backup status read, pulled straight out
// of index.html the same way the intake engine is (see _extract-engine.js),
// and driven against a scripted stand-in for matrix-js-sdk's crypto API.
//
// What this can and can't prove: that the panel's state is read back from
// the server rather than assumed, and fails with something a person can act
// on. Setting the backup up and unlocking it are in office-keys.test.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const START_MARKER = "async function keyBackupStatus(client) {";
const END_MARKER = "// ── Office history: every sign-in reads everything";

function loadBackup() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf-8");
  const start = html.indexOf(START_MARKER);
  if (start === -1) throw new Error("backup test: keyBackupStatus not found — index.html shape changed");
  const end = html.indexOf(END_MARKER, start);
  if (end === -1) throw new Error("backup test: office-history banner not found — index.html shape changed");
  const context = vm.createContext({ console: { warn() {}, error() {}, log() {} } });
  vm.runInContext(html.slice(start, end), context, { filename: "index.html#backup" });
  return context;
}

test("status is read back from the server, not inferred from a call not throwing", async () => {
  const { keyBackupStatus } = loadBackup();
  const client = { getCrypto: () => ({
    checkKeyBackupAndEnable: async () => ({ backupInfo: { version: "3", count: 41 }, trustInfo: { trusted: true } }),
    getActiveSessionBackupVersion: async () => "3",
    isSecretStorageReady: async () => true,
  }) };
  const s = await keyBackupStatus(client);
  assert.equal(s.serverVersion, "3");
  assert.equal(s.keyCount, 41);
  assert.equal(s.activeHere, "3");
  assert.equal(s.trusted, true);
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
