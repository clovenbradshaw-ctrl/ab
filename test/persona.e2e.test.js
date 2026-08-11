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

test("name field: a middle initial with a period is recognized as a name and title-cased, not left as a run-on sentence", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", ["frank e. smith", "yes"]);
  const nameField = engine.SCHEMA.fields.find((f) => f.path === "complainant_name");
  assert.equal(intake.answers()[nameField.path], "Frank E. Smith");
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

test("upfront overview: a fresh session sees a one-time walkthrough banner before the first question, and a resumed session doesn't repeat it", async () => {
  const engine = loadEngine();
  const store = makeStore(engine);
  const intake1 = new engine.Intake({ schema: engine.SCHEMA, store, model: new engine.EchoModel(), lang: "en" });
  await intake1.begin();
  const overview = intake1.history.find((m) => m.text === engine.INTAKE_OVERVIEW_EN);
  assert.ok(overview, "overview banner should appear on a fresh start");
  assert.equal(overview.banner, true);
  // Answer the first field, then simulate resuming with a brand-new Intake
  // instance over the same store (same shape as a page reload).
  await intake1.submit("Frank Smith");
  await intake1.submit("yes");
  const intake2 = new engine.Intake({ schema: engine.SCHEMA, store, model: new engine.EchoModel(), lang: "en" });
  await intake2.begin();
  assert.equal(intake2.history.some((m) => m.text === engine.INTAKE_OVERVIEW_EN), false);
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

test("multiselect field: multiple race/ethnicity picks are stored as one comma-joined value", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "child_race_ethnicity");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("Black or African American, Hispanic or Latino", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.answers().child_race_ethnicity, "Black or African American, Hispanic or Latino");
});

test("conditional field: the disability follow-up is skipped (never asked) when the Yes/No question is answered No", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "child_disability_has");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("No", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.answers().child_disability_has, "No");
  assert.equal(intake.answers().child_disability_explain, undefined);
  assert.equal(intake.nextField().path, "custody_start_date");
});

test("conditional field: the disability follow-up is asked and stored when the Yes/No question is answered Yes", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "child_disability_has");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("Yes", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.answers().child_disability_has, "Yes");
  assert.equal(intake.nextField().path, "child_disability_explain");
});

test("conditional field: the home-language 'other' follow-up is skipped unless Other is picked", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "home_language");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("English", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "family_background");
});

test("conditional field: the home-language 'other' follow-up is asked when Other is picked", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "home_language");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("Other", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "home_language_other");
});

test("narrative follow-up: mentioning medication in the family-background answer inserts the medication follow-up question right after it", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "family_background");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("My child may not be getting his medication on schedule.", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "narrative_followup_medical");
  assert.equal(intake.answers().narrative_followup_abuse, undefined);
});

test("narrative follow-up: mentioning bruising inserts the abuse/injury follow-up question, and it isn't asked when nothing matches", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "family_background");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("I noticed bruises on my child after a visit.", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "narrative_followup_abuse");
});

test("narrative follow-up: the SAME shared follow-up fires no matter which narrative field the topic is mentioned in (not just family_background)", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "dcs_actions_failures");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("The caseworker never followed up about his prescription in March 2024.", "yes");
  const { intake } = await converse(engine, "en", lines);
  // Both the coverage follow-up (see below) and the triggered medication
  // follow-up get spliced in right after dcs_actions_failures — the
  // medication one is the one under test here.
  assert.ok(intake.schema.fields.some((f) => f.path === "narrative_followup_medical"));
});

test("coverage framework: an answer with neither a date nor a name asks for 'when' first, then 'who', then stops — never more than the 2-question cap", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "dcs_actions_failures");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("The caseworker never called me back about the school issue.", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "dcs_actions_failures_coverage_1");

  await intake.submit("Sometime last spring, I think."); await intake.submit("yes");
  assert.equal(intake.nextField().path, "dcs_actions_failures_coverage_2");

  await intake.submit("I don't remember her name."); await intake.submit("yes");
  // Only 2 slots exist (when/who) and both have now been asked once —
  // nothing a 3rd coverage follow-up could target, cap or no cap.
  assert.equal(intake.nextField().path, "coercion_threats");
  assert.equal(intake.schema.fields.filter((f) => f.path.startsWith("dcs_actions_failures_coverage_")).length, 2);
});

