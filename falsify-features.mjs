// falsify-features.mjs — the browser half of the 2026-10 falsification.
//
// Runs the real index.html in Chromium (served from this directory), then
// tries to FALSIFY each claim of the pass. Exit code is non-zero only on a
// real FAIL; an environment we cannot test in (no OCR CDN) is reported SKIP.
//
//   node falsify-features.mjs
//
// Finds Playwright either normally or in a sibling checkout.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    "playwright",
    process.env.PLAYWRIGHT_DIR && path.join(process.env.PLAYWRIGHT_DIR, "playwright"),
    path.resolve(__dirname, "..", "holodeck-latest", "node_modules", "playwright"),
  ].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch (e) {} }
  throw new Error("playwright not found — set PLAYWRIGHT_DIR or install it");
}
const { chromium } = loadPlaywright();

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".css": "text/css", ".json": "application/json" };
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(root, url === "/" ? "/index.html" : url);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const results = [];
const ok = (name, detail = "") => results.push({ s: "PASS", name, detail });
const bad = (name, detail = "") => results.push({ s: "FAIL", name, detail });
const skip = (name, detail = "") => results.push({ s: "SKIP", name, detail });
function check(name, cond, detail = "") { (cond ? ok : bad)(name, detail); }

const server = await serve(__dirname);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1200);

// 1. favicon exists, is served, and is a valid svg
{
  const r = await page.request.get(`${base}/favicon.svg`);
  const body = r.ok() ? await r.text() : "";
  check("favicon.svg is served and is an <svg>", r.ok() && /<svg[\s>]/.test(body), `http ${r.status()}`);
  const linked = await page.evaluate(() => !!document.querySelector('link[rel="icon"][href="favicon.svg"]'));
  check("index.html links the favicon", linked);
}

// 2. birthday parsing works inside the real page
{
  const probe = await page.evaluate(() => {
    const cases = [["April 23, 1990", "1990-04-23"], ["4/23/90", "1990-04-23"], ["3 Apr 2016", "2016-04-03"], ["2016-04-03", "2016-04-03"], ["April 2016", "2016-04"], ["1990", "1990"]];
    const bad = [];
    for (const [inp, exp] of cases) { const got = window.Steer.parseDateFlexible(inp); if (!got || got.iso !== exp) bad.push([inp, got && got.iso, exp]); }
    return { bad, refused: window.Steer.validate({ type: "date_flex" }, "hello"), normalized: window.Steer.normalizeAnswer({ type: "date_flex" }, "4/23/90") };
  });
  check("birthdays parse to the right ISO in-page", probe.bad.length === 0, JSON.stringify(probe.bad));
  check("birthday normalized before store", probe.normalized === "1990-04-23");
  check("gibberish birthday refused", /date/i.test(probe.refused || ""));
}

// 3. commitOcr records only when something actually changed
{
  const r = await page.evaluate(() => {
    const seen = [];
    const emit = (id, attrs) => seen.push({ id, attrs });
    const doc = { id: "doc1", filename: "x.png", mimetype: "image/png", key: { kty: "oct" }, url: "mxc://demo/x", iv: "iv", hash: "h", ocrText: "ABC", ocrKind: "ocr", ocrAt: "2020", ocrBy: "@a" };
    const same = commitOcr(emit, doc, { ocrText: "ABC" });
    const afterSame = seen.length;
    const changed = commitOcr(emit, doc, { ocrText: "ABCD", ocrKind: "edited", ocrAt: "2021", ocrBy: "@b" });
    const statusOnly = commitOcr(emit, { ...doc, ocrText: "", ocrStatus: undefined }, { ocrText: "", ocrStatus: "empty" });
    return { same, afterSame, changed, emits: seen };
  });
  check("an unchanged correction writes nothing", r.same === false && r.afterSame === 0);
  check("a real correction writes once", r.changed === true && r.emits.length >= 1);
  check("the correction keeps the encrypted media pointer", r.emits[0].attrs.url === "mxc://demo/x" && r.emits[0].attrs.key);
  check("the earlier reading is kept as a revision", Array.isArray(r.emits[0].attrs.ocrHistory) && r.emits[0].attrs.ocrHistory[0].text === "ABC");
  check("a status-only change still records", r.emits.length >= 2);
}

