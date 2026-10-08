import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { createApp } from "./server.mjs";

function listen(app) {
  return new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port));
  });
}

async function post(base, path, body, token) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(base, path, token) {
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
}

function ev(id, op, path, value) {
  return { id, op, payload: { path, value, anchor: "applicant" }, at: "2026-10-07T00:00:00.000Z", by: "@user:hs" };
}

test("append-only log: writes, dedups, folds and enforces access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({
    dbFile: join(dir, "test.sqlite"),
    verifyMatrix: false,
    adminUserId: "@office:hs",
    adminToken: "office-secret",
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  // Health
  assert.deepEqual(await get(base, "/health"), { status: 200, body: { ok: true, append_only: true } });

  // Missing token rejected
  assert.equal((await post(base, "/append", { submission_id: "s1", events: [] })).status, 401);

  // Submitter writes (write-only; token is hashed since verifyMatrix is off)
  const a = await post(base, "/append", {
    submission_id: "s1",
    room_id: "!room:hs",
    events: [ev("e1", "DEF", "complainant_name", "Jane"), ev("e2", "DEF", "complainant_phone", "6155550148")],
  }, "submitter-token");
  assert.equal(a.status, 200);
  assert.equal(a.body.appended, 2);

  // Re-sending the same events appends nothing (append-only, idempotent)
  const again = await post(base, "/append", {
    submission_id: "s1",
    room_id: "!room:hs",
    events: [ev("e1", "DEF", "complainant_name", "Jane")],
  }, "submitter-token");
  assert.equal(again.body.appended, 0);
  assert.equal(again.body.skipped, 1);

  // Submitter cannot read
  assert.equal((await get(base, "/submissions", "submitter-token")).status, 403);

  // Admin reads everything
  const list = await get(base, "/submissions", "office-secret");
  assert.equal(list.status, 200);
  assert.equal(list.body.submissions.length, 1);
  const sub = list.body.submissions[0];
  assert.equal(sub.submission_id, "s1");
  assert.equal(sub.room_id, "!room:hs");
  assert.equal(sub.events.length, 2);

  // A different admin token is not admin
  assert.equal((await get(base, "/submissions", "wrong-token")).status, 403);

  app.server.close();
  app.db.close();
});

test("write-only is scoped to the owner: another user cannot append into a submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({ dbFile: join(dir, "o.sqlite"), verifyMatrix: false, adminUserId: "@office:hs", adminToken: "office-secret" });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  // User A creates the submission.
  const a = await post(base, "/append", {
    submission_id: "s1", room_id: "!room:hs",
    events: [ev("e1", "DEF", "complainant_name", "Jane")],
  }, "token-A");
  assert.equal(a.status, 200);
  assert.equal(a.body.appended, 1);

  // User B cannot append to A's submission.
  const b = await post(base, "/append", {
    submission_id: "s1", room_id: "!room:hs",
    events: [ev("e2", "DEF", "complainant_phone", "555")],
  }, "token-B");
  assert.equal(b.status, 403);

  // The office (admin) can append to it.
  const admin = await post(base, "/append", {
    submission_id: "s1", room_id: "!room:hs",
    events: [ev("e2", "DEF", "complainant_phone", "6155550148")],
  }, "office-secret");
  assert.equal(admin.status, 200);
  assert.equal(admin.body.appended, 1);

  // And the office can read it back, both events present.
  const list = await get(base, "/submissions", "office-secret");
  assert.equal(list.status, 200);
  assert.equal(list.body.submissions[0].events.length, 2);

  app.server.close();
  app.db.close();
});

test("invalid events are skipped, never crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({ dbFile: join(dir, "t.sqlite"), verifyMatrix: false, adminUserId: "@office:hs" });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  const r = await post(base, "/append", {
    submission_id: "s2",
    events: [
      { id: "ok", op: "DEF", payload: { path: "a", value: 1 } },
      { id: "bad-op", op: "NOPE", payload: {} },
      { id: "", op: "DEF", payload: {} },
      "not-an-object",
    ],
  }, "t");
  assert.equal(r.status, 200);
  assert.equal(r.body.appended, 1);
  assert.equal(r.body.skipped, 3);

  app.server.close();
  app.db.close();
});