test("coverage framework: an answer that already names a date and a caseworker skips the coverage follow-ups entirely", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "dcs_actions_failures");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("On March 2024, Caseworker Angela Ford told me the placement was final.", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "coercion_threats");
});

test("coverage framework: declining the first coverage follow-up ends the loop instead of asking the second slot", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "dcs_actions_failures");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("The caseworker never called me back about the school issue.", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "dcs_actions_failures_coverage_1");

  // "I don't know" is deliberately not used here — it's in Steer's HELP
  // lexicon (a person asking for clarification), not its skip lexicon, so
  // the app would read it as "explain the question" and never store it as
  // a decline. "not applicable" is unambiguous.
  await intake.submit("not applicable"); await intake.submit("yes");
  assert.equal(intake.nextField().path, "coercion_threats");
  assert.equal(intake.schema.fields.some((f) => f.path === "dcs_actions_failures_coverage_2"), false);
});

test("narrative follow-up: no tracked topic mentioned means neither follow-up is inserted", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "family_background");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("We are a close family and this has been a hard year.", "yes");
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.nextField().path, "placement_1_when");
});

test("placement history: a repeating group — 'another placement?' answered yes adds a second round, answered no moves on", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "placement_1_when");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  // Round 1: date, type (first select option), notes, then "yes" to another one.
  lines.push(
    "2024-03-01", "yes",
    "A foster home", "yes",
    "Stayed about two months.", "yes",
    "Yes", "yes",
  );
  const { intake } = await converse(engine, "en", lines);
  assert.equal(intake.answers().placement_1_when, "2024-03-01");
  assert.equal(intake.answers().placement_1_type, "A foster home");
  assert.equal(intake.answers().placement_more_1, "Yes");
  assert.equal(intake.nextField().path, "placement_2_when");

  // Round 2: this time say no to a third round.
  await intake.submit("2024-05-01"); await intake.submit("yes");
  await intake.submit("A group home"); await intake.submit("yes");
  await intake.submit("Not applicable"); await intake.submit("yes");
  await intake.submit("No"); await intake.submit("yes");
  assert.equal(intake.answers().placement_2_when, "2024-05-01");
  assert.equal(intake.answers().placement_more_2, "No");
  assert.equal(intake.answers().placement_3_when, undefined);
  assert.equal(intake.nextField().path, "alternatives_asked");
});

test("sectionProgress: starts with section 1 active and empty, sections 2 and 3 at zero", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", []);
  const sp = intake.sectionProgress();
  assert.deepEqual(Array.from(sp.map((s) => s.key)), ["about", "story", "wrapup"]);
  assert.equal(sp[0].active, true);
  assert.equal(sp[0].done, 0);
  assert.ok(sp[0].total > 0);
  assert.equal(sp[1].active, false);
  assert.equal(sp[2].active, false);
});

test("sectionProgress: answering every 'about' field marks that section complete and hands off activity to 'story'", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "family_background");
  const lines = linesUpTo(fields, idx, "yes"); // walks through every "about" field
  const { intake } = await converse(engine, "en", lines);
  const sp = intake.sectionProgress();
  const about = sp.find((s) => s.key === "about");
  const story = sp.find((s) => s.key === "story");
  assert.equal(about.complete, true);
  assert.equal(about.done, about.total);
  assert.equal(about.active, false);
  assert.equal(story.active, true);
  assert.equal(story.done, 0);
});

test("sectionProgress: a follow-up injected into the 'story' section (see NARRATIVE_FOLLOWUPS) counts toward that section's total, not a fourth bucket", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "family_background");
  const lines = linesUpTo(fields, idx, "yes");
  lines.push("My child may not be getting his medication.", "yes");
  const { intake } = await converse(engine, "en", lines);
  const sp = intake.sectionProgress();
  assert.deepEqual(Array.from(sp.map((s) => s.key)), ["about", "story", "wrapup"]);
  const story = sp.find((s) => s.key === "story");
  assert.equal(story.active, true);
  assert.ok(story.total >= 11, "the injected medication follow-up should be counted inside 'story', not dropped");
});