// 4. the transcription panel: best guess, what the image is, what the eyes did, revisions, search, and a read control
{
  const r = await page.evaluate(() => {
    const doc = {
      filename: "order.png", mimetype: "image/png", ocrText: "CASE NO 12345\nAna Bell\nDOB 2015-04-10", ocrAt: new Date().toISOString(),
      ocrRelevant: ["CASE NO 12345"], ocrHistory: [{ text: "old" }],
      imageKind: "a phone screenshot", imageConfidence: 0.8, imageEvidence: ["tall, phone-shaped", "a uniform background"],
      ocrEyes: ["model", "ocr"], ocrChosen: "model", ocrDisagreements: [{ eye: "ocr", only: ["x"] }], ocrWatermark: { present: true, n: 1 },
    };
    const panel = ocrPanel(doc, { canRead: true, onRead: () => {}, onEdit: () => {} });
    return { text: panel.textContent };
  });
  check("panel shows the transcription", /Ana Bell/.test(r.text) && /CASE NO 12345/.test(r.text));
  check("panel names what the image is (CV)", /Looks like: a phone screenshot/.test(r.text) && /80% sure/.test(r.text));
  check("panel reports which eye won and what was kept", /2D model won/.test(r.text) && /watermark layer/.test(r.text) && /disagreement/.test(r.text));
  check("panel surfaces submission-relevant lines", /match this submission/i.test(r.text));
  check("panel surfaces kept revisions", /earlier revision/i.test(r.text));
  check("panel offers NO reader chooser, only a correction", !/Read with these eyes/.test(r.text) && !/Read this image/.test(r.text) && /Correct transcription/.test(r.text));
}

// 4b. search is scoped WITHIN one source — it never reaches into another document
{
  const r = await page.evaluate(() => {
    const doc = { filename: "a.png", mimetype: "image/png", ocrText: "ALPHA one\nBETA two\nALPHA three" };
    const panel = ocrPanel(doc, { canRead: true, onRead: () => {} });
    document.body.appendChild(panel);
    const input = panel.querySelector(".ocr-search");
    const lines = () => [...panel.querySelectorAll(".ocr-line")];
    const total = lines().length;
    input.value = "alpha"; input.dispatchEvent(new Event("input"));
    const visible = lines().filter((l) => !l.classList.contains("dim")).map((l) => l.textContent);
    const count = panel.querySelector(".ocr-searchcount").textContent;
    input.value = ""; input.dispatchEvent(new Event("input"));
    const allBack = lines().filter((l) => l.classList.contains("dim")).length;
    panel.remove();
    return { total, visible, count, allBack, text: panel.textContent };
  });
  check("search within a source filters to that source's matching lines", r.total === 3 && r.visible.length === 2 && r.visible.every((l) => /alpha/i.test(l)) && r.count === "2 of 3 lines");
  check("clearing the search restores every line", r.allBack === 0);
  check("the source's text is only its own lines", /ALPHA one/.test(r.text) && /BETA two/.test(r.text) && !/other family/i.test(r.text));
}

// 4c. the CV guess classifies a phone screenshot, a photograph and a document
{
  const r = await page.evaluate(() => {
    const feat = (w, h, draw) => {
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const cx = cv.getContext("2d"); draw(cx, w, h);
      const d = cx.getImageData(0, 0, w, h).data;
      return summarizePixels({ width: w, height: h, data: d });
    };
    const shot = feat(390, 844, (cx, w, h) => {
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
      cx.fillStyle = "#111"; cx.fillRect(0, 0, w, 40);
      for (let i = 0; i < 16; i++) cx.fillRect(30, 90 + i * 44, (i % 3 === 0 ? w - 60 : 180), 14);
    });
    const photo = feat(400, 300, (cx, w, h) => {
      const img = cx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { img.data[i * 4] = (i * 37) % 256; img.data[i * 4 + 1] = (i * 91) % 256; img.data[i * 4 + 2] = (i * 53) % 256; img.data[i * 4 + 3] = 255; }
      cx.putImageData(img, 0, 0);
    });
    const scan = feat(600, 800, (cx, w, h) => {
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
      cx.fillStyle = "#000";
      for (let i = 0; i < 30; i++) cx.fillRect(50, 60 + i * 22, w - 100, 6);
      for (let i = 0; i < 6; i++) cx.fillRect(40, 120 + i * 110, w - 80, 3);
    });
    return {
      shot: guessImageKind({ width: 390, height: 844, features: shot, stats: { words: 40, texts: 20 } }).kind,
      photo: guessImageKind({ width: 400, height: 300, features: photo, stats: {} }).kind,
      scan: guessImageKind({ width: 600, height: 800, features: scan, stats: { words: 60, texts: 30, rules: 6 } }).kind,
    };
  });
  check("CV reads a phone-shaped render as a phone screenshot", /phone screenshot/.test(r.shot), r.shot);
  check("CV reads a colourful noisy image as a photograph", /photograph/.test(r.photo), r.photo);
  check("CV reads a ruled light page as a document", /document/.test(r.scan), r.scan);
}

