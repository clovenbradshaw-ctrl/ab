// server/e2e.test.mjs — end-to-end falsification of the database tier.
//
// Runs the REAL server code (createApp from server.mjs) against a mock Matrix
// homeserver that implements /account/whoami, so the actual auth path — bearer
// token → whoami → "is this the office?" — is exercised exactly as it will be
// in production. The test then asserts the three properties the office relies
// on:
//
//   1. The database actually gets filled: it reopens the SQLite file directly
//      and counts rows, rather than trusting the API's own "appended" counter.
//   2. Submitters are write-only: they can append, but reading is refused, and
//      they cannot write into another submitter's case.
//   3. The office can read everything from ANY device: a brand-new client that
//      holds nothing but the admin token sees every submission — no local
//      state, no crypto keys, no Matrix decryption involved.
//
// Any failure here means the tier is broken and the test fails loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./server.mjs";

const ADMIN_ID = "@planetary_nebula996083:hyphae.social";
const ADMIN_TOKEN = "office-access-token-xyz";
const A_TOKEN = "family-a-access-token";
const B_TOKEN = "family-b-access-token";

const TOKENS = {
  [ADMIN_TOKEN]: ADMIN_ID,
  [A_TOKEN]: "@family-a:hyphae.social",
  [B_TOKEN]: "@family-b:hyphae.social",
};

function mockHomeserver() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.endsWith("/account/whoami")) {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
      const userId = m && TOKENS[m[1]];
      if (!userId) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ user_id: userId }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function listen(app) {
  return new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port));
  });
}

function freshClient(base, token) {
  // A brand-new device: nothing but the endpoint and a bearer token.
  return {
    append: (body) => fetch(`${base}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    read: () => fetch(`${base}/submissions`, { headers: { authorization: `Bearer ${token}` } }),
  };
}

function answerEvent(id, path, value) {
  return { id, op: "DEF", payload: { path, value, anchor: "applicant" }, at: "2026-10-07T00:00:00.000Z", by: "@family-a:hyphae.social" };
}

function countRows(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM events").get().n);
  } finally {
    db.close();
  }
}

test("E2E: DB fills, submitters are write-only, admin reads from any device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-e2e-"));
  const dbFile = join(dir, "e2e.sqlite");
  const homeserver = await mockHomeserver();

  const app = createApp({
    dbFile,
    homeserver: `http://127.0.0.1:${homeserver.address().port}`,
    verifyMatrix: true,
    adminUserId: ADMIN_ID,
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  try {
    // — Submitter A fills the form on device 1.
    const a1 = freshClient(base, A_TOKEN);
    const r1 = await a1.append({
      submission_id: "sub-a",
      room_id: "!room-a:hyphae.social",
      events: [
        answerEvent("ea1", "complainant_name", "Jane Doe"),
        answerEvent("ea2", "complainant_phone", "6155550148"),
        answerEvent("ea3", "dcs_county", "Davidson"),
      ],
    });
    assert.equal(r1.status, 200, "submitter A's write should be accepted");
    assert.equal((await r1.json()).appended, 3);

    // 1) The database actually got filled — prove it from the file, not the API.
    assert.equal(countRows(dbFile), 3, "sqlite must contain the 3 appended rows");

    // — Submitter A refreshes on a DIFFERENT device (same account): idempotent.
    const a2 = freshClient(base, A_TOKEN);
    const r2 = await a2.append({
      submission_id: "sub-a",
      room_id: "!room-a:hyphae.social",
      events: [answerEvent("ea1", "complainant_name", "Jane Doe")],
    });
    assert.equal((await r2.json()).appended, 0, "re-send must not duplicate");
    assert.equal(countRows(dbFile), 3, "still exactly 3 rows after a re-send");

    // 2) Submitters are write-only: A cannot read anything, from any device.
    for (const c of [a1, a2]) {
      const rd = await c.read();
      assert.equal(rd.status, 403, "submitter must never read the database");
    }

    // — Submitter B (a different family) also submits.
    const b1 = freshClient(base, B_TOKEN);
    const rb = await b1.append({
      submission_id: "sub-b",
      room_id: "!room-b:hyphae.social",
      events: [answerEvent("eb1", "complainant_name", "Maria Garcia")],
    });
    assert.equal((await rb.json()).appended, 1);

    // B cannot write into A's submission (ownership scoping).
    const hijack = await b1.append({
      submission_id: "sub-a",
      room_id: "!room-a:hyphae.social",
      events: [answerEvent("eaX", "complainant_name", "HACKED")],
    });
    assert.equal(hijack.status, 403, "a submitter must not append into another's case");
    assert.equal(countRows(dbFile), 4, "and no extra row was written");

    // 3) The office reads everything from ANY device: a fresh client holding
    //    only the admin token (no local state, no keys, no Matrix decrypt).
    const admin = freshClient(base, ADMIN_TOKEN);
    const list = await admin.read();
    assert.equal(list.status, 200, "admin read must succeed");
    const body = await list.json();
    assert.equal(body.submissions.length, 2, "admin sees both submissions");

    const byId = Object.fromEntries(body.submissions.map((s) => [s.submission_id, s]));
    assert.deepEqual(
      byId["sub-a"].events.map((e) => e.payload.value).sort(),
      ["6155550148", "Davidson", "Jane Doe"],
      "admin gets the full folded answer set for A",
    );
    assert.equal(byId["sub-b"].events[0].payload.value, "Maria Garcia");
    assert.equal(byId["sub-a"].events.find((e) => e.payload.path === "complainant_name").payload.value, "Jane Doe");

    // — Admin-side mirroring: the office decrypts a room the family never
    //   flushed, and writes it to the DB declaring the family as owner — so
    //   the family can keep flushing later instead of being locked out.
    const mirror = await admin.append({
      submission_id: "sub-mirror",
      room_id: "!room-m:hyphae.social",
      owner_user: "@family-a:hyphae.social",
      events: [answerEvent("em1", "complainant_name", "Casey Doe")],
    });
    assert.equal(mirror.status, 200, "admin mirror write must succeed");
    assert.equal((await mirror.json()).appended, 1);

    // The family can still append to that same submission.
    const familyResume = await a1.append({
      submission_id: "sub-mirror",
      room_id: "!room-m:hyphae.social",
      events: [answerEvent("em2", "dcs_county", "Shelby")],
    });
    assert.equal(familyResume.status, 200, "owner must be able to keep flushing after an admin mirror");

    // A different family still cannot.
    const foreign = await b1.append({
      submission_id: "sub-mirror",
      room_id: "!room-m:hyphae.social",
      events: [answerEvent("emX", "dcs_county", "NOPE")],
    });
    assert.equal(foreign.status, 403, "another family must not write into a mirrored submission");

    // — Durability: restart the server over the same file and read again.
    app.server.close();
    const app2 = createApp({
      dbFile,
      homeserver: `http://127.0.0.1:${homeserver.address().port}`,
      verifyMatrix: true,
      adminUserId: ADMIN_ID,
    });
    const port2 = await listen(app2);
    const admin2 = freshClient(`http://127.0.0.1:${port2}`, ADMIN_TOKEN);
    const list2 = await admin2.read();
    assert.equal(list2.status, 200);
    assert.equal((await list2.json()).submissions.length, 3, "data survives a server restart");
    app2.server.close();
  } finally {
    app.server.close?.();
    homeserver.close();
  }
});
