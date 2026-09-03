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
  //
  // A 1-character target is the one length this scale can't safely give
  // ANY tolerance to: "n" and "a" (what "n/a" normalizes and splits into —
  // see phraseFuzzyPresentIn) sit within edit-distance 1 of nearly any
  // other single letter, which turns a specific decline phrase into a
  // near-wildcard against short, extremely common words — measured:
  // "I called the office in March." and "I am not sure what happened
  // next." both false-positived as "n/a" (matching "n"/"a" against the
  // pronoun "I") before this floor was added. "no"/"si" (2 characters)
  // still need the same tolerance="1" every other short word gets, or the
  // typo-tolerance tests for "nno"->"no" and "sii"->"si" stop passing.
  function wordMatches(word, target) {
    if (!word || !target) return false;
    const tolerance = target.length <= 1 ? 0 : target.length <= 5 ? 1 : 2;
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
  // ("...and I said no, and I still don't understand why..."). Single-word
  // phrases get an even tighter window (the first two words): "help" is a
  // genuine request when the whole reply is "help", but as the fifth word
  // of "we asked for legal help and..." it is ordinary narration about a
  // service, not a request aimed at this app — and "yes"/"no" a few words
  // into a sentence are just as often narrative, not confirmation. distress
  // phrases get no such limit: a crisis signal buried mid-paragraph still
  // has to fire.
  function matchesAny(text, phrases, { leading = null } = {}) {
    const norm = normalize(text);
    if (!norm) return false;
    const words = norm.split(" ");
    const zone = leading ? words.slice(0, leading) : words;
    return phrases.some((p) => {
      const single = !normalize(p).includes(" ");
      return phraseFuzzyPresentIn(single ? words.slice(0, 2) : zone, p);
    });
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
      // Only consulted for a field that's already both optional AND failed
      // its own type-format check (see the skip handling in index.html's
      // Intake._classifyAndReply) — never for plain unconstrained text
      // fields, where a real answer legitimately starting with "none" or
      // "n/a" ("N/A — no case number was assigned") must be stored as
      // written, not swallowed as a decline.
      skip: ["skip this", "skip it", "n/a", "not applicable", "i dont have one", "i don't have one", "dont have one", "don't have one", "i dont have any", "i don't have any", "i dont have it", "i don't have it", "dont have it", "don't have it", "none", "prefer not to say", "rather not say"],
    },
    es: {
      yes: ["si", "sí", "vale", "correcto", "claro", "asi es", "así es", "dale", "esta bien", "está bien"],
      no: ["no", "nel", "incorrecto", "mal", "cambiar", "corregir", "editar", "no es correcto"],
      // Same reasoning as the English list: no bare "que"/"qué"/"porque" —
      // "que" especially is one of the most common words in Spanish
      // narration generally, not a help signal on its own.
      help: ["ayuda", "que significa", "qué significa", "por que necesitas", "explicar", "no se", "no sé", "confundido", "confundida", "no entiendo"],
      skip: ["no aplica", "no tengo uno", "no tengo una", "no tengo", "ninguno", "ninguna", "prefiero no decir"],
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
      skip: matchesAny(trimmed, LEXICON[l].skip, { leading: 5 }),
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
      confirming: (value) => `You said: "${value}". Does that look right? You can say yes to keep it, or no to change it.`,
      confirmed: "Thank you — I've saved that.",
      // Hand-written variants of the same acknowledgement, rotated per
      // stored answer (see pickReply's meta.n) so a 30-question interview
      // doesn't repeat one identical line 30 times. Same trust level as
      // everything else in this table: written once, reviewed, never
      // generated.
      confirmedAlt: [
        "Got it — that's saved.",
        "Okay, I've noted that down.",
        "Saved — thank you.",
        "Thank you. That's recorded.",
      ],
      // Milestone encouragement, said occasionally after a save — never in
      // place of the acknowledgement, always in addition, and only at
      // moderate intervals so it stays meaningful.
      // The back-and-forth on an open question (see readAttempt below). One
      // line per rung of the ladder: the first time an answer comes back
      // unusable the question is specific, the second time it's easier and
      // says the way out. There is no third rung — Intake stops asking and
      // keeps whatever the person wrote (see MAX_PROBES).
      probing: {
        unreadable: [
          "Sorry — I couldn't quite make that out. Could you tell me in your own words what happened?",
          "I still can't read that one. Even a single plain sentence is enough, or you can skip this and come back to it later.",
        ],
        bare: [
          "Thank you — can you tell me a bit more? Even a sentence or two about what happened, and roughly when, really helps.",
          "Whatever you can add helps: who was involved, about when it happened, or what it's meant for your child. If that's all you want to say for now, say so and we'll move on.",
        ],
      },
      progress: (done, total) => `That's ${done} of ${total} — you're making real progress.`,
      // The OCR-complaint drive: how much of the *fileable complaint* is
      // still missing. Count-based so one wording works for any mix of
      // missing fields, in both languages.
      almostDone: (n) => n === 1
        ? "Nearly there — just one required piece of the complaint left."
        : `Nearly there — only ${n} required pieces of the complaint left.`,
      requiredDone: "That's every required part of the complaint covered — anything more you share now only makes it stronger.",
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
      confirming: (value) => `Dijiste: "${value}". ¿Está correcto? Puedes decir sí para guardarlo, o no para cambiarlo.`,
      confirmed: "Gracias — ya lo guardé.",
      confirmedAlt: [
        "Listo — quedó guardado.",
        "Bien, lo anoté.",
        "Guardado — gracias.",
        "Gracias. Quedó registrado.",
      ],
      probing: {
        unreadable: [
          "Perdón — no logré entender eso. ¿Puedes contarme con tus propias palabras qué pasó?",
          "Sigo sin poder leerlo. Con una sola frase sencilla basta, o puedes saltar esto y volver más tarde.",
        ],
        bare: [
          "Gracias — ¿puedes contarme un poco más? Con una o dos frases sobre qué pasó, y más o menos cuándo, ya ayuda mucho.",
          "Lo que puedas agregar ayuda: quién estuvo involucrado, cuándo pasó aproximadamente, o qué ha significado para tu hijo o hija. Si eso es todo lo que quieres decir por ahora, dilo y seguimos.",
        ],
      },
      progress: (done, total) => `Ya llevas ${done} de ${total} — vas muy bien.`,
      almostDone: (n) => n === 1
        ? "Ya casi — solo falta una respuesta requerida para la queja."
        : `Ya casi — solo faltan ${n} respuestas requeridas para la queja.`,
      requiredDone: "Con eso ya está cubierta toda la parte requerida de la queja — todo lo que agregues ahora solo la hace más fuerte.",
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
    if (focus === "confirming") return L.confirming(meta.value ?? "");
    // "confirmed" rotates through the vetted variants, keyed by how many
    // answers have been stored (meta.n) — deterministic, so the same
    // conversation always reads the same way, and with no meta.n it's the
    // canonical line, exactly as before.
    if (focus === "confirmed") {
      const all = [L.confirmed, ...(L.confirmedAlt || [])];
      return all[(meta.n ?? 0) % all.length];
    }
    // The ladder clamps at its last rung rather than running off the end;
    // Intake stops asking before that anyway (MAX_PROBES), so a third call
    // would only ever be a bug elsewhere, not a reason to show nothing.
    if (focus === "probing") {
      const ladder = (L.probing && L.probing[meta.kind]) || L.probing.bare;
      return ladder[clamp(meta.n ?? 0, 0, ladder.length - 1)];
    }
    if (focus === "progress") return L.progress(meta.done ?? 0, meta.total ?? 0);
    if (focus === "almostDone") return L.almostDone(meta.n ?? 0);
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

  // Title-cases a proper name, word by word, instead of only the sentence
  // start ("frank smith" -> "Frank Smith"). Same conservative bar as the
  // rest of this file: a word that already contains an interior capital
  // ("McDonald", "O'Brien", "DeVon") is left completely alone rather than
  // guessed at, since re-casing it could just as easily make it wrong. This
  // only ever *adds* capitalization to an all-lowercase word — it never
  // lowercases anything, so it can't strip a capitalization the person
  // typed on purpose.
  function titleCaseName(text) {
    return text.replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*/g, (word) => {
      if (/[A-ZÀ-Þ]/.test(word.slice(1))) return word;
      return word[0].toUpperCase() + word.slice(1);
    });
  }

  // A field marked nameCase is asking for a short proper name, but a small
  // classifier (or a person just narrating instead of answering) can still
  // hand back a whole run-on sentence ("my name is Frank Smith, I'm the
  // father..."). Title-casing every word of that would produce something
  // that reads like a book title, not a name — worse than leaving it alone.
  // Only apply name-casing to text that actually looks like a name: a
  // handful of words, no digits, no sentence punctuation.
  //
  // A middle initial ("Frank E. Smith") carries a period that isn't
  // sentence punctuation — strip just that shape (a single letter followed
  // by a period) before the punctuation check, so a real name with a
  // middle initial isn't rejected as a run-on sentence.
  function looksLikeName(text) {
    const withoutInitials = text.replace(/\b([A-Za-zÀ-ÿ])\.(?=\s|$)/g, "$1");
    return text.length <= 60 && !/[0-9]/.test(text) && !/[,.!?;:]/.test(withoutInitials) && text.trim().split(/\s+/).length <= 6;
  }

  function tidyText(text, lang = "en", field = null) {
    if (!text) return text;
    let t = text.toString().replace(/\s+/g, " ").trim();
    if (!t) return t;
    t = t.replace(/\s+([,.!?;:])/g, "$1"); // no space before punctuation
    t = fixContractions(t, lang);
    t = field && field.nameCase && looksLikeName(t) ? titleCaseName(t) : capitalizeSentences(t);
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

  // ---- reading an attempt: is this an answer yet? ---------------------------
  //
  // validate() answers "does this fit the field's shape" — a required field
  // is satisfied by any non-empty string, which is the right bar for a phone
  // number and the wrong one for "tell us what happened to your child." A
  // stray keystroke and a two-word shrug both pass it, get confirmed, and end
  // up quoted in a federal civil rights complaint as the family's own account.
  // This is the second, softer read: not "is it valid" but "is this yet an
  // attempt at the question," and its only power is to make the conversation
  // ask once more (see Intake._probeReply, which caps the asking and then
  // stores whatever the person wrote regardless).
  //
  // What it borrows from eoreader7: the shape of its material reader
  // (native/adapters/text/material.js), which scores text by average per-word
  // surprisal against a frequency table. There's no table to score against
  // here — a browser page with no build step can't ship a corpus, and one
  // intake answer wouldn't calibrate one — so the same question ("do these
  // tokens look like language?") is asked of each word's own letter shape
  // instead. Deliberately crude in one direction only: every rule below has
  // to be wrong about a real word before it can nudge someone, and being
  // wrong costs one extra gentle question, never a blocked answer.
  const UNREADABLE_SHARE = 0.5;   // half the words unreadable => the text is
  const NARRATIVE_MIN_WORDS = 4;  // shorter than this isn't yet a story

  // Accent-stripped, apostrophe-tolerant word list. Digits and punctuation
  // are not words: "12/2024" contributes nothing either way.
  function letterTokens(text) {
    return normalize(text).split(" ")
      .map((w) => w.replace(/'/g, ""))
      .filter((w) => w && !/[0-9]/.test(w));
  }

  // Every threshold here is one step past what English or Spanish spelling
  // actually does, so an ordinary word can't trip it: "strength" and
  // "transcripción" carry 4-consonant runs, so the run test starts at 5;
  // "aa" and "ll" are ordinary, so the repeat test starts at 4. Words under
  // three letters are never judged at all — initials, "ok", "no", "sí".
  function looksUnreadable(word) {
    if (word.length < 3) return false;
    if (!/[aeiouy]/.test(word)) return true;      // no vowel anywhere
    if (/[^aeiouy]{5,}/.test(word)) return true;  // an unpronounceable run
    if (/(.)\1{3,}/.test(word)) return true;      // "aaaaa"
    if (word.length > 24) return true;            // one unbroken mash
    return false;
  }

  // readAttempt(text, field) -> { kind: "answer" | "unreadable" | "bare" }
  //
  // "unreadable" is judged for any free-text field — a language name or a
  // caseworker's name is no more usefully recorded as keyboard noise than a
  // story is. "bare" (too short to be an account of anything) is judged only
  // for fields the schema marks `narrative: true`, because "Spanish" is a
  // complete answer to "which language?" and a three-word answer to "what
  // happened to your child" is the start of one.
  function readAttempt(text, field = {}) {
    const raw = (text ?? "").toString().trim();
    const f = field || {};
    const freeText = (f.type == null || f.type === "text") && !f.enum && !f.digits;
    if (!raw || !freeText) return { kind: "answer" };
    const tokens = letterTokens(raw);
    const unreadable = tokens.filter(looksUnreadable).length;
    if (tokens.length && unreadable / tokens.length >= UNREADABLE_SHARE) return { kind: "unreadable" };
    if (f.narrative && tokens.length < NARRATIVE_MIN_WORDS) return { kind: "bare" };
    return { kind: "answer" };
  }

  // ---- bilingual field validation -------------------------------------------
  const VALIDATION_MESSAGES = {
    en: {
      required: "This one's required — even a rough answer is fine to start.",
      email: "That doesn't look like an email address — mind checking it?",
      date: "I couldn't read that as a date. A format like 1990-04-23 works well.",
      year: (lo, hi) => `That year doesn't look right — please use a year between ${lo} and ${hi}.`,
      number: "That should be a number.",
      digits: (n) => `That should be exactly ${n} digits.`,
      enumMsg: (opts) => `Please pick one of: ${opts.join(", ")}.`,
      // Shown by the address widget as a soft hint next to the ZIP box, never
      // returned by validate() — see the note there on why an address never
      // blocks.
      zip: "A US ZIP code is 5 digits, like 37201.",
    },
    es: {
      required: "Este campo es obligatorio — una respuesta aproximada está bien para empezar.",
      email: "Eso no parece una dirección de correo electrónico — ¿puedes revisarla?",
      date: "No pude leer eso como una fecha. Un formato como 1990-04-23 funciona bien.",
      year: (lo, hi) => `Ese año no parece correcto — por favor usa un año entre ${lo} y ${hi}.`,
      number: "Eso debería ser un número.",
      digits: (n) => `Eso debería tener exactamente ${n} dígitos.`,
      enumMsg: (opts) => `Por favor elige una opción: ${opts.join(", ")}.`,
      zip: "Un código postal de EE. UU. tiene 5 dígitos, como 37201.",
    },
  };

  // The plausible window for any date this intake asks about — see the note
  // in validate(). maxYear() is a function so a session left open across New
  // Year's doesn't start rejecting today.
  const MIN_YEAR = 1900;
  function maxYear() { return new Date().getFullYear() + 1; }

  // ISO bounds for a native date/month picker, taken from the same window
  // validate() enforces, so a control can't hand back what the validator is
  // about to reject. `kind` is "date" or "month" (the date_flex toggle).
  function dateBounds(kind = "date") {
    return kind === "month"
      ? { min: `${MIN_YEAR}-01`, max: `${maxYear()}-12` }
      : { min: `${MIN_YEAR}-01-01`, max: `${maxYear()}-12-31` };
  }

  function validate(field, value, lang = "en") {
    const M = VALIDATION_MESSAGES[lang] || VALIDATION_MESSAGES.en;
    const v = (value ?? "").toString().trim();
    if (field.required && !v) return M.required;
    if (field.type === "email" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return M.email;
    // "date_flex" is the same field, just answerable to month precision
    // ("2024-03") instead of always requiring an exact day — Date.parse
    // already accepts that shorter ISO form, so no separate check is needed.
    if ((field.type === "date" || field.type === "date_flex") && v) {
      if (isNaN(Date.parse(v))) return M.date;
      // Date.parse is happy with a year of 23, and a date picker will hand
      // one over from a mistyped keystroke ("0023-12-22" reached a real
      // interview this way). A complaint dated in the third century is not a
      // typo anyone benefits from having stored, and neither is one dated
      // decades out. The window is deliberately wide — a grandparent's birth
      // year at one end, next year at the other for an already-scheduled
      // hearing — so it only ever catches what could not have happened.
      const year = new Date(v).getFullYear();
      if (year < MIN_YEAR || year > maxYear()) return M.year(MIN_YEAR, maxYear());
    }
    if (field.type === "number" && v && isNaN(Number(v))) return M.number;
    // `digits: N` requires the value, once non-digit formatting characters
    // are stripped, to contain exactly N digits — used for phone numbers and
    // the DCS case number. `digitsOrKeywords` names literal escape words
    // (e.g. "unknown") that bypass the digit check entirely, for a field
    // that's allowed to be answered with an honest "I don't know" instead of
    // a number.
    if (field.digits && v) {
      const isEscape = field.digitsOrKeywords && field.digitsOrKeywords.some((k) => k.toLowerCase() === v.toLowerCase());
      if (!isEscape && (v.match(/\d/g) || []).length !== field.digits) return M.digits(field.digits);
    }
    // A multiselect's stored value is several enum options joined with
    // ", " (see the checkbox control in index.html's renderQuickAnswer) —
    // each piece has to be a real option, not the joined string as a whole.
    if (field.type === "multiselect" && field.enum && v) {
      const bad = v.split(",").map((s) => s.trim()).filter(Boolean)
        .filter((piece) => !field.enum.some((o) => o.toLowerCase() === piece.toLowerCase()));
      if (bad.length) return M.enumMsg(field.enum);
    } else if (field.enum && v && !field.enum.some((o) => o.toLowerCase() === v.toLowerCase())) {
      return M.enumMsg(field.enum);
    }
    // Note: `type: "address"` deliberately falls through to required-only.
    // A malformed ZIP is surfaced as a soft hint beside the box (M.zip) and
    // never as a blocking error, because a mailing address is exactly the
    // field where the unusual real answer is common — rural routes, PO
    // boxes, APO/FPO, care-of lines, shelter and transitional addresses,
    // and people who simply have no fixed one. Refusing to store what
    // someone typed about where to mail their own reply would be a worse
    // failure than storing something oddly formatted.
    return null;
  }

  // ---- US mailing addresses --------------------------------------------------
  // Why this lives here: steer.js is the one module loaded by BOTH the browser
  // (<script src>) and the Node tests, and it already owns the other per-field
  // text faculties (validate, tidyText). The address widget itself is DOM and
  // stays in index.html; everything below is pure string work, so it's testable
  // directly.
  //
  // The stored value of an address field is always ONE string, identical in
  // shape to every other text field — so the complaint letter, the bulk
  // extractor, the Matrix event log, and every answer already stored keep
  // working untouched. The structured street/city/state/ZIP boxes exist for
  // one reason: the BROWSER's own autofill needs standard, separately-labelled
  // fields to map its saved addresses onto (autocomplete="address-line1" and
  // friends). parse/format are how that structure is borrowed for the input
  // and then folded straight back into the single canonical string. No
  // network, no third-party geocoder — the only suggestions a person ever
  // sees are the ones already saved in their own browser.

  const US_STATES = [
    { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
    { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
    { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
    { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
    { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
    { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
    { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
    { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
    { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
    { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
    { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
    { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
    { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
    { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
    { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
    { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
    { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
    { code: "DC", name: "District of Columbia" },
    // Territories and military posts get mail from federal agencies too, and
    // OCR's jurisdiction reaches them — leaving them out would silently tell
    // those families their address is wrong.
    { code: "AS", name: "American Samoa" }, { code: "GU", name: "Guam" },
    { code: "MP", name: "Northern Mariana Islands" }, { code: "PR", name: "Puerto Rico" },
    { code: "VI", name: "U.S. Virgin Islands" },
    { code: "AA", name: "Armed Forces Americas" }, { code: "AE", name: "Armed Forces Europe" },
    { code: "AP", name: "Armed Forces Pacific" },
  ];

  const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
  function isValidZip(zip) { return ZIP_RE.test((zip ?? "").toString().trim()); }

  const STATE_BY_CODE = new Map(US_STATES.map((s) => [s.code, s]));
  const STATE_BY_NAME = new Map(US_STATES.map((s) => [s.name.toLowerCase(), s]));

  // Resolves "TN" / "tn" / "Tennessee" / "Tenn." to the canonical entry, or
  // null. Returning null is a normal outcome, not an error: the caller keeps
  // whatever the person typed rather than overwriting it with a guess.
  function lookupState(text) {
    const t = (text ?? "").toString().trim().replace(/\.$/, "");
    if (!t) return null;
    return STATE_BY_CODE.get(t.toUpperCase()) || STATE_BY_NAME.get(t.toLowerCase()) || null;
  }

  // Secondary-address markers common enough to recognize on sight. Anything
  // not on this list stays part of the street line instead of being guessed
  // into the unit box.
  const UNIT_RE = /^(?:#|apt\.?|apartment|unit|ste\.?|suite|rm\.?|room|fl\.?|floor|bldg\.?|building|lot|trlr|trailer|space|spc|box)\b/i;
  const COUNTRY_RE = /^(?:usa|u\.?s\.?a\.?|u\.?s\.?|united states(?: of america)?|ee\.?\s?uu\.?|estados unidos)$/i;

  const EMPTY_ADDRESS = { street: "", unit: "", city: "", state: "", zip: "" };
  function emptyAddress() { return { ...EMPTY_ADDRESS }; }

  // Pulls a trailing state off a token list, in place. Tries the longest
  // candidate first so "District of Columbia" and "New York" win over a
  // chance single-word match on their last word.
  function takeTrailingState(tokens) {
    for (let n = Math.min(3, tokens.length); n >= 1; n--) {
      const st = lookupState(tokens.slice(tokens.length - n).join(" "));
      if (st) { tokens.length -= n; return st.code; }
    }
    return "";
  }

  // parseAddress(str) -> { street, unit, city, state, zip }
  //
  // Best-effort, and deliberately lossless: anything this can't confidently
  // place stays in `street`, so formatAddress(parseAddress(s)) never DROPS
  // part of what someone wrote. That one-way guarantee is what makes it safe
  // to re-parse a stored answer every time the editor reopens.
  //
  // It works backwards from the end because the tail of a US address is the
  // only part with a reliable shape ("TN 37201" / "37201" / "Tennessee").
  // Where it stops short: with no commas at all ("123 Main St Nashville TN
  // 37201") the state and ZIP still come off cleanly, but there is no
  // non-guessing way to tell where the street ends and the city begins —
  // "123 Oak Grove Lane" would just as happily yield a city of "Grove Lane".
  // So the remainder stays whole in `street` and the city box is left empty
  // for the person to split themselves, if they even care to.
  function parseAddress(value) {
    const out = emptyAddress();
    const raw = (value ?? "").toString();
    if (!raw.trim()) return out;

    // A pasted address is as often three lines as one comma-joined line;
    // normalizing newlines to commas lets both take the same path.
    const flat = raw.replace(/[\r\n]+/g, ", ").replace(/\s+/g, " ").trim();
    let parts = flat.split(",").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return out;

    // A trailing "USA" is noise on a domestic form, but only drop it when
    // something else remains — "USA" alone is all the person gave us.
    if (parts.length > 1 && COUNTRY_RE.test(parts[parts.length - 1])) parts.pop();

    const tokens = parts[parts.length - 1].split(" ").filter(Boolean);
    if (tokens.length && ZIP_RE.test(tokens[tokens.length - 1])) out.zip = tokens.pop();
    out.state = takeTrailingState(tokens);
    if (out.zip || out.state) {
      // Whatever is left of that last segment isn't state or ZIP — usually
      // the city ("Nashville TN 37201" as one comma-free segment).
      const remainder = tokens.join(" ");
      if (remainder) parts[parts.length - 1] = remainder;
      else parts.pop();
    }

    // With two or more segments left, the last is the city and the earlier
    // ones are the street. With only one, it's a street — a lone segment is
    // never a bare city on a form that asked for a mailing address.
    if (parts.length >= 2) out.city = parts.pop();
    if (parts.length >= 2 && UNIT_RE.test(parts[1])) {
      out.unit = parts[1];
      out.street = [parts[0], ...parts.slice(2)].join(", ");
    } else {
      out.street = parts.join(", ");
    }
    return out;
  }

  // The canonical single-line form: "123 Main St, Apt 4B, Nashville, TN 37201".
  // Every empty part simply drops out, so a half-filled address still reads
  // as a sentence instead of a row of stray commas.
  function formatAddress(parts) {
    const p = parts || {};
    const get = (k) => (p[k] ?? "").toString().trim();
    const line1 = [get("street"), get("unit")].filter(Boolean).join(", ");
    const region = [get("state"), get("zip")].filter(Boolean).join(" ");
    return [line1, get("city"), region].filter(Boolean).join(", ");
  }

  // ---- conditional fields (repeating groups, follow-ups) --------------------
  // A field can carry `skipUnless: { field: <path>, oneOf: [<values>] }` to
  // opt out of being asked unless an earlier answer matches. This is
  // deliberately DATA, not a function: fields defined in index.html's
  // SCHEMA get round-tripped through the admin's question-editor panel
  // (putField -> a JSON event -> foldConfig), and a function property is
  // silently dropped by JSON serialization. A field authored with the old
  // `skipIf(answers) -> bool` shape (a plain function, not going through
  // config-room storage) still works here too, so nothing already holding
  // one breaks.
  function isFieldSkipped(field, answers) {
    if (typeof field.skipIf === "function") return field.skipIf(answers);
    if (field.skipUnless) {
      const v = answers[field.skipUnless.field];
      if (v == null) return true;
      // A multiselect's stored value is several picks comma-joined (see the
      // checkbox control in index.html's renderQuickAnswer) — split so
      // skipUnless can match on any one pick, not just an exact whole-string
      // equal. A single-value answer splits to itself, so this is a no-op
      // for every other field type.
      const picks = String(v).split(",").map((s) => s.trim());
      return !field.skipUnless.oneOf.some((opt) => picks.includes(opt));
    }
    return false;
  }

  return {
    createState, applyForce, tierOf,
    classifyIntent, matchesAny, normalize, levenshtein,
    REPLIES, pickReply,
    VALIDATION_MESSAGES, validate, dateBounds,
    tidyText, readAttempt,
    US_STATES, lookupState, isValidZip, parseAddress, formatAddress, emptyAddress,
    isFieldSkipped,
  };
});
