// test/templates.test.js — the admin's outgoing-document layer: custom
// {{placeholder}} templates, the folded letter record (status/text edits as
// DEF overlays), and the conversational additions that drive an interview
// toward a *fileable* OCR complaint (section transitions, rotated
// acknowledgements, required-fields-remaining milestones).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadEngine } = require("./_extract-engine.js");
const Steer = require("../vendor/steer.js");

// ── renderTemplate ──

test("renderTemplate: substitutes answers, reports missing paths, and fills {{_date}}", () => {
  const engine = loadEngine();
  const tpl = { id: "t1", name: "Ack letter", body: "Date: {{_date}}\nDear {{complainant_name}},\nCounty: {{dcs_county}}." };
  const { letter, missing } = engine.renderTemplate(tpl, { complainant_name: "Nora Alvarez" });
  assert.match(letter, /Dear Nora Alvarez,/);
  assert.match(letter, /County: \(not provided\)\./);
  assert.doesNotMatch(letter, /\{\{/); // every placeholder resolved one way or another
  // Array.from: the engine's arrays come from a vm realm, whose Array
  // prototype fails deepStrictEqual against a same-shaped local literal.
  assert.deepEqual(Array.from(missing, (m) => m.path), ["dcs_county"]);
});

test("renderTemplate: sources carry provenance for every answered placeholder", () => {
  const engine = loadEngine();
  const tpl = { id: "t1", name: "T", body: "{{complainant_name}} / {{harms}}" };
  const provenance = {
    complainant_name: { value: "Nora Alvarez", source: "my name is nora alvarez", inputKind: "typed", at: "2026-01-01T00:00:00Z", by: "@a:local", eventId: "e1", voiceClipId: null },
  };
  const { sources } = engine.renderTemplate(tpl, { complainant_name: "Nora Alvarez" }, provenance);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].path, "complainant_name");
  assert.equal(sources[0].source, "my name is nora alvarez");
  assert.equal(sources[0].inputKind, "typed");
});

test("templatePaths: dedupes and preserves order; whitespace inside braces tolerated", () => {
  const engine = loadEngine();
  const paths = engine.templatePaths("{{ a }} {{b}} {{a}} {{ _date }}");
  assert.deepEqual(Array.from(paths), ["a", "b", "_date"]);
});

test("buildOutgoingDoc: no template (or the builtin id) falls through to the OCR assembler", () => {
  const engine = loadEngine();
  const answers = { complainant_name: "Nora Alvarez" };
  const viaNull = engine.buildOutgoingDoc(null, answers);
  const viaBuiltin = engine.buildOutgoingDoc({ id: engine.BUILTIN_TEMPLATE_ID, name: "x", body: "ignored" }, answers);
  const direct = engine.buildComplaintLetter(answers);
  assert.equal(viaNull.letter, direct.letter);
  assert.equal(viaBuiltin.letter, direct.letter);
  // And a custom template does NOT fall through:
  const custom = engine.buildOutgoingDoc({ id: "t9", name: "T", body: "Hi {{complainant_name}}" }, answers);
  assert.equal(custom.letter, "Hi Nora Alvarez");
});

// ── foldLetterRecord (extracted straight from index.html, same
// no-hand-copied-fork rule as _extract-engine.js) ──

function loadFoldLetterRecord() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf-8");
  const start = html.indexOf("function foldLetterRecord(");
  assert.notEqual(start, -1, "foldLetterRecord not found — index.html shape changed");
  const end = html.indexOf("\n}", start);
  const src = html.slice(start, end + 2);
  const sandbox = { exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(src + "\nexports.foldLetterRecord = foldLetterRecord;", sandbox);
  return sandbox.exports.foldLetterRecord;
}

test("foldLetterRecord: a status DEF on the letter's anchor overrides the INS attrs (the bug that froze every letter at draft)", () => {
  const engine = loadEngine();
  const foldLetterRecord = loadFoldLetterRecord();
  const events = [
    { id: "e1", op: "INS", payload: { entity: "letter", id: "letter_1", attrs: { text: "original", status: "draft" } }, at: "2026-01-01T00:00:00Z", by: "@admin:local" },
    { id: "e2", op: "DEF", payload: { anchor: "letter_1", path: "status", value: "approved" }, at: "2026-01-02T00:00:00Z", by: "@admin:local" },
  ];
  const folded = engine.fold(events);
  const l = foldLetterRecord("letter_1", folded.records.letter_1, folded, { roomId: "!r" });
  assert.equal(l.status, "approved");
  assert.equal(l.text, "original");
});

test("foldLetterRecord: an admin text edit rides a DEF too — latest text wins, edit metadata surfaces, original stays in attrs", () => {
  const engine = loadEngine();
  const foldLetterRecord = loadFoldLetterRecord();
  const events = [
    { id: "e1", op: "INS", payload: { entity: "letter", id: "letter_1", attrs: { text: "original", status: "draft" } }, at: "2026-01-01T00:00:00Z", by: "@admin:local" },
    { id: "e2", op: "DEF", payload: { anchor: "letter_1", path: "text", value: "edited by hand" }, at: "2026-01-03T00:00:00Z", by: "@admin:local" },
  ];
  const folded = engine.fold(events);
  const l = foldLetterRecord("letter_1", folded.records.letter_1, folded, {});
  assert.equal(l.text, "edited by hand");
  assert.equal(l.editedAt, "2026-01-03T00:00:00Z");
  assert.equal(l.editedBy, "@admin:local");
  assert.equal(folded.records.letter_1.attrs.text, "original"); // never destroyed
});

