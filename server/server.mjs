// ab/server/server.mjs — the "standard database" tier that sits beside Matrix.
//
// Why this exists: the Feedback Platform's primary store is an E2E-encrypted
// Matrix room stream. That layer is correct but fragile (megolm-vs-database,
// one crypto store per origin, partial sync, UISI). This server is the
// boring, reliable store the office can always read:
//
//   * An append-only event log (submissions are never updated or deleted —
//     only more events are appended; the current state is a fold over the log).
//   * Submitters are WRITE-ONLY: they POST their events, and there is no read
//     endpoint they can reach. They cannot see anyone else's content, nor even
//     their own, from the database — they only ever see local/Matrix copies.
//     A submission is bound to the user who first writes it; only that user
//     (or the office) may append to it again.
//   * Admins read everything the log holds, which the client merges (deduped)
//     with whatever they can still decrypt on Matrix.
//
// Run:  node server.mjs            (see AB_* env below)
//   AB_PORT             listen port                      (default 8788)
//   AB_DB               sqlite file path                 (default ./data/ab.sqlite)
//   AB_HOMESERVER       Matrix homeserver for whoami     (default https://hyphae.social)
//   AB_ADMIN_USER_ID    the office's Matrix user id      (default @planetary_nebula996083:hyphae.social)
//   AB_ADMIN_TOKEN      optional static admin read token (default empty)
//   AB_VERIFY_MATRIX    "0" to skip whoami (test only)   (default "1")
//   AB_ALLOWED_ORIGINS  comma-separated CORS origins, or "*" (default "*")
//   AB_MAX_BODY         max request body bytes           (default 4 MiB)
//
// HTTPS is expected to terminate in front of this (nginx/caddy) on the VM.

import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPS = new Set(["DEF", "INS", "CON"]);

