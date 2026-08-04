// test/persona.e2e.test.js — regression coverage for bugs found by running
// ~30 simulated personas (typos, out-of-order info, enum answers typed as
// free text, anger/confusion, distress true/false-positives, a crashed
// model backend, and Spanish mirrors of all of it) through the REAL Intake
// engine. Same extraction/driver pattern as intake.e2e.test.js — no
// hand-copied logic.
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

async function converse(engine, lang, lines, { model } = {}) {
  const { Intake, SCHEMA } = engine;
  const store = makeStore(engine);
  const m = model || new engine.EchoModel();
  const intake = new Intake({ schema: SCHEMA, store, model: m, lang });
  await intake.begin();
  const turns = [];
  for (const line of lines) {
    await intake.submit(line);
    const last = intake.history[intake.history.length - 1];
    turns.push({ said: line, reply: last.text, support: !!last.support });
  }
  return { intake, turns };
}

function validAnswerFor(field) {
  if (field.type === "enum") return field.enum[0];
  if (field.type === "email") return "person@example.com";
  if (field.type === "number") return "5";
  if (field.type === "date") return "2026-01-01";
  return "Test answer for " + field.label;
}

test("name field: all-lowercase input is title-cased per word, not just the sentence start", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", ["frank smith", "yes"]);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Frank Smith");
});

test("name field: a word with an interior capital (McDonald-style) is left untouched, never re-cased", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", ["Frank McDonald", "yes"]);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Frank McDonald");
});

test("name field: a whole volunteered sentence (not a short name) is NOT blanket title-cased into a book title", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", [
    "My name is Frank Smith, I'm the father, my number is 615-555-0134",
    "yes",
  ]);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  const stored = intake.answers()[nameField.path];
  // Must stay a normal sentence — "My Name Is Frank Smith, I'm The Father..."
  // would be worse than leaving it alone.
  assert.equal(stored, "My name is Frank Smith, I'm the father, my number is 615-555-0134");
});

test("enum field: a free-text answer that doesn't match any option gets the specific 'pick one of' message, not a generic nudge, in EchoModel/Demo mode", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "en", ["Frank Smith", "yes", "father"]);
  const relField = engine.SCHEMA.fields.find((f) => f.path === "complainant_relationship");
  const enumMsg = engine.Steer.VALIDATION_MESSAGES.en.enumMsg(relField.enum);
  assert.equal(turns[2].reply, enumMsg);
});

test("enum field: repeated free-text misses keep surfacing the specific options instead of getting stuck on an unhelpful generic loop", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "en", ["Frank Smith", "yes", "father", "im the father", "just the dad"]);
  const relField = engine.SCHEMA.fields.find((f) => f.path === "complainant_relationship");
  const enumMsg = engine.Steer.VALIDATION_MESSAGES.en.enumMsg(relField.enum);
  for (const t of turns.slice(2)) assert.equal(t.reply, enumMsg);
});

test("enum field: exact and case-insensitive matches still confirm and store normally", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", ["Frank Smith", "yes", "PARENT", "yes"]);
  const relField = engine.SCHEMA.fields.find((f) => f.path === "complainant_relationship");
  assert.equal(intake.answers()[relField.path], "PARENT");
});

test("email field: an invalid free-text email gets the specific email validation message in Demo mode", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "complainant_email");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  lines.push("bob at gmail dot com");
  const { turns } = await converse(engine, "en", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.en.email);
});

test("date field: an unparseable free-text date gets the specific date validation message in Demo mode", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "custody_start_date");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  lines.push("sometime last summer, not totally sure");
  const { turns } = await converse(engine, "en", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.en.date);
});

test("number field: a non-numeric free-text answer gets the specific number validation message in Demo mode", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "child_age");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  lines.push("about 7ish");
  const { turns } = await converse(engine, "en", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.en.number);
});

test("distress: a real first-person crisis phrase mid-conversation still shows the safety line and stores nothing new", async () => {
  const engine = loadEngine();
  const { turns, intake } = await converse(engine, "en", [
    "Frank Smith", "yes", "Parent", "yes",
    "I dont want to go on anymore, want to die",
  ]);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.REPLIES.en.safety);
  assert.equal(Object.keys(intake.answers()).length, 2);
});

test("distress: third-person narration ('my son... wanted to hurt himself') does NOT false-trigger the safety line", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "harms");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  lines.push("my son told his therapist he wanted to hurt himself after they separated him from us");
  const { turns } = await converse(engine, "en", lines);
  assert.notEqual(turns[turns.length - 1].reply, engine.Steer.REPLIES.en.safety);
});

test("angry/dismissive narration on an enum field still gets the specific rejection, not a false yes/help trigger", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "en", [
    "Frank Smith", "yes",
    "im so sick of typing this over and over, obviously the father",
  ]);
  const relField = engine.SCHEMA.fields.find((f) => f.path === "complainant_relationship");
  assert.equal(turns[2].reply, engine.Steer.VALIDATION_MESSAGES.en.enumMsg(relField.enum));
});