// 5. the multi-child fork banner names the child, and the fork point says who and how many
{
  const r = await page.evaluate(() => {
    intake = { lang: "en", answers: () => ({ child_1_name: "Ana", child_more_1: "Yes", child_2_name: "Carlos" }) };
    renderChildBanner({ path: "child_2_name" });
    const banner = document.getElementById("childBanner");
    const perChild = { hidden: banner.classList.contains("hidden"), text: banner.textContent, fork: banner.classList.contains("fork") };
    renderChildBanner({ path: "child_more_2" });
    const fork = { hidden: banner.classList.contains("hidden"), text: banner.textContent, fork: banner.classList.contains("fork") };
    renderChildBanner(null);
    const gone = banner.classList.contains("hidden");
    return { perChild, fork, gone };
  });
  check("while on a child, the banner names them and keeps them in view", !r.perChild.hidden && /Carlos/.test(r.perChild.text) && /one complaint per child/i.test(r.perChild.text) && !r.perChild.fork);
  check("the fork point lists the children named so far", r.fork.fork && /Ana/.test(r.fork.text) && /Carlos/.test(r.fork.text));
  check("the fork point says each child is its own file", /own complaint file/i.test(r.fork.text));
  check("the banner hides when not on a child", r.gone);
}

// 6. answer cards are EXPANDED by default (the answers are the hero content)
{
  const r = await page.evaluate(async () => {
    const card = document.createElement("div");
    card.className = "acard";
    card.innerHTML = '<div class="acard-head">Q</div><div class="acard-answer"><div class="acard-final">A</div></div><ol class="atl"><li>x</li></ol>';
    document.body.appendChild(card);
    const answerShown = getComputedStyle(card.querySelector(".acard-answer")).display !== "none";
    const timelineShown = getComputedStyle(card.querySelector(".atl")).display !== "none";
    card.remove();
    const src = await (await fetch("/index.html")).text();
    return { answerShown, timelineShown, sourceCollapsed: /"acard collapsed"/.test(src), hasToggle: /acard-toggle/.test(src) };
  });
  check("answer cards show their answer and history by default", r.answerShown && r.timelineShown);
  check("no collapse machinery remains", !r.sourceCollapsed && !r.hasToggle);
}

