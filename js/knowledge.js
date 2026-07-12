// knowledge.js — the reference log.
//
// The "LOT of information" that would normally be stuffed into the prompt lives
// here as events instead, and is *folded on demand* into the slice a given turn
// actually needs. This is the surfer/retrieve seam from eoreader4.2: a scorer
// picks the relevant items for the current field, budgeted by size, so the
// prompt carries minimal structure and the system supplies the rest per turn.
//
// A knowledge item is just an INS-shaped record:
//   { id, topic, tags:[], scope:{ field?, anchor? }, text }
//
// In production these are room events (INS entity='knowledge') folded from a
// reference room; here they're seeded in memory. Swap `retrieve` for
// eoreader3/surfer's retriever and nothing else changes.

export class KnowledgeStore {
  constructor(items = []) { this._n = 0; this.items = items.map((i) => this._normalize(i)); }

  _normalize(i = {}) { return { id: i.id || "k" + (this._n++), topic: "", text: "", tags: [], scope: {}, ...i }; }

  add(item) { const it = this._normalize(item); this.items.push(it); return it; }

  // Edit an item in place (topic/text/tags/scope). Used by the memory editor —
  // the change shows up in the very next fold, no rebuild needed.
  update(id, patch = {}) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    Object.assign(it, patch);
    if (patch.scope) it.scope = { ...patch.scope };
    if (patch.tags) it.tags = [...patch.tags];
    return it;
  }

  remove(id) { const i = this.items.findIndex((x) => x.id === id); if (i >= 0) this.items.splice(i, 1); return i >= 0; }

  list() { return this.items.slice(); }

  // Plain-JSON snapshot / restore, so edited memory can persist across reloads.
  toJSON() { return this.items.map(({ id, topic, text, tags, scope }) => ({ id, topic, text, tags, scope })); }
  static fromJSON(arr) { return new KnowledgeStore(Array.isArray(arr) ? arr : []); }

  // Fold the relevant slice for a field into a compact reference block.
  // Returns { text, items } where `items` is what was actually included.
  retrieve(field, { budget = 700, seed = [] } = {}) {
    const kws = keywords(`${field.label} ${field.help || ""}`);
    const scored = this.items.map((it) => ({ it, s: score(it, field, kws) }))
      .filter((x) => x.s >= 2)   // scope (+5), a tag hit (+2), or 2+ keyword hits — never a lone generic word
      .sort((a, b) => b.s - a.s);

    const chosen = [];
    let used = 0;
    // seed items (e.g. the field's own help) always come first, then retrieved.
    for (const s of [...seed, ...scored.map((x) => x.it)]) {
      const block = `• ${s.topic}: ${s.text}`;
      if (used + block.length > budget && chosen.length) break;
      chosen.push(s); used += block.length + 1;
      if (used >= budget) break;
    }
    const text = chosen.map((s) => `• ${s.topic}: ${s.text}`).join("\n");
    return { text, items: chosen };
  }
}

function score(item, field, kws) {
  let s = 0;
  if (item.scope?.field === field.path) s += 5;
  if (Array.isArray(field.tags) && Array.isArray(item.tags))
    s += field.tags.filter((t) => item.tags.includes(t)).length * 2;
  const hay = keywords(`${item.topic} ${item.text} ${(item.tags || []).join(" ")}`);
  s += [...kws].filter((k) => hay.has(k)).length;
  return s;
}

const STOP = new Set("the a an of to for and or in on is are your you what which was were with about".split(" "));
function keywords(str) {
  return new Set((str.toLowerCase().match(/[a-z][a-z]{2,}/g) || []).filter((w) => !STOP.has(w)));
}

// Demo reference material scoped to the example schema's fields. Only the
// item(s) relevant to the current field will ever reach the prompt.
export const DEMO_KNOWLEDGE = new KnowledgeStore([
  { topic: "Legal name", scope: { field: "full_legal_name" }, tags: ["identity"],
    text: "Use the exact spelling from a government passport. Document mismatches are recorded as a note, not corrected silently." },
  { topic: "Protected grounds", scope: { field: "fear_basis" }, tags: ["asylum", "eligibility"],
    text: "Asylum requires a well-founded fear of persecution on one of five grounds: race, religion, nationality, political opinion, or membership in a particular social group. Cases often span several; pick the closest." },
  { topic: "Particular social group", scope: { field: "fear_basis" }, tags: ["asylum"],
    text: "A 'particular social group' shares an immutable characteristic (family, gender, sexual orientation, past experience) that the person cannot or should not be forced to change." },
  { topic: "Meaning of entry", scope: { field: "entry_date" }, tags: ["dates", "procedure"],
    text: "'Entry' is the most recent physical arrival in the U.S., including on foot. Approximate dates are flagged for review, never rejected." },
  { topic: "One-year deadline", scope: { field: "entry_date" }, tags: ["asylum", "deadline"],
    text: "Asylum is generally filed within one year of the last entry; exceptions exist for changed or extraordinary circumstances. The date matters for that test." },
  { topic: "Statelessness", scope: { field: "nationality" }, tags: ["identity"],
    text: "If the person holds no citizenship, record 'stateless' and the country of last habitual residence." },
  { topic: "Trauma-informed narrative", scope: { field: "narrative" }, tags: ["support", "wellbeing"],
    text: "The account need not be chronological or complete in one sitting. Fragmentary recall is normal after trauma; partial answers are saved and can be extended." },
]);
