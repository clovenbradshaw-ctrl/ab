// test/letter.test.js — the OCR complaint assembler and its audit trail,
// driven against the real engine extracted from index.html.
//
// buildComplaintLetter is pure and deterministic: identical answers must
// produce an identical draft, its `missing` list must name only unanswered
// *required* fields, and its `sources` array must connect every line of the
// letter back to the exact raw input (typed text, voice transcript + clip
// id, or an explicit edit). The voice-meta test at the end goes through a
// real Intake conversation so the DEF events really carry that provenance
// end-to-end rather than being hand-fabricated.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEngine } = require("./_extract-engine.js");

function makeStore(engine) {
  const events = [];
  return {
    emit(op, payload) {
      const ev = { id: "e" + events.length, op, payload, at: new Date(0).toISOString(), by: "@applicant:local" };
      events.push(ev);
      return ev;
    },
    timeline() { return events.slice(); },
    fold() { return engine.fold(events); },
  };
}

function validAnswerFor(field) {
  if (field.type === "enum") return field.enum[0];
  if (field.type === "email") return "person@example.com";
  if (field.type === "number") return "5";
  if (field.type === "date" || field.type === "date_flex") return "2026-01-01";
  if (field.type === "tel") return "615-555-0148";
  // "No" keeps the default walk from ever triggering the disability
  // follow-up's skipIf — same reasoning as picking enum[0] for select
  // below rather than something that would open a conditional field.
  if (field.type === "boolean") return "No";
  if ((field.type === "select" || field.type === "multiselect") && field.enum?.length) return field.enum[0];
  // dcs_actions_failures is a COVERAGE_FRAMEWORKS key (see index.html) — a
  // generic answer with no date or name in it legitimately triggers a
  // coverage follow-up that these "walk every field" helpers don't know to
  // answer, desyncing everything after it. Answering with both up front
  // keeps the walk on the schema's static field list, same reasoning as
  // "No" above for the disability skipUnless.
  if (field.path === "dcs_actions_failures") return "In March 2024, Caseworker Jane Smith did not respond to my calls.";
  if (field.digits && !field.required) return "unknown";
  return "Test answer for " + field.label;
}

// A full answer set with a value for every field the letter can contain.
function fullAnswers(engine) {
  const answers = {};
  for (const f of engine.SCHEMA.fields) answers[f.path] = validAnswerFor(f);
  return answers;
}

// buildComplaintLetter's arrays live in the vm sandbox realm, so their
// prototype differs from host arrays — deepEqual would reject them on
// reference identity. Array.from snapshots them into the host realm.
const host = (x) => Array.from(x);

