// integration.smoke.mjs — the two-room split, end to end, no browser.
//
//   node test/integration.smoke.mjs
//
// Drives the REAL modules: an admin authors the shared config room, the intake
// folds that room into its question set, and a user walks the intake with the
// EchoModel — proving (a) admin edits reach the user through the fold, and
// (b) the user's answers land in their OWN room, never the shared config room.
//
// DemoStore falls back to an in-memory log when localStorage is absent (Node),
// so this runs the production code paths unchanged.

import { DemoStore } from "../js/store.js";
import { EchoModel } from "../js/model.js";
import { KnowledgeStore } from "../js/knowledge.js";
import { Intake } from "../js/intake.js";
import { foldConfig, ensureSeeded, putField, setFieldOrder, CONFIG_ANCHOR } from "../js/config.js";

let passed = 0, failed = 0;
const ok = (c, m) => { c ? passed++ : (failed++, console.error("  ✗ " + m)); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// --- admin authors the shared config room ----------------------------------
const configStore = await new DemoStore("@admin:local").open("!intake-config:local");
ensureSeeded(configStore);                                   // seed the example doc

// Admin adds a new question and moves it to the front.
putField(configStore, { path: "preferred_language", label: "Preferred language", type: "text", required: true, prompt: "What language are you most comfortable in?", help: "We'll try to match you." });
const orderNow = foldConfig(configStore.timeline()).schema.fields.map((f) => f.path);
setFieldOrder(configStore, ["preferred_language", ...orderNow.filter((p) => p !== "preferred_language")]);

// Admin tweaks an existing question's prompt.
putField(configStore, { path: "full_legal_name", label: "Full legal name", type: "text", required: true, prompt: "EDITED: your full legal name?", help: "As printed on your passport." });

// --- the user's app folds that room into its live document ------------------
const cfg = foldConfig(configStore.timeline());
eq(cfg.schema.fields[0].path, "preferred_language", "admin's new question is first for the user");
eq(cfg.schema.fields.find((f) => f.path === "full_legal_name").prompt, "EDITED: your full legal name?", "admin's edit reaches the user through the fold");
ok(cfg.schema.fields.length >= 9, "seeded fields + the new one are all present");

// --- the user answers into their OWN private room --------------------------
const answerStore = await new DemoStore("@amir:local").open("!intake-answers-amir:local");
const knowledge = KnowledgeStore.fromJSON(cfg.knowledge);
const intake = new Intake({ schema: cfg.schema, store: answerStore, model: new EchoModel(), knowledge, systemPrompt: cfg.systemPrompt });

await intake.begin();
eq(intake.nextField().path, "preferred_language", "intake asks the admin-defined first question");

// Answer the first field: Echo offers the value, "yes" confirms -> one DEF.
await intake.submit("Dari");
await intake.submit("yes");
eq(intake.answers().preferred_language, "Dari", "confirmed answer is stored");

// The answer is in the USER's room only — the shared config room is untouched.
const answerEvents = answerStore.timeline().filter((e) => e.op === "DEF" && e.payload.anchor === "applicant");
eq(answerEvents.length, 1, "exactly one answer DEF in the user's room");
const leakedToConfig = configStore.timeline().some((e) => e.payload?.anchor === "applicant" || e.payload?.path === "preferred_language" && e.op === "DEF" && e.payload?.anchor === "applicant");
ok(!leakedToConfig, "no user answer leaked into the shared config room");
const configHasApplicant = configStore.timeline().some((e) => e.op === "DEF" && e.payload.anchor === "applicant");
ok(!configHasApplicant, "shared config room holds only config, never applicant answers");

// Resumable by construction: a BRAND-NEW controller with zero internal state,
// pointed at the same timeline, recomputes the place from fold() alone.
const resumed = new Intake({ schema: cfg.schema, store: answerStore, model: new EchoModel(), knowledge, systemPrompt: cfg.systemPrompt });
eq(resumed.answers().preferred_language, "Dari", "fresh controller recovers the answer from the log (resumable by fold)");
eq(resumed.nextField().path, cfg.schema.fields[1].path, "resume advances past the answered field");

console.log(`\nintegration smoke: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
