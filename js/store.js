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
function rid() { return "e_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

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
    const ev = { id: rid(), op, payload, at: nowIso(), by: this.user };
    this._events.push(ev);
    try { localStorage.setItem(this._key, JSON.stringify(this._events)); } catch {}
    this._notify(ev);
    return ev;
  }
  async reset() { this._events = []; try { localStorage.removeItem(this._key); } catch {} this._notify(null); }
}

// ---- Live Matrix backend ---------------------------------------------------
// Dependency-free: no SDK. It rides the account session from auth.js (ported
// from NPJ) and speaks the raw client-server API. Each op is one room event of
// type EVENT_TYPE, so the log folds alongside amino data in the same room and
// the admin — invited to every user's room — can fold them all.
export class MatrixStore extends BaseStore {
  constructor(auth, roomId) { super(); this.auth = auth; this.roomId = roomId; this.user = (auth.current() || {}).user_id || null; }

  async open(roomId) {
    if (roomId) this.roomId = roomId;
    const evs = await this.auth.roomEvents(this.roomId, EVENT_TYPE);
    this._events = evs.map((e) => ({ id: e.id, op: e.content.op, payload: e.content.payload, at: new Date(e.ts).toISOString(), by: e.sender }));
    return this;
  }

  emit(op, payload) {
    // Optimistic local append; the server assigns the real event id, which we
    // fold back in on ack. The controller only reads fold(), so a transient
    // temp-id before the ack is harmless (last-write-wins on the same cell).
    const ev = { id: rid(), op, payload, at: nowIso(), by: this.user, _pending: true };
    this._events.push(ev);
    this._notify(ev);
    this.auth.sendEvent(this.roomId, EVENT_TYPE, { op, payload })
      .then((serverId) => { if (serverId) ev.id = serverId; ev._pending = false; })
      .catch(() => { /* keep the optimistic copy; a reopen re-reads the true log */ });
    return ev;
  }
}
