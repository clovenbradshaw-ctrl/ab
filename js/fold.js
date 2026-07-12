// fold.js — the prompt fold.
//
// The model's context is a PROJECTION of the log, not a running dump. It's the
// same move store.js makes for document state: state is never stored, it's
// recomputed from the timeline — and here the *prompt* is recomputed from the
// timeline + transcript on every turn, so it stays as small as the current
// question no matter how long the session ran. We never "put it all in the
// prompt"; we fold what's there down to minimal structure.
//
// Mirrors eoreader4.2's session-register fold (src/turn/converse/history.js):
// the recent turns VERBATIM + a SURFED recap of the older movers. Intake is a
// far more STRUCTURED conversation, though, so the two registers specialize:
//
//   document register  the confirmed answers, folded from the store into a
//                       compact ANSWERED block — the "lot of information"
//                       reduced to minimal structure the model reads instead
//                       of re-deriving it from raw transcript.
//   session register    the CURRENT FIELD's turns, verbatim within a token
//                       budget; an over-long support detour beyond the budget
//                       condenses to a one-line recap (the discourse fold), so
//                       a hard field with lots of back-and-forth never blows
//                       the context window.
//
// Cross-field chatter isn't recapped in prose the way eoreader does for free
// conversation: in a structured intake the only thing an earlier field ever
// "moved" is its answer, and that already lives in the document register. So
// the fold is leaner here by construction — the structure does the work.

const DEFAULTS = Object.freeze({
  budgetTokens: 500,   // the current field's verbatim window ceiling
  minRecent:    2,     // continuity floor: the question + the latest reply always ride
  maxNoteChars: 160,   // a folded detour line is a recap, not a replay
});

const estTokens = (s) => Math.ceil(String(s || "").length / 4);   // chars/4, the usual heuristic
const label = (role) => (role === "assistant" ? "Me:" : "You:");
const condense = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…";
};

// foldContext — recompute the model's context from state + transcript.
//   schema   the document (for order + labels)
//   answers  { path: value }   — answersOf(store.fold(), anchor)
//   history  [{ role, text, field? }]
//   field    the current field object, or null when the intake is complete
// -> { answered, recent, notes, stats }
export function foldContext({ schema, answers, history = [], field }) {
  // --- document register: confirmed answers, in document order ---
  const answered = schema.fields
    .filter((f) => answers[f.path] != null && answers[f.path] !== "")
    .map((f) => ({ path: f.path, label: f.label, value: answers[f.path] }));

  // --- session register: the CURRENT FIELD's discourse only ---
  let recent = [], notes = "";
  if (field) {
    // Segment on the FIRST assistant turn tagged with this field — that's where
    // this field's questioning opened. Everything before it belongs to
    // already-answered fields and has folded into the document register above;
    // everything from it on (the opening prompt plus any support back-and-forth,
    // all tagged with this same path) is this field's discourse.
    let start = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === "assistant" && history[i].field === field.path) { start = i; break; }
    }
    const seg = (start >= 0 ? history.slice(start) : history.slice(-DEFAULTS.minRecent))
      .filter((m) => m.text);

    // Verbatim window: newest -> oldest until the budget is spent AND the floor
    // is met (the floor keeps continuity even if one huge turn overflows alone).
    let used = 0, from = seg.length;
    for (let i = seg.length - 1; i >= 0; i--) {
      const kept = seg.length - 1 - i;
      const cost = estTokens(seg[i].text);
      if (used + cost > DEFAULTS.budgetTokens && kept >= DEFAULTS.minRecent) break;
      used += cost; from = i;
    }
    recent = seg.slice(from)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }));

    // Discourse fold: turns older than the window (a long support detour on THIS
    // field) condense to recap lines rather than being dropped outright.
    const older = seg.slice(0, from);
    if (older.length) {
      notes = older.map((m) => `${label(m.role)} ${condense(m.text, DEFAULTS.maxNoteChars)}`).join("\n");
    }
  }

  return {
    answered, recent, notes,
    stats: { answered: answered.length, recent: recent.length, folded: notes ? notes.split("\n").length : 0 },
  };
}

// Render the document register as compact, minimal-structure text for the prompt.
export function answeredBlock(answered) {
  if (!answered.length) return "(nothing recorded yet)";
  return answered.map((a) => `- ${a.label}: ${a.value}`).join("\n");
}