export function createApp(config = {}) {
  const cfg = {
    port: Number(config.port || process.env.AB_PORT || 8788),
    dbFile: config.dbFile || process.env.AB_DB || resolve(__dirname, "data", "ab.sqlite"),
    homeserver: (config.homeserver || process.env.AB_HOMESERVER || "https://hyphae.social").replace(/\/+$/, ""),
    adminUserId: config.adminUserId || process.env.AB_ADMIN_USER_ID || "@planetary_nebula996083:hyphae.social",
    adminToken: config.adminToken ?? (process.env.AB_ADMIN_TOKEN || ""),
    verifyMatrix: config.verifyMatrix ?? (process.env.AB_VERIFY_MATRIX !== "0"),
    allowedOrigins: (config.allowedOrigins || process.env.AB_ALLOWED_ORIGINS || "*")
      .split(",").map((s) => s.trim()).filter(Boolean),
    maxBody: Number(config.maxBody || process.env.AB_MAX_BODY || 4 * 1024 * 1024),
  };

  mkdirSync(dirname(cfg.dbFile), { recursive: true });
  const db = new DatabaseSync(cfg.dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT NOT NULL,
      event_id      TEXT NOT NULL,
      op            TEXT NOT NULL,
      payload       TEXT NOT NULL,
      at            TEXT,
      by            TEXT,
      room_id       TEXT,
      user_id       TEXT,
      server_ts     TEXT NOT NULL,
      UNIQUE (submission_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_submission ON events (submission_id);
  `);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events
      (submission_id, event_id, op, payload, at, by, room_id, user_id, server_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const allEvents = db.prepare("SELECT * FROM events ORDER BY seq ASC");
  const ownerOf = db.prepare("SELECT user_id FROM events WHERE submission_id = ? LIMIT 1");

  // whoami(token) -> userId, cached 5 minutes so a flush storm doesn't hammer
  // the homeserver. When verification is off (tests) the token is hashed into
  // a stable pseudonymous id instead.
  const whoamiCache = new Map(); // token -> { userId, exp }

  async function whoami(token) {
    if (!cfg.verifyMatrix) {
      return "token:" + createHash("sha256").update(token).digest("hex").slice(0, 16);
    }
    const hit = whoamiCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.userId;
    const res = await fetch(`${cfg.homeserver}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw Object.assign(new Error("invalid matrix token"), { status: 401 });
    const body = await res.json();
    const userId = body && body.user_id;
    if (typeof userId !== "string" || !userId.startsWith("@")) {
      throw Object.assign(new Error("whoami returned no user_id"), { status: 401 });
    }
    whoamiCache.set(token, { userId, exp: Date.now() + 5 * 60 * 1000 });
    return userId;
  }

  function bearer(req) {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
  }

  function isAdmin({ token, userId }) {
    if (cfg.adminToken && token && safeEqual(token, cfg.adminToken)) return true;
    if (userId && userId === cfg.adminUserId) return true;
    return false;
  }

  function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  function corsHeaders(origin) {
    const allow = cfg.allowedOrigins.includes("*") || cfg.allowedOrigins.includes(origin || "")
      ? (cfg.allowedOrigins.includes("*") ? "*" : origin)
      : null;
    const h = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-max-age": "86400",
    };
    if (allow) h["access-control-allow-origin"] = allow;
    if (cfg.allowedOrigins.includes("*") === false) h.vary = "Origin";
    return h;
  }

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > cfg.maxBody) {
        const err = Object.assign(new Error("body too large"), { status: 413 });
        throw err;
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid JSON"), { status: 400 });
    }
  }

  // POST /append — submitter writes. Append-only: every call only ever adds
  // events; duplicates (same submission_id + event_id) are ignored.
  async function handleAppend(req, res) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    let userId;
    try {
      userId = await whoami(token);
    } catch (e) {
      return json(res, e.status || 401, { error: e.message });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }

    const submissionId = typeof body.submission_id === "string" ? body.submission_id.trim() : "";
    const roomId = typeof body.room_id === "string" ? body.room_id.trim() : "";
    const events = Array.isArray(body.events) ? body.events : [];
    if (!submissionId || submissionId.length > 200) {
      return json(res, 400, { error: "bad submission_id" });
    }
    if (events.length > 10000) {
      return json(res, 400, { error: "too many events" });
    }

    // Write-only scoping: a submission is bound to the user who first writes
    // it, and only that user (or the office) may append to it again. This is
    // what keeps "submitters are write-only" from meaning "submitters can
    // write into anyone's case".
    const owner = ownerOf.get(submissionId);
    if (owner && owner.user_id && owner.user_id !== userId && !isAdmin({ token, userId })) {
      return json(res, 403, { error: "submission belongs to another user" });
    }

    const serverTs = new Date().toISOString();
    let appended = 0, skipped = 0;
    for (const ev of events) {
      if (!ev || typeof ev !== "object") { skipped++; continue; }
      if (!OPS.has(ev.op)) { skipped++; continue; }
      const id = typeof ev.id === "string" && ev.id ? ev.id.slice(0, 200) : null;
      if (!id) { skipped++; continue; }
      let payload;
      try {
        payload = typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload ?? null);
      } catch {
        skipped++; continue;
      }
      const res0 = insertEvent.run(
        submissionId, id, ev.op, payload,
        typeof ev.at === "string" ? ev.at.slice(0, 64) : null,
        typeof ev.by === "string" ? ev.by.slice(0, 255) : userId,
        roomId || null, userId, serverTs,
      );
      if (Number(res0.changes) > 0) appended++; else skipped++;
    }

    return json(res, 200, { ok: true, submission_id: submissionId, appended, skipped });
  }

  // GET /submissions — admin read. Returns every submission folded from the
  // append-only log (deduped by event id, ordered by time).
  function handleList(req, res) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    (async () => {
      const userId = await whoami(token).catch(() => null);
      if (!isAdmin({ token, userId })) return json(res, 403, { error: "forbidden" });

      const bySubmission = new Map();
      for (const row of allEvents.all()) {
        let s = bySubmission.get(row.submission_id);
        if (!s) {
          s = {
            submission_id: row.submission_id,
            room_id: row.room_id,
            user_id: row.user_id,
            updated_at: row.server_ts,
            events: [],
            seen: new Set(),
          };
          bySubmission.set(row.submission_id, s);
        }
        if (row.server_ts > s.updated_at) s.updated_at = row.server_ts;
        if (row.room_id && !s.room_id) s.room_id = row.room_id;
        if (s.seen.has(row.event_id)) continue;
        s.seen.add(row.event_id);
        let payload = null;
        try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
        s.events.push({
          id: row.event_id, op: row.op, payload,
          at: row.at, by: row.by,
        });
      }

      const submissions = [...bySubmission.values()]
        .map(({ seen, ...rest }) => rest)
        .sort((a, b) => (a.updated_at || "").localeCompare(b.updated_at || ""));

      return json(res, 200, { ok: true, submissions });
    })().catch((e) => json(res, 500, { error: e.message }));
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const ch = corsHeaders(origin);
    for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url || "/", "http://localhost");
    // Tolerant of being mounted behind a reverse-proxy path (e.g. /ab-db): a
    // request for /ab-db/append or /append both land on the append handler.
    const p = url.pathname;
    if (req.method === "GET" && (p === "/health" || p.endsWith("/health"))) {
      return json(res, 200, { ok: true, append_only: true });
    }
    if (req.method === "POST" && (p === "/append" || p.endsWith("/append"))) {
      return handleAppend(req, res);
    }
    if (req.method === "GET" && (p === "/submissions" || p.endsWith("/submissions"))) {
      return handleList(req, res);
    }
    return json(res, 404, { error: "not found" });
  });

  return { server, db, config: cfg };
}

function main() {
  const app = createApp();
  app.server.listen(app.config.port, () => {
    console.log(`[ab-db] append-only store listening on :${app.config.port}`);
    console.log(`[ab-db] sqlite: ${app.config.dbFile}`);
    console.log(`[ab-db] homeserver (whoami): ${app.config.homeserver}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
