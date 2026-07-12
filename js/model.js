// model.js — the model membrane.
//
// One interface, three backends (mirrors eoreader4.2's model/ faculty:
// webllm / qwen-coders / echo). The controller only ever calls:
//
//   await model.ready()
//   await model.chat(messages) -> string           (full completion)
//   model.stream(messages, onToken) -> Promise      (optional streaming)
//
// Default is WebLLM, in-browser, zero server. Ollama is there for bigger
// models on a local daemon. Echo needs nothing at all and makes the whole
// intake flow demonstrable offline — it fakes a small instruct model well
// enough to drive the conversation and return the structured JSON the
// controller expects.

// ---- WebLLM: in-browser, WebGPU -------------------------------------------
export class WebLLMModel {
  constructor(modelId = "Llama-3.2-3B-Instruct-q4f16_1-MLC") {
    this.modelId = modelId; this.engine = null;
  }
  async ready(onProgress) {
    if (this.engine) return;
    const webllm = await import("https://esm.run/@mlc-ai/web-llm");
    this.engine = await webllm.CreateMLCEngine(this.modelId, {
      initProgressCallback: (r) => onProgress?.(r.text, r.progress),
    });
  }
  async chat(messages) {
    const r = await this.engine.chat.completions.create({ messages, temperature: 0.3 });
    return r.choices[0].message.content;
  }
  async stream(messages, onToken) {
    let full = "";
    const it = await this.engine.chat.completions.create({ messages, temperature: 0.3, stream: true });
    for await (const chunk of it) {
      const t = chunk.choices[0]?.delta?.content || "";
      if (t) { full += t; onToken?.(t); }
    }
    return full;
  }
}

// ---- Ollama: local daemon --------------------------------------------------
export class OllamaModel {
  constructor(model = "llama3.2", host = "http://localhost:11434") {
    this.model = model; this.host = host;
  }
  async ready() {
    const r = await fetch(this.host + "/api/tags").catch(() => null);
    if (!r || !r.ok) throw new Error("Ollama not reachable at " + this.host);
  }
  async chat(messages) {
    const r = await fetch(this.host + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, stream: false, options: { temperature: 0.3 } }),
    });
    const d = await r.json();
    return d.message.content;
  }
  async stream(messages, onToken) {
    const r = await fetch(this.host + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, stream: true, options: { temperature: 0.3 } }),
    });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let full = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); const t = j.message?.content || ""; if (t) { full += t; onToken?.(t); } } catch {}
      }
    }
    return full;
  }
}

// ---- Echo: no model, deterministic ----------------------------------------
// Not an LLM. It reads the same system contract the real backends get, finds
// the "CURRENT FIELD" block the controller injects, and returns the structured
// JSON the controller parses — so you can walk the entire intake with zero
// setup, then swap in WebLLM/Ollama without touching the controller.
export class EchoModel {
  async ready() {}
  async chat(messages) {
    const sys = messages.find((m) => m.role === "system")?.content || "";
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content?.trim() || "";
    const field = this._field(sys);

    // A bare "?" or help-ish message -> supportive explanation, no value yet.
    // Help now lives in the folded REFERENCE block (context.js), not the field
    // JSON, so read it from there; fall back to the field's own help, then a
    // generic nudge.
    if (/^\??$|help|what|why|explain|mean|unsure|don't know|dont know/i.test(lastUser) && lastUser.length < 40) {
      return JSON.stringify({
        reply: this._reference(sys) || field?.help || "Take your time — answer in whatever words feel natural and I'll tidy it up.",
        support: true, ready: false, extracted: null,
      });
    }
    // Otherwise treat the message as the answer, lightly validated.
    const value = lastUser;
    const err = field ? validate(field, value) : null;
    if (err) return JSON.stringify({ reply: err, support: true, ready: false, extracted: null });
    return JSON.stringify({
      reply: `Got it — I'll record "${value}". Does that look right?`,
      support: false, ready: true, extracted: value,
    });
  }
  stream(messages, onToken) { return this.chat(messages).then((s) => { onToken?.(s); return s; }); }

  _field(sys) {
    const m = sys.match(/CURRENT FIELD:\s*({[\s\S]*?})\s*(?:\n\n|$)/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  // Pull the first line of the folded REFERENCE block (the field's own help is
  // seeded first), stripped of its "• Topic: " prefix — Echo's stand-in for the
  // reasoning a real model would do over the retrieved reference.
  _reference(sys) {
    const m = sys.match(/REFERENCE \(folded for this field\):\n([\s\S]*?)(?:\n\n|$)/);
    if (!m) return "";
    return (m[1].split("\n")[0] || "").replace(/^•\s*[^:]*:\s*/, "").trim();
  }
}

// Shared lightweight validation, used by Echo and re-exported for the controller.
export function validate(field, value) {
  const v = (value ?? "").toString().trim();
  if (field.required && !v) return "This one's required — even a rough answer is fine to start.";
  if (field.type === "email" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "That doesn't look like an email address — mind checking it?";
  if (field.type === "date" && v && isNaN(Date.parse(v))) return "I couldn't read that as a date. A format like 1990-04-23 works well.";
  if (field.type === "number" && v && isNaN(Number(v))) return "That should be a number.";
  if (field.enum && v && !field.enum.some((o) => o.toLowerCase() === v.toLowerCase()))
    return `Please pick one of: ${field.enum.join(", ")}.`;
  return null;
}

export function makeModel(kind, opts = {}) {
  if (kind === "webllm") return new WebLLMModel(opts.model);
  if (kind === "ollama") return new OllamaModel(opts.model, opts.host);
  return new EchoModel();
}