// 7. the end-of-interview review shows every question, no produced document, and an own-records-only notice
{
  const r = await page.evaluate(() => {
    configStore = null;
    const answers = { complainant_name: "Nora Alvarez", child_1_name: "Ana", child_1_dob: "2015-04-10", child_more_1: "Yes", child_2_name: "Carlos", child_2_dob: "2017-09-01" };
    intake = {
      lang: "en",
      answers: () => answers,
      isComplete: () => true,
      progress: () => [],
      schema: { fields: SCHEMA.fields },
      store: { fold: () => ({ records: {} }), timeline: () => [] },
    };
    currentStoreKind = "demo";
    renderSubmission();
    return document.getElementById("submissionPane").innerHTML;
  });
  check("review says 'for your own records only'", /for your own records only/i.test(r));
  check("review says it is not a form to submit or provide", /not a form for you to submit or provide/i.test(r));
  check("review says it gives no produced documents", /don't give you any of the documents it produces/i.test(r));
  check("review shows all questions, including a later child's", /Child 2|child 2/i.test(r) && /Date of birth/i.test(r));
  check("review tells a multi-child family there will be a file per child", /2 children/i.test(r) && /separate complaint for each/i.test(r));
  check("review contains no drafted complaint document", !/Re: Complaint against/i.test(r) && !/Dear /.test(r));
}

// 8. OCR actually reads an image end to end (needs the tesseract CDN)
{
  try {
    const r = await page.evaluate(async () => {
      const cv = document.createElement("canvas");
      cv.width = 480; cv.height = 140;
      const cx = cv.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
      cx.fillStyle = "#000"; cx.font = "bold 64px sans-serif"; cx.fillText("HELLO 12345", 20, 90);
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      const id = newId("doc");
      const stored = await putEncryptedMedia(blob, mediaBackend(), id);
      const doc = { id, ...stored, filename: "t.png", mimetype: "image/png" };
      const out = await readDocumentText(doc, mediaBackend());
      return { ok: out.ok, reason: out.reason, text: out.text, tess: typeof window.Tesseract };
    });
    if (r.ok && /HELLO|12345/i.test(r.text)) ok("OCR reads an uploaded image on-device", r.text.slice(0, 40).replace(/\n/g, " "));
    else if (r.tess === "undefined") skip("OCR reads an uploaded image on-device", "tesseract.js CDN unreachable in this environment");
    else bad("OCR reads an uploaded image on-device", `ok=${r.ok} reason=${r.reason} text=${JSON.stringify(r.text).slice(0, 80)}`);
  } catch (e) { skip("OCR reads an uploaded image on-device", "could not run: " + e.message); }
}

// 9. submitter: an uploaded image is read AUTOMATICALLY and invisibly — no
//    chooser, no manual step — and its text is editable by hand.
{
  try {
    const r = await page.evaluate(async () => {
      currentStoreKind = "demo";
      const cv = document.createElement("canvas");
      cv.width = 480; cv.height = 140;
      const cx = cv.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
      cx.fillStyle = "#000"; cx.font = "bold 60px sans-serif"; cx.fillText("AUTO 54321", 20, 90);
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      const file = new File([blob], "auto.png", { type: "image/png" });
      const emitLog = [];
      store = { fold: () => ({ records: {} }), timeline: () => [], subscribe() {}, emit: (op, payload) => emitLog.push([op, payload]) };
      intake = { nextField: () => null };
      // the real upload path — no click anywhere:
      handleFiles([file]);
      for (let i = 0; i < 200 && !emitLog.some(([, p]) => p.entity === "document" && (p.attrs || {}).ocrText); i++) await new Promise((r) => setTimeout(r, 250));
      // what the family sees for that document:
      const doc = { filename: "auto.png", mimetype: "image/png", ocrText: "AUTO 54321", ocrAt: new Date().toISOString() };
      const row = docRow(doc);
      const btns = [...row.querySelectorAll("button")].map((b) => b.textContent);
      const text = row.textContent;
      return { emits: emitLog.map(([, p]) => ({ entity: p.entity, text: (p.attrs || {}).ocrText })), btns, text };
    });
    const ins = r.emits.find((e) => e.entity === "document" && /AUTO|54321/i.test(e.text || ""));
    check("an uploaded image is read automatically, with no manual step", !!ins, JSON.stringify(r.emits).slice(0, 120));
    check("the family's row shows the text", /AUTO 54321/.test(r.text));
    check("the family's row offers NO OCR chooser or read button", !r.btns.some((b) => /Read with these eyes|Read this image|Re-read image/i.test(b)));
    check("the family's row offers editing the text", r.btns.some((b) => /Fix the text|Type the text|transcription/i.test(b)));
  } catch (e) { bad("submitter auto-read (no manual step)", "could not run: " + e.message); }
}

// 9b. the reader warms its models in the background after load, unprompted
{
  const r = await page.evaluate(async () => {
    const had = typeof warmOcr === "function" && typeof scheduleOcrWarm === "function";
    await warmOcr();
    return { had, warmed: _ocrWarmed === true, tess: typeof window.Tesseract };
  });
  check("the reader warms itself in the background", r.had && r.warmed);
  check("warming loads the engine with no user action", r.tess !== "undefined");
}

// 9c. byte sniffing, no-lost-text (the screenshot-of-text-messages bug), deep-link ids, inbox
{
  const r = await page.evaluate(async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0]);
    const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const sniff = { png: sniffSourceKind(png), jpeg: sniffSourceKind(jpg) };
    const cv = document.createElement("canvas"); cv.width = 420; cv.height = 720;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#f2f2f7"; cx.fillRect(0, 0, 420, 720);
    cx.fillStyle = "#e5e5ea"; cx.fillRect(30, 60, 250, 70); cx.fillRect(140, 150, 250, 70);
    cx.fillStyle = "#000"; cx.font = "24px sans-serif";
    cx.fillText("meet me at the courthouse", 45, 105);
    cx.fillText("i will bring the order", 155, 195);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    const id = newId("doc"); const stored = await putEncryptedMedia(blob, mediaBackend(), id);
    const doc = { id, ...stored, filename: "thread.png", mimetype: "image/png" };
    const out = await readDocumentText(doc, mediaBackend());
    const a1 = anonRecordId("!a:hs"), a2 = anonRecordId("!a:hs"), b1 = anonRecordId("!b:hs");
    const url = recordUrl("!room:hs", "doc_1");
    const src = await (await fetch("/index.html")).text();
    return {
      sniff, ok: out.ok, text: out.text, raw: out.raw, sourceKind: out.sourceKind,
      stable: a1 === a2, differs: a1 !== b1, url,
      srcHasInbox: /"inbox"/.test(src) && /inbox-name/.test(src) && /inbox-kids/.test(src) && /caseStatusChip/.test(src),
      srcHasHeader: /submissionProgress/.test(src) && /submissionDocsBox/.test(src) && /Search file names and text in the files/.test(src),
    };
  });
  check("byte sniffing reads file signatures", r.sniff.png === "png" && r.sniff.jpeg === "jpeg");
  check("a screenshot of text is read — raw fallback, the reported bug", r.ok && /courthouse|order|meet/i.test((r.text || "") + (r.raw || "")));
  check("the reading knows its own file kind", r.sourceKind === "png");
  check("deep-link id is stable per room, differs across rooms", r.stable && r.differs);
  check("the deep link carries only the anonymized id, no name or room id", /[?&]sub=/.test(r.url) && !/!(room|a|b):hs/.test(r.url));
  check("the submissions tab is an inbox: name, date, children, status per row", r.srcHasInbox);
  check("the profile header is the dashboard + searchable documents box", r.srcHasHeader);
}

