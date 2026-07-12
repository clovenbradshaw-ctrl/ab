// auth.js — real Matrix accounts, ported from NPJ's matrix-auth.js.
//
// Identity is verified against a homeserver, never trusted from input. Two ways
// in, both dependency-free (raw client-server API over fetch — no SDK):
//
//   signUp()          fast, anonymous account generation. A CSPRNG localpart
//                     (guest-xxxxx) + a random password, registered on the site
//                     homeserver and signed in immediately. This is the path a
//                     new complainant takes — no email, no chosen name.
//   login(id, pw)     password login, then whoami confirms who the token is for.
//                     The admin uses this; `admin` unlocks only when whoami
//                     returns ADMIN_MXID, so nobody can grant it by typing it.
//
// The tenancy model on top (see app.js): each new user gets their OWN private
// room, the admin is auto-invited to it, and the intake events (DEF/…) are sent
// into that room. The admin, invited to every room, folds them all — that's how
// "the admin gets access to all data" is actually enforced (by Matrix ACLs, not
// by us). Config lives in CONFIG below; override at runtime with configure().

const DEFAULTS = {
  // The site's homeserver and the admin account. Point these at your Synapse.
  homeserver: "matrix.org",
  adminMxid:  "@resolve-admin:matrix.org",
  appRoomType: "com.resolve.intake.room",   // state event tagging a room as one of ours
  deviceName:  "Resolve intake (web)",
  lsKey:       "resolve_session_v1",
};
const CONFIG = { ...DEFAULTS };
export function configure(patch = {}) { Object.assign(CONFIG, patch); }
export function adminMxid() { return CONFIG.adminMxid; }

// ---- pure helpers (exported for tests) ------------------------------------
export function parseMxid(input) {
  const m = String(input || "").trim().match(/^@?([a-z0-9._=\-/+]+):([a-z0-9.\-]+\.[a-z]{2,})$/i);
  if (!m) return null;
  return { localpart: m[1], domain: m[2], mxid: "@" + m[1] + ":" + m[2] };
}

// A "hashid": short, CSPRNG, from an alphabet with no look-alikes (0/O, 1/l/i)
// and no vowels — so a code never spells a word, reads cleanly aloud, and is
// hard to mistype. 27 symbols; five of them is ~14M combinations.
const HASHID_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";
export function hashid(len, rng = defaultRng) {
  const n = Math.max(1, len || 6), A = HASHID_ALPHABET, ceil = 256 - (256 % A.length);
  const bytes = new Uint8Array(n * 2); rng(bytes);
  let out = "", bi = 0;
  for (let i = 0; i < n; i++) {
    let b = bytes[bi++];
    while (b >= ceil) { if (bi >= bytes.length) { rng(bytes); bi = 0; } b = bytes[bi++]; }
    out += A[b % A.length];
  }
  return out;
}
// A human-friendly localpart: optional name-slug + a hashid suffix for uniqueness.
export function randomLocalpart(seed, rng = defaultRng) {
  const slug = String(seed || "").toLowerCase()
    .replace(/[^a-z0-9._=\-/]+/g, "-").replace(/[-._/]{2,}/g, "-")
    .replace(/^[-._/]+|[-._/]+$/g, "").slice(0, 16).replace(/[-._/]+$/g, "");
  return (slug || "guest") + "-" + hashid(5, rng);
}
export function randomPassword(rng = defaultRng) {
  const a = new Uint8Array(18); rng(a);
  let s = ""; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "A").replace(/\//g, "B").replace(/=+$/, "");
}
function defaultRng(buf) { (globalThis.crypto || require("crypto").webcrypto).getRandomValues(buf); return buf; }

// A short, readable case reference (CS-4021-8837 shape) from a room/user id.
export function caseRef(seed) {
  const s = String(seed || "");
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const a = 1000 + (h % 9000), b = 1000 + ((h >>> 8) % 9000);
  return "CS-" + a + "-" + b;
}

// ---- registration flow classification ------------------------------------
function pickRegisterFlow(flows, hasToken) {
  const can = (s) => s === "m.login.dummy" || (s === "m.login.registration_token" && hasToken);
  const usable = (flows || []).map(f => (f && f.stages) || []).filter(st => st.length && st.every(can));
  usable.sort((a, b) => a.length - b.length);
  return usable[0] || null;
}
function registerFlowMessage(flows) {
  const all = new Set(); (flows || []).forEach(f => ((f && f.stages) || []).forEach(s => all.add(s)));
  if (all.has("m.login.registration_token")) return "This homeserver needs a registration token. Paste one (from your Synapse admin) and try again.";
  if (all.has("m.login.recaptcha")) return "This homeserver requires a CAPTCHA to register, which can't be completed from here.";
  if (all.has("m.login.email.identity") || all.has("m.login.msisdn")) return "This homeserver requires email/phone verification to register.";
  return "This homeserver doesn't allow creating accounts from the browser.";
}

