// ab/server/server.mjs — the "standard database" tier that sits beside Matrix.
//
// Why this exists: the Feedback Platform's primary store is an E2E-encrypted
// Matrix room stream. That layer is correct but fragile (megolm-vs-database,
// one crypto store per origin, partial sync, UISI). This server is the
// boring, reliable store the office can always read:
//
//   * An append-only event log (submissions are never updated or deleted —
//     only more events are appended; the current state is a fold over the log).
//   * Submitters write with POST /append and read back only their OWN
//     submissions with GET /mine. A submission is bound to the user who first
//     writes it; only that user (or the office) may append to it again.
//   * Admins read everything with GET /submissions.
//   * Files (images, PDFs, video) are stored as blobs: PUT/GET /blob/<id>,
//     readable by the uploader and the admin.
//   * Magic links: the admin mints a token for one user (POST /magic),
//     optionally narrowed to one submission. It acts AS that user — read and
//     write their own content, nothing else — and can never act as the admin
//     or mint more links. Every write is an append, so any edit made through a
//     link is recoverable; events written via a link are marked in `via`.
//     Links expire and can be revoked. Only the sha256 is stored.
//   * Matrix is used only to prove who you are (whoami on the bearer token).
//     No content is stored on, or read from, Matrix.
//
// Run:  node server.mjs            (see AB_* env below)
//   AB_PORT             listen port                      (default 8788)
//   AB_DB               sqlite file path                 (default ./data/ab.sqlite)
//   AB_HOMESERVER       Matrix homeserver for whoami     (default https://hyphae.social)
//   AB_ADMIN_USER_ID    the office's Matrix user id      (default @planetary_nebula996083:hyphae.social)
//   AB_ADMIN_TOKEN      optional static admin read token (default empty)
//   AB_VERIFY_MATRIX    "0" to skip whoami (test only)   (default "1")
//   AB_ALLOWED_ORIGINS  comma-separated CORS origins, or "*" (default "*")
//   AB_MAX_BODY         max JSON body bytes              (default 16 MiB)
//   AB_MAX_BLOB         max file upload bytes            (default 64 MiB)
//
// HTTPS is expected to terminate in front of this (nginx/caddy) on the VM.

