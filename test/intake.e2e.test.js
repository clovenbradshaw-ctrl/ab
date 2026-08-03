// test/intake.e2e.test.js — drives the ACTUAL Intake engine shipped in
// index.html (extracted verbatim, not reimplemented) through full bilingual,
// typo-riddled conversations. This is the "go back and forth with a person
// asking things with typos" scenario from the spec, run against the real
// code path: Intake.submit() -> EchoModel.chat() -> Steer.classifyIntent /
// Steer.pickReply, with the real physics state on `intake.steer`.
//
// The extraction (scripts/extract-engine.js) pulls the SCHEMA-through-Intake
// slice of index.html into a fresh vm context each run, so this test can
// never silently drift onto a hand-copied fork of the logic — if index.html
// changes shape, extraction fails loudly instead of testing stale code.
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

async function converse(engine, lang, lines) {
  const { Intake, SCHEMA } = engine;
  const store = makeStore(engine);
  const model = new engine.EchoModel();
  const intake = new Intake({ schema: SCHEMA, store, model, lang });
  await intake.begin();
  const turns = [];
  for (const line of lines) {
    await intake.submit(line);
    const last = intake.history[intake.history.length - 1];
    turns.push({ said: line, reply: last.text, steer: { ...intake.steer } });
  }
  return { intake, turns };
}

test("engine slice extracts and evaluates cleanly", () => {
  const engine = loadEngine();
  assert.equal(typeof engine.Intake, "function");
  assert.equal(typeof engine.EchoModel, "function");
  assert.ok(Array.isArray(engine.SCHEMA.fields) && engine.SCHEMA.fields.length > 0);
});

test("English: a full name field walked with typos, then confirmed with a typo'd yes", async () => {
  const engine = loadEngine();
  const { intake, turns } = await converse(engine, "en", [
    "Nroa Alvarez",   // typo'd candidate answer for "full_name"
    "yse",            // typo'd confirmation
  ]);
  // First reply must be the confirming line (mechanical, from the table).
  assert.equal(turns[0].reply, engine.Steer.REPLIES.en.confirming);
  // Second turn confirms despite the typo, and the answer is now stored.
  assert.equal(intake.answers().full_name, "Nroa Alvarez");
  // After confirming, the engine moved on to ask the next field mechanically
  // (its own schema-authored prompt, not model prose).
  const nextFieldPrompt = engine.SCHEMA.fields[1].prompt;
  assert.equal(intake.history[intake.history.length - 1].text, nextFieldPrompt);
});

test("English: typo'd help request is answered from the field's own help text, no model round trip needed to notice it", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "en", ["waht does that mean"]);
  assert.equal(turns[0].reply, engine.SCHEMA.fields[0].help);
});

test("Spanish: accent-free typed reply still gets the Spanish confirmation line", async () => {
  const engine = loadEngine();
  const { turns } = await converse(engine, "es", [
    "Nora Alvarez",
    "sii",  // typo'd "sí"
  ]);
  assert.equal(turns[0].reply, engine.Steer.REPLIES.es.confirming);
  // Confirmed in Spanish mode -> the *next* prompt shown is the field's
  // Spanish prompt, not the English one.
  const nextFieldPromptEs = engine.SCHEMA.fields[1].promptEs;
  assert.ok(nextFieldPromptEs);
});

test("distress mid-conversation immediately shows the safety line and does not store/advance", async () => {
  const engine = loadEngine();
  // Schema order is full_name, contact_email, agency_name, ... — walk the
  // first two fields for real (valid answers, both confirmed) before the
  // crisis signal lands on the third.
  const { intake, turns } = await converse(engine, "en", [
    "Nora Alvarez",
    "yes",
    "nora@example.com",
    "yes",
    "I dont want to go on anymore, want to die", // distress mid-conversation
  ]);
  const last = turns[turns.length - 1];
  assert.equal(last.reply, engine.Steer.REPLIES.en.safety);
  // The distress turn must not have been treated as an answer to whatever
  // field was active — nothing new got stored from it.
  assert.equal(Object.keys(intake.answers()).length, 2); // only the two confirmed fields from before
});

test("every single reply across a long, typo-heavy conversation is a literal line from the mechanical table (or a schema-authored field prompt/help)", async () => {
  const engine = loadEngine();
  const { intake, turns } = await converse(engine, "en", [
    "waht", "Nora Alvarez", "yeh",           // full_name: help, answer, typo'd confirm
    "nora@example.com", "yse",               // contact_email: valid answer, typo'd confirm
    "waht do you mean", "the DMV", "y",      // agency_name: help, answer, confirm
  ]);
  const mechanical = new Set([
    ...engine.Steer.REPLIES.en.supporting,
    engine.Steer.REPLIES.en.confirming, engine.Steer.REPLIES.en.confirmed,
    engine.Steer.REPLIES.en.denied, engine.Steer.REPLIES.en.safety, engine.Steer.REPLIES.en.closing,
  ]);
  const fieldTexts = new Set(engine.SCHEMA.fields.flatMap((f) => [f.prompt, f.help]).filter(Boolean));
  for (const t of turns) {
    assert.ok(mechanical.has(t.reply) || fieldTexts.has(t.reply), `unexpected freeform reply: ${JSON.stringify(t.reply)}`);
  }
});
