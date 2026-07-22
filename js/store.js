// store.js — the append-only event store.
//
// Mirrors amino / eoreader4.2: a room is a table, events are rows, and
// `fold(events)` is the query. State is never stored — it is always
// recomputed from the timeline. Two backends behind one interface:
//
//   DemoStore   — offline, persists to localStorage (like amino's "Explore demo data")
//   MatrixStore — live, wraps matrix-js-sdk; each op is a room event
//
// Both expose the same surface the controller depends on:
//   await store.open(roomId)
//   store.emit(op, payload)            // OP.DEF | OP.INS | OP.CON
//   store.timeline()                   // ordered array of events
//   store.fold()                       // events -> projected answer state
//   store.subscribe(fn)                // called on every append
//
// The operator algebra is amino's:
//   DEF  { anchor, path, value }       a field's value was set
//   INS  { entity, id, attrs }         a record was inserted
//   CON  { from, to, kind }            a relationship was asserted

import { ADMIN_USER_ID } from "./config.js";

export const OP = Object.freeze({ DEF: "DEF", INS: "INS", CON: "CON" });

// Namespace the events so a live homeserver folds them alongside amino's
// own data. Amino writes under `io.matrix-events`; we tag our event type
// the same way so the two can share a room if you want them to.
export const EVENT_TYPE = "io.matrix-events.op";

// fold(timeline) -> { anchor: { path: value, ... }, records: {...}, edges: [...] }
// Last write wins per (anchor, path). This is the only place "current state"
// is ever computed.
export function fold(events) {
  const anchors = {};
  const records = {};
  const edges = [];
  for (const e of events) {
    if (e.op === OP.DEF) {
      const a = e.payload.anchor || "_root";
      (anchors[a] ||= {})[e.payload.path] = {
        value: e.payload.value,
        at: e.at,
        by: e.by,
        eventId: e.id,
      };
    } else if (e.op === OP.INS) {
      records[e.payload.id] = { entity: e.payload.entity, attrs: e.payload.attrs || {}, at: e.at };
    } else if (e.op === OP.CON) {
      edges.push({ from: e.payload.from, to: e.payload.to, kind: e.payload.kind, at: e.at });
    }
  }
  return { anchors, records, edges };
}

// Convenience: flat { path: value } view of one anchor's fields.
export function answersOf(folded, anchor = "_root") {
  const out = {};
  const a = folded.anchors[anchor] || {};
  for (const [path, cell] of Object.entries(a)) out[path] = cell.value;
  return out;
}

function nowIso() { return new Date().toISOString(); }
export function newId(prefix = "e") { return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

export function decodeMxEvent(mxEvent) {
  const c = mxEvent.getContent();
  return { id: mxEvent.getId(), op: c.op, payload: c.payload, at: new Date(mxEvent.getTs()).toISOString(), by: mxEvent.getSender() };
}

class BaseStore {
  constructor() { this._subs = new Set(); this._events = []; }
  timeline() { return this._events.slice(); }
  fold() { return fold(this._events); }
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _notify(ev) { for (const fn of this._subs) fn(ev, this._events); }
}

// ---- Offline demo backend --------------------------------------------------
export class DemoStore extends BaseStore {
  constructor(user = "@demo:local") { super(); this.user = user; }
  async open(roomId) {
    this.roomId = roomId;
    this._key = "intake:" + roomId;
    try { this._events = JSON.parse(localStorage.getItem(this._key) || "[]"); }
    catch { this._events = []; }
    return this;
  }
  emit(op, payload) {
    const ev = { id: newId("e"), op, payload, at: nowIso(), by: this.user };
    this._events.push(ev);
    try { localStorage.setItem(this._key, JSON.stringify(this._events)); } catch {}
    this._notify(ev);
    return ev;
  }
  async reset() { this._events = []; try { localStorage.removeItem(this._key); } catch {} this._notify(null); }

  // ---- room enumeration, for the admin dashboard --------------------------
  // In demo mode "the server" is just this device, so every room ever opened
  // here lives in localStorage under the same "intake:<roomId>" convention
  // `open()` uses. This is how the admin view finds every applicant's
  // submissions without a real multi-user backend to query.
  static listRoomIds() {
    const ids = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("intake:") && !k.startsWith("intake:ctx:")) ids.push(k.slice("intake:".length));
    }
    return ids;
  }
  static loadEvents(roomId) {
    try { return JSON.parse(localStorage.getItem("intake:" + roomId) || "[]"); } catch { return []; }
  }
  static appendEvent(roomId, op, payload, by) {
    const events = DemoStore.loadEvents(roomId);
    const ev = { id: newId("e"), op, payload, at: nowIso(), by };
    events.push(ev);
    try { localStorage.setItem("intake:" + roomId, JSON.stringify(events)); } catch {}
    return ev;
  }
}

