// vendor/eoreader6.js — surf/fold, adapted from eoreader6.
//
// eoreader6 (https://github.com/clovenbradshaw-ctrl/eoreader6) is a
// calibrated statistical surprise-detector: `surf` rides a NUMERIC series,
// growing a bootstrap-resampled "ground" distribution and flagging each new
// window as met/broke/flat; `fold` projects that ground across a whole
// series from a chosen standpoint. Both need real calibration (`window`,
// `draws`, a seed) and `fold` refuses to run on fewer than 10x its window of
// prior material — built for whole-book corpora, measured against real
// text at that scale (see eoreader6/emergence/fold.js's own header).
//
// A DCS intake answer is a few sentences, not a corpus, and there's no
// number series here to ride — so this is NOT a port of that engine. What's
// borrowed is the shape of the two operations, purpose-built for a much
// smaller problem:
//   surf — read the text that has arrived so far against a standing set of
//          anticipated topics ("slots"), and report which ones showed up.
//   fold — take what surf found and compose it into ONE accumulated view:
//          which slots a field's framework has covered across every answer
//          given to it so far, not just the latest one. (Same accumulate-
//          never-retract shape as this app's own fold(events) in
//          index.html — a different fold, for a different kind of pile of
//          things, not this file's business to unify with it.)
//
// Deterministic, synchronous, and reads nothing but the string it's given —
// no model call, no network, no async. That's load-bearing: the framework/
// follow-up loop this drives has to work in Demo mode with no model loaded
// at all (see vendor/steer.js's own note on why the chat model is never
// trusted to author or gate what a person reads — this holds it to the same
// bar, one step earlier, by never touching the model in the first place).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EOReader6 = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // surf(text, slots) -> [{ key, met }]
  //
  // `slots` is [{ key, test(normalizedText, rawText) -> bool }] or [{ key,
  // keywords: [...] }] (keywords matched as case-insensitive substrings —
  // same tolerance level, and the same reasoning, as every other mechanical
  // keyword match in this app: cheap, reviewable, and it can only ever
  // trigger a vetted follow-up question, never author what the person
  // reads). `test` wins if both are present. `test` gets the raw text too,
  // not just the lowercased one — a slot that has to look for something
  // case-sensitive (e.g. "does this look like a proper name") would
  // otherwise never see the case it needs, since normalization already
  // erased it before `test` ever runs.
  function surf(text, slots) {
    const raw = (text || "").toString();
    const norm = raw.toLowerCase();
    return slots.map((slot) => ({
      key: slot.key,
      met: typeof slot.test === "function"
        ? !!slot.test(norm, raw)
        : (slot.keywords || []).some((k) => norm.includes(k)),
    }));
  }

  // fold(coverageSoFar, reading) -> coverage
  //
  // A slot once met stays met, even if a later reading (a different answer
  // folded into the same framework) doesn't happen to repeat it — coverage
  // only ever accumulates, the same one-way shape as a DEF nobody can
  // un-store.
  function fold(coverageSoFar, reading) {
    const next = Object.assign({}, coverageSoFar || {});
    for (const r of reading) next[r.key] = !!(next[r.key] || r.met);
    return next;
  }

  // Convenience: surf then fold in one call, for the common case of "read
  // this new text, merge it into what's already covered."
  function surfAndFold(coverageSoFar, text, slots) {
    return fold(coverageSoFar, surf(text, slots));
  }

  // True once every slot the framework declares has been met.
  function isSatisfied(coverage, slots) {
    return slots.every((slot) => !!(coverage && coverage[slot.key]));
  }

  return { surf, fold, surfAndFold, isSatisfied };
});
