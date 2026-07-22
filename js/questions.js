// questions.js — the shared question-configuration room.
//
// The questions the assistant asks, their order, and the material used to help
// the user (system prompt + memory) are not hard-coded — they live as events in
// a Matrix room that EVERY user can read. The question-authoring surface
// (questions.html) writes to this room; each user's app folds it to learn the
// current document.
//
// (Distinct from config.js, which just holds the ADMIN_USER_ID constant used by
// the document-review dashboard. This module is the shared *question set*.)
//
// This is the same amino move the rest of the app makes: a room is a table,
// events are rows, `foldConfig(timeline)` is the query. State is never stored —
// the live schema is always recomputed from the log, so an edit by the admin is
// visible to every user the next time they fold, with full provenance.
//
// Two rooms, two purposes:
//   CONFIG_ROOM              shared — questions/order/help. All users read it.
//   answerRoomFor(user)      private — one per user. Their answers, uploaded
//                            documents, and message content live here, never
//                            mixed with anyone else's timeline.
//
// Config event shapes (reusing store.js's OP algebra):
//   INS entity="field"      { id:<path>, attrs:{ label,type,required,prompt,help,enum } }
//                           attrs:{ deleted:true } tombstones a field.
//   INS entity="knowledge"  { id, attrs:{ topic,text,tags,scope } }  (+ deleted tombstone)
//   DEF anchor="qconfig"    path "field_order" -> [id,...]   (ordering, last write wins)
//                           path "systemPrompt"/"title"/"blurb"/"id"/"seeded"
//
// Ordering is a single DEF holding the id list, so reordering rewrites one event
// rather than touching every field. Fold applies it last-write-wins.

import { OP } from "./store.js";
import { SCHEMA } from "./schema.js";
import { MINIMAL_SYSTEM } from "./context.js";
import { DEMO_KNOWLEDGE } from "./knowledge.js";

export const CONFIG_ANCHOR = "qconfig";
export const ENTITY = Object.freeze({ FIELD: "field", KNOWLEDGE: "knowledge" });

// The shared room every user reads for the questions. In a live deployment this
// is a real Matrix room id whose membership is "all intake users, read".
export const CONFIG_ROOM = "!intake-config:local";

// Each user gets their own answers room. Derived here for the demo; in a live
// deployment it is a real per-user room id (created/invited out of band) so one
// person's message content is never visible in another's timeline. This is also
// the room the document-review dashboard (admin.js) reads for uploaded files.
export function answerRoomFor(userId = "@demo:local") {
  const safe = String(userId).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "user";
  return "!intake-answers-" + safe + ":local";
}

// foldConfig(timeline) -> { meta, schema:{ id,title,blurb,fields:[...] }, systemPrompt, knowledge:[...] }
// The ONLY place the live document is computed from the config log.
export function foldConfig(events) {
  const meta = {};
  const fields = new Map();
  const know = new Map();
  const fieldSeen = [];
  const knowSeen = [];
  let systemPrompt = null;
  let order = null;

  for (const e of events) {
    if (e.op === OP.DEF && e.payload.anchor === CONFIG_ANCHOR) {
      const { path, value } = e.payload;
      if (path === "systemPrompt") systemPrompt = value;
      else if (path === "field_order") order = Array.isArray(value) ? value : null;
      else meta[path] = value;
    } else if (e.op === OP.INS && e.payload.entity === ENTITY.FIELD) {
      const { id, attrs = {} } = e.payload;
      if (attrs.deleted) { fields.delete(id); continue; }
      if (!fields.has(id)) fieldSeen.push(id);
      fields.set(id, { ...(fields.get(id) || {}), ...attrs, path: id });
    } else if (e.op === OP.INS && e.payload.entity === ENTITY.KNOWLEDGE) {
      const { id, attrs = {} } = e.payload;
      if (attrs.deleted) { know.delete(id); continue; }
      if (!know.has(id)) knowSeen.push(id);
      know.set(id, { ...(know.get(id) || {}), ...attrs, id });
    }
  }

  // Resolve field order: the explicit list first (skipping tombstoned/unknown
  // ids), then any fields not named in the list, in first-seen order.
  const ordered = [];
  const used = new Set();
  if (order) for (const id of order) if (fields.has(id) && !used.has(id)) { ordered.push(fields.get(id)); used.add(id); }
  for (const id of fieldSeen) if (fields.has(id) && !used.has(id)) { ordered.push(fields.get(id)); used.add(id); }

  const knowledge = knowSeen.filter((id) => know.has(id)).map((id) => know.get(id));

  return {
    meta,
    schema: { id: meta.id || "custom", title: meta.title || "Intake", blurb: meta.blurb || "", fields: ordered },
    systemPrompt,
    knowledge,
  };
}

// ---- emit helpers: every admin action is one event on the config room -------

export function putField(store, field) {
  const { path, ...attrs } = field;
  // Drop empty enum so a non-enum field doesn't carry a stray array.
  if (!attrs.enum || !attrs.enum.length) delete attrs.enum;
  return store.emit(OP.INS, { entity: ENTITY.FIELD, id: path, attrs });
}
export function deleteField(store, path) {
  return store.emit(OP.INS, { entity: ENTITY.FIELD, id: path, attrs: { deleted: true } });
}
export function setFieldOrder(store, ids) {
  return store.emit(OP.DEF, { anchor: CONFIG_ANCHOR, path: "field_order", value: ids });
}
export function setSystemPrompt(store, text) {
  return store.emit(OP.DEF, { anchor: CONFIG_ANCHOR, path: "systemPrompt", value: text });
}
export function setMeta(store, key, value) {
  return store.emit(OP.DEF, { anchor: CONFIG_ANCHOR, path: key, value });
}
export function putKnowledge(store, item) {
  const { id, ...attrs } = item;
  return store.emit(OP.INS, { entity: ENTITY.KNOWLEDGE, id, attrs });
}
export function deleteKnowledge(store, id) {
  return store.emit(OP.INS, { entity: ENTITY.KNOWLEDGE, id, attrs: { deleted: true } });
}

// ---- defaults + seeding ----------------------------------------------------
// The starting document is the example schema shipped in the repo, so a fresh
// config room opens onto a working intake with zero setup — same ethos as the
// demo store. Everything below is editable from the admin surface afterward.
export const DEFAULT_CONFIG = {
  meta: { id: SCHEMA.id, title: SCHEMA.title, blurb: SCHEMA.blurb },
  fields: SCHEMA.fields,
  systemPrompt: MINIMAL_SYSTEM,
  knowledge: DEMO_KNOWLEDGE.toJSON(),
};

export function seedConfig(store, cfg = DEFAULT_CONFIG) {
  setMeta(store, "id", cfg.meta.id);
  setMeta(store, "title", cfg.meta.title);
  setMeta(store, "blurb", cfg.meta.blurb);
  setSystemPrompt(store, cfg.systemPrompt);
  for (const f of cfg.fields) putField(store, f);
  setFieldOrder(store, cfg.fields.map((f) => f.path));
  for (const k of cfg.knowledge) putKnowledge(store, k);
  setMeta(store, "seeded", true);
}

// Idempotent: seed once, guarded by a `seeded` marker so opening the shared room
// from several places never double-writes the starting document.
export function ensureSeeded(store, cfg = DEFAULT_CONFIG) {
  let folded = foldConfig(store.timeline());
  if (!folded.meta.seeded) { seedConfig(store, cfg); folded = foldConfig(store.timeline()); }
  return folded;
}
