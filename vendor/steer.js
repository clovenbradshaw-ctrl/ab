// steer.js — the discourse-physics steering faculty.
//
// The chat model (webllm/ollama) is never allowed to author the text a
// person reads. Its only job each turn is to CLASSIFY the turn — did they
// share something, deflect, ask for help, confirm, deny, or signal
// distress? Everything the person actually sees comes from the fixed,
// hand-written, bilingual reply table below (REPLIES). That's what keeps
// the visible conversation predictable and reviewable no matter how small
// or occasionally-wrong the local model is: a bad classification picks the
// wrong *tier* of a vetted line, it can never put unvetted words in the
// app's mouth.
//
// Which tier gets picked is "steered" by a tiny physics model, not by
// looking only at the last message: `opening` is a position, `momentum`
// is its velocity, and each turn's signal is a force applied through a
// damped spring (see applyForce). Sharing detail nudges it up over
// several turns; deflecting nudges it down; both decay toward the
// midpoint on their own, the way eoreader6's discourse/index.js decays
// motif weight every tick. One good sentence doesn't jump the person to
// "tell me everything" and one bad turn doesn't reset all the trust
// they've built — same shape as a spring settling, not a step function.
//
// distress is tracked the same way but is deliberately NOT physics-gated:
// a single distress signal always wins, immediately, regardless of
// `opening`. See classifyIntent's note on why it also ignores the UI
// language toggle.
//
// Loaded two ways from one file: `<script src="vendor/steer.js">` in the
// browser (attaches `window.Steer`), `require("./vendor/steer.js")` in
// Node tests. Zero dependencies either way.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Steer = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ---- physics: a damped spring over turns --------------------------------
  // Tunable but deliberately mild: SPRING pulls opening toward the force,
  // DAMPING bleeds momentum every turn so the state can't oscillate forever.
  const SPRING = 0.35;
  const DAMPING = 0.7;
  const DISTRESS_RISE = 0.6;
  const DISTRESS_DECAY = 0.6;

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function createState() {
    return { opening: 0, momentum: 0, distress: 0, turns: 0 };
  }

  // signal: { opens?: bool, deflects?: bool, distress?: bool }
  // Mutates and returns `state` — same in-place-decay shape as
  // eoreader6's decayMotifs, so a session is just "the state so far",
  // cheap to carry around and to reset.
  function applyForce(state, signal = {}) {
    const force = signal.opens ? 1 : signal.deflects ? -0.5 : 0;
    state.momentum = (state.momentum + force * SPRING) * DAMPING;
    const next = state.opening + state.momentum;
    state.opening = clamp(next, 0, 1);
    // Hitting the wall stops the ball: without this, momentum keeps
    // building while `opening` sits pinned at the clamp, and a single
    // deflection afterward isn't enough to move it — the state reads as
    // "still fully open" even though the person just pulled back. An
    // inelastic wall (zero momentum on clamp) keeps every future force
    // starting from rest, so one bad turn always registers.
    if (state.opening !== next) state.momentum = 0;
    state.distress = signal.distress
      ? Math.min(1, state.distress + DISTRESS_RISE)
      : state.distress * DISTRESS_DECAY;
    state.turns++;
    return state;
  }

  // Which tier of the mechanical script this state calls for. "safety"
  // always outranks everything else, at any opening level.
  function tierOf(state) {
    if (state.distress >= 0.5) return "safety";
    if (state.opening >= 0.66) return 2;
    if (state.opening >= 0.33) return 1;
    return 0;
  }

  // ---- typo-tolerant intent matching ---------------------------------------
  function normalize(s) {
    return (s || "")
      .toString()
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents: e.g. si + combining acute -> si
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Damerau-Levenshtein (optimal string alignment): plain edit distance
  // plus adjacent transpositions counting as one edit, since "teh"/"yse"
  // are the single most common typo shape and shouldn't cost two edits.
  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const d = [];
    for (let i = 0; i <= m; i++) d.push([i]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, d[i - 2][j - 2] + cost);
        }
        d[i][j] = v;
      }
    }
    return d[m][n];
  }

  // Edit-distance tolerance scales with word length so short words ("no",
  // "si") still require a near-exact hit rather than matching anything.
  function wordMatches(word, target) {
    if (!word || !target) return false;
    const tolerance = target.length <= 5 ? 1 : 2;
    return levenshtein(word, target) <= tolerance;
  }

  // Multi-word phrases match if every phrase word fuzzy-matches some word
  // in the scanned zone, in any order — "dont no" still reaches "don't know".
  function phraseFuzzyPresentIn(zoneWords, phrase) {
    const normPhrase = normalize(phrase);
    if (normPhrase.includes(" ")) {
      return normPhrase.split(" ").every((pw) => zoneWords.some((zw) => wordMatches(zw, pw)));
    }
    return zoneWords.some((zw) => wordMatches(zw, normPhrase));
  }

  // `leading` restricts the scan to the first N normalized words. A yes/
  // no/help read is only trustworthy near the START of a reply ("yes,
  // that's right" / "no wait" / "not sure, can you explain?") — scanning
  // an entire long, detailed disclosure for the same short words would
  // false-positive constantly, since ordinary narration is full of them
  // ("...and I said no, and I still don't understand why..."). distress
  // phrases get no such limit: a crisis signal buried mid-paragraph still
  // has to fire.
  function matchesAny(text, phrases, { leading = null } = {}) {
    const norm = normalize(text);
    if (!norm) return false;
    const words = norm.split(" ");
    const zone = leading ? words.slice(0, leading) : words;
    return phrases.some((p) => phraseFuzzyPresentIn(zone, p));
  }

  const LEXICON = {
    en: {
      yes: ["yes", "yeah", "yep", "yup", "sure", "correct", "right", "ok", "okay", "confirm", "looks good", "sounds good"],
      no: ["no", "nope", "nah", "wrong", "incorrect", "edit", "change", "redo", "not right"],
      // Deliberately no bare "what"/"why"/"mean": those are ordinary
      // sentence-openers in real narrative answers ("What DCS did was...",
      // "Why they moved her is..."), not just clarification requests. Only
      // multi-word phrases that are unambiguously a person asking THIS app
      // something, not describing their own situation.
      help: ["help", "what does", "what do you mean", "what does that mean", "why do you need that", "why is that", "explain", "unsure", "confused", "stuck", "dont know", "don't know", "not sure"],
    },
    es: {
      yes: ["si", "sí", "vale", "correcto", "claro", "asi es", "así es", "dale", "esta bien", "está bien"],
      no: ["no", "nel", "incorrecto", "mal", "cambiar", "corregir", "editar", "no es correcto"],
      // Same reasoning as the English list: no bare "que"/"qué"/"porque" —
      // "que" especially is one of the most common words in Spanish
      // narration generally, not a help signal on its own.
      help: ["ayuda", "que significa", "qué significa", "por que necesitas", "explicar", "no se", "no sé", "confundido", "confundida", "no entiendo"],
    },
  };

  // Crisis-signal keywords, checked in BOTH languages regardless of the
  // active UI language: a person's safety can never depend on the app
  // having guessed which language they're typing in. This is a plain
  // keyword heuristic, not a clinical risk assessment — it exists only to
  // trigger the safety line and hand off to real crisis resources, never
  // to gate, block, or diagnose.
  const DISTRESS_PHRASES = {
    en: ["kill myself", "suicide", "hurt myself", "want to die", "cant go on", "can't go on", "end it all", "harm myself", "no reason to live"],
    es: ["matarme", "suicidio", "hacerme dano", "hacerme daño", "quiero morir", "no puedo mas", "no puedo más", "acabar con todo", "quitarme la vida", "hacerme dano a mi mismo"],
  };

  function classifyIntent(text, lang) {
    const l = LEXICON[lang] ? lang : "en";
    const trimmed = (text || "").trim();
    return {
      yes: matchesAny(trimmed, LEXICON[l].yes, { leading: 4 }),
      no: matchesAny(trimmed, LEXICON[l].no, { leading: 4 }),
      help: matchesAny(trimmed, LEXICON[l].help, { leading: 5 }),
      distress: matchesAny(trimmed, DISTRESS_PHRASES.en) || matchesAny(trimmed, DISTRESS_PHRASES.es),
    };
  }

  // ---- the fixed, bilingual, mechanical reply table ------------------------
  // Nothing here is generated. Every line was written and reviewed once;
  // the app only ever picks among them. `field.prompt` / `field.promptEs`
  // are treated the same way — schema-authored, not model-authored.
  const REPLIES = {
    en: {
      supporting: [
        "Take your time — there's no rush, and you can answer in whatever words feel natural.",
        "No pressure to get it perfect. Share as much, or as little, as feels okay right now.",
        "You're doing fine. Even a partial answer helps — we can always add more later.",
      ],
      confirming: "Does that look right? You can say yes to keep it, or no to change it.",
      confirmed: "Thank you — I've saved that.",
      denied: "No problem — go ahead and tell me the version you'd like instead.",
      safety: "Thank you for trusting me with that. Your safety matters more than this form. If you're in immediate danger, please contact your local emergency number, or a crisis line — in the US you can call or text 988. We can keep going whenever, and only whenever, you're ready.",
      closing: "That's everything I need for now. Thank you for sharing this with me — you can review or change any answer from the checklist whenever you like.",
      welcomeBack: (done, total) => `Welcome back. You've got ${done} of ${total} answered — let's pick up where you left off.`,
    },
    es: {
      supporting: [
        "Tómate tu tiempo — no hay prisa, y puedes responder con las palabras que te resulten naturales.",
        "No tienes que decirlo perfecto. Comparte tanto, o tan poco, como te sientas cómodo o cómoda ahora mismo.",
        "Lo estás haciendo bien. Incluso una respuesta parcial ayuda — siempre podemos añadir más después.",
      ],
      confirming: "¿Está correcto? Puedes decir sí para guardarlo, o no para cambiarlo.",
      confirmed: "Gracias — ya lo guardé.",
      denied: "No hay problema — dime la versión correcta cuando quieras.",
      safety: "Gracias por confiar en mí con eso. Tu seguridad importa más que este formulario. Si estás en peligro inmediato, por favor contacta a tu número de emergencia local, o a una línea de crisis — en EE. UU. puedes llamar o enviar un mensaje de texto al 988. Podemos continuar cuando, y solo cuando, te sientas listo o lista.",
      closing: "Eso es todo lo que necesito por ahora. Gracias por compartir esto conmigo — puedes revisar o cambiar cualquier respuesta desde la lista cuando quieras.",
      welcomeBack: (done, total) => `Bienvenido/a de nuevo. Ya tienes ${done} de ${total} respondidas — sigamos donde lo dejaste.`,
    },
  };

  // focus: "asking" | "clarifying" | "supporting" | "confirming" | "confirmed"
  //      | "denied" | "safety" | "closing" | "welcomeBack"
  // For "asking"/"clarifying", the field's own bilingual prompt/help is the
  // mechanical line — authored once in the schema, same trust level as
  // everything else here, just keyed by field instead of by focus.
  function pickReply({ lang = "en", focus, tier = 0, field = null, meta = {} } = {}) {
    const L = REPLIES[lang] || REPLIES.en;
    const f = field || {};
    if (focus === "asking") return (lang === "es" && f.promptEs) ? f.promptEs : (f.prompt || "");
    if (focus === "clarifying") {
      const help = (lang === "es" && f.helpEs) ? f.helpEs : f.help;
      return help || L.supporting[0];
    }
    if (focus === "supporting") return L.supporting[clamp(tier, 0, L.supporting.length - 1)];
    if (focus === "welcomeBack") return L.welcomeBack(meta.done ?? 0, meta.total ?? 0);
    if (L[focus]) return L[focus];
    return L.supporting[0];
  }

  // ---- conservative text tidy ------------------------------------------------
  // This is deliberately small: whitespace/punctuation cleanup, sentence
  // capitalization, and a short list of contractions that have no
  // legitimate alternate meaning without the apostrophe ("dont" is never
  // intentionally a word; "were" is, so it's NOT on this list — changing it
  // to "we're" could silently alter what a legal complaint says). This
  // feeds a federal civil rights complaint, so the bar is "never risk
  // changing meaning" over "catch everything" — anything ambiguous is left
  // alone for the person to fix themselves, and whatever this produces is
  // always shown back to them for an explicit yes/no before it's stored,
  // never substituted silently.
  //
  // Note on scope: true UniMorph (a cross-lingual morphological inflection
  // database) isn't realistically wireable into a single-file, no-build
  // browser app — there's no lightweight runtime for it. This approximates
  // the "basic spelling and grammar clean-up" goal with a compact,
  // hand-reviewed correction table instead; a local-model pass (see
  // Intake.submit's use of CLASSIFY_SCHEMA's `extracted`) does the more
  // context-sensitive normalization on top of this.
  const CONTRACTION_FIXES = {
    en: {
      dont: "don't", wont: "won't", cant: "can't", isnt: "isn't", wasnt: "wasn't",
      werent: "weren't", didnt: "didn't", doesnt: "doesn't", couldnt: "couldn't",
      shouldnt: "shouldn't", wouldnt: "wouldn't", hasnt: "hasn't", havent: "haven't",
      arent: "aren't", thats: "that's", whats: "what's", theres: "there's",
    },
    es: {
      // Spanish doesn't have an equivalent apostrophe-contraction class;
      // the fixable, unambiguous gap is missing question/exclamation marks
      // at the start, handled separately below, not via word substitution.
    },
  };

  function fixContractions(text, lang) {
    const table = CONTRACTION_FIXES[lang] || {};
    return text.replace(/[A-Za-zÀ-ÿ']+/g, (word) => {
      const key = word.toLowerCase();
      const fix = table[key];
      if (!fix) return word;
      // Preserve the original's capitalization style (e.g. "Dont" -> "Don't").
      return word[0] === word[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
    });
  }

  function capitalizeSentences(text) {
    return text.replace(/(^\s*|[.!?]\s+)([a-záéíóúñ])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }

  function tidyText(text, lang = "en") {
    if (!text) return text;
    let t = text.toString().replace(/\s+/g, " ").trim();
    if (!t) return t;
    t = t.replace(/\s+([,.!?;:])/g, "$1"); // no space before punctuation
    t = fixContractions(t, lang);
    t = capitalizeSentences(t);
    // Opening Spanish question/exclamation marks are easy to miss when
    // typing quickly (or transcribing speech) and cost nothing to add back
    // when the sentence clearly ends with the closing mark but doesn't open
    // with one.
    if (lang === "es") {
      if (/\?\s*$/.test(t) && !/^¿/.test(t)) t = "¿" + t;
      if (/!\s*$/.test(t) && !/^¡/.test(t)) t = "¡" + t;
    }
    return t;
  }

  // ---- bilingual field validation -------------------------------------------
  const VALIDATION_MESSAGES = {
    en: {
      required: "This one's required — even a rough answer is fine to start.",
      email: "That doesn't look like an email address — mind checking it?",
      date: "I couldn't read that as a date. A format like 1990-04-23 works well.",
      number: "That should be a number.",
      enumMsg: (opts) => `Please pick one of: ${opts.join(", ")}.`,
    },
    es: {
      required: "Este campo es obligatorio — una respuesta aproximada está bien para empezar.",
      email: "Eso no parece una dirección de correo electrónico — ¿puedes revisarla?",
      date: "No pude leer eso como una fecha. Un formato como 1990-04-23 funciona bien.",
      number: "Eso debería ser un número.",
      enumMsg: (opts) => `Por favor elige una opción: ${opts.join(", ")}.`,
    },
  };

  function validate(field, value, lang = "en") {
    const M = VALIDATION_MESSAGES[lang] || VALIDATION_MESSAGES.en;
    const v = (value ?? "").toString().trim();
    if (field.required && !v) return M.required;
    if (field.type === "email" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return M.email;
    if (field.type === "date" && v && isNaN(Date.parse(v))) return M.date;
    if (field.type === "number" && v && isNaN(Number(v))) return M.number;
    if (field.enum && v && !field.enum.some((o) => o.toLowerCase() === v.toLowerCase())) return M.enumMsg(field.enum);
    return null;
  }

  return {
    createState, applyForce, tierOf,
    classifyIntent, matchesAny, normalize, levenshtein,
    REPLIES, pickReply,
    VALIDATION_MESSAGES, validate,
    tidyText,
  };
});
