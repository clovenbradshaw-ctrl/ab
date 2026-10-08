// db-client.js — thin browser bridge to the append-only database tier.
//
// The Feedback Platform's primary store is a Matrix room stream; this module
// talks to the small server (server/server.mjs) that keeps a *standard*,
// append-only SQL log of the same events. Submitters are write-only against
// it (they POST, never read). Admins read everything and merge it, deduped,
// with whatever they can still decrypt on Matrix.
//
// Everything here is deliberately forgiving: if the endpoint is unreachable
// or the module fails to load, the app keeps working exactly as before. The
// database is a safety net layered *beside* Matrix, never a hard dependency.
(function (root) {
  "use strict";

  var LS_PREFIX = "ab.submissionId.";

  var cfg = {
    endpoint: null,   // absolute URL of the server, e.g. https://hyphae.social/ab-db
    token: null,      // Matrix access token used as the bearer token
    userId: null,
    timeoutMs: 8000,
  };

  function configure(o) {
    if (o) Object.assign(cfg, o || {});
  }

  function available() {
    return !!(cfg.endpoint && typeof fetch === "function");
  }

  function store() {
    try { return root.localStorage; } catch (e) { return null; }
  }

  function submissionId(roomId) {
    var s = store();
    return s ? s.getItem(LS_PREFIX + roomId) : null;
  }

  function setSubmissionId(roomId, id) {
    var s = store();
    if (s) { try { s.setItem(LS_PREFIX + roomId, id); } catch (e) {} }
  }

  function newSubmissionId() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return root.crypto.randomUUID();
    }
    return "sub_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function join(base, path) {
    return (base || "").replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
  }

  function headers(extra) {
    var h = Object.assign({ "Content-Type": "application/json" }, extra || {});
    if (cfg.token) h.Authorization = "Bearer " + cfg.token;
    return h;
  }

  async function req(path, opts) {
    var res = await fetch(join(cfg.endpoint, path), Object.assign({
      headers: headers(),
    }, opts || {}));
    if (!res.ok) {
      var detail = "";
      try { detail = JSON.stringify(await res.json()); } catch (e) { detail = res.statusText; }
      throw new Error("ab-db " + res.status + " " + path + " " + detail);
    }
    return res.json();
  }

  // Submit one submission's events (append-only). Duplicates are ignored by
  // the server, so re-sending the whole log is always safe.
  async function append(payload) {
    return req("append", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout ? AbortSignal.timeout(cfg.timeoutMs) : undefined,
    });
  }

  // Admin read: every submission the log holds, folded server-side.
  async function list() {
    return req("submissions", {
      signal: AbortSignal.timeout ? AbortSignal.timeout(cfg.timeoutMs) : undefined,
    });
  }

  // Merge two event streams for one room, deduped by event id with the
  // database copy winning on ties (the DB is the reliable store). Preserves
  // chronological order. Pure and testable.
  function mergeRoomEvents(base, db) {
    var byId = new Map();
    (base || []).forEach(function (e) { if (e && e.id) byId.set(e.id, e); });
    (db || []).forEach(function (e) { if (e && e.id) byId.set(e.id, e); });
    var out = Array.from(byId.values());
    out.sort(function (a, b) { return String(a.at || "").localeCompare(String(b.at || "")); });
    return out;
  }

  // Rooms that exist only in the database (Matrix data missing/unreadable)
  // are surfaced as synthetic ids "db:<submission_id>".
  function syntheticRoomIds(baseRoomIds, submissions) {
    var have = new Set(baseRoomIds || []);
    var out = [];
    (submissions || []).forEach(function (s) {
      if (s && s.room_id && have.has(s.room_id)) return;
      var rid = "db:" + (s && s.submission_id);
      if (s && !have.has(rid)) { have.add(rid); out.push(rid); }
    });
    return out;
  }

  var api = {
    configure: configure,
    available: available,
    submissionId: submissionId,
    setSubmissionId: setSubmissionId,
    newSubmissionId: newSubmissionId,
    append: append,
    list: list,
    mergeRoomEvents: mergeRoomEvents,
    syntheticRoomIds: syntheticRoomIds,
    _cfg: cfg,
  };

  root.ABDB = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
