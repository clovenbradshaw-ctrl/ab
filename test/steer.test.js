// test/steer.test.js — exercises the actual steering module the app ships
// (vendor/steer.js), not a re-implementation of it. Run with:
//   node --test test/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Steer = require("../vendor/steer.js");

test("typo-tolerant yes/no/help — English", () => {
  assert.equal(Steer.classifyIntent("yse", "en").yes, true);
  assert.equal(Steer.classifyIntent("yeh", "en").yes, true);
  assert.equal(Steer.classifyIntent("nno", "en").no, true);
  assert.equal(Steer.classifyIntent("dont kno", "en").help, true);
  assert.equal(Steer.classifyIntent("whta does that mean", "en").help, true); // typo'd but still clearly a help-seeking question
});

test("help/yes/no only reads the start of a reply, not keywords buried in a long disclosure", () => {
  const long = "My name is Nora and I don't know if this makes sense but I want to explain what happened at the shelter";
  const i = Steer.classifyIntent(long, "en");
  assert.equal(i.help, false, "a long narrative shouldn't be misread as a help request just because it contains 'explain'/'what'");
  assert.equal(i.yes, false);
  assert.equal(i.no, false);
});

test("typo-tolerant yes/no/help — Spanish, accent-insensitive", () => {
  assert.equal(Steer.classifyIntent("si", "es").yes, true);
  assert.equal(Steer.classifyIntent("sii", "es").yes, true);
  assert.equal(Steer.classifyIntent("correcto", "es").yes, true);
  assert.equal(Steer.classifyIntent("no se", "es").help, true);
  assert.equal(Steer.classifyIntent("no", "es").no, true);
});

test("a real answer is not misread as yes/no/help", () => {
  const i = Steer.classifyIntent("My name is Nora Alvarez", "en");
  assert.equal(i.yes, false);
  assert.equal(i.no, false);
  assert.equal(i.help, false);
});

test("distress phrases fire regardless of active UI language", () => {
  assert.equal(Steer.classifyIntent("I want to kill myself", "es").distress, true);
  assert.equal(Steer.classifyIntent("ya no puedo mas, quiero morir", "en").distress, true);
});

test("ordinary distressing-but-not-crisis text does not trip the safety branch", () => {
  assert.equal(Steer.classifyIntent("he hit me and I was scared", "en").distress, false);
});

test("physics: sustained sharing raises the tier over several turns, not instantly", () => {
  const s = Steer.createState();
  assert.equal(Steer.tierOf(s), 0);
  Steer.applyForce(s, { opens: true });
  assert.equal(Steer.tierOf(s), 0, "one good turn should not jump straight to the top tier");
  Steer.applyForce(s, { opens: true });
  Steer.applyForce(s, { opens: true });
  Steer.applyForce(s, { opens: true });
  assert.ok(s.opening > 0.33, "opening should have climbed after repeated sharing");
});

test("physics: deflection pulls the tier back down but doesn't slam to zero", () => {
  const s = Steer.createState();
  for (let i = 0; i < 6; i++) Steer.applyForce(s, { opens: true });
  const openedTo = s.opening;
  Steer.applyForce(s, { deflects: true });
  assert.ok(s.opening < openedTo, "a deflection should reduce opening");
  assert.ok(s.opening > 0, "a single deflection should not erase all built trust");
});

test("physics: distress spikes immediately and outranks tier regardless of opening", () => {
  const s = Steer.createState();
  for (let i = 0; i < 8; i++) Steer.applyForce(s, { opens: true }); // build to tier 2
  assert.equal(Steer.tierOf(s), 2);
  Steer.applyForce(s, { distress: true });
  assert.equal(Steer.tierOf(s), "safety");
});

test("physics: distress decays back out once signals stop", () => {
  const s = Steer.createState();
  Steer.applyForce(s, { distress: true });
  assert.equal(Steer.tierOf(s), "safety");
  for (let i = 0; i < 5; i++) Steer.applyForce(s, {});
  assert.notEqual(Steer.tierOf(s), "safety");
});

test("mechanical replies: every reply comes from the fixed table, never freeform", () => {
  const allEn = new Set([
    ...Steer.REPLIES.en.supporting,
    Steer.REPLIES.en.confirming, Steer.REPLIES.en.confirmed, Steer.REPLIES.en.denied,
    Steer.REPLIES.en.safety, Steer.REPLIES.en.closing,
  ]);
  for (const focus of ["confirming", "confirmed", "denied", "safety", "closing"]) {
    assert.ok(allEn.has(Steer.pickReply({ lang: "en", focus })));
  }
  for (let tier = 0; tier < 5; tier++) {
    assert.ok(allEn.has(Steer.pickReply({ lang: "en", focus: "supporting", tier })));
  }
});

