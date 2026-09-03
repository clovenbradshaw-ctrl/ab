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
const Steer = require("../vendor/steer.js");

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

// Same idea as validAnswerFor, but skip-aware: a field whose skipIf(answers)
// is true given the answers accumulated so far is never asked by the real
// engine (see Intake.nextField()'s own skip logic in index.html), so a
// naive "one line per field" walk would feed that field's answer to
// whatever field actually comes next instead — silently misaligning every
// answer after it. This mirrors the engine's skip check so a line-per-field
// test setup always lines up with what will actually be asked.
function linesUpTo(fields, stopIndex, confirmWord = "yes") {
  const lines = [];
  const answers = {};
  for (let i = 0; i < stopIndex; i++) {
    const f = fields[i];
    if (Steer.isFieldSkipped(f, answers)) continue;
    const ans = validAnswerFor(f);
    lines.push(ans, confirmWord);
    answers[f.path] = ans;
  }
  return lines;
}
function linesForAll(fields, confirmWord = "yes") {
  return linesUpTo(fields, fields.length, confirmWord);
}

// confirming is a template (see vendor/steer.js), not a literal from the
// table — it always has some captured value spliced into a fixed frame.
// Derive that frame from the live template itself (a sentinel substitution,
// not a hand-copied wording guess) so a reply can be recognized as "a
// confirming line" regardless of which value it's confirming.
function confirmingPattern(engine, lang) {
  const SENTINEL = " SENTINEL "; // wont occur naturally in the template
  const templated = engine.Steer.REPLIES[lang].confirming(SENTINEL);
  const [prefix, suffix] = templated.split(SENTINEL);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + esc(prefix) + "[\\s\\S]*" + esc(suffix) + "$");
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
  // First reply must be the confirming line (mechanical, from the table),
  // and must embed the captured value itself — otherwise there's nothing
  // on screen to anchor what "does that look right?" is asking about.
  assert.equal(turns[0].reply, engine.Steer.REPLIES.en.confirming("Nroa Alvarez"));
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
  assert.equal(turns[0].reply, engine.Steer.REPLIES.es.confirming("Nora Alvarez"));
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
  lines.push(...linesUpTo(fields, deadlineIndex, "yes"));
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
  lines.push(...linesUpTo(fields, deadlineIndex, "yes"));
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
  lines.push(...linesForAll(fields, "yes"));
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
    engine.Steer.REPLIES.en.confirmed,
    engine.Steer.REPLIES.en.denied, engine.Steer.REPLIES.en.safety, engine.Steer.REPLIES.en.closing,
  ]);
  const confirmRe = confirmingPattern(engine, "en");
  const fieldTexts = new Set(engine.SCHEMA.fields.flatMap((f) => [f.prompt, f.help]).filter(Boolean));
  const validationTexts = new Set(Object.values(engine.Steer.VALIDATION_MESSAGES.en).filter((v) => typeof v === "string"));
  for (const t of turns) {
    const isEnumRejection = /^Please pick one of:/.test(t.reply);
    assert.ok(
      mechanical.has(t.reply) || fieldTexts.has(t.reply) || validationTexts.has(t.reply) || isEnumRejection || confirmRe.test(t.reply),
      `unexpected freeform reply: ${JSON.stringify(t.reply)}`
    );
  }
});

// ── open questions are a back-and-forth, not a single capture ────────────────

// Walks the interview to whichever field asks for the family's story, so
// these tests read against the real schema position rather than a hardcoded
// index that any question edit would silently invalidate.
function linesToNarrative(engine) {
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.narrative);
  assert.ok(idx > 0, "schema must contain at least one narrative field");
  return { fields, idx, lines: linesUpTo(fields, idx, "yes") };
}

test("a narrative question asks again instead of storing keyboard noise, and keeps what was said along the way", async () => {
  const engine = loadEngine();
  const { fields, idx, lines } = linesToNarrative(engine);
  const P = engine.Steer.REPLIES.en.probing;

  const { intake, turns } = await converse(engine, "en", [
    ...lines,
    "wefklmw;efklm",              // the stray keystroke from the bug report
    "he took her",                // real, but three words isn't yet an account
    "in March 2024 without telling me or my lawyer",
    "yes",
  ]);

  const [noise, bare, real] = turns.slice(-4);
  assert.equal(noise.reply, P.unreadable[0], "noise gets a question back, not 'does that look right?'");
  assert.equal(bare.reply, P.bare[1], "the second ask is the next rung of the ladder, not a repeat");
  // The third turn is usable, and what it confirms is the whole account —
  // the sentence the person managed first, plus what they added when asked.
  assert.match(real.reply, confirmingPattern(engine, "en"));
  assert.match(real.reply, /he took her/i);
  assert.match(real.reply, /in March 2024 without telling me/i);
  assert.equal(intake.answers()[fields[idx].path], "He took her. In March 2024 without telling me or my lawyer");
});

test("the asking always ends: after MAX_PROBES the person's own words are taken as written", async () => {
  const engine = loadEngine();
  const { fields, idx, lines } = linesToNarrative(engine);
  const { intake, turns } = await converse(engine, "en", [
    ...lines,
    "wefklmw;efklm",
    "wefklmw;efklm",
    "wefklmw;efklm",
    "yes",
  ]);
  // Two asks, then it stops arguing and confirms whatever it was given.
  assert.match(turns[turns.length - 2].reply, confirmingPattern(engine, "en"));
  assert.ok(intake.answers()[fields[idx].path], "an answer nobody could improve on is still the person's answer");
});

test("Spanish: the same back-and-forth happens in the person's own language", async () => {
  const engine = loadEngine();
  const { lines } = linesToNarrative(engine);
  const { turns } = await converse(engine, "es", [...lines, "asdfgh"]);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.REPLIES.es.probing.unreadable[0]);
});