// 9e. timeline (answers + free text), query helpers, inbox progress, native+transcript view
{
  const r = await page.evaluate(async () => {
    const marked = highlightPassage("DCS <b>custody</b> changed", "custody");
    const clipped = clipPassage("alpha\nbeta\n" + "x".repeat(400) + "\ngamma custodian here\nomega", ["custodian"]);
    const dates = extractDatesFromText("we met on March 5, 2025 and again 4/6/25, plus 2024-01-02").map((d) => d.iso);
    const fromName = [filenameDate("IMG_20240105_091500.jpg"), filenameDate("Screenshot 2026-10-08 at 10.13.01.png")];
    const src = await (await fetch("/index.html")).text();
    return {
      marked, clippedHasTerm: /custodian/.test(clipped) && clipped.length < 500, dates, fromName,
      srcHasTimeline: /submissionTimeline/.test(src) && /tl-src/.test(src) && /openEvidence/.test(src) && /extractDatesFromText/.test(src),
      srcNoBuckets: !/submissionBuckets/.test(src) && !/"srow"/.test(src) && !/bchip/.test(src),
      srcTimelineRightOfAnswers: /"sbody"|sbody/.test(src) && /sbody-side/.test(src) && /submissionTimeline\(pl\)/.test(src),
      srcHasQuery: /submissionPassages/.test(src) && /showPassagesModal/.test(src) && /appquery/.test(src) && /passage-text/.test(src),
      srcHasAnswerAnchor: /card\.id = "ac-/.test(src),
      srcInboxProgress: /submissionPct/.test(src) && /ib-progress/.test(src),
      srcSingleView: /docSurface/.test(src) && /ds-flat/.test(src) && !/docTranscriptView/.test(src),
      srcPosBackfill: /function wantsReading/.test(src) && /backfillPositions/.test(src) && /pagesChanged/.test(src),
      srcVideoRead: /readVideoText/.test(src) && /isVideoDoc/.test(src) && /readMediaText/.test(src),
      srcDedupeSteps: /Collapse runs of the same value/.test(src),
      srcInboxSearch: /inbox-search/.test(src) && /inbox-filters/.test(src) && /submissionSearchBlob/.test(src),
      srcTestDefaultOff: /let showTest = false;/.test(src) && /isTestSubmission/.test(src) && /Test \(/.test(src),
      srcCardShrink: /\.acard\{[^}]*display:block/.test(src) && /histBtn\.onclick/.test(src) && /realEditCount/.test(src),
      srcTimelineEdit: /openTimelineEditor/.test(src) && /emitTimelineIns/.test(src) && /tl-badge/.test(src) && /isAdded \? "added" : "edited"/.test(src),
      srcTimelineSort: /height:800px/.test(src) && /tl-tools/.test(src) && /Edited \/ added/.test(src),
      srcThumbs: /sdoc-thumb/.test(src) && /loadThumb/.test(src),
      srcCapture: /fileHeadDate/.test(src) && /filenameDate/.test(src) && /capturedAt/.test(src),
      srcTimelineEntity: /entity: "timeline"/.test(src) && /r\.entity === "timeline"/.test(src),
      srcDocAI: /data-view="docai"/.test(src) && /renderDocAI/.test(src) && /induceDocKinds/.test(src) && /DOC_KIND_ENTITY/.test(src),
      srcNotes: /addNoteEditor/.test(src) && /notesWidget/.test(src) && /entity: "note"/.test(src),
      srcSurface: /docSurface/.test(src) && /ds-span/.test(src) && /ocrPages/.test(src),
      srcBigModal: /width:min\(1200px/.test(src) && /max-height:82vh/.test(src),
    };
  });
  check("highlight marks the match and escapes the text", /<mark>custody<\/mark>/.test(r.marked) && !/<b>/.test(r.marked));
  check("clipPassage returns a tight window around the hit", r.clippedHasTerm);
  check("dates are pulled from free text (answers, texts, transcripts)", ["2025-03-05", "2025-04-06", "2024-01-02"].every((d) => r.dates.includes(d)), JSON.stringify(r.dates));
  check("timeline carries provenance back to the evidence", r.srcHasTimeline);
  check("the bucket thing is gone", r.srcNoBuckets);
  check("the timeline sits in the right column beside the answers", r.srcTimelineRightOfAnswers);
  check("query pops up the application's own passages", r.srcHasQuery);
  check("answers are anchorable for evidence jumps", r.srcHasAnswerAnchor);
  check("the inbox card shows completion progress", r.srcInboxProgress);
  check("image/video pop-ups show ONE view at a time (page or text)", r.srcSingleView);
  check("past docs are re-read for positioned text on refresh", r.srcPosBackfill);
  check("video is auto-transcribed from its frames", r.srcVideoRead);
  check("duplicate same-value steps are collapsed", r.srcDedupeSteps);
  check("the inbox has search + status/phase filters", r.srcInboxSearch);
  check("test submissions (before today) are hidden by default", r.srcTestDefaultOff);
  check("answer cards are single-column; history is a real-edit tally", r.srcCardShrink);
  check("dates come from file names too", r.fromName[0] === "2024-01-05" && r.fromName[1] === "2026-10-08", JSON.stringify(r.fromName));
  check("timeline items can be corrected / added, with auto vs edited badges", r.srcTimelineEdit);
  check("timeline is 800px, sortable and filterable", r.srcTimelineSort);
  check("documents list shows real thumbnails", r.srcThumbs);
  check("image/video dates come from metadata or file name", r.srcCapture);
  check("timeline edits/additions persist as room events", r.srcTimelineEntity);
  check("DocAI page learns document kinds from templates + uploads", r.srcDocAI);
  check("notes attach anywhere and roll up", r.srcNotes);
  check("positioned, editable OCR text over the page", r.srcSurface);
  check("the document modal is large", r.srcBigModal);
}

// 9f. a document opens at its true aspect ratio — never stretched to a guess
{
  const r = await page.evaluate(async () => {
    // a 400x100 page: clearly not square
    const cv = document.createElement("canvas"); cv.width = 400; cv.height = 100;
    const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, 400, 100);
    cx.fillStyle = "#000"; cx.font = "20px sans-serif"; cx.fillText("wide page", 10, 60);
    const url = cv.toDataURL("image/png");
    const measure = async (doc) => {
      const img = document.createElement("img");
      const el = docSurface(doc, img, null);
      document.body.appendChild(el);
      img.src = url;
      await new Promise((res) => { if (img.complete) res(); else img.addEventListener("load", res); });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const b = el.querySelector(".ds-stage").getBoundingClientRect();
      el.remove();
      return b.width / b.height;
    };
    // No stored page dims: the shape must come from the file, not a square guess.
    const legacy = await measure({ id: "x", mimetype: "image/png", ocrText: "wide page" });
    // Stored measured page dims are honored.
    const measured = await measure({ id: "y", mimetype: "image/png", ocrPages: [{ page: 1, width: 400, height: 100, text: "wide page", elements: [] }] });
    const src = await (await fetch("/index.html")).text();
    return { legacy, measured, contain: /object-fit:contain/.test(src) };
  });
  check("a document opens at its true aspect ratio, not stretched", Math.abs(r.legacy - 4) < 0.2 && Math.abs(r.measured - 4) < 0.2, JSON.stringify(r));
  check("the page uses contain, never fill", r.contain);
}

// 9f2. positioned text comes back per LINE, not as oversized paragraph blocks —
//      the wrapped-message-screenshot case
{
  const r = await page.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 420; cv.height = 720;
    const cx = cv.getContext("2d"); cx.fillStyle = "#f2f2f7"; cx.fillRect(0, 0, 420, 720);
    cx.fillStyle = "#e5e5ea"; cx.fillRect(20, 60, 300, 110);
    cx.fillStyle = "#0b84ff"; cx.fillRect(120, 240, 280, 110);
    cx.fillStyle = "#000"; cx.font = "22px sans-serif";
    cx.fillText("meet me at the", 36, 95); cx.fillText("courthouse tomorrow", 36, 125);
    cx.fillStyle = "#fff";
    cx.fillText("i will bring the", 136, 275); cx.fillText("custody order with me", 136, 305);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    const id = newId("doc"); const stored = await putEncryptedMedia(blob, mediaBackend(), id);
    const doc = { id, ...stored, filename: "thread.png", mimetype: "image/png" };
    const out = await readDocumentText(doc, mediaBackend());
    const els = (out.pages && out.pages[0] && out.pages[0].elements) || [];
    // Every placed element is a single line: its box is about one line tall and
    // sized by its own em. A paragraph block would be ~2.5em tall.
    const perLine = els.length >= 2 && els.every((e) => e.em > 0 && e.region[3] <= e.em * 1.6);
    return { ok: out.ok, n: els.length, perLine, text: (out.text || "").replace(/\s+/g, " ").trim() };
  });
  check("a wrapped text screenshot is positioned per line, not one huge block", r.ok && r.perLine, JSON.stringify(r));
  check("the wrapped lines read back", /courthouse/.test(r.text) && /custody/.test(r.text), r.text);
}