test("mechanical replies: Spanish table is fully populated and distinct from English", () => {
  for (const focus of ["confirming", "confirmed", "denied", "safety", "closing"]) {
    const en = Steer.pickReply({ lang: "en", focus });
    const es = Steer.pickReply({ lang: "es", focus });
    assert.ok(es && es.length > 0);
    assert.notEqual(en, es);
  }
});

test("mechanical replies: asking uses the field's own bilingual prompt, falling back to English", () => {
  const field = { prompt: "What happened?", promptEs: "¿Qué pasó?" };
  assert.equal(Steer.pickReply({ lang: "en", focus: "asking", field }), "What happened?");
  assert.equal(Steer.pickReply({ lang: "es", focus: "asking", field }), "¿Qué pasó?");
  const noTranslation = { prompt: "What happened?" };
  assert.equal(Steer.pickReply({ lang: "es", focus: "asking", field: noTranslation }), "What happened?");
});

test("mechanical replies: clarifying uses the field's own bilingual help text", () => {
  const field = { help: "An approximate date is fine.", helpEs: "Una fecha aproximada está bien." };
  assert.equal(Steer.pickReply({ lang: "en", focus: "clarifying", field }), field.help);
  assert.equal(Steer.pickReply({ lang: "es", focus: "clarifying", field }), field.helpEs);
  assert.equal(Steer.pickReply({ lang: "en", focus: "clarifying", field: {} }), Steer.REPLIES.en.supporting[0]);
});

test("mechanical replies: welcomeBack is bilingual and reports real progress numbers", () => {
  const en = Steer.pickReply({ lang: "en", focus: "welcomeBack", meta: { done: 3, total: 10 } });
  const es = Steer.pickReply({ lang: "es", focus: "welcomeBack", meta: { done: 3, total: 10 } });
  assert.match(en, /3 of 10/);
  assert.match(es, /3 de 10/);
});

test("bilingual validation messages", () => {
  const field = { required: true, type: "email" };
  assert.match(Steer.validate(field, "", "en"), /required/i);
  assert.match(Steer.validate(field, "", "es"), /obligatorio/i);
  assert.match(Steer.validate(field, "not-an-email", "en"), /email address/i);
  assert.match(Steer.validate(field, "not-an-email", "es"), /correo electr/i);
  assert.equal(Steer.validate(field, "a@b.com", "en"), null);
});

// ---- end-to-end simulation: a full bilingual, typo-riddled back-and-forth ----
// This is the "person going back and forth with the app" scenario, driven
// entirely through the shipped module — no mock of the steering logic.
function runTurn(state, lang, userText) {
  const intent = Steer.classifyIntent(userText, lang);
  const opens = !intent.yes && !intent.no && !intent.help && !intent.distress && userText.trim().length >= 10;
  const deflects = intent.help;
  Steer.applyForce(state, { opens, deflects, distress: intent.distress });
  const tier = Steer.tierOf(state);
  const focus = tier === "safety" ? "safety" : intent.help ? "supporting" : "supporting";
  return { intent, tier, reply: Steer.pickReply({ lang, focus, tier: typeof tier === "number" ? tier : 0 }) };
}

test("end-to-end: English conversation with typos escalates tier and stays mechanical", () => {
  const state = Steer.createState();
  const transcript = [
    "waht do you mean",                                  // help/typo
    "he yelled at me evrey day for monhts and i was scared", // opens, typo-riddled
    "it got worse wehn he started hitting me and i didnt tell anyone", // opens
    "i finaly left last month wtih my kids",              // opens
  ];
  const seen = [];
  for (const line of transcript) seen.push(runTurn(state, "en", line));

  assert.equal(seen[0].intent.help, true);
  assert.ok(seen[3].tier === 1 || seen[3].tier === 2, "sustained sharing should raise the tier");
  for (const turn of seen) {
    const table = new Set([...Steer.REPLIES.en.supporting, Steer.REPLIES.en.safety]);
    assert.ok(table.has(turn.reply), "every reply must be a literal line from the mechanical table");
  }
});

test("end-to-end: Spanish conversation with typos, including a mid-conversation distress signal", () => {
  const state = Steer.createState();
  const transcript = [
    "no se que decir",                                    // help, no accents
    "el me grito todos los dias por meses y tenia miedo",  // opens
    "ya no puedo mas, a veces pienso en quitarme la vida", // distress, mid-conversation
    "perdon, estoy mejor ahora, solo fue un mal momento",  // recovering
  ];
  const seen = [];
  for (const line of transcript) seen.push(runTurn(state, "es", line));

  assert.equal(seen[2].intent.distress, true, "typo/accent-free Spanish distress phrase must still be caught");
  assert.equal(seen[2].tier, "safety");
  assert.equal(seen[2].reply, Steer.REPLIES.es.safety);
  // reply always comes from the Spanish table when lang="es", never English leakage
  for (const turn of seen) {
    assert.ok(!Object.values(Steer.REPLIES.en).flat().includes(turn.reply) || turn.reply === Steer.REPLIES.es.safety);
  }
});
