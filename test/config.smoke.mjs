// config.smoke.mjs — Node smoke test for the shared config room fold.
//
//   node test/config.smoke.mjs
//
// No browser, no network. Uses an in-memory stub of the store surface config.js
// depends on (emit + timeline) and exercises the operations the admin surface
// performs: define fields, reorder, edit help, delete, seed. Asserts that
// foldConfig recomputes the live document correctly at each step.

import {
  foldConfig, putField, deleteField, setFieldOrder, setSystemPrompt,
  setMeta, putKnowledge, deleteKnowledge, seedConfig, ensureSeeded, DEFAULT_CONFIG,
} from "../js/config.js";

// Minimal store: just the append-log surface config.js uses (emit + timeline).
function makeStore() {
  const events = [];
  let n = 0;
  return {
    emit(op, payload) { const ev = { id: "e" + n++, op, payload, at: new Date().toISOString(), by: "@admin:test" }; events.push(ev); return ev; },
    timeline() { return events.slice(); },
  };
}

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// 1) A single field folds into an ordered schema of one.
{
  const s = makeStore();
  putField(s, { path: "name", label: "Name", type: "text", required: true, prompt: "Your name?", help: "As on ID." });
  const c = foldConfig(s.timeline());
  eq(c.schema.fields.map((f) => f.path), ["name"], "one field");
  eq(c.schema.fields[0].label, "Name", "field label folded");
  eq(c.schema.fields[0].required, true, "field required folded");
}

// 2) Editing a field is last-write-wins per path; a partial edit merges.
{
  const s = makeStore();
  putField(s, { path: "name", label: "Name", type: "text", required: true, prompt: "v1", help: "h1" });
  putField(s, { path: "name", label: "Full name", type: "text", required: true, prompt: "v2", help: "h1" });
  const c = foldConfig(s.timeline());
  eq(c.schema.fields.length, 1, "still one field after edit");
  eq(c.schema.fields[0].label, "Full name", "label updated");
  eq(c.schema.fields[0].prompt, "v2", "prompt updated");
}

// 3) Explicit order controls the sequence; new fields append after it.
{
  const s = makeStore();
  putField(s, { path: "a", label: "A", type: "text" });
  putField(s, { path: "b", label: "B", type: "text" });
  putField(s, { path: "c", label: "C", type: "text" });
  setFieldOrder(s, ["c", "a", "b"]);
  eq(foldConfig(s.timeline()).schema.fields.map((f) => f.path), ["c", "a", "b"], "reordered");
  putField(s, { path: "d", label: "D", type: "text" }); // added after the order list
  eq(foldConfig(s.timeline()).schema.fields.map((f) => f.path), ["c", "a", "b", "d"], "new field appended");
}

// 4) Deleting a field tombstones it out of the fold and out of a stale order.
{
  const s = makeStore();
  putField(s, { path: "a", label: "A", type: "text" });
  putField(s, { path: "b", label: "B", type: "text" });
  setFieldOrder(s, ["a", "b"]);
  deleteField(s, "a");
  eq(foldConfig(s.timeline()).schema.fields.map((f) => f.path), ["b"], "deleted field gone even though order still names it");
}

// 5) enum + type carry through; empty enum is dropped by putField.
{
  const s = makeStore();
  putField(s, { path: "g", label: "Ground", type: "enum", enum: ["X", "Y"] });
  putField(s, { path: "t", label: "Txt", type: "text", enum: [] });
  const c = foldConfig(s.timeline());
  eq(c.schema.fields.find((f) => f.path === "g").enum, ["X", "Y"], "enum kept");
  ok(!("enum" in c.schema.fields.find((f) => f.path === "t")), "empty enum dropped");
}

// 6) System prompt, meta, and knowledge fold; knowledge delete tombstones.
{
  const s = makeStore();
  setSystemPrompt(s, "be kind");
  setMeta(s, "title", "My intake");
  putKnowledge(s, { id: "k1", topic: "T", text: "help text", tags: ["a"], scope: { field: "name" } });
  putKnowledge(s, { id: "k2", topic: "T2", text: "more", tags: [], scope: {} });
  deleteKnowledge(s, "k2");
  const c = foldConfig(s.timeline());
  eq(c.systemPrompt, "be kind", "system prompt folded");
  eq(c.schema.title, "My intake", "title folded");
  eq(c.knowledge.map((k) => k.id), ["k1"], "knowledge delete tombstones");
  eq(c.knowledge[0].scope, { field: "name" }, "knowledge scope folded");
}

// 7) seedConfig reproduces the shipped default document; ensureSeeded is idempotent.
{
  const s = makeStore();
  seedConfig(s);
  const c = foldConfig(s.timeline());
  eq(c.schema.fields.map((f) => f.path), DEFAULT_CONFIG.fields.map((f) => f.path), "seed reproduces field order");
  eq(c.schema.title, DEFAULT_CONFIG.meta.title, "seed sets title");
  ok(c.meta.seeded === true, "seed marks seeded");
  const before = s.timeline().length;
  ensureSeeded(s);            // already seeded -> no new events
  eq(s.timeline().length, before, "ensureSeeded is idempotent");
}

// 8) ensureSeeded on an empty room seeds it once.
{
  const s = makeStore();
  const c = ensureSeeded(s);
  ok(c.schema.fields.length > 0, "empty room gets seeded");
  ok(c.meta.seeded === true, "seeded marker set");
}

console.log(`\nconfig fold smoke: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
