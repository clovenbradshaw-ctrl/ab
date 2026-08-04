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
  // confirming is a template, not a literal — it always embeds whatever
  // value it's given (see the next test), so here it's called the same way
  // pickReply defaults it (no meta -> "") to get the literal it will emit.
  const allEn = new Set([
    ...Steer.REPLIES.en.supporting,
    Steer.REPLIES.en.confirming(""), Steer.REPLIES.en.confirmed, Steer.REPLIES.en.denied,
    Steer.REPLIES.en.safety, Steer.REPLIES.en.closing,
  ]);
  for (const focus of ["confirmed", "denied", "safety", "closing"]) {
    assert.ok(allEn.has(Steer.pickReply({ lang: "en", focus })));
  }
  // confirming is parameterized by the value about to be stored (it echoes
  // the value back for the person to check) — a fixed template, not a fixed
  // literal, is what's mechanical about it.
  assert.equal(
    Steer.pickReply({ lang: "en", focus: "confirming", meta: { value: "Nora Alvarez" } }),
    Steer.REPLIES.en.confirming("Nora Alvarez")
  );
  for (let tier = 0; tier < 5; tier++) {
    assert.ok(allEn.has(Steer.pickReply({ lang: "en", focus: "supporting", tier })));
  }
});

test("mechanical replies: confirming embeds the captured value so it's clear what's being confirmed", () => {
  const en = Steer.pickReply({ lang: "en", focus: "confirming", meta: { value: "Nora Alvarez" } });
  const es = Steer.pickReply({ lang: "es", focus: "confirming", meta: { value: "Nora Alvarez" } });
  assert.match(en, /Nora Alvarez/);
  assert.match(es, /Nora Alvarez/);
  assert.equal(en, Steer.REPLIES.en.confirming("Nora Alvarez"));
  assert.equal(es, Steer.REPLIES.es.confirming("Nora Alvarez"));
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

test("tidyText: fixes unambiguous missing-apostrophe contractions, preserving case", () => {
  assert.equal(Steer.tidyText("i dont know what happened", "en"), "I dont know what happened".replace("dont", "don't"));
  assert.equal(Steer.tidyText("Dont go there", "en"), "Don't go there");
  assert.equal(Steer.tidyText("They said it wasnt her fault", "en"), "They said it wasnt her fault".replace("wasnt", "wasn't"));
});

test("tidyText: never touches ambiguous real words, even ones that look similar to a contraction typo", () => {
  // "were" is a real word (past tense of "are") — must NOT become "we're",
  // since that would change what a legal complaint says.
  assert.equal(Steer.tidyText("we were at the hearing", "en"), "We were at the hearing");
  // "ill" is a real word (sick) — must NOT become "I'll".
  assert.equal(Steer.tidyText("my daughter was ill that week", "en"), "My daughter was ill that week");
});

test("tidyText: capitalizes sentence starts and cleans stray whitespace/punctuation spacing", () => {
  assert.equal(Steer.tidyText("  he yelled at me .  then he left  ", "en"), "He yelled at me. Then he left");
});

test("tidyText: Spanish opening question/exclamation marks are restored when missing", () => {
  assert.equal(Steer.tidyText("como se llama tu hijo?", "es"), "¿Como se llama tu hijo?");
  assert.equal(Steer.tidyText("nunca me avisaron!", "es"), "¡Nunca me avisaron!");
});

test("tidyText: empty/whitespace-only input passes through safely", () => {
  assert.equal(Steer.tidyText("", "en"), "");
  assert.equal(Steer.tidyText("   ", "en"), "");
  assert.equal(Steer.tidyText(null, "en"), null);
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

// ── address parsing ─────────────────────────────────────────────────────────
// The address widget in index.html borrows structured street/city/state/ZIP
// boxes purely so the browser's own autofill has something standard to fill,
// then folds them back into the single string every other text field stores.
// These cover that fold in both directions.

test("address: canonical single-line form round-trips exactly", () => {
  const canonical = "123 Main St, Apt 4B, Nashville, TN 37201";
  const p = Steer.parseAddress(canonical);
  assert.deepEqual(p, { street: "123 Main St", unit: "Apt 4B", city: "Nashville", state: "TN", zip: "37201" });
  assert.equal(Steer.formatAddress(p), canonical);
});

test("address: parses without a unit, and with a ZIP+4", () => {
  assert.deepEqual(
    Steer.parseAddress("500 Oak Ridge Dr, Knoxville, TN 37920-1234"),
    { street: "500 Oak Ridge Dr", unit: "", city: "Knoxville", state: "TN", zip: "37920-1234" }
  );
});

test("address: a pasted multi-line address takes the same path as a comma-joined one", () => {
  const pasted = "123 Main St\nApt 4B\nNashville, TN 37201";
  assert.deepEqual(Steer.parseAddress(pasted), Steer.parseAddress("123 Main St, Apt 4B, Nashville, TN 37201"));
});

test("address: full state names resolve to their code, including multi-word ones", () => {
  assert.equal(Steer.parseAddress("1 Elm St, Memphis, Tennessee 38103").state, "TN");
  assert.equal(Steer.parseAddress("1 Elm St, Charlotte, North Carolina 28202").state, "NC");
  assert.equal(Steer.parseAddress("1 Elm St, Providence, Rhode Island 02903").state, "RI");
});

test("address: a city that shares a state's name is not eaten by the state matcher", () => {
  // "Washington, DC 20001" — the state matcher works right-to-left off the
  // LAST segment, so the city keeps its name.
  assert.deepEqual(
    Steer.parseAddress("1600 Pennsylvania Ave NW, Washington, DC 20001"),
    { street: "1600 Pennsylvania Ave NW", unit: "", city: "Washington", state: "DC", zip: "20001" }
  );
  assert.equal(Steer.parseAddress("350 5th Ave, New York, NY 10001").city, "New York");
});

test("address: with no commas at all, state and ZIP still come off and nothing is invented", () => {
  // There's no non-guessing way to find the city boundary here, so the
  // remainder stays whole in `street` rather than being split on a hunch.
  assert.deepEqual(
    Steer.parseAddress("123 Main St Nashville TN 37201"),
    { street: "123 Main St Nashville", unit: "", city: "", state: "TN", zip: "37201" }
  );
});

test("address: parse -> format never drops what the person wrote", () => {
  const inputs = [
    "123 Main St, Apt 4B, Nashville, TN 37201",
    "PO Box 88, Erwin, TN 37650",
    "c/o Room In The Inn, 705 Drexel St, Nashville, TN 37203",
    "the shelter on 5th, ask for Nora",
    "Rural Route 2 Box 14, Sneedville, Tennessee",
    "Unit 7, Building C, 90 Airport Rd, Gatlinburg, TN 37738",
    "no fixed address right now",
    "Tennessee",
    "37201",
  ];
  const words = (s) => s.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  for (const input of inputs) {
    const parsed = Steer.parseAddress(input);
    const out = Steer.formatAddress(parsed);
    // A full state name legitimately canonicalizes to its code ("Tennessee"
    // -> "TN"), which is a rewrite, not a loss — so the words it was built
    // from are excused, and the code has to actually be there.
    const canonicalized = new Set();
    if (parsed.state) {
      const st = Steer.lookupState(parsed.state);
      for (const w of words(st.name)) canonicalized.add(w);
      assert.ok(words(out).includes(parsed.state.toLowerCase()), `state code missing from "${out}"`);
    }
    for (const w of words(input)) {
      if (canonicalized.has(w)) continue;
      assert.ok(words(out).includes(w), `"${w}" from "${input}" was dropped — became "${out}"`);
    }
  }
});

test("address: a trailing country is dropped, but only when something else remains", () => {
  assert.equal(Steer.parseAddress("123 Main St, Nashville, TN 37201, USA").city, "Nashville");
  assert.equal(Steer.formatAddress(Steer.parseAddress("123 Main St, Nashville, TN 37201, USA")), "123 Main St, Nashville, TN 37201");
  assert.equal(Steer.parseAddress("USA").street, "USA", "a lone country is all they gave us — keep it");
});

test("address: empty and whitespace-only input parse to a blank address, not a crash", () => {
  for (const v of ["", "   ", null, undefined, "\n\n"]) {
    assert.deepEqual(Steer.parseAddress(v), Steer.emptyAddress());
  }
  assert.equal(Steer.formatAddress(Steer.emptyAddress()), "");
  assert.equal(Steer.formatAddress(null), "");
});

test("address: a half-filled address formats as a sentence, not stray commas", () => {
  assert.equal(Steer.formatAddress({ street: "123 Main St", city: "Nashville" }), "123 Main St, Nashville");
  assert.equal(Steer.formatAddress({ state: "TN", zip: "37201" }), "TN 37201");
  assert.equal(Steer.formatAddress({ street: "PO Box 12", zip: "37201" }), "PO Box 12, 37201");
});

test("address: lookupState accepts codes, names, and casing; returns null rather than guessing", () => {
  assert.equal(Steer.lookupState("tn").code, "TN");
  assert.equal(Steer.lookupState("Tennessee").code, "TN");
  assert.equal(Steer.lookupState("TN.").code, "TN");
  assert.equal(Steer.lookupState("Puerto Rico").code, "PR");
  assert.equal(Steer.lookupState("AE").code, "AE", "military posts get federal mail too");
  assert.equal(Steer.lookupState("Nashville"), null);
  assert.equal(Steer.lookupState(""), null);
});

test("address: ZIP check accepts 5-digit and ZIP+4, rejects the rest", () => {
  assert.equal(Steer.isValidZip("37201"), true);
  assert.equal(Steer.isValidZip("37201-1234"), true);
  assert.equal(Steer.isValidZip("3720"), false);
  assert.equal(Steer.isValidZip("abcde"), false);
  assert.equal(Steer.isValidZip(""), false);
});

test("address fields never block on format — only on being empty when required", () => {
  const field = { path: "complainant_address", type: "address", required: true };
  // Nothing about the shape of what they typed is grounds for refusing it.
  assert.equal(Steer.validate(field, "no fixed address right now", "en"), null);
  assert.equal(Steer.validate(field, "c/o my sister, 12 Elm, Nashville TN 3720", "en"), null);
  assert.equal(Steer.validate(field, "", "en"), Steer.VALIDATION_MESSAGES.en.required);
  assert.equal(Steer.validate({ ...field, required: false }, "", "en"), null);
});
