// test/_extract-engine.js — pulls the SCHEMA-through-Intake slice straight
// out of index.html and evaluates it in a vm context with the real
// vendor/steer.js as `Steer`. Not a hand-maintained copy: if index.html's
// shape changes enough to break these markers, this throws instead of
// silently testing stale logic.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const START_MARKER = "const SCHEMA = {";
// Intake's last method, and the "method close, then class close" line pair
// right after it — text-anchored rather than brace-counted, since naive
// brace counting is fooled by the `{`/`}` inside this file's regex
// literals, template strings, and comments.
const LAST_METHOD_MARKER = "_parseClassification(raw, field, userText) {";
const CLASS_AND_METHOD_CLOSE = "\n  }\n}";

function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf-8");

  const start = html.indexOf(START_MARKER);
  if (start === -1) throw new Error("extract-engine: START_MARKER not found — index.html shape changed");

  const lastMethodIdx = html.indexOf(LAST_METHOD_MARKER, start);
  if (lastMethodIdx === -1) throw new Error("extract-engine: Intake's last method not found — index.html shape changed");

  const closeIdx = html.indexOf(CLASS_AND_METHOD_CLOSE, lastMethodIdx);
  if (closeIdx === -1) throw new Error("extract-engine: could not find the class Intake close brace after its last method");
  const end = closeIdx + CLASS_AND_METHOD_CLOSE.length;

  const slice = html.slice(start, end);

  // The SCHEMA-through-Intake range isn't purely DOM-free: a document-
  // preview modal helper (ensureModal/closeDoc/previewDocument) happens to
  // sit inside it and registers one top-level `document.addEventListener`
  // at parse time. None of it is reachable from anything this test drives
  // (Intake, EchoModel, Steer), so a permissive stub just needs to survive
  // being defined, not behave correctly.
  const stubEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {},
    addEventListener() {}, removeEventListener() {},
    appendChild: (x) => x, remove() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: stubEl, querySelectorAll: () => [], focus() {}, click() {},
  });
  const sandbox = {
    console,
    Steer: require("../vendor/steer.js"),
    document: {
      addEventListener() {}, removeEventListener() {},
      getElementById: stubEl, querySelector: stubEl, querySelectorAll: () => [],
      createElement: stubEl, createTextNode: (t) => ({ textContent: t }), body: stubEl(),
    },
    navigator: { gpu: undefined },
    URL: { revokeObjectURL() {}, createObjectURL: () => "blob:stub" },
    exports: {},
  };
  vm.createContext(sandbox);
  const exposer = `
    ${slice}
    exports.SCHEMA = SCHEMA;
    exports.Intake = Intake;
    exports.EchoModel = EchoModel;
    exports.makeModel = makeModel;
    exports.Steer = Steer;
    exports.OP = OP;
    exports.fold = fold;
    exports.answersOf = answersOf;
    exports.DEADLINE_CHECK_FIELD = DEADLINE_CHECK_FIELD;
    exports.OCR_FILING_WINDOW_DAYS = OCR_FILING_WINDOW_DAYS;
    exports.DEADLINE_WARNING_EN = DEADLINE_WARNING_EN;
    exports.DEADLINE_WARNING_ES = DEADLINE_WARNING_ES;
    exports.CLOSING_MESSAGE_EN = CLOSING_MESSAGE_EN;
    exports.CLOSING_MESSAGE_ES = CLOSING_MESSAGE_ES;
  `;
  vm.runInContext(exposer, sandbox, { filename: "index.html (extracted engine slice)" });
  return sandbox.exports;
}

module.exports = { loadEngine };
