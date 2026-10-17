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

test("submitters read only their own; blobs; magic links act as the user, scoped and appended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({
    dbFile: join(dir, "t2.sqlite"),
    verifyMatrix: false,
    adminUserId: "@office:hs",
    adminToken: "office-secret",
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  const send = async (method, path, token, body, raw) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { "content-type": "application/json" }) },
      body: raw ? raw : (body === undefined ? undefined : JSON.stringify(body)),
    });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  await send("POST", "/append", "alice-token", { submission_id: "sa", events: [ev("a1", "DEF", "name", "Alice")] });
  await send("POST", "/append", "bob-token", { submission_id: "sb", events: [ev("b1", "DEF", "name", "Bob")] });

  // /mine: each sees only their own
  const mineA = await send("GET", "/mine", "alice-token");
  assert.equal(mineA.status, 200);
  assert.deepEqual(mineA.body.submissions.map((s) => s.submission_id), ["sa"]);
  assert.equal((await send("GET", "/mine")).status, 401);

  // /submissions stays admin only
  assert.equal((await send("GET", "/submissions", "alice-token")).status, 403);
  assert.equal((await send("GET", "/submissions", "office-secret")).body.submissions.length, 2);

  // blobs: owner + admin read, others don't
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  assert.equal((await send("PUT", "/blob/blob-aaaa-1111", "alice-token", undefined, bytes)).status, 200);
  assert.deepEqual((await send("GET", "/blob/blob-aaaa-1111", "alice-token")).body, bytes);
  assert.deepEqual((await send("GET", "/blob/blob-aaaa-1111", "office-secret")).body, bytes);
  assert.equal((await send("GET", "/blob/blob-aaaa-1111", "bob-token")).status, 403);

  // magic links: only the admin mints; not for the admin; act as the user only
  assert.equal((await send("POST", "/magic", "alice-token", { user_id: "x" })).status, 403);
  assert.equal((await send("POST", "/magic", "office-secret", { user_id: "@office:hs" })).status, 400);
  const aliceId = mineA.body.submissions[0].user_id;
  const m = await send("POST", "/magic", "office-secret", { user_id: aliceId, ttl_days: 1 });
  assert.equal(m.status, 200);
  const mt = m.body.token;
  assert.match(mt, /^mgk_/);

  const viaMagic = await send("GET", "/mine", mt);
  assert.deepEqual(viaMagic.body.submissions.map((s) => s.submission_id), ["sa"]);
  assert.deepEqual((await send("GET", "/blob/blob-aaaa-1111", mt)).body, bytes);
  assert.equal((await send("GET", "/submissions", mt)).status, 403);
  // ...but it can write the user's own content, marked as via-link, appended
  const w = await send("POST", "/append", mt, { submission_id: "sa", events: [ev("a2", "DEF", "name", "Alice B")] });
  assert.equal(w.status, 200);
  assert.equal(w.body.appended, 1);
  assert.equal((await send("PUT", "/blob/blob-zzzz-2222", mt, undefined, bytes)).status, 200);
  // ...and cannot write into someone else's submission
  assert.equal((await send("POST", "/append", mt, { submission_id: "sb", events: [ev("b2", "DEF", "name", "X")] })).status, 403);
  // the earlier value is still in the log (append-only)
  const after = await send("GET", "/mine", "alice-token");
  const ids = after.body.submissions[0].events.map((e) => e.id);
  assert.deepEqual(ids, ["a1", "a2"]);
  assert.match(after.body.submissions[0].events[1].via, /^magic:/);
  // a link narrowed to one submission can't touch another of the same user
  await send("POST", "/append", "alice-token", { submission_id: "sa2", events: [ev("a3", "DEF", "name", "Alice 2")] });
  const narrow = await send("POST", "/magic", "office-secret", { user_id: aliceId, submission_id: "sa2" });
  assert.equal((await send("POST", "/append", narrow.body.token, { submission_id: "sa", events: [ev("a4", "DEF", "x", "y")] })).status, 403);
  assert.deepEqual((await send("GET", "/mine", narrow.body.token)).body.submissions.map((s) => s.submission_id), ["sa2"]);
  assert.equal((await send("POST", "/magic", mt, { user_id: aliceId })).status, 403);

  // revoke kills it
  assert.equal((await send("POST", "/magic/revoke", "office-secret", { user_id: aliceId })).body.revoked, 2);
  assert.equal((await send("GET", "/mine", mt)).status, 401);
  assert.equal((await send("GET", "/mine", "alice-token")).status, 200);

  app.server.close();
});