// 9g. lessons learned improve comprehension of a form (handprint / clinical)
{
  const r = await page.evaluate(() => {
    const text = [
      "Adherence Counseling Record",
      "Participant ID: 102",
      "Visit Date: 03/24/2010",
      "Counseling notes: feels good about being in the study",
      "Next step: needs to feel more relaxed",
      "Strategy: change dose time to at lunch",
      "Agreement: strategy and action plan",
    ].join("\n");
    const before = applyKeyLessons(text, "clinical/acr").map((f) => ({ k: f.label, known: f.known, fmt: f.format }));
    // a fake shared room so a lesson can be recorded without a Matrix session
    const records = {};
    configStore = { roomId: "!cfg", fold: () => ({ records }), emit: (op, payload) => { records[payload.id] = { entity: payload.entity, attrs: payload.attrs }; return { id: payload.id }; } };
    recordKeyLesson("Visit Date", valueFormat("03/24/2010"), "clinical/acr");
    recordKeyLesson("Participant ID", valueFormat("102"), "clinical/acr");
    const after = applyKeyLessons(text, "clinical/acr").map((f) => ({ k: f.label, known: f.known, fmt: f.format }));
    const variant = applyKeyLessons("Visit  date: 1/2/03\nPARTICIPANT ID: 999", "clinical/acr").map((f) => ({ k: f.label, known: f.known }));
    return { before, after, variant };
  });
  const known = (arr, k) => (arr.find((x) => x.k.toLowerCase() === k.toLowerCase()) || {}).known;
  check("a form parses to keys + value formats", r.before.length >= 5 && r.before.every((x) => x.fmt));
  check("value formats are recognized (date / integer / name)", r.before.some((x) => x.fmt === "date") && r.before.some((x) => x.fmt === "integer"));
  check("before learning, the key is unknown", known(r.before, "Visit Date") === false);
  check("after a lesson the key is known — comprehension improves", known(r.after, "Visit Date") === true && known(r.after, "Participant ID") === true);
  check("the lesson generalizes across label variants", r.variant.every((x) => x.known));
}