test("email field: an invalid free-text email gets the specific email validation message in Demo mode", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "complainant_email");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("bob at gmail dot com");
  const { turns } = await converse(engine, "en", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.en.email);
});

test("date field: an unparseable free-text date gets the specific date validation message in Demo mode", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "custody_start_date");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
  lines.push("sometime last summer, not totally sure");
  const { turns } = await converse(engine, "en", lines);
  assert.equal(turns[turns.length - 1].reply, engine.Steer.VALIDATION_MESSAGES.en.date);
});

test("number field: a non-numeric free-text answer gets the specific number validation message in Demo mode", async () => {
  const engine = loadEngine();
  const fields = engine.SCHEMA.fields;
  const idx = fields.findIndex((f) => f.path === "child_age");
  const lines = [];
  lines.push(...linesUpTo(fields, idx, "yes"));
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
  lines.push(...linesUpTo(fields, idx, "yes"));
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
  lines.push(...linesUpTo(fields, idx, "si"));
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
  lines.push(...linesUpTo(fields, idx, "yes"));
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

// declineField() — the always-available quick-answer chip, so nobody has to
// find the right magic words to skip a question (see the "no i don't have
// it" regression below, which is exactly the phrasing that motivated it).
test("declineField: an optional digits field (dcs_case_number) stores its own escape keyword and advances", async () => {
  const engine = loadEngine();
  const { fields } = engine.SCHEMA;
  const caseNumberIndex = fields.findIndex((f) => f.path === "dcs_case_number");
  const { intake } = await converse(engine, "en", linesUpTo(fields, caseNumberIndex));
  assert.equal(intake.nextField().path, "dcs_case_number");
  await intake.declineField();
  assert.equal(intake.answers().dcs_case_number, "unknown");
  assert.notEqual(intake.nextField()?.path, "dcs_case_number");
});

test("declineField: an optional field with no digitsOrKeywords stores the bilingual 'N/A' phrase", async () => {
  const engine = loadEngine();
  const { fields } = engine.SCHEMA;
  const emailIndex = fields.findIndex((f) => f.path === "complainant_email");
  const { intake } = await converse(engine, "en", linesUpTo(fields, emailIndex));
  assert.equal(intake.nextField().path, "complainant_email");
  await intake.declineField();
  assert.equal(intake.answers().complainant_email, "N/A");
});

test("declineField: Spanish gets 'No aplica' instead of 'N/A'", async () => {
  const engine = loadEngine();
  const { fields } = engine.SCHEMA;
  const emailIndex = fields.findIndex((f) => f.path === "complainant_email");
  const { intake } = await converse(engine, "es", linesUpTo(fields, emailIndex, "si"));
  await intake.declineField();
  assert.equal(intake.answers().complainant_email, "No aplica");
});

test("declineField: a required field can't be declined — it's a no-op, not a stored blank", async () => {
  const engine = loadEngine();
  const { intake } = await converse(engine, "en", []);
  assert.equal(intake.nextField().path, "complainant_name");
  await intake.declineField();
  assert.equal(intake.answers().complainant_name, undefined);
  assert.equal(intake.nextField().path, "complainant_name");
});

test("regression: 'no i don't have it' on the optional case-number field is recognized as a decline, not rejected as a bad digit count", async () => {
  const engine = loadEngine();
  const { fields } = engine.SCHEMA;
  const caseNumberIndex = fields.findIndex((f) => f.path === "dcs_case_number");
  const { intake, turns } = await converse(engine, "en", [
    ...linesUpTo(fields, caseNumberIndex),
    "no i don't have it",
  ]);
  const last = turns[turns.length - 1];
  assert.doesNotMatch(last.reply, /exactly 10 digits/);
  assert.equal(last.reply, engine.Steer.REPLIES.en.confirming("no i don't have it"));
  await intake.submit("yes");
  assert.equal(intake.answers().dcs_case_number, "no i don't have it");
});