test("question set: public read, office-only write, not listed as a submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({ dbFile: join(dir, "t3.sqlite"), verifyMatrix: false, adminUserId: "@office:hs", adminToken: "office-secret" });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  const w = await post(base, "/append", { submission_id: "config", events: [ev("c1", "INS", "q1", "Name?")] }, "someone");
  assert.equal(w.status, 403);
  const ok = await post(base, "/append", { submission_id: "config", events: [ev("c1", "INS", "q1", "Name?")] }, "office-secret");
  assert.equal(ok.status, 200);
  const read = await get(base, "/config");
  assert.equal(read.status, 200);
  assert.equal(read.body.events.length, 0); // "c1" is not a question-set event
  // question-set events are public; office-internal ones are office-only
  const mk = (id, op, payload) => ({ id, op, payload, at: "2026-10-07T00:00:00.000Z", by: "@office:hs" });
  await post(base, "/append", { submission_id: "config", events: [
    mk("q1", "INS", { entity: "field", id: "name", attrs: { label: "Name" } }),
    mk("q2", "DEF", { anchor: "qconfig", path: "seeded", value: true }),
    mk("t1", "INS", { entity: "eye_trail", id: "x", attrs: { seen: "sub-1" } }),
  ] }, "office-secret");
  const pub = await get(base, "/config");
  assert.deepEqual(pub.body.events.map((e) => e.id).sort(), ["q1", "q2"]);
  const full = await get(base, "/config", "office-secret");
  assert.deepEqual(full.body.events.map((e) => e.id).sort(), ["c1", "q1", "q2", "t1"]);
  assert.equal((await get(base, "/submissions", "office-secret")).body.submissions.length, 0);
  app.server.close();
});


async function put(base, path, bytes, token) {
  const res = await fetch(base + path, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
}

test("per-user storage cap: files and events stop at the limit; the office is exempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({
    dbFile: join(dir, "t.sqlite"), verifyMatrix: false,
    adminUserId: "@office:hs", adminToken: "office-secret",
    maxUserBytes: 1000, maxTotalBytes: 1e9, rateWrites: 1000,
  });
  const base = `http://127.0.0.1:${await listen(app)}`;

  assert.equal((await put(base, "/blob/mx_user0001", Buffer.alloc(600), "fam-a")).status, 200);
  // 600 + 600 > 1000: refused, and nothing stored for it
  const over = await put(base, "/blob/mx_user0002", Buffer.alloc(600), "fam-a");
  assert.equal(over.status, 413);
  assert.equal(app.db.prepare("select count(*) c from blobs where id='mx_user0002'").get().c, 0);
  // a different account has its own allowance
  assert.equal((await put(base, "/blob/mx_user0003", Buffer.alloc(600), "fam-b")).status, 200);
  // the office is not capped
  assert.equal((await put(base, "/blob/mx_office01", Buffer.alloc(5000), "office-secret")).status, 200);

  // events count toward the same per-user allowance as files
  const big = (id) => ({ id, op: "INS", payload: { text: "x".repeat(250) }, at: "2026-10-07T00:00:00.000Z" });
  // fam-b already holds 600 bytes of files; two 250-byte events (~560) push it over 1000
  assert.equal((await post(base, "/append", { submission_id: "q1", events: [big("a1"), big("a2")] }, "fam-b")).status, 413);
  assert.equal(app.db.prepare("select count(*) c from events where submission_id='q1'").get().c, 0);
  // a small event still fits in what is left
  assert.equal((await post(base, "/append", { submission_id: "q1", events: [{ id: "s1", op: "INS", payload: { t: "ok" } }] }, "fam-b")).status, 200);
  assert.equal((await post(base, "/append", { submission_id: "q2", events: [big("a1")] }, "office-secret")).status, 200);
  app.server.close();
});

test("per-user rate limit: writes and reads are throttled per account; the office is exempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({
    dbFile: join(dir, "t.sqlite"), verifyMatrix: false,
    adminUserId: "@office:hs", adminToken: "office-secret",
    rateWrites: 3, rateReads: 2, rateWindowMs: 60000,
  });
  const base = `http://127.0.0.1:${await listen(app)}`;
  const w = (tok, i) => post(base, "/append", { submission_id: "r-" + tok, events: [ev("e" + i, "DEF", "k", i)] }, tok);

  for (let i = 0; i < 3; i++) assert.equal((await w("fam-a", i)).status, 200);
  const limited = await w("fam-a", 9);
  assert.equal(limited.status, 429);
  assert.ok(limited.body.retry_after >= 1);
  // another account is unaffected; the office is never throttled
  assert.equal((await w("fam-b", 0)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await w("office-secret", i)).status, 200);

  assert.equal((await get(base, "/mine", "fam-b")).status, 200);
  assert.equal((await get(base, "/mine", "fam-b")).status, 200);
  assert.equal((await get(base, "/mine", "fam-b")).status, 429);
  app.server.close();
});

test("system-wide cap: when the whole store is full, every write is refused, the office's included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  const app = createApp({
    dbFile: join(dir, "t.sqlite"), verifyMatrix: false,
    adminUserId: "@office:hs", adminToken: "office-secret",
    maxUserBytes: 10000, maxTotalBytes: 1500, rateWrites: 1000,
  });
  const base = `http://127.0.0.1:${await listen(app)}`;
  assert.equal((await put(base, "/blob/mx_a0000001", Buffer.alloc(800), "fam-a")).status, 200);
  assert.equal((await put(base, "/blob/mx_b0000001", Buffer.alloc(600), "fam-b")).status, 200);
  // 1400 held; another 300 would pass fam-c's own allowance but not the system's
  assert.equal((await put(base, "/blob/mx_c0000001", Buffer.alloc(300), "fam-c")).status, 507);
  assert.equal((await put(base, "/blob/mx_o0000001", Buffer.alloc(300), "office-secret")).status, 507);
  // a write that fits still goes through
  assert.equal((await put(base, "/blob/mx_c0000002", Buffer.alloc(50), "fam-c")).status, 200);
  app.server.close();
});
