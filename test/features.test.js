// test/features.test.js — falsification for the 2026-10 pass: flexible
// birthdays, the multi-child fork, and the pieces the browser falsifier
// (falsify-features.mjs) can't reach from node. Everything here is asserted
// against the real index.html slice / the real vendor/steer.js — never a
// hand-copied version — so a later edit that breaks the shape fails here.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEngine } = require("./_extract-engine.js");
const Steer = require("../vendor/steer.js");

// ── flexible birthdays ──
// Each row: input the way a person might type it, the ISO best guess, and the
// precision that guess is good to. A parser that silently misreads a birthday
// is worse than one that refuses it, so every row is exact.
const DATE_CASES = [
  ["April 23, 1990", "1990-04-23"],
  ["apr 23 1990", "1990-04-23"],
  ["23 April 1990", "1990-04-23"],
  ["3 Apr 2016", "2016-04-03"],
  ["April 3 2016", "2016-04-03"],
  ["4/23/90", "1990-04-23"],
  ["4/23/1990", "1990-04-23"],
  ["04-23-1990", "1990-04-23"],
  ["4.3.2016", "2016-04-03"],
  ["4-3-16", "2016-04-03"],
  ["2016-04-03", "2016-04-03"],
  ["2016/4/3", "2016-04-03"],
  ["20160403", "2016-04-03"],
  ["13/4/2018", "2018-04-13"],
  ["born 4/3/16", "2016-04-03"],
  ["DOB: 04-23-1990", "1990-04-23"],
  ["nacimiento 3 de abril de 2016", "2016-04-03"],
  ["April 2016", "2016-04"],
  ["feb 2017", "2017-02"],
  ["2016/4", "2016-04"],
  ["1990", "1990"],
];

test("parseDateFlexible reads birthdays written however people write them", () => {
  for (const [input, iso] of DATE_CASES) {
    const got = Steer.parseDateFlexible(input);
    assert.ok(got, `expected to read ${JSON.stringify(input)}`);
    assert.equal(got.iso, iso, `input ${JSON.stringify(input)}`);
  }
});

test("parseDateFlexible refuses what it cannot place, rather than guessing", () => {
  // A day and month with no year is date-shaped but not a birthday.
  assert.equal(Steer.parseDateFlexible("4/23").iso, null);
  assert.equal(Steer.parseDateFlexible("blue"), null);
  assert.equal(Steer.parseDateFlexible(""), null);
});

test("normalizeAnswer turns a typed birthday into the stored ISO value", () => {
  const f = { path: "child_1_dob", type: "date_flex" };
  assert.equal(Steer.normalizeAnswer(f, "April 23, 1990"), "1990-04-23");
  assert.equal(Steer.normalizeAnswer(f, "1990-04-23"), "1990-04-23", "already-ISO is unchanged");
  assert.equal(Steer.normalizeAnswer(f, "nonsense"), "nonsense", "unparseable text is left for validate() to refuse");
  assert.equal(Steer.normalizeAnswer({ type: "text" }, "hello"), "hello", "only date fields are touched");
});

test("validate accepts the flexible forms and still holds the year window", () => {
  const f = { path: "child_1_dob", type: "date_flex" };
  for (const [input] of DATE_CASES) assert.equal(Steer.validate(f, input), null, `accepts ${JSON.stringify(input)}`);
  assert.match(Steer.validate(f, "hello") || "", /date/i, "plain text is refused");
  assert.match(Steer.validate(f, "0023-12-22") || "", /year/i, "a year outside the window is refused");
  assert.match(Steer.validate(f, "4/23") || "", /date/i, "a yearless date is refused");
});

// ── the multi-child fork ──

test("childIndicesFromAnswers counts every child named, mid-interview included", () => {
  const engine = loadEngine();
  const kids = engine.childIndicesFromAnswers;
  assert.deepEqual(Array.from(kids({ child_1_name: "Ana" })), [1]);
  assert.deepEqual(Array.from(kids({ child_1_name: "Ana", child_more_1: "Yes" })), [1, 2], "a yes to another child counts the next round before it is named");
  assert.deepEqual(Array.from(kids({ child_1_name: "Ana", child_more_1: "Yes", child_2_name: "Carlos" })), [1, 2]);
  assert.deepEqual(Array.from(kids({ child_1_name: "Ana", child_more_1: "Sí", child_2_name: "Carlos", child_more_2: "No" })), [1, 2]);
  assert.deepEqual(Array.from(kids({ child_1_name: "Ana", child_more_1: "No" })), [1]);
  assert.deepEqual(Array.from(kids({})), []);
});

test("the child round's schema makes the fork explicit and one-child-at-a-time", () => {
  const engine = loadEngine();
  const r2 = engine.childRoundFields(2);
  const paths = r2.map((f) => f.path);
  assert.ok(paths.includes("child_2_name"), "a second round has its own name question");
  assert.ok(paths.includes("child_2_dob"));
  assert.ok(paths.includes("child_more_2"));
  const more = r2.find((f) => f.path === "child_more_2");
  assert.match(more.help, /each child gets their own separate complaint/i);
  const dob = r2.find((f) => f.path === "child_2_dob");
  assert.equal(dob.type, "date_flex");
  assert.match(dob.help, /however you remember it/i);
});
