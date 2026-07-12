// context.js — the prompt is a projection.
//
// Instead of a fixed system prompt + the whole transcript, the messages sent to
// the model are *folded per turn* from two logs:
//
//   knowledge  — reference material, folded to the slice this field needs
//   discourse  — the conversation, folded so only the LIVE exchange is verbatim
//
// The discourse trick is the important one: every confirmed answer is a stored
// DEF, so the turns that produced it are redundant with fold(timeline). We
// don't summarize resolved turns — we DROP them and represent them as a compact
// digest of the answer fold. The live window is only the turns since the last
// store, so prompt size stays ~constant no matter how long the session runs.

import { fold, answersOf } from "./store.js";

// Minimal fixed structure. Everything situational is folded in below.
export const MINIMAL_SYSTEM =
`You are a calm intake companion helping someone fill a sensitive document one field at a time. You are not a lawyer and give no legal advice.
Work only on the current field. If they seem stuck or ask a question, help briefly (support=true, ready=false). When their message contains a usable answer, normalize it, set ready=true and extracted to the clean value, and ask them to confirm. Never invent facts; if unsure, ask one short question.
Reply with ONLY a JSON object: {"reply":string,"support":boolean,"ready":boolean,"extracted":string|null}`;

// assemble -> { messages, stats }
// stats exposes what the fold decided, so the UI can show it (context is
// provenance too).
export function assemble({ field, discourse = [], timeline = [], knowledge = null, schema = null, anchor = "_root", budget = {} }) {
  const B = { knowledge: 700, digest: 400, liveTurns: 6, ...budget };
  const answers = answersOf(fold(timeline), anchor);

  // 1) Knowledge slice — the field's own help seeds it, then retrieved refs.
  const seed = field.help ? [{ topic: field.label, text: field.help }] : [];
  const know = knowledge
    ? knowledge.retrieve(field, { budget: B.knowledge, seed })
    : { text: seed.map((s) => `• ${s.topic}: ${s.text}`).join("\n"), items: seed };

  // 2) Answer digest — resolved fields, compact. This REPLACES all the chat
  //    that produced them.
  const digest = buildDigest(schema, answers, B.digest);

  // 3) Live window — only turns from the current epoch (said since the last
  //    store), capped. Epoch is order-based and collision-proof; if the caller
  //    didn't stamp epochs, fall back to the wall-clock boundary.
  const texted = discourse.filter((m) => m.text && (m.role === "user" || m.role === "assistant"));
  const hasEpoch = texted.some((m) => typeof m.epoch === "number");
  let live;
  if (hasEpoch) {
    const maxEpoch = Math.max(...texted.map((m) => m.epoch ?? 0));
    live = texted.filter((m) => (m.epoch ?? 0) === maxEpoch);
  } else {
    const lastStoreAt = lastDefAt(timeline);
    live = texted.filter((m) => !lastStoreAt || new Date(m.at).getTime() > new Date(lastStoreAt).getTime());
  }
  const dropped = texted.length - live.length;
  const window = live.slice(-B.liveTurns);

  const total = schema ? schema.fields.length : Object.keys(answers).length;
  const done = schema ? schema.fields.filter((f) => answers[f.path] != null && answers[f.path] !== "").length : 0;

  const systemParts = [
    MINIMAL_SYSTEM,
    `CURRENT FIELD: ${JSON.stringify({ label: field.label, type: field.type, required: field.required, enum: field.enum })}`,
  ];
  if (know.text) systemParts.push(`REFERENCE (folded for this field):\n${know.text}`);
  systemParts.push(`PROGRESS: ${done}/${total} captured.` + (digest ? `\nAlready recorded — do not re-ask:\n${digest}` : ""));

  const messages = [
    { role: "system", content: systemParts.join("\n\n") },
    ...window.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })),
  ];

  return {
    messages,
    stats: {
      knowledgeItems: know.items.length,
      knowledgeChars: know.text.length,
      liveTurns: window.length,
      droppedTurns: Math.max(0, dropped),
      digestedAnswers: digest ? digest.split("\n").length : 0,
      promptChars: messages.reduce((n, m) => n + m.content.length, 0),
    },
  };
}

function buildDigest(schema, answers, budget) {
  if (!schema) return "";
  const lines = [];
  let used = 0;
  for (const f of schema.fields) {
    const v = answers[f.path];
    if (v == null || v === "") continue;
    const line = `${f.label}: ${clip(String(v), 80)}`;
    if (used + line.length > budget && lines.length) break;
    lines.push(line); used += line.length + 1;
  }
  return lines.join("\n");
}

function lastDefAt(timeline) {
  let at = null;
  for (const e of timeline) if (e.op === "DEF") at = e.at; // timeline is ordered
  return at;
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