// ── conversational layer ──

test("confirmed acknowledgements rotate deterministically through the vetted variants and wrap around", () => {
  for (const lang of ["en", "es"]) {
    const all = [Steer.REPLIES[lang].confirmed, ...Steer.REPLIES[lang].confirmedAlt];
    const seen = new Set();
    for (let n = 0; n < all.length; n++) {
      const line = Steer.pickReply({ lang, focus: "confirmed", meta: { n } });
      assert.ok(all.includes(line), `variant not from the vetted table: ${line}`);
      seen.add(line);
    }
    assert.equal(seen.size, all.length, "each variant should appear once per cycle");
    // No meta.n (every pre-existing call site): the canonical line, unchanged.
    assert.equal(Steer.pickReply({ lang, focus: "confirmed" }), Steer.REPLIES[lang].confirmed);
    assert.equal(Steer.pickReply({ lang, focus: "confirmed", meta: { n: all.length } }), Steer.REPLIES[lang].confirmed);
  }
});

test("progress / almostDone / requiredDone lines exist in both languages and embed their numbers", () => {
  for (const lang of ["en", "es"]) {
    assert.match(Steer.pickReply({ lang, focus: "progress", meta: { done: 6, total: 30 } }), /6.*30/);
    assert.match(Steer.pickReply({ lang, focus: "almostDone", meta: { n: 2 } }), /2/);
    assert.equal(typeof Steer.pickReply({ lang, focus: "requiredDone" }), "string");
  }
  assert.notEqual(Steer.pickReply({ lang: "en", focus: "requiredDone" }), Steer.pickReply({ lang: "es", focus: "requiredDone" }));
});

// Full-conversation checks against the real engine.

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
  if (field.type === "boolean") return "No";
  if (field.path === "dcs_actions_failures") return "In March 2024, Caseworker Jane Smith did not respond to my calls.";
  if ((field.type === "select" || field.type === "multiselect") && field.enum?.length) return field.enum[0];
  if (field.digits && !field.required) return "unknown";
  return "Test answer for " + field.label;
}

async function walkAll(engine, lang = "en") {
  const store = makeStore(engine);
  const intake = new engine.Intake({ schema: engine.SCHEMA, store, model: new engine.EchoModel(), lang });
  await intake.begin();
  const answers = {};
  // Drive by what the engine actually asks (intake.nextField()) instead of a
  // precomputed line list — robust to injected follow-ups and skips.
  for (let guard = 0; guard < 500; guard++) {
    const f = intake.nextField();
    if (!f) break;
    const ans = validAnswerFor(f);
    await intake.submit(ans);
    // A section review pauses the interview until someone looks it over —
    // stand in for the person pressing "Looks right".
    while (intake.awaitingReview) await intake.approveReview();
    answers[f.path] = ans;
  }
  return { intake, answers };
}

test("section transitions: crossing into a later section says its hand-written intro exactly once; the first section is seated silently", async () => {
  const engine = loadEngine();
  const { intake } = await walkAll(engine, "en");
  const texts = intake.history.filter((m) => m.role === "assistant").map((m) => m.text);
  const storyIntro = engine.SECTION_INTROS.story.en;
  const aboutIntro = engine.SECTION_INTROS.about.en;
  assert.equal(texts.filter((t) => t === storyIntro).length, 1, "story intro said exactly once");
  assert.equal(texts.filter((t) => t === aboutIntro).length, 0, "the opening section needs no announcement");
});

test("OCR-completion drive: a full walk announces the required-fields countdown and the all-required-done line, and still closes with the mandatory wording", async () => {
  const engine = loadEngine();
  const { intake } = await walkAll(engine, "en");
  const texts = intake.history.filter((m) => m.role === "assistant").map((m) => m.text);
  assert.ok(texts.includes(Steer.REPLIES.en.almostDone(1)), "the one-required-piece-left line should appear");
  assert.ok(texts.includes(Steer.REPLIES.en.requiredDone), "the all-required-covered line should appear");
  assert.equal(intake.history[intake.history.length - 1].text, engine.CLOSING_MESSAGE_EN, "the mandatory closing stays the final message");
});

test("acknowledgement rotation shows up in a real conversation: a multi-field walk uses more than one confirmed variant", async () => {
  const engine = loadEngine();
  const { intake } = await walkAll(engine, "en");
  const all = new Set([Steer.REPLIES.en.confirmed, ...Steer.REPLIES.en.confirmedAlt]);
  const used = new Set(intake.history.filter((m) => m.role === "assistant" && all.has(m.text)).map((m) => m.text));
  assert.ok(used.size > 1, "a long interview should not repeat one identical acknowledgement");
  for (const t of used) assert.ok(all.has(t));
});
