// mirror.js — the DB-facing half of the resync bot, kept free of matrix-js-sdk
// so it can be unit-tested without a live homeserver. It turns decrypted
// Matrix events into the append payloads the database server understands.

export const EVENT_TYPE = "io.matrix-events.op";
export const OPS = new Set(["DEF", "INS", "CON"]);

// The same 3-operator fold the app uses, so the bot and the app agree on what
// "the current state of a room" is.
export function fold(events) {
  const anchors = {};
  const records = {};
  for (const e of events) {
    if (e.op === "DEF") {
      const a = e.payload.anchor || "_root";
      (anchors[a] ||= {})[e.payload.path] = { value: e.payload.value, at: e.at, by: e.by, eventId: e.id };
    } else if (e.op === "INS") {
      records[e.payload.id] = { entity: e.payload.entity, attrs: e.payload.attrs || {}, at: e.at };
    } else if (e.op === "CON") {
      // edges are not needed for the mirror; ignored.
    }
  }
  return { anchors, records };
}

// Decode a decrypted MatrixEvent into the app's event shape. `eid` is the
// app-local id the sender stamped on the event, so the DB and Matrix copies of
// the same event share an id and dedup.
export function decodeMatrixEvent(mxEvent) {
  const content = mxEvent.getContent?.() || {};
  return {
    id: content.eid || mxEvent.getId?.(),
    op: content.op,
    payload: content.payload,
    at: new Date(mxEvent.getTs?.()).toISOString(),
    by: mxEvent.getSender?.(),
  };
}

export function isOpEvent(mxEvent) {
  return mxEvent.getType?.() === EVENT_TYPE && !mxEvent.isDecryptionFailure?.();
}

export function collectEvents(mxEvents) {
  const out = [];
  for (const e of mxEvents || []) {
    if (!isOpEvent(e)) continue;
    const ev = decodeMatrixEvent(e);
    if (ev.id && ev.op && OPS.has(ev.op) && ev.payload) out.push(ev);
  }
  return out;
}

// The stable identity shared by family, office-device, and bot: a room's own
// `submission` record if it has one, else derived from the room id.
export function submissionIdFor(roomId, events) {
  const f = fold(events);
  const rec = Object.values(f.records).find((r) => r.entity === "submission");
  return rec?.attrs?.submission_id || ("room:" + roomId);
}

// The family is the owner of its own case — whoever first wrote the room —
// regardless of which device (the bot) is mirroring it.
export function ownerFor(events, me) {
  return events.find((e) => e.by && e.by !== me)?.by || null;
}

export function buildPayload(roomId, events, me) {
  const body = {
    submission_id: submissionIdFor(roomId, events),
    room_id: roomId,
    events: events.map(({ id, op, payload, at, by }) => ({ id, op, payload, at, by })),
  };
  const owner = ownerFor(events, me);
  if (owner) body.owner_user = owner;
  return body;
}

// Cheap change-detector so we don't re-POST a room whose decrypted set hasn't
// changed. Length + last id catches new appends and newly-decrypted events.
export function signature(events) {
  return events.length + ":" + (events[events.length - 1]?.id || "");
}