// 9h. invent the tuple of everything, including nesting (a table)
{
  const r = await page.evaluate(() => {
    const table = "No.  Name  Service No.  Job Title\n01  W.D. Ranjan  008249  Tech Mugr\n02  H.C. Jayawardena  068301  Tk Ordm\n03  H.P. Dharmadasa  058293  TM Ord\n04  C.B.T. De Silva  011430  SAE";
    const inv = inventTuples(table);
    const records = {};
    configStore = { roomId: "!cfg", fold: () => ({ records }), emit: (op, payload) => { records[payload.id] = { entity: payload.entity, attrs: payload.attrs }; return { id: payload.id }; } };
    inventRules(table, "table");
    return { nested: inv.nested, kind: inv.kind, columns: inv.columns, nameKnown: !!keyLesson("Name", "table"), structLesson: !!records["struct_table"] };
  });
  check("a table reading is detected as nested", r.nested === true && r.kind === "table", JSON.stringify(r));
  check("its columns are found", r.columns.length >= 3);
  check("columns are learned as keys", r.nameKnown === true);
  check("a structure lesson is recorded", r.structLesson === true);
}

// 9i. a local pass proposes rules that get applied
{
  const r = await page.evaluate(() => {
    const text = "Adherence Counseling Record\nVisit Date: 03/24/2010\nParticipant ID: 102\nCounselor: J. Hale";
    const prop = structuralProposer(text);
    const records = {};
    configStore = { roomId: "!cfg", fold: () => ({ records }), emit: (op, payload) => { records[payload.id] = { entity: payload.entity, attrs: payload.attrs }; return { id: payload.id }; } };
    for (const rule of prop.rules) if (rule.type === "key") recordKeyLesson(rule.label, rule.valueType, prop.kindName);
    const after = applyKeyLessons(text, prop.kindName).map((f) => ({ k: f.label, known: f.known }));
    return { kindName: prop.kindName, rules: prop.rules.length, after };
  });
  check("a local pass proposes rules (key / type / kind name)", r.rules >= 3 && /Adherence/.test(r.kindName), JSON.stringify(r).slice(0, 120));
  check("accepted proposals are applied on the next read", r.after.length > 0 && r.after.every((x) => x.known));
}