test("draft is deterministic: identical answers produce the identical letter", () => {
  const engine = loadEngine();
  const a = engine.buildComplaintLetter(fullAnswers(engine));
  const b = engine.buildComplaintLetter(fullAnswers(engine));
  assert.equal(a.letter, b.letter);
  assert.match(a.letter, /DRAFT FOR REVIEW — REPRESENTATIVE AFTYN BEHN'S OFFICE/);
});

test("draft reads as an internal review document, not a filed filing", () => {
  const engine = loadEngine();
  const { letter } = engine.buildComplaintLetter(fullAnswers(engine));
  assert.match(letter, /pending review before any filing/);
  assert.doesNotMatch(letter, /signed, filed, and transmitted/);
});

test("missing lists only unanswered REQUIRED fields", () => {
  const engine = loadEngine();
  const required = engine.LETTER_REQUIRED_FIELDS.map((f) => f.path);
  const answers = fullAnswers(engine);
  // Empty the optional document fields entirely; they must NOT count as
  // missing — they render as "(none reported)". The prior-remedy questions
  // are no longer in this group: they're required now (see
  // LETTER_REQUIRED_FIELDS), covered by the next test instead.
  for (const p of [
    "harms", "doc_court_orders", "doc_dcs_records",
    "doc_medical_records", "doc_school_records", "doc_other_evidence",
  ]) delete answers[p];
  const { missing } = engine.buildComplaintLetter(answers);
  // All required fields are still answered -> nothing may be flagged missing,
  // no matter how many optional fields were left blank.
  assert.equal(host(missing).length, 0);
  // Now actually empty one required field too: it must be the sole miss.
  delete answers.complainant_name;
  const { missing: missing2 } = engine.buildComplaintLetter(answers);
  assert.deepEqual(host(missing2).map((m) => m.path), ["complainant_name"]);
});

test("missing flags an unanswered prior-remedy question — those are required, not optional", () => {
  const engine = loadEngine();
  const answers = fullAnswers(engine);
  delete answers.prior_remedy_legal_help;
  const { missing } = engine.buildComplaintLetter(answers);
  assert.deepEqual(host(missing).map((m) => m.path), ["prior_remedy_legal_help"]);
});

test("missing is empty when every required field has a value", () => {
  const engine = loadEngine();
  const { missing } = engine.buildComplaintLetter(fullAnswers(engine));
  assert.equal(host(missing).length, 0);
});

test("placement history: dynamically-numbered rounds render as a numbered list in letter order, beyond what LETTER_PATHS knows about statically", () => {
  const engine = loadEngine();
  const answers = {
    ...fullAnswers(engine),
    placement_1_when: "2024-03-01", placement_1_type: "A relative's home (kinship placement)", placement_1_location: "Nashville", placement_1_notes: "Grandmother's house",
    placement_2_when: "2024-06-01", placement_2_type: "A foster home", placement_2_location: "", placement_2_notes: "",
    placement_3_when: "2024-11-01", placement_3_type: "A residential or treatment facility", placement_3_location: "", placement_3_notes: "Current placement",
  };
  const { letter } = engine.buildComplaintLetter(answers);
  assert.match(letter, /1\. 2024-03-01 — A relative's home \(kinship placement\) — Nashville — Grandmother's house/);
  assert.match(letter, /2\. 2024-06-01 — A foster home\n/);
  assert.match(letter, /3\. 2024-11-01 — A residential or treatment facility — Current placement/);
});

// Fabricate a folded provenance map the way fold() would: a cell per path,
// but only for a known subset — including one optional and one required path.
function provenanceCellsFor(engine, paths, overrides = {}) {
  const prov = {};
  for (const p of paths) {
    prov[p] = {
      value: overrides[p]?.value ?? "Audit value for " + p,
      at: new Date(0).toISOString(),
      by: "@applicant:local",
      eventId: "e0",
      source: overrides[p]?.source ?? "Audit value for " + p,
      inputKind: overrides[p]?.inputKind ?? "typed",
      voiceClipId: overrides[p]?.voiceClipId ?? null,
    };
  }
  return prov;
}

test("sources cover every non-empty provenance path in letter order", () => {
  const engine = loadEngine();
  // A mix that includes a required field, an optional one, and a voice clip —
  // and deliberately NOT a fourth answered-but-unsourced path.
  const covered = ["complainant_name", "prior_remedy_legal_help", "doc_school_records"];
  const prov = provenanceCellsFor(engine, covered, {
    prior_remedy_legal_help: { source: "I called Legal Aid", inputKind: "voice", voiceClipId: "clip_x9" },
  });
  const answers = {
    complainanta_name: "should not appear",
    ...Object.fromEntries(covered.map((p) => [p, prov[p].value])),
    child_age: "unsourced but answered",
  };
  const { sources } = engine.buildComplaintLetter(answers, prov);
  // sources must be exactly the covered paths, in LETTER_PATHS order, and
  // nothing unsourced (child_age) may leak in.
  assert.deepEqual(host(sources).map((s) => s.path), covered);
  for (const s of sources) assert.equal(s.value, prov[s.path].value);
  const voice = sources.find((s) => s.path === "prior_remedy_legal_help");
  assert.equal(voice.inputKind, "voice");
  assert.equal(voice.voiceClipId, "clip_x9");
  assert.equal(voice.source, "I called Legal Aid");
  assert.equal(voice.at, new Date(0).toISOString());
  assert.equal(voice.by, "@applicant:local");
  assert.equal(voice.eventId, "e0");
});

test("sources default to typed with no voice clip when provenance omits the fields", () => {
  const engine = loadEngine();
  const covered = ["complainant_name"];
  const prov = provenanceCellsFor(engine, covered);
  const { sources } = engine.buildComplaintLetter({ complainant_name: prov.complainant_name.value }, prov);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].inputKind, "typed");
  assert.equal(sources[0].source, prov.complainant_name.value);
  assert.equal(sources[0].voiceClipId, null);
});