// ---- Live Matrix backend ---------------------------------------------------
// Wraps matrix-js-sdk. Sign-in is a Matrix login (no app-managed auth, no
// credential store) exactly as in amino. Requires window.matrixcs (the SDK)
// to be loaded — see index.html for the CDN tag.
export class MatrixStore extends BaseStore {
  constructor(client) { super(); this.client = client; this.user = client.getUserId(); }

  static async login({ homeserver, userId, password }) {
    const sdk = window.matrixcs;
    if (!sdk) throw new Error("matrix-js-sdk not loaded");
    const tmp = sdk.createClient({ baseUrl: homeserver });
    const res = await tmp.loginWithPassword(userId, password);
    const client = sdk.createClient({
      baseUrl: homeserver,
      accessToken: res.access_token,
      userId: res.user_id,
      deviceId: res.device_id,
    });
    await client.startClient({ initialSyncLimit: 100 });
    await new Promise((resolve) => {
      client.once("sync", (state) => state === "PREPARED" && resolve());
    });
    return new MatrixStore(client);
  }

  async open(roomId) {
    this.roomId = roomId;
    const room = this.client.getRoom(roomId);
    if (room) {
      this._events = room.getLiveTimeline().getEvents()
        .filter((e) => e.getType() === EVENT_TYPE)
        .map((e) => this._decode(e));
      this._ensureAdminInvited(room);
    }
    this.client.on("Room.timeline", (event, room) => {
      if (room.roomId !== this.roomId) return;
      if (event.getType() !== EVENT_TYPE) return;
      const ev = this._decode(event);
      this._events.push(ev);
      this._notify(ev);
    });
    return this;
  }

  // Give the admin visibility into this room, the same way a caseworker gets
  // added to a case file — without this, "the admin can see everything" is
  // just a claim, since Matrix room membership is what actually gates who
  // can read the document keys folded into these events. Best-effort: silently
  // no-ops if we lack invite permission or the admin is already a member.
  // This is a convenience, not the security boundary — room membership is.
  async _ensureAdminInvited(room) {
    if (this.user === ADMIN_USER_ID) return;
    if (room.getMember(ADMIN_USER_ID)) return;
    try { await this.client.invite(this.roomId, ADMIN_USER_ID); } catch {}
  }

  _decode(mxEvent) { return decodeMxEvent(mxEvent); }

  emit(op, payload) {
    // Optimistic local append; the echo back from Room.timeline will carry
    // the server event id. The controller only reads fold(), so a transient
    // duplicate before the echo is harmless (last-write-wins on the same cell).
    const ev = { id: newId("e"), op, payload, at: nowIso(), by: this.user, _pending: true };
    this._events.push(ev);
    this._notify(ev);
    this.client.sendEvent(this.roomId, EVENT_TYPE, { op, payload });
    return ev;
  }

  // ---- room enumeration, for the admin dashboard --------------------------
  // The admin's own joined-rooms list already reflects real Matrix room
  // membership (built up via _ensureAdminInvited above), so this is exactly
  // "every room the admin actually has access to" — no separate index needed.
  static joinedRoomIds(client) { return client.getRooms().map((r) => r.roomId); }
  static foldRoomEvents(client, roomId) {
    const room = client.getRoom(roomId);
    if (!room) return [];
    return room.getLiveTimeline().getEvents().filter((e) => e.getType() === EVENT_TYPE).map(decodeMxEvent);
  }
}
