// mirror.test.mjs — unit tests for the resync bot's mirror logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectEvents, submissionIdFor, ownerFor, buildPayload, signature, fold,
} from "./mirror.js";

const mx = (id, op, payload, { by = "@family:hs", eid = null, decryptionFailure = false } = {}) => ({
  getType: () => "io.matrix-events.op",
  getId: () => id,
  getContent: () => ({ op, payload, ...(eid ? { eid } : {}) }),
  getTs: () => Date.parse("2026-10-07T00:00:00.000Z"),
  getSender: () => by,
  isDecryptionFailure: () => decryptionFailure,
});

test("collectEvents decodes op-events, prefers eid, skips undecryptable", () => {
  const events = collectEvents([
    mx("$mx1", "DEF", { path: "name", value: "Jane", anchor: "applicant" }, { eid: "e1" }),
    mx("$mx2", "INS", { id: "sub1", entity: "submission", attrs: { submission_id: "sub1" } }),
    mx("$mx3", "DEF", { path: "x", value: "y" }, { decryptionFailure: true }),
    { getType: () => "m.room.message" }, // wrong type
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, "e1"); // eid wins over mx id
  assert.equal(events[1].op, "INS");
});

test("submissionIdFor: uses the room's submission record, else room-derived", () => {
  const withRec = [mx("$a", "INS", { id: "u1", entity: "submission", attrs: { submission_id: "u1" } })];
  assert.equal(submissionIdFor("!room:hs", collectEvents(withRec)), "u1");
  assert.equal(submissionIdFor("!room:hs", []), "room:!room:hs");
});

test("ownerFor: the family is the owner, not the bot", () => {
  const events = collectEvents([
    mx("$1", "DEF", { path: "name", value: "Jane" }, { by: "@family:hs" }),
    mx("$2", "DEF", { path: "note", value: "admin note" }, { by: "@planetary:hs" }),
  ]);
  assert.equal(ownerFor(events, "@planetary:hs"), "@family:hs");
  assert.equal(ownerFor([], "@planetary:hs"), null);
});

test("buildPayload shapes the append body with owner_user", () => {
  const events = collectEvents([mx("$1", "DEF", { path: "name", value: "Jane" }, { by: "@family:hs" })]);
  const body = buildPayload("!room:hs", events, "@planetary:hs");
  assert.equal(body.room_id, "!room:hs");
  assert.equal(body.submission_id, "room:!room:hs");
  assert.equal(body.owner_user, "@family:hs");
  assert.equal(body.events[0].payload.value, "Jane");
});

test("signature changes only when the decrypted set grows", () => {
  const a = collectEvents([mx("$1", "DEF", { path: "a", value: "1" })]);
  const a2 = collectEvents([mx("$1", "DEF", { path: "a", value: "1" })]);
  const b = collectEvents([
    mx("$1", "DEF", { path: "a", value: "1" }),
    mx("$2", "DEF", { path: "b", value: "2" }),
  ]);
  assert.equal(signature(a), signature(a2));
  assert.notEqual(signature(a), signature(b));
});

test("fold mirrors the app's DEF/INS shape", () => {
  const events = collectEvents([
    mx("$1", "DEF", { path: "complainant_name", value: "Jane", anchor: "applicant" }),
    mx("$2", "INS", { id: "doc1", entity: "document", attrs: { name: "x.pdf" } }),
  ]);
  const f = fold(events);
  assert.equal(f.anchors.applicant.complainant_name.value, "Jane");
  assert.equal(f.records.doc1.entity, "document");
});