// ---- session (module singleton) -------------------------------------------
let session = null;   // { user_id, access_token, base_url, device_id, verified, admin, password }
const listeners = new Set();
function emit() { const s = current(); listeners.forEach(fn => { try { fn(s); } catch (e) {} }); }
function persist() { try { localStorage.setItem(CONFIG.lsKey, JSON.stringify(session)); } catch (e) {} }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function current() {
  if (!session) return null;
  return { user_id: session.user_id, base_url: session.base_url, verified: !!session.verified, admin: !!session.admin, device_id: session.device_id };
}
export function token() { return session ? session.access_token : null; }
export function isSignedIn() { return !!session; }
export function isAdmin() { return !!(session && session.admin); }
export function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(CONFIG.lsKey) || "null");
    if (s && s.access_token && s.user_id) { session = s; session.admin = s.user_id === CONFIG.adminMxid; }
  } catch (e) { session = null; }
  if (session) emit();
  return current();
}
export async function logout() {
  const s = session; session = null; persist(); emit();
  if (s && s.access_token) { try { await api(s.base_url, "/_matrix/client/v3/logout", { method: "POST", token: s.access_token }); } catch (e) {} }
}
export function credentials() {
  if (!session) return null;
  const id = parseMxid(session.user_id);
  return { user_id: session.user_id, password: session.password || null, base_url: session.base_url, homeserver: id ? id.domain : null };
}

// ---- transport ------------------------------------------------------------
async function discover(domain) {
  try {
    const r = await fetch(`https://${domain}/.well-known/matrix/client`);
    if (r.ok) { const j = await r.json(); const base = j && j["m.homeserver"] && j["m.homeserver"].base_url; if (base) return String(base).replace(/\/+$/, ""); }
  } catch (e) {}
  return `https://${domain}`;
}
async function api(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;
  let res;
  try { res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (e) { const err = new Error("network/cors error reaching the homeserver"); err.code = "network"; throw err; }
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error((data && (data.error || data.errcode)) || ("request failed (" + res.status + ")")); err.status = res.status; err.errcode = data && data.errcode; err.data = data; throw err; }
  return data || {};
}

// ---- login ----------------------------------------------------------------
export async function login(input, password) {
  const id = parseMxid(input);
  if (!id) { const e = new Error("That isn't a valid Matrix ID (expected @name:server)"); e.code = "badmxid"; throw e; }
  const base = await discover(id.domain);
  const out = await api(base, "/_matrix/client/v3/login", {
    method: "POST",
    body: { type: "m.login.password", identifier: { type: "m.id.user", user: id.localpart }, password: String(password), initial_device_display_name: CONFIG.deviceName },
  });
  const respBase = out.well_known && out.well_known["m.homeserver"] && out.well_known["m.homeserver"].base_url;
  const finalBase = respBase ? String(respBase).replace(/\/+$/, "") : base;
  const who = await api(finalBase, "/_matrix/client/v3/account/whoami", { token: out.access_token });
  const user_id = who.user_id || out.user_id;
  session = { user_id, access_token: out.access_token, base_url: finalBase, device_id: out.device_id || who.device_id || null, verified: true, admin: user_id === CONFIG.adminMxid, password: String(password) };
  persist(); emit();
  return current();
}