test("model failover: a backend that always throws is replaced by the deterministic EchoModel flow after one failure, instead of repeating a dead-end message every turn", async () => {
  const engine = loadEngine();
  class DyingModel { async chat() { throw new Error("WebGPU adapter lost"); } }
  const { intake } = await converse(engine, "en", ["Frank Smith", "yes", "Parent", "yes"], { model: new DyingModel() });
  // The failover notice is a secondary message within the turn it happens on
  // (the real reply follows right after it), so scan the full transcript
  // rather than each turn's last message.
  const downMessages = intake.history.filter((m) => /isn't responding/.test(m.text));
  assert.equal(downMessages.length, 1, "the 'model isn't responding' notice should show exactly once, not every turn");
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  const relField = engine.SCHEMA.fields.find((f) => f.path === "complainant_relationship");
  assert.equal(intake.answers()[nameField.path], "Frank Smith");
  assert.equal(intake.answers()[relField.path], "Parent");
  assert.ok(intake.model instanceof engine.EchoModel, "Intake should have failed over onto EchoModel");
});

test("model failover: works the same way in Spanish, with the Spanish notice", async () => {
  const engine = loadEngine();
  class DyingModel { async chat() { throw new Error("Ollama unreachable"); } }
  const { intake } = await converse(engine, "es", ["Maria Garcia", "si", "Parent", "si"], { model: new DyingModel() });
  const downMessages = intake.history.filter((m) => /no responde/.test(m.text));
  assert.equal(downMessages.length, 1);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Maria Garcia");
});

test("Spanish: name title-casing works the same way as English", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "es", ["maria garcia", "si"]);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Maria Garcia");
});

test("Spanish: enum free-text miss gets the Spanish 'pick one of' message", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "es", ["Maria Garcia", "si", "soy la madre"]);
  const relField = engine.SCHEMA.fields.find((f) => f.path === "complainant_relationship");
  assert.equal(turns[2].reply, engine.Steer.VALIDATION_MESSAGES.es.enumMsg(relField.enum));
});

test("Spanish: invalid email gets the Spanish email validation message", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "complainant_email");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(fields[i])); lines.push("si"); }
  // A genuine typo'd attempt at giving an email, not a decline ("no tengo" /
  // "ninguno" style phrases are a deliberate skip on this optional field —
  // see the bulk.e2e.test.js / persona tests covering that path instead).
  lines.push("bob arroba gmail punto com, sin arroba de verdad");
  const { turns } = await converse(engine, "es", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.es.email);
});

test("Spanish: a real distress phrase shows the Spanish safety line and stores nothing new", async () => {
  const engine = loadEngine();
  const { turns, intake } = await converse(engine, "es", [
    "Maria Garcia", "si", "Parent", "si",
    "ya no puedo mas, quiero morir",
  ]);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.REPLIES.es.safety);
  assert.equal(Object.keys(intake.answers()).length, 2);
});

test("correction flow: 'no' clears the pending value and the redo stores the corrected one (English)", async () => {
  const engine = loadEngine();
  const { intake, turns } = await converse(engine, "en", ["Frnak Smith", "no", "Frank J Smith", "yes"]);
  assert.equal(turns[1].reply, engine.Steer.REPLIES.en.denied);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Frank J Smith");
});

test("correction flow: 'no' clears the pending value and the redo stores the corrected one (Spanish)", async () => {
  const engine = loadEngine();
  const { intake, turns } = await converse(engine, "es", ["Maria Garcia", "no", "Maria Elena Garcia", "si"]);
  assert.equal(turns[1].reply, engine.Steer.REPLIES.es.denied);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Maria Elena Garcia");
});

// ── Skipping an optional field ──
// complainant_email's own prompt says "you can skip this if you don't have
// one" — but its format check (a real email regex) used to reject every
// possible way of saying that ("skip", "n/a", "I don't have one"), trapping
// anyone without an email in a dead-end loop identical to the enum trap
// above. Fixed by treating an explicit decline on an OPTIONAL, non-enum
// field as an answer to store verbatim (their own words are meaningful
// audit content), never a silent blank.
function walkToEmail(fields) {
  const idx = fields.findIndex((f) => f.path === "complainant_email");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  return lines;
}

for (const phrase of ["skip this", "n/a", "not applicable", "I don't have one", "none"]) {
  test(`optional email field: "${phrase}" is accepted as an explicit decline and stored verbatim, not rejected as an invalid email`, async () => {
    const engine = loadEngine();
    const lines = walkToEmail(engine.SCHEMA.fields);
    lines.push(phrase);
    const { turns, intake } = await converse(engine, "en", lines);
    const last = turns[turns.length - 1];
    assert.notEqual(last.reply, engine.Steer.VALIDATION_MESSAGES.en.email, `"${phrase}" must not be treated as a malformed email`);
    assert.equal(last.reply, engine.Steer.REPLIES.en.confirming(phrase.trim()));
    assert.ok(intake.pending, "the decline should be pending confirmation, same as any other answer");
    await intake.submit("yes");
    assert.equal(intake.answers().complainant_email, phrase.trim());
  });
}

test("optional email field: a genuine typo'd email attempt (not a decline) still gets the real validation message", async () => {
  const engine = loadEngine();
  const lines = walkToEmail(engine.SCHEMA.fields);
  lines.push("bob at gmail dot com");
  const { turns } = await converse(engine, "en", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.en.email);
});

test("Spanish: optional email field accepts a Spanish decline verbatim", async () => {
  const engine = loadEngine();
  const idx = engine.SCHEMA.fields.findIndex((f) => f.path === "complainant_email");
  const lines = [];
  for (let i = 0; i < idx; i++) { lines.push(validAnswerFor(engine.SCHEMA.fields[i])); lines.push("si"); }
  lines.push("no tengo");
  const { turns, intake } = await converse(engine, "es", lines);
  assert.notEqual(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.es.email);
  await intake.submit("si");
  assert.equal(intake.answers().complainant_email, "no tengo");
});

test("a decline phrase on a plain required text field is just stored as typed, not treated as a skip", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "en", ["n/a"]);
  // complainant_name is plain "text" with no format check beyond required,
  // so "n/a" already satisfies validate() (non-empty) on its own — the skip
  // bypass never even needs to run here. It goes through the ordinary
  // confirm step like any other text answer (title-cased, since this is the
  // name field — see the nameCase tests).
  assert.equal(turns[0].reply, engine.Steer.REPLIES.en.confirming("N/A"));
});
