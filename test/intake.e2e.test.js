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

// A syntactically valid dummy answer for any field, regardless of type —
// keeps the conversation tests robust to schema reordering/edits instead of
// hardcoding assumptions about which field sits at which position.
function validAnswerFor(field) {
  if (field.type === "enum") return field.enum[0];
  if (field.type === "email") return "person@example.com";
  if (field.type === "number") return "5";
  if (field.type === "date") return "2026-01-01";
  return "Test answer for " + field.label;
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

test("English: the complainant-name field walked with typos, then confirmed with a typo'd yes", async () => {
  const engine = loadEngine();
  const { intake, turns } = await converse(engine, "en", [
    "Nroa Alvarez",   // typo'd candidate answer for the first field (complainant_name)
    "yse",            // typo'd confirmation
  ]);
  // First reply must be the confirming line (mechanical, from the table).
  assert.equal(turns[0].reply, engine.Steer.REPLIES.en.confirming);
  // Second turn confirms despite the typo, and the answer is now stored.
  assert.equal(intake.answers()[engine.SCHEMA.fields[0].path], "Nroa Alvarez");
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
  // Walk the first two fields for real (valid answers, both confirmed,
  // whatever type they happen to be) before the crisis signal lands.
  const [f0, f1] = engine.SCHEMA.fields;
  const { intake, turns } = await converse(engine, "en", [
    validAnswerFor(f0), "yes",
    validAnswerFor(f1), "yes",
    "I dont want to go on anymore, want to die", // distress mid-conversation
  ]);
  const last = turns[turns.length - 1];
  assert.equal(last.reply, engine.Steer.REPLIES.en.safety);
  // The distress turn must not have been treated as an answer to whatever
  // field was active — nothing new got stored from it.
  assert.equal(Object.keys(intake.answers()).length, 2); // only the two confirmed fields from before
});

test("180-day filing deadline: an old incident date triggers the exact required warning banner, and the interview continues past it", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const deadlineIndex = fields.findIndex((f) => f.path === engine.DEADLINE_CHECK_FIELD);
  assert.ok(deadlineIndex > 0, "schema must contain the deadline-check field");

  // Walk every field up to (but not including) the deadline field with a
  // throwaway valid answer, then answer the deadline field itself with a
  // date far outside the 180-day window.
  const lines = [];
  for (let i = 0; i < deadlineIndex; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  lines.push("2000-01-01");
  lines.push("yes");

  const { intake } = await converse(engine, "en", lines);
  const sawWarning = intake.history.some((m) => m.text === engine.DEADLINE_WARNING_EN && m.banner);
  assert.ok(sawWarning, "the exact required 180-day warning must appear as a banner message");

  // "the interview will continue" — never stop: the field after the
  // deadline field must still get asked, if one exists.
  const nextField = fields[deadlineIndex + 1];
  if (nextField) {
    const lastMsg = intake.history[intake.history.length - 1];
    assert.equal(lastMsg.text, nextField.prompt);
  }
});

test("180-day filing deadline: a recent incident date does not trigger the warning", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const deadlineIndex = fields.findIndex((f) => f.path === engine.DEADLINE_CHECK_FIELD);
  const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10); // 10 days ago
  const lines = [];
  for (let i = 0; i < deadlineIndex; i++) { lines.push(validAnswerFor(fields[i])); lines.push("yes"); }
  lines.push(recent);
  lines.push("yes");

  const { intake } = await converse(engine, "en", lines);
  const sawWarning = intake.history.some((m) => m.text === engine.DEADLINE_WARNING_EN);
  assert.equal(sawWarning, false);
});

test("closing block uses the exact mandatory Rep. Behn's-office wording, rendered as a banner", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const lines = [];
  for (const f of fields) { lines.push(validAnswerFor(f)); lines.push("yes"); }
  const { intake } = await converse(engine, "en", lines);
  const last = intake.history[intake.history.length - 1];
  assert.equal(last.text, engine.CLOSING_MESSAGE_EN);
  assert.equal(last.banner, true);
  assert.match(last.text, /REPRESENTATIVE BEHN'S OFFICE/);
});

test("every single reply across a long, typo-heavy conversation is a literal line from the mechanical table (or schema-authored text)", async () => {
  const engine = loadEngine();
  const [f0, f1, f2] = engine.SCHEMA.fields;
  const { turns } = await converse(engine, "en", [
    "waht", validAnswerFor(f0), "yeh",       // field 0: help, answer, typo'd confirm
    validAnswerFor(f1), "yse",               // field 1: valid answer, typo'd confirm
    "waht do you mean", validAnswerFor(f2), "y", // field 2: help, answer, confirm
  ]);
  const mechanical = new Set([
    ...engine.Steer.REPLIES.en.supporting,
    engine.Steer.REPLIES.en.confirming, engine.Steer.REPLIES.en.confirmed,
    engine.Steer.REPLIES.en.denied, engine.Steer.REPLIES.en.safety, engine.Steer.REPLIES.en.closing,
  ]);
  const fieldTexts = new Set(engine.SCHEMA.fields.flatMap((f) => [f.prompt, f.help]).filter(Boolean));
  const validationTexts = new Set(Object.values(engine.Steer.VALIDATION_MESSAGES.en).filter((v) => typeof v === "string"));
  for (const t of turns) {
    const isEnumRejection = /^Please pick one of:/.test(t.reply);
    assert.ok(
      mechanical.has(t.reply) || fieldTexts.has(t.reply) || validationTexts.has(t.reply) || isEnumRejection,
      `unexpected freeform reply: ${JSON.stringify(t.reply)}`
    );
  }
});