// ---- registration ---------------------------------------------------------
async function register({ domain, username, password, registrationToken, deviceName, seed, inhibitLogin = true } = {}) {
  const raw = String(domain || "").trim();
  const dom = (raw.indexOf(":") >= 0 ? raw.split(":").pop() : raw).replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!dom) { const e = new Error("Need a homeserver to register on"); e.code = "badmxid"; throw e; }
  const base = await discover(dom);
  const explicit = String(username || "").trim();
  const pw = password || randomPassword();

  async function attempt(localpart) {
    const base_body = { username: localpart, password: pw, inhibit_login: inhibitLogin, initial_device_display_name: deviceName || CONFIG.deviceName };
    let uiaSession = null, flows = null, serverDone = [];
    for (let i = 0; i < 8; i++) {
      let auth;
      if (uiaSession) {
        const flow = pickRegisterFlow(flows, !!registrationToken);
        if (!flow) { const e = new Error(registerFlowMessage(flows)); e.code = "uia"; e.flows = flows; throw e; }
        const next = flow.find(s => serverDone.indexOf(s) < 0) || flow[flow.length - 1];
        auth = next === "m.login.registration_token"
          ? { type: "m.login.registration_token", token: registrationToken, session: uiaSession }
          : { type: "m.login.dummy", session: uiaSession };
      }
      let res, data = {};
      try { res = await fetch(base + "/_matrix/client/v3/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(auth ? { ...base_body, auth } : base_body) }); }
      catch (e) { const err = new Error("network/cors error reaching the homeserver"); err.code = "network"; throw err; }
      try { data = await res.json(); } catch (e) { data = {}; }
      if (res.ok) return { mxid: "@" + localpart + ":" + dom, localpart, domain: dom, password: pw, base_url: base, user_id: data.user_id || ("@" + localpart + ":" + dom), access_token: data.access_token || null, device_id: data.device_id || null };
      if (res.status === 401 && data && Array.isArray(data.flows)) {
        flows = data.flows; uiaSession = data.session; serverDone = data.completed || [];
        if (!pickRegisterFlow(flows, !!registrationToken)) { const e = new Error(registerFlowMessage(flows)); e.code = "uia"; e.flows = flows; throw e; }
        continue;
      }
      const err = new Error((data && (data.error || data.errcode)) || ("registration failed (" + res.status + ")"));
      err.status = res.status; err.errcode = data && data.errcode; err.data = data;
      if (err.errcode === "M_FORBIDDEN") err.message = "This homeserver has registration closed.";
      if (err.errcode === "M_USER_IN_USE") err.message = "That username is taken — try generating again.";
      throw err;
    }
    const e = new Error("Registration didn't complete on this homeserver."); e.code = "uia"; throw e;
  }

  let localpart = explicit || randomLocalpart(seed);
  let lastErr;
  for (let tries = 0; tries < (explicit ? 1 : 6); tries++) {
    try { return await attempt(localpart); }
    catch (e) { lastErr = e; if (!explicit && e && e.errcode === "M_USER_IN_USE") { localpart = randomLocalpart(seed); continue; } throw e; }
  }
  throw lastErr;
}

// Fast, anonymous account generation → signed in immediately.
export async function signUp({ domain, password, registrationToken } = {}) {
  const dom = String(domain || CONFIG.homeserver || "").trim();
  const pw = password || randomPassword();
  const acct = await register({ domain: dom, password: pw, registrationToken, inhibitLogin: false });
  if (acct.access_token) {
    const who = await api(acct.base_url, "/_matrix/client/v3/account/whoami", { token: acct.access_token });
    const user_id = who.user_id || acct.user_id;
    session = { user_id, access_token: acct.access_token, base_url: acct.base_url, device_id: acct.device_id || who.device_id || null, verified: true, admin: user_id === CONFIG.adminMxid, password: pw };
    persist(); emit();
  } else {
    await login(acct.mxid, pw);
    if (session) { session.password = pw; persist(); }
  }
  return current();
}

export async function setDisplayName(name) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  await api(session.base_url, "/_matrix/client/v3/profile/" + encodeURIComponent(session.user_id) + "/displayname", { method: "PUT", token: session.access_token, body: { displayname: String(name || "") } });
}
export async function changePassword(oldPassword, newPassword) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const id = parseMxid(session.user_id);
  const auth = { type: "m.login.password", identifier: { type: "m.id.user", user: id ? id.localpart : session.user_id }, password: String(oldPassword) };
  const body = { new_password: String(newPassword), logout_devices: false, auth };
  try { await api(session.base_url, "/_matrix/client/v3/account/password", { method: "POST", token: session.access_token, body }); }
  catch (e) {
    if (e.status === 401 && e.data && e.data.session) { await api(session.base_url, "/_matrix/client/v3/account/password", { method: "POST", token: session.access_token, body: { ...body, auth: { ...auth, session: e.data.session } } }); }
    else throw e;
  }
}

// ---- rooms ----------------------------------------------------------------
function appRoomState() { return { type: CONFIG.appRoomType, state_key: "", content: { app: "resolve", v: 1 } }; }