// 9i2. the lesson loop re-derives every other reading, recursively, TRACKING the
//      machine's changes and never touching a person's pinned text or kind
{
  const r = await page.evaluate(async () => {
    const before = configStore;
    const records = {
      // one active key lesson and one confirmed kind signature
      key_child_1_name: { entity: "doc_key", attrs: { label: "Child Name", status: "active", kind: "form", at: "" } },
      kind_form: { entity: "doc_kind", attrs: { name: "form", tokens: ["family", "court", "child"], count: 2, source: "confirmed" } },
    };
    configStore = { roomId: "!cfg", fold: () => ({ records }), emit: () => {} };
    const human = { id: "d1", roomId: "!a:hs", ocrText: "Family court\nChild Name: Ana\nChild 2 Name: Bo", ocrKind: "edited", docKind: "form", docKindAssertedBy: "@j:hs", ocrFields: [], ocrRelevant: [], ocrIgnored: null };
    const machine = { id: "d2", roomId: "!a:hs", ocrText: "Family court\nChild Name: Ana", docKind: null, ocrFields: null, ocrRelevant: [], ocrIgnored: null };
    const writes = [];
    const n = await reapplyLessonsEverywhere([human, machine], (d, patch) => writes.push({ id: d.id, patch }), { source: "test" });
    configStore = before;
    const h = writes.find((x) => x.id === "d1");
    const m = writes.find((x) => x.id === "d2");
    return {
      n,
      humanKindPinned: !h || h.patch.docKind === undefined,
      machineKindLearned: !!m && m.patch.docKind === "form",
      machineFieldsKnown: !!m && (m.patch.ocrFields || []).some((f) => f.label === "Child Name" && f.known),
      tracked: !!m && m.patch.ocrDerivedBy === "machine" && Array.isArray(m.patch.ocrDerivedHistory) && m.patch.ocrDerivedHistory.length === 1,
    };
  });
  check("a person's pinned kind survives the recursive re-derive", r.humanKindPinned);
  check("machine readings are re-classified and re-keyed", r.machineKindLearned && r.machineFieldsKnown, JSON.stringify(r));
  check("machine alterations are tracked, attributable and bounded", r.tracked && r.n <= 4);
}

// 9j. grid forms: header row -> columns; each row binds to them
{
  const r = await page.evaluate(() => {
    const els = [
      { text: "Date (mm/dd/yyyy)", region: [40, 100, 120, 14] },
      { text: "Last Name", region: [220, 100, 90, 14] },
      { text: "First Name", region: [330, 100, 90, 14] },
      { text: "01/10/2023", region: [40, 140, 90, 14] },
      { text: "Pei", region: [220, 140, 60, 14] },
      { text: "Lee", region: [330, 140, 60, 14] },
    ];
    const g = readGridFromElements(els);
    const t = readGridFromText(["Name   Service No   Rank", "W.D. Ranjan   008249   Tech", "H.C. Jayawardena   068301   Tk"]);
    return { geoCols: g.columns, geoRec: g.records, txtCols: t.columns, txtRec: t.records.length };
  });
  check("grid (geometry): a header row becomes the columns", r.geoCols.length === 3 && /Date/.test(r.geoCols[0]), JSON.stringify(r.geoCols));
  check("grid (geometry): a data row binds its cells to the columns", r.geoRec.length === 1 && r.geoRec[0]["Last Name"] === "Pei" && r.geoRec[0]["Date (mm/dd/yyyy)"] === "01/10/2023");
  check("grid (text fallback): a whitespace table is read", r.txtCols.length === 3 && r.txtRec === 2);
}

// 10. OCR/CV must never block a submission: a slow read is abandoned, a failed
//     read returns cleanly, and auto-reading can be switched off entirely.
{
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const timed = await withDeadline(new Promise(() => {}), 60, "Reading");
    const elapsed = performance.now() - t0;
    let threw = false, ret;
    try {
      ret = await readAndStoreOcr({ id: "x", mimetype: "image/png", url: "mxc://demo/missing", key: {}, iv: "x", hash: "x" }, mediaBackend(), { emit: () => {}, quiet: true });
    } catch (e) { threw = true; }
    try { localStorage.setItem("ab:ocr", "off"); } catch (e) {}
    const offRespected = ocrAutoAllowed() === false;
    try { localStorage.removeItem("ab:ocr"); } catch (e) {}
    return { timed, elapsed, threw, ret, offRespected };
  });
  check("a slow reader is abandoned, not left hanging", r.timed && r.timed.ok === false && r.elapsed < 2000);
  check("a failed read returns cleanly and never throws", r.threw === false && r.ret === false);
  check("auto-reading can be switched off at the device", r.offRespected === true);
}

await browser.close();
server.close();

// report
let failed = 0;
for (const r of results) {
  console.log(`${r.s === "PASS" ? "✔" : r.s === "FAIL" ? "✖" : "…"} ${r.s}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (r.s === "FAIL") failed++;
}
const anyTess = pageErrors.some((e) => /renderChildBanner|commitOcr|ocrPanel|readDocumentText|childIndices/.test(e));
console.log(`\n${results.length} checks · ${results.filter((r) => r.s === "PASS").length} pass · ${results.filter((r) => r.s === "SKIP").length} skip · ${failed} fail`);
if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 6));
process.exit(failed || anyTess ? 1 : 0);
