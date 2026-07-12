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
  constructor(items = []) { this.items = items.map((i, n) => ({ id: i.id || "k" + n, tags: [], scope: {}, ...i })); }

  add(item) { this.items.push({ id: item.id || "k" + this.items.length, tags: [], scope: {}, ...item }); return this; }

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

// Demo reference material scoped to the sample schema's fields. Only the
// item(s) relevant to the current field will ever reach the prompt.
export const DEMO_KNOWLEDGE = new KnowledgeStore([
  { topic: "Identifying the account", scope: { field: "account_id" }, tags: ["identity"],
    text: "The account or phone number is on any recent bill or in the online account. Partial digits are enough to identify it — a full number is never required to open a complaint." },
  { topic: "Tracked reference and deadline", scope: { field: "description" }, tags: ["procedure", "core"],
    text: "A logged complaint carries a case reference and a set number of business days for a reply; an agent can't close it without responding. Filing does something concrete — it starts that clock." },
  { topic: "Escalation to the ombudsman", scope: { field: "resolution" }, tags: ["resolution", "escalation"],
    text: "If the deadline lapses or the reply doesn't resolve it, telecom complaints can be escalated to an independent industry ombudsman, free of charge. Recording the outcome you want sets the bar that escalation is measured against." },
  { topic: "Outage vs. billing", scope: { field: "issue_type" }, tags: ["triage"],
    text: "'Service outage' routes to the network team and is checked against known incidents; 'Billing' routes to accounts. Poor handling of either can be logged as 'Poor customer service' in addition." },
  { topic: "Approximate dates are fine", scope: { field: "started" }, tags: ["dates"],
    text: "An approximate start (\"early June\", \"about three weeks ago\") is accepted and flagged as approximate, never rejected. A precise date only matters where a specific event (an outage, a charge) anchors it." },
  { topic: "Prior contact is evidence", scope: { field: "prior_contact" }, tags: ["procedure"],
    text: "Every earlier call, chat or email counts — especially ones that went unresolved or where no reference was given. A pattern of contact without resolution strengthens the complaint." },
  { topic: "Impact counts", scope: { field: "impact" }, tags: ["impact", "wellbeing"],
    text: "Concrete effects beyond the service — hours lost on hold, a missed work call, extra costs — are optional but weigh on how a complaint is handled. Partial answers are saved and can be extended later." },
]);