// Create a private room owned by the signed-in user. The admin is auto-invited
// (and, being in the room, can read everything sent to it) — this is the whole
// "admin gets access to all data" mechanism, enforced by the homeserver.
export async function createRoom(name, { inviteAdmin = true } = {}) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const invite = (inviteAdmin && CONFIG.adminMxid && CONFIG.adminMxid !== session.user_id) ? [CONFIG.adminMxid] : [];
  const body = {
    name: name || "Intake", topic: "Resolve intake — one case",
    visibility: "private", preset: "private_chat", invite,
    initial_state: [appRoomState()],
  };
  const out = await api(session.base_url, "/_matrix/client/v3/createRoom", { method: "POST", token: session.access_token, body });
  return { roomId: out.room_id };
}
export async function invite(roomId, mxid) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const id = parseMxid(mxid); if (!id) { const e = new Error("Not a valid Matrix ID"); e.code = "badmxid"; throw e; }
  await api(session.base_url, "/_matrix/client/v3/rooms/" + encodeURIComponent(roomId) + "/invite", { method: "POST", token: session.access_token, body: { user_id: id.mxid } });
}
export async function joinRoom(roomIdOrAlias) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const v = String(roomIdOrAlias || "").trim(); if (!v) return null;
  for (let attempt = 0; ; attempt++) {
    try { const out = await api(session.base_url, "/_matrix/client/v3/join/" + encodeURIComponent(v), { method: "POST", token: session.access_token, body: {} }); return out.room_id || v; }
    catch (e) {
      const limited = e && (e.errcode === "M_LIMIT_EXCEEDED" || e.status === 429);
      if (!limited || attempt >= 4) throw e;
      const wait = Math.min((e.data && e.data.retry_after_ms) || (500 * Math.pow(2, attempt)), 5000);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ---- raw event I/O (used by the Matrix store backend and the admin view) ---
export async function sendEvent(roomId, type, content) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const txn = "m" + Date.now() + Math.random().toString(36).slice(2, 8);
  const out = await api(session.base_url, "/_matrix/client/v3/rooms/" + encodeURIComponent(roomId) + "/send/" + encodeURIComponent(type) + "/" + encodeURIComponent(txn), { method: "PUT", token: session.access_token, body: content || {} });
  return out.event_id;
}
// Read a room's message timeline (oldest→newest), filtered to one event type.
export async function roomEvents(roomId, type, { limit = 200 } = {}) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const filter = encodeURIComponent(JSON.stringify({ types: [type] }));
  const out = await api(session.base_url, "/_matrix/client/v3/rooms/" + encodeURIComponent(roomId) + "/messages?dir=b&limit=" + limit + "&filter=" + filter, { token: session.access_token });
  const chunk = (out.chunk || []).filter(e => e.type === type).reverse(); // /messages dir=b is newest→oldest
  return chunk.map(e => ({ id: e.event_id, type: e.type, content: e.content, sender: e.sender, ts: e.origin_server_ts }));
}
// Rooms tagged as ours that the session is in (joined or invited). The admin
// uses this to enumerate every user's case; a user sees only their own.
export async function listAppRooms({ acceptInvites = false } = {}) {
  if (!session) { const e = new Error("Sign in first"); e.code = "noauth"; throw e; }
  const sync = await api(session.base_url, "/_matrix/client/v3/sync?timeout=0", { token: session.access_token });
  const rooms = [];
  const isOurs = (stateEvents) => (stateEvents || []).some(ev => ev.type === CONFIG.appRoomType);
  const join = (sync.rooms && sync.rooms.join) || {};
  for (const [roomId, r] of Object.entries(join)) {
    if (isOurs(r.state && r.state.events)) rooms.push({ roomId, membership: "join" });
  }
  const invited = (sync.rooms && sync.rooms.invite) || {};
  for (const [roomId, r] of Object.entries(invited)) {
    const st = r.invite_state && r.invite_state.events;
    if (isOurs(st)) {
      if (acceptInvites) { try { await joinRoom(roomId); rooms.push({ roomId, membership: "join" }); continue; } catch (e) {} }
      rooms.push({ roomId, membership: "invite" });
    }
  }
  return rooms;
}

export const Auth = {
  configure, adminMxid, current, token, isSignedIn, isAdmin, subscribe, restore, logout, credentials,
  login, signUp, setDisplayName, changePassword,
  createRoom, invite, joinRoom, sendEvent, roomEvents, listAppRooms,
};
export default Auth;
