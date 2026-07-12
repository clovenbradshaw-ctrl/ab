// intake.js — the conversation fold.
//
// This is the turn loop (eoreader4.2's turn/converse, cut down). It owns no UI
// and no storage of its own: it reads `fold(store)` to know what's answered,
// asks the model for the next move, and on a confirmed answer emits ONE
// operator into the store. Progress is the room timeline, so the flow is
// resumable for free — reopen the room and fold tells you where you stopped.
//
// The model contract is a small JSON envelope, so even a 3B local model stays
// on the rails:
//   { reply, support?: bool, ready?: bool, extracted?: string|null }
//     reply     — what to say to the person (always)
//     support   — true when this turn is help/clarification, not an answer
//     ready      — true when `extracted` is a clean value awaiting confirmation
//     extracted — the normalized value to store on confirm

import { OP, answersOf } from "./store.js";
import { validate } from "./model.js";

const SYSTEM = `You are a calm, patient intake companion helping someone fill out a sensitive legal document one field at a time. You are not a lawyer and never give legal advice; you help them express what they already know.

Rules:
- Work only on the CURRENT FIELD. Never ask about other fields.
- If the person seems confused, stuck, or asks a question, help them — warmly, plainly, briefly. Set support=true and ready=false.
- When their message contains a usable answer, normalize it and set ready=true with extracted set to the clean value. Ask them to confirm in your reply.
- Never invent facts. If an answer is ambiguous, ask one short clarifying question instead of guessing.
- Keep replies short and human. No legal jargon, no lists unless they help.

Respond with ONLY a JSON object, no prose around it:
{"reply": string, "support": boolean, "ready": boolean, "extracted": string|null}`;

export class Intake {
  constructor({ schema, store, model, anchor = "applicant" }) {
    this.schema = schema; this.store = store; this.model = model; this.anchor = anchor;
    this.history = [];          // chat transcript for the UI
    this.pending = null;        // { field, value } awaiting confirmation
    this._listeners = new Set();
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(kind, data) { for (const fn of this._listeners) fn(kind, data); }

  answers() { return answersOf(this.store.fold(), this.anchor); }

  // Ordered progress view for the UI's checklist.
  progress() {
    const a = this.answers();
    return this.schema.fields.map((f) => ({ ...f, value: a[f.path], done: a[f.path] != null && a[f.path] !== "" }));
  }

  // Next unanswered field in document order. Requiredness governs whether you
  // can *finish* (isComplete), not the order questions are asked — a form that
  // jumps its optional fields to the end feels disorienting.
  nextField() {
    const a = this.answers();
    return this.schema.fields.find((f) => a[f.path] == null || a[f.path] === "");
  }

  isComplete() { return this.schema.fields.every((f) => !f.required || this.answers()[f.path]); }

  _say(role, text, meta = {}) {
    const msg = { role, text, at: Date.now(), ...meta };
    this.history.push(msg);
    this._emit("message", msg);
    return msg;
  }

  // Kick off / resume. Greets, then asks the first unanswered question.
  async begin() {
    if (this.history.length === 0) {
      const done = this.progress().filter((p) => p.done).length;
      this._say("assistant",
        done > 0
          ? `Welcome back. You've got ${done} of ${this.schema.fields.length} answered — let's pick up where you left off.`
          : this.schema.blurb);
    }
    await this._askNext();
  }

  async _askNext() {
    this.pending = null;
    const f = this.nextField();
    if (!f) { this._say("assistant", "That's everything I need. Your answers are all saved — you can review or edit any of them from the checklist."); this._emit("complete", this.answers()); return; }
    this._emit("field", f);
    this._say("assistant", f.prompt, { field: f.path });
  }

  // The person sent a message. Route it through the model, then act.
  async submit(text) {
    this._say("user", text);
    const f = this.nextField();
    if (!f) return;

    // If we're awaiting confirmation, interpret yes/no locally (cheap + reliable).
    if (this.pending) {
      if (/^(y|yes|yep|yeah|correct|right|ok|okay|confirm|looks good|👍)/i.test(text.trim())) {
        return this._confirm();
      }
      if (/^(n|no|nope|wrong|edit|change|redo)/i.test(text.trim())) {
        this.pending = null;
        this._say("assistant", "No problem — go ahead and tell me the right version.");
        return;
      }
      // Anything else: treat as a fresh answer to the same field (fall through).
      this.pending = null;
    }

    const thinking = this._say("assistant", "", { streaming: true, field: f.path });
    const messages = [
      { role: "system", content: `${SYSTEM}\n\nCURRENT FIELD: ${JSON.stringify({ label: f.label, type: f.type, required: f.required, enum: f.enum, help: f.help })}` },
      ...this.history.filter((m) => m.text).slice(-8).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })),
    ];

    let raw = "";
    try { raw = await this.model.chat(messages); }
    catch (e) { thinking.text = "The model isn't responding — you can keep typing and I'll store your answers directly."; thinking.streaming = false; this._emit("message", thinking); return; }

    const parsed = this._parse(raw, f, text);
    thinking.text = parsed.reply; thinking.streaming = false; thinking.support = parsed.support; this._emit("message", thinking);

    if (parsed.ready && parsed.extracted != null) {
      const err = validate(f, parsed.extracted);
      if (err) { this._say("assistant", err); return; }
      this.pending = { field: f, value: parsed.extracted };
      this._emit("pending", this.pending);
    }
  }

  // Store the confirmed answer as one DEF operator, then advance.
  _confirm() {
    const { field, value } = this.pending;
    const ev = this.store.emit(OP.DEF, { anchor: this.anchor, path: field.path, value });
    this.pending = null;
    this._emit("stored", { field, value, event: ev });
    return this._askNext();
  }

  // Direct edit from the checklist (bypasses chat): also just a DEF.
  editField(path, value) {
    const field = this.schema.fields.find((f) => f.path === path);
    const err = validate(field, value);
    if (err) return { ok: false, error: err };
    const ev = this.store.emit(OP.DEF, { anchor: this.anchor, path, value });
    this._emit("stored", { field, value, event: ev });
    return { ok: true, event: ev };
  }

  _parse(raw, field, userText) {
    // Pull the first {...} block; tolerate models that wrap it in prose/fences.
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try {
      const j = JSON.parse(m[0]);
      return { reply: j.reply || "Okay.", support: !!j.support, ready: !!j.ready, extracted: j.extracted ?? null };
    } catch {} }
    // No parseable envelope: treat the reply as support, and if the user's raw
    // text validates, offer it as the answer so the flow never dead-ends.
    const err = validate(field, userText);
    if (!err && userText.trim()) return { reply: `I'll record "${userText.trim()}" — does that look right?`, support: false, ready: true, extracted: userText.trim() };
    return { reply: raw.trim() || "Tell me a little more?", support: true, ready: false, extracted: null };
  }
}