import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPS = new Set(["DEF", "INS", "CON"]);
const CONFIG_SUBMISSION = "config";

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
    maxBody: Number(config.maxBody || process.env.AB_MAX_BODY || 16 * 1024 * 1024),
    maxBlob: Number(config.maxBlob || process.env.AB_MAX_BLOB || 64 * 1024 * 1024),
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
    CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id);
    CREATE TABLE IF NOT EXISTS magic_links (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0,
      submission_id TEXT
    );
    CREATE TABLE IF NOT EXISTS blobs (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL,
      data      BLOB NOT NULL,
      server_ts TEXT NOT NULL
    );
  `);

  try { db.exec("ALTER TABLE events ADD COLUMN via TEXT"); } catch { /* already there */ }

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events
      (submission_id, event_id, op, payload, at, by, room_id, user_id, server_ts, via)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const allEvents = db.prepare("SELECT * FROM events ORDER BY seq ASC");
  const eventsByUser = db.prepare("SELECT * FROM events WHERE user_id = ? ORDER BY seq ASC");
  const insertMagic = db.prepare("INSERT INTO magic_links (token_hash, user_id, created_by, created_at, expires_at, submission_id) VALUES (?, ?, ?, ?, ?, ?)");
  const findMagic = db.prepare("SELECT user_id, submission_id, expires_at, revoked FROM magic_links WHERE token_hash = ?");
  const revokeMagic = db.prepare("UPDATE magic_links SET revoked = 1 WHERE user_id = ? AND revoked = 0");
  const getBlob = db.prepare("SELECT user_id, data FROM blobs WHERE id = ?");
  const putBlob = db.prepare("INSERT OR IGNORE INTO blobs (id, user_id, data, server_ts) VALUES (?, ?, ?, ?)");
  const ownerOf = db.prepare("SELECT user_id FROM events WHERE submission_id = ? LIMIT 1");

  // whoami(token) -> userId, cached 5 minutes so a flush storm doesn't hammer
  // the homeserver. When verification is off (tests) the token is hashed into
  // a stable pseudonymous id instead.
  const whoamiCache = new Map(); // token -> { userId, exp }

  const sha = (t) => createHash("sha256").update(String(t)).digest("hex");
  // A live magic-link token resolves to its user.
  function magicInfo(token) {
    if (!token || !String(token).startsWith("mgk_")) return null;
    const row = findMagic.get(sha(token));
    if (!row || row.revoked || row.expires_at <= new Date().toISOString()) return null;
    return { user_id: row.user_id, submission_id: row.submission_id || null, via: "magic:" + sha(token).slice(0, 12) };
  }
  function magicUser(token) { const m = magicInfo(token); return m ? m.user_id : null; }

  async function whoami(token) {
    const mu = magicUser(token);
    if (mu) return mu;
    // A magic-shaped token that isn't live (expired, revoked, unknown) is
    // never handed to Matrix or treated as an ordinary token.
    if (String(token || "").startsWith("mgk_")) {
      throw Object.assign(new Error("magic link expired or revoked"), { status: 401 });
    }
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
    if (magicUser(token)) return false;
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
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
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

  async function readBody(req, limit = cfg.maxBody) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
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
    const magic = magicInfo(token);
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
    //
    // The office may mirror a room it can decrypt, in which case it declares
    // the real owner via owner_user so the submitter can keep flushing their
    // own case later (a submission bound to the admin would otherwise lock the
    // family out of it). owner_user is honoured for the office only.
    if (magic && magic.submission_id && magic.submission_id !== submissionId) {
      return json(res, 403, { error: "this link only covers one submission" });
    }
    const isAdminUser = isAdmin({ token, userId });
    // The shared question set is one well-known submission only the office
    // may write; everyone may read it (GET /config).
    if (submissionId === CONFIG_SUBMISSION && !isAdminUser) {
      return json(res, 403, { error: "only the office writes the question set" });
    }
    const claimedOwner = (isAdminUser && typeof body.owner_user === "string" && body.owner_user.trim())
      ? body.owner_user.trim().slice(0, 255) : userId;

    const owner = ownerOf.get(submissionId);
    if (owner && owner.user_id && owner.user_id !== claimedOwner && !isAdminUser) {
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
        roomId || null, claimedOwner, serverTs, magic ? magic.via : null,
      );
      if (Number(res0.changes) > 0) appended++; else skipped++;
    }

    return json(res, 200, { ok: true, submission_id: submissionId, appended, skipped });
  }

  // Fold event rows into one object per submission (deduped by event id,
  // ordered by time). Shared by the admin read and a submitter's own read.
  function foldRows(rows) {
    const bySubmission = new Map();
    for (const row of rows) {
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
        ...(row.via ? { via: row.via } : {}),
      });
    }
    return [...bySubmission.values()]
      .map(({ seen, ...rest }) => rest)
      .sort((a, b) => (a.updated_at || "").localeCompare(b.updated_at || ""));
  }

  // GET /me — who this token is: lets a magic-link page learn its user.
  function handleMe(req, res) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    (async () => {
      const userId = await whoami(token).catch(() => null);
      if (!userId) return json(res, 401, { error: "unknown user" });
      const m = magicInfo(token);
      return json(res, 200, {
        ok: true, user_id: userId, is_admin: isAdmin({ token, userId }),
        magic: !!m, submission_id: m ? m.submission_id : null,
      });
    })().catch((e) => json(res, 500, { error: e.message }));
  }

  // GET /config — the shared question set. Public, so it returns ONLY what a
  // family's form needs (questions, knowledge, templates, the question-set
  // settings). Everything else in the office's config log — what it looked
  // at, what it learned — is returned to the office alone.
  const PUBLIC_ENTITIES = new Set(["field", "knowledge", "template"]);
  function isQuestionSetEvent(ev) {
    const p = ev && ev.payload;
    if (!p || typeof p !== "object") return false;
    if (ev.op === "DEF" && p.anchor === "qconfig") return true;
    return ev.op === "INS" && PUBLIC_ENTITIES.has(p.entity);
  }
  function handleConfig(req, res) {
    (async () => {
      const token = bearer(req);
      let office = false;
      if (token) {
        const userId = await whoami(token).catch(() => null);
        office = isAdmin({ token, userId });
      }
      const rows = db.prepare("SELECT * FROM events WHERE submission_id = ? ORDER BY seq ASC").all(CONFIG_SUBMISSION);
      const sub = foldRows(rows)[0];
      const events = sub ? sub.events : [];
      return json(res, 200, { ok: true, events: office ? events : events.filter(isQuestionSetEvent) });
    })().catch((e) => json(res, 500, { error: e.message }));
  }

  // GET /submissions — admin read: every submission.
  // GET /mine        — anyone signed in: only the submissions they own.
  function handleList(req, res, { mine }) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    (async () => {
      const userId = await whoami(token).catch(() => null);
      if (!userId && !isAdmin({ token, userId })) return json(res, 401, { error: "unknown user" });
      if (mine) {
        const scope = magicInfo(token)?.submission_id || null;
        const rows = eventsByUser.all(userId).filter((r) => r.submission_id !== CONFIG_SUBMISSION && (!scope || r.submission_id === scope));
        return json(res, 200, { ok: true, submissions: foldRows(rows) });
      }
      if (!isAdmin({ token, userId })) return json(res, 403, { error: "forbidden" });
      return json(res, 200, { ok: true, submissions: foldRows(allEvents.all().filter((r) => r.submission_id !== CONFIG_SUBMISSION)) });
    })().catch((e) => json(res, 500, { error: e.message }));
  }

  async function readRaw(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // PUT /blob/<id> — store a file. The id is the client's (a random uuid);
  // first writer owns it, and a re-upload of the same id is ignored.
  function handleBlobPut(req, res, id) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    (async () => {
      const userId = await whoami(token).catch(() => null);
      if (!userId) return json(res, 401, { error: "unknown user" });
      if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(id)) return json(res, 400, { error: "bad blob id" });
      const prior = getBlob.get(id);
      if (prior && prior.user_id !== userId && !isAdmin({ token, userId })) {
        return json(res, 403, { error: "blob belongs to another user" });
      }
      const data = await readRaw(req, cfg.maxBlob);
      putBlob.run(id, userId, data, new Date().toISOString());
      return json(res, 200, { ok: true, id, bytes: data.length });
    })().catch((e) => json(res, e.status || 500, { error: e.message }));
  }

  // GET /blob/<id> — the uploader and the admin only.
  function handleBlobGet(req, res, id) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    (async () => {
      const userId = await whoami(token).catch(() => null);
      const row = getBlob.get(id);
      if (!row) return json(res, 404, { error: "not found" });
      if (row.user_id !== userId && !isAdmin({ token, userId })) {
        return json(res, 403, { error: "forbidden" });
      }
      const data = Buffer.from(row.data);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": data.length,
        "cache-control": "private, max-age=31536000, immutable",
      });
      res.end(data);
    })().catch((e) => json(res, 500, { error: e.message }));
  }

  // POST /magic        {user_id, submission_id?, ttl_days?} — admin mints a link token.
  // POST /magic/revoke {user_id}             — admin revokes all of a user's links.
  function handleMagic(req, res, revoke) {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing bearer token" });
    (async () => {
      const userId = await whoami(token).catch(() => null);
      if (!isAdmin({ token, userId })) return json(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const target = typeof body.user_id === "string" ? body.user_id.trim().slice(0, 255) : "";
      if (!target) return json(res, 400, { error: "user_id required" });
      if (target === cfg.adminUserId) return json(res, 400, { error: "cannot mint a link for the admin" });
      if (revoke) {
        const r = revokeMagic.run(target);
        return json(res, 200, { ok: true, revoked: Number(r.changes) });
      }
      const days = Math.min(Math.max(Number(body.ttl_days) || 7, 1), 90);
      const secret = "mgk_" + randomBytes(24).toString("base64url");
      const now = new Date();
      const exp = new Date(now.getTime() + days * 86400000).toISOString();
      const only = typeof body.submission_id === "string" && body.submission_id.trim() ? body.submission_id.trim().slice(0, 200) : null;
      insertMagic.run(sha(secret), target, userId || "admin-token", now.toISOString(), exp, only);
      return json(res, 200, { ok: true, token: secret, user_id: target, submission_id: only, expires_at: exp });
    })().catch((e) => json(res, e.status || 500, { error: e.message }));
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
      return handleList(req, res, { mine: false });
    }
    if (req.method === "GET" && (p === "/me" || p.endsWith("/me"))) return handleMe(req, res);
    if (req.method === "GET" && (p === "/config" || p.endsWith("/config"))) return handleConfig(req, res);
    if (req.method === "GET" && (p === "/mine" || p.endsWith("/mine"))) {
      return handleList(req, res, { mine: true });
    }
    if (req.method === "POST" && (p === "/magic" || p.endsWith("/magic"))) return handleMagic(req, res, false);
    if (req.method === "POST" && p.endsWith("/magic/revoke")) return handleMagic(req, res, true);
    const bm = /\/blob\/([^/]+)$/.exec(p);
    if (bm && req.method === "PUT") return handleBlobPut(req, res, decodeURIComponent(bm[1]));
    if (bm && req.method === "GET") return handleBlobGet(req, res, decodeURIComponent(bm[1]));
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
