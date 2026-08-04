// test/bulk.e2e.test.js — Intake.extractBulk()/commitBulk(), the "answer
// several at once" escape hatch from the one-field-at-a-time chat. Runs
// against the REAL extracted engine, with a small fake per-field-aware
// model standing in for a real LLM backend (EchoModel can't do this job —
// see the guard test below, and the comment on extractBulk in index.html).
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

// A minimal stand-in for a real backend that actually reads CURRENT FIELD
// and only answers ready:true for the field it recognizes text for — the
// behavior a real small LLM is expected to have, and EchoModel does not.
class FakeFieldAwareModel {
  constructor() { this.calls = 0; }
  async chat(messages) {
    this.calls++;
    const sys = messages.find((m) => m.role === "system")?.content || "";
    const user = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const fm = sys.match(/CURRENT FIELD:\s*({[\s\S]*?})\n/);
    const field = fm ? JSON.parse(fm[1]) : {};
    const label = (field.label || "").toLowerCase();
    let extracted = null;
    if (label.includes("full name")) extracted = "frank smith";
    else if (label.includes("relationship")) extracted = /father|mother|parent/i.test(user) ? "Parent" : null;
    else if (label.includes("email")) { const m = user.match(/[\w.+-]+@[\w-]+\.\w+/); extracted = m ? m[0] : null; }
    return JSON.stringify({ support: extracted == null, ready: extracted != null, extracted, distress: false });
  }
}

function makeIntake(engine, model, lang = "en") {
  const store = makeStore(engine);
  const intake = new engine.Intake({ schema: engine.SCHEMA, store, model, lang });
  return { intake, store };
}

test("extractBulk finds candidates for the fields a field-aware model recognizes, and only those", async () => {
  const engine = loadEngine();
  const model = new FakeFieldAwareModel();
  const { intake } = makeIntake(engine, model);
  await intake.begin();

  const text = "My name is frank smith and I'm the father. Reach me at frank@example.com.";
  const result = await intake.extractBulk(text);

  assert.equal(result.distress, false);
  const byPath = Object.fromEntries(result.candidates.map((c) => [c.field.path, c.value]));
  assert.equal(byPath.complainant_name, "Frank Smith"); // nameCase applied, same tidyText as chat
  assert.equal(byPath.complainant_relationship, "Parent");
  assert.equal(byPath.complainant_email, "frank@example.com");
  // Fields the fake model has no logic for (address, phone, ...) must not
  // show up as false-positive candidates.
  assert.equal(byPath.complainant_address, undefined);
  assert.equal(byPath.complainant_phone, undefined);
});

test("extractBulk probes fields sequentially, one model.chat() call per still-unanswered field", async () => {
  const engine = loadEngine();
  const model = new FakeFieldAwareModel();
  const { intake } = makeIntake(engine, model);
  await intake.begin();
  const unanswered = intake.progress().filter((p) => !p.done).length;
  await intake.extractBulk("My name is frank smith.");
  assert.equal(model.calls, unanswered);
});

test("extractBulk: a distress phrase short-circuits locally, shows the safety line, and never calls the model", async () => {
  const engine = loadEngine();
  const model = new FakeFieldAwareModel();
  const { intake } = makeIntake(engine, model);
  await intake.begin();

  const result = await intake.extractBulk("I dont want to go on anymore, want to die");
  assert.equal(result.distress, true);
  assert.equal(result.candidates.length, 0);
  assert.equal(model.calls, 0, "distress must be caught locally before any per-field model call");
  assert.equal(intake.history[intake.history.length - 1].text, engine.Steer.REPLIES.en.safety);
});

test("extractBulk: a distress signal returned mid-probe by the model also stops immediately", async () => {
  const engine = loadEngine();
  class DistressMidwayModel {
    constructor() { this.calls = 0; }
    async chat() {
      this.calls++;
      if (this.calls === 2) return JSON.stringify({ support: true, ready: false, extracted: null, distress: true });
      return JSON.stringify({ support: true, ready: false, extracted: null, distress: false });
    }
  }
  const model = new DistressMidwayModel();
  const { intake } = makeIntake(engine, model);
  await intake.begin();
  const result = await intake.extractBulk("some ordinary bulk text");
  assert.equal(result.distress, true);
  assert.equal(model.calls, 2, "must stop probing further fields the instant distress is signaled");
});

test("commitBulk stores accepted candidates with inputKind 'bulk' and the original text as source, then resumes the chat", async () => {
  const engine = loadEngine();
  const model = new FakeFieldAwareModel();
  const { intake } = makeIntake(engine, model);
  await intake.begin();

  const text = "My name is frank smith and I'm the father.";
  const result = await intake.extractBulk(text);
  await intake.commitBulk(result.candidates);

  assert.equal(intake.answers().complainant_name, "Frank Smith");
  assert.equal(intake.answers().complainant_relationship, "Parent");

  const folded = intake.store.fold();
  const prov = engine.provenanceOf(folded, "applicant");
  assert.equal(prov.complainant_name.inputKind, "bulk");
  assert.equal(prov.complainant_name.source, text);

  // Chat resumes on whatever's still unanswered next, same as after any
  // other confirmed answer.
  const nextField = intake.nextField();
  assert.ok(nextField, "should still have unanswered fields left");
  assert.equal(intake.history[intake.history.length - 1].text, nextField.prompt);
});

test("commitBulk: only the accepted subset is stored — a candidate the person unchecked or rejected in review never reaches the store", async () => {
  const engine = loadEngine();
  const model = new FakeFieldAwareModel();
  const { intake } = makeIntake(engine, model);
  await intake.begin();

  const result = await intake.extractBulk("My name is frank smith and I'm the father.");
  const nameOnly = result.candidates.filter((c) => c.field.path === "complainant_name");
  await intake.commitBulk(nameOnly);

  assert.equal(intake.answers().complainant_name, "Frank Smith");
  assert.equal(intake.answers().complainant_relationship, undefined);
});

test("extractBulk against EchoModel (Demo mode) is unsafe to trust for unconstrained text fields — documents why the UI gates bulk mode to real backends only", async () => {
  // EchoModel has no semantic understanding (see vendor/steer.js): for any
  // unconstrained "text" field it just echoes the whole message back as
  // soon as it passes validate() (which is nearly always, for free text).
  // Run against a real multi-topic bulk paragraph, it will confidently
  // "extract" the ENTIRE paragraph as the answer to *every* unconstrained
  // text field. This test locks in that documented limitation so nobody
  // accidentally wires EchoModel into bulk mode expecting it to behave
  // like a real extractor.
  const engine = loadEngine();
  const { intake } = makeIntake(engine, new engine.EchoModel());
  await intake.begin();
  const text = "My name is Frank Smith, I'm the father, my number is 615-555-0134.";
  const result = await intake.extractBulk(text);
  const nameCandidate = result.candidates.find((c) => c.field.path === "complainant_name");
  const addressCandidate = result.candidates.find((c) => c.field.path === "complainant_address");
  assert.ok(nameCandidate && addressCandidate, "EchoModel dumps the same blob into every unconstrained text field");
  assert.equal(nameCandidate.value, addressCandidate.value, "proof it's not real per-field extraction — every field gets the identical text");
});