test("empty provenance yields an empty audit trail without crashing", () => {
  const engine = loadEngine();
  const answers = fullAnswers(engine);
  const { sources, letter } = engine.buildComplaintLetter(answers, {});
  assert.equal(host(sources).length, 0);
  assert.ok(letter.length > 0);
});

test("voice-meta from a real Intake conversation reaches fold() provenance and the draft sources", async () => {
  const engine = loadEngine();
  const store = makeStore(engine);
  const model = new engine.EchoModel();
  const intake = new engine.Intake({ schema: engine.SCHEMA, store, model, lang: "en" });
  await intake.begin();
  const f0 = engine.SCHEMA.fields[0];

  // Dictated answer (first field) via a voice transcription.
  await intake.submit("Nora Alvarez", { inputKind: "voice", voiceClipId: "clip_v0j2kl" });
  // The answer is stored as it is given — the provenance below is what the
  // trace compares against, not a confirmation step that no longer exists.

  const folded = store.fold();
  const prov = engine.provenanceOf(folded, "applicant");
  const cell = prov[f0.path];
  assert.ok(cell, "provenance must carry the stored field");
  assert.equal(cell.inputKind, "voice");
  assert.equal(cell.voiceClipId, "clip_v0j2kl");
  assert.equal(cell.source, "Nora Alvarez");
  assert.equal(cell.at, new Date(0).toISOString());
  assert.equal(cell.by, "@applicant:local");

  const answers = engine.answersOf(folded, "applicant");
  const { sources } = engine.buildComplaintLetter(answers, prov);
  const hit = sources.find((s) => s.path === f0.path);
  assert.ok(hit, "the voice-answered field must appear in the draft's audit trail");
  assert.equal(hit.inputKind, "voice");
  assert.equal(hit.voiceClipId, "clip_v0j2kl");
  assert.equal(hit.source, "Nora Alvarez");
});

test("editField marks the value as an in-place edit with no source or clip", async () => {
  const engine = loadEngine();
  const store = makeStore(engine);
  const model = new engine.EchoModel();
  const intake = new engine.Intake({ schema: engine.SCHEMA, store, model, lang: "en" });
  await intake.begin();
  const f0 = engine.SCHEMA.fields[0];

  await intake.submit(validAnswerFor(f0), { inputKind: "voice", voiceClipId: "clip_abc" });
  intake.editField(f0.path, "Nora Alvarez Corrigan");

  const folded = store.fold();
  const cell = engine.provenanceOf(folded, "applicant")[f0.path];
  assert.equal(cell.inputKind, "edited");
  assert.equal(cell.source, null);
  assert.equal(cell.voiceClipId, null);
  // The draft's trace must reflect the correction, not the earlier voice take.
  const answers = engine.answersOf(folded, "applicant");
  const { sources } = engine.buildComplaintLetter(answers, engine.provenanceOf(folded, "applicant"));
  const hit = sources.find((s) => s.path === f0.path);
  assert.equal(hit.value, "Nora Alvarez Corrigan");
  assert.equal(hit.inputKind, "edited");
});
