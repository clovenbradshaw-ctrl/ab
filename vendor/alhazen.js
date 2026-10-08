// Alhazen — the optics pipeline.
//
// Named for Ibn al-Haytham (Alhazen, 965–1040), who argued that seeing is not
// something the eye emits but something the light *imprints* — that vision is
// measured, not willed. This is the reading pipeline for documents: it takes a
// page's pixels, makes them legible, finds the keys and values on them, reads a
// grid's structure, and proposes rules about what it is seeing — every step
// measured, disclosed, and reversible.
//
// Pure and dependency-free. Loads as ESM (`import { ... } from './alhazen.js'`),
// CommonJS (`require`), or a classic `<script>` (exposes `window.Alhazen`).
//
// THE DISCIPLINE (shared with the rest of the fold): a reading is a hypothesis.
// Keys are not assumed correct; a value is reduced to its FORMAT and the value's
// content is thrown away; nothing here decides meaning on its own.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Alhazen = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ── optics: make a faint page legible ─────────────────────────────────────
  // Grayscale + Otsu binarize, in place, on RGBA pixel data. Gated to pages
  // that read as a document (a light background), so a dark/colourful UI
  // screenshot is left alone.
  function binarizeData(data, w, h, opts) {
    const n = w * h;
    if (!n || !data) return data;
    const gate = !opts || opts.gate !== false; // default: leave dark/UI alone
    const hist = new Array(256).fill(0);
    const gray = new Uint8ClampedArray(n);
    let sumL = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const g = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      gray[j] = g; hist[g]++; sumL += g;
    }
    if (gate && sumL / n < 120) return data; // dark / UI: leave it
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, max = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > max) { max = v; thr = t; }
    }
    for (let i = 0, j = 0; j < n; i += 4, j++) { const v = gray[j] > thr ? 255 : 0; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
    return data;
  }
  function binarizeCanvas(cv) {
    try {
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const im = cx.getImageData(0, 0, cv.width, cv.height);
      binarizeData(im.data, cv.width, cv.height);
      cx.putImageData(im, 0, 0);
    } catch (e) {}
    return cv;
  }

  // ── the value's FORMAT (its shape; the content is discarded) ─────────────
  function valueFormat(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "empty";
    if (/^[$€£]\s?\d[\d,]*\.?\d{0,2}$/.test(s)) return "currency";
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(s) || /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(s) || /^(0[1-9]|1[0-2])[0-2]\d(19|20)\d{2}$/.test(s)) return "date";
    if (/^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i.test(s)) return "time";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return "email";
    if (/^\+?1?[\s.\-()]*\d{3}[\s.\-()]*\d{3}[\s.\-]*\d{4}$/.test(s)) return "phone";
    if (/^(yes|no|true|false|s[ií])$/i.test(s)) return "choice";
    if (/\d/.test(s) && /^[A-Za-z0-9][A-Za-z0-9\-\/.]{3,}$/.test(s) && /[A-Za-z]/.test(s)) return "identifier";
    if (/^\d+$/.test(s)) return "integer";
    if (/^\d[\d,]*\.\d+$/.test(s)) return "decimal";
    if (/^[A-Za-z][A-Za-z.'\-]+( [A-Za-z][A-Za-z.'\-]+){1,3}$/.test(s)) return "name";
    return s.length > 60 ? "free-text" : "text";
  }

  // ── read a form: the label a page prints and the value beside it ─────────
  // colon, or two-or-more spaces, or " - ". Lowercase labels accepted.
  function extractFormFields(text) {
    const out = [];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.replace(/\s+$/, "").trim();
      if (line.length < 4) continue;
      let label, value;
      const sep = line.indexOf(":");
      if (sep > 1 && sep <= 40) { label = line.slice(0, sep); value = line.slice(sep + 1); }
      else {
        const m = /^([A-Za-z][A-Za-z ./()&#,\-]{1,40}?)(?:\s{2,}|\s+[-–—]\s+)(\S.*)$/.exec(line);
        if (!m) continue;
        label = m[1]; value = m[2];
      }
      label = label.replace(/[\s.:\-–—]+$/, "").trim();
      value = value.trim();
      const words = label.split(/\s+/).filter(Boolean);
      if (label.length < 2 || words.length > 6 || /\d/.test(label) || !/[A-Za-z]/.test(label)) continue;
      if (!value || /^[\W_]*$/.test(value)) continue;
      out.push({ label, value: value.slice(0, 220) });
      if (out.length >= 60) break;
    }
    return out;
  }
  function snake(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
  function titleLine(text) { return (String(text || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "").slice(0, 60); }

  // ── a grid ("nested") form: a header row defines columns; rows fill them ─
  function readGridFromElements(els) {
    const items = (els || []).filter((e) => e && e.text && e.region && String(e.text).trim())
      .map((e) => ({ t: String(e.text).trim(), x: e.region[0], y: e.region[1], h: e.region[3] }));
    if (items.length < 6) return { columns: [], records: [] };
    items.sort((a, b) => a.y - b.y);
    const rows = [];
    for (const it of items) {
      const cy = it.y + it.h / 2, r = rows[rows.length - 1];
      if (r && Math.abs(cy - r.cy) < Math.max(9, it.h * 0.6)) { r.items.push(it); r.cy = (r.cy * (r.items.length - 1) + cy) / r.items.length; }
      else rows.push({ cy, items: [it] });
    }
    if (rows.length < 2) return { columns: [], records: [] };
    const head = rows[0].items.slice().sort((a, b) => a.x - b.x);
    const colX = head.map((h) => h.x);
    const records = [];
    for (const r of rows.slice(1)) {
      const rec = {};
      for (const it of r.items) {
        let bi = 0, bd = 1e9;
        colX.forEach((cx, i) => { const d = Math.abs(cx - it.x); if (d < bd) { bd = d; bi = i; } });
        const key = head[bi] ? head[bi].t : ("col" + (bi + 1));
        rec[key] = rec[key] ? rec[key] + " " + it.t : it.t;
      }
      if (Object.keys(rec).length >= 2) records.push(rec);
    }
    return { columns: head.map((h) => h.t), records };
  }
  function readGridFromText(lines) {
    let header = null; const records = [];
    for (const line of lines) {
      const cells = line.trim().split(/\s{2,}|\t/).map((s) => s.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      if (!header && cells.every((c) => /[A-Za-z]/.test(c) && c.length <= 28)) { header = cells; continue; }
      if (header && cells.length >= Math.max(2, header.length - 1)) {
        const rec = {}; for (let i = 0; i < header.length; i++) rec[header[i]] = cells[i] || ""; records.push(rec);
      }
    }
    return { columns: header || [], records };
  }

  // ── the tuple of everything + nesting ────────────────────────────────────
  function inventTuples(text, elements) {
    const lines = String(text || "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
    const tuples = [];
    for (const line of lines) {
      const f = extractFormFields(line)[0];
      if (f) { const fmt = valueFormat(f.value); tuples.push({ label: f.label, value: f.value, canonical: snake(f.label), format: fmt, type: fmt }); }
    }
    let grid = elements && elements.length ? readGridFromElements(elements) : { columns: [], records: [] };
    if (!grid.records.length) grid = readGridFromText(lines);
    const cellLines = lines.filter((l) => l.trim().split(/\s{2,}|\t/).filter(Boolean).length >= 3);
    const nested = grid.records.length > 0 || cellLines.length >= 3;
    const kind = nested ? "table" : (tuples.length >= 3 ? "form" : "prose");
    const columns = grid.columns.length ? grid.columns : (nested ? cellLines[0].trim().split(/\s{2,}|\t/).filter(Boolean) : []);
    return { nested, kind, tuples, columns, records: grid.records, header: grid.columns };
  }

  // ── a local pass: propose rules about what it is seeing ──────────────────
  // Deterministic and offline; a local model may replace or supplement it.
  function structuralProposer(text, elements) {
    const inv = inventTuples(text, elements);
    const rules = [];
    for (const t of inv.tuples) rules.push({ type: "key", label: t.label, canonical: t.canonical, valueType: t.format, value: t.value });
    for (const r of (inv.records || [])) rules.push({ type: "record", record: r });
    if (inv.nested) {
      for (const c of inv.columns) rules.push({ type: "key", label: c, canonical: snake(c), valueType: "column" });
      rules.push({ type: "struct", structure: "table", nested: true, columns: inv.columns });
    }
    return { kindName: titleLine(text) || "unknown", structure: inv.kind, nested: inv.nested, rules };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEE ANYTHING — the domain-agnostic optical read.
  //
  // The document functions above assume a light page with dark ink. A reader
  // that only sees documents is blind to the rest of the world. These functions
  // make NO assumption about what the image is: they measure luminance, colour,
  // background and structure, cut the image into regions, name what the whole
  // looks like (sceneKind), and disclose what they could NOT read (gaps). Every
  // classification here is a PROPOSAL — falsifiable, reversible — never a fact.
  // ═══════════════════════════════════════════════════════════════════════════
  const _lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const _sat = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
  const _hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");

  // luminance + colour + sharpness, measured over the whole frame
  function frameStats(data, w, h) {
    const n = w * h; let sum = 0, sumSq = 0, sat = 0, dark = 0, light = 0;
    let gx = 0, gxp = 0; const seen = new Set();
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const L = _lum(r, g, b); sum += L; sumSq += L * L; sat += _sat(r, g, b);
      if (L < 60) dark++; if (L > 200) light++;
      seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      const x = j % w; if (x) gx += Math.abs(L - gxp); gxp = L;
    }
    const mean = sum / n, std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    return { mean: +mean.toFixed(1), std: +std.toFixed(1), saturation: +(sat / n).toFixed(3),
             darkShare: +(dark / n).toFixed(3), lightShare: +(light / n).toFixed(3),
             colors: seen.size, edge: +(gx / n).toFixed(1) };
  }

  // the frame's palette: the k most-covered colours (quantized to 4 bits/channel)
  function palette(data, w, h, k) {
    k = k || 8; const n = w * h, m = new Map();
    for (let i = 0, j = 0; j < n; i += 16, j += 4) { // sample every 4th pixel for speed
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      m.set(key, (m.get(key) || 0) + 1);
    }
    const tot = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, c]) => ({
      hex: _hex(((key >> 8) & 15) * 17, ((key >> 4) & 15) * 17, (key & 15) * 17), share: +(c / tot).toFixed(3),
    }));
  }

  // the frame's background: the dominant colour of the border band
  function backgroundOf(data, w, h) {
    const m = new Map(), band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    const add = (i) => { const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4); const e = m.get(key) || [0, 0, 0, 0]; e[0] += data[i]; e[1] += data[i + 1]; e[2] += data[i + 2]; e[3]++; m.set(key, e); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (x < band || x >= w - band || y < band || y >= h - band) add((y * w + x) * 4); }
    if (!m.size) return { hex: "#ffffff", lum: 255 };
    const [key, e] = [...m.entries()].sort((a, b) => b[1][3] - a[1][3])[0];
    const r = e[0] / e[3], g = e[1] / e[3], b = e[2] / e[3];
    return { hex: _hex(r, g, b), lum: +_lum(r, g, b).toFixed(1) };
  }

  // the ink mask: pixels that differ from the background by more than a threshold
  function inkMask(data, w, h, eps) {
    const bg = backgroundOf(data, w, h), thr = eps == null ? 45 : eps;
    const mask = new Uint8Array(w * h);
    let count = 0;
    for (let i = 0, j = 0; j < w * h; i += 4, j++) {
      const d = Math.abs(data[i] - parseHex(bg.hex, 0)) + Math.abs(data[i + 1] - parseHex(bg.hex, 1)) + Math.abs(data[i + 2] - parseHex(bg.hex, 2));
      if (d > thr) { mask[j] = 1; count++; }
    }
    return { mask, background: bg, share: +(count / (w * h)).toFixed(4) };
  }
  function parseHex(hex, k) { const v = parseInt(hex.slice(1 + k * 2, 3 + k * 2), 16); return isNaN(v) ? 0 : v; }

  // connected components of the ink mask (4-neighbour, iterative); boxes + area
  function segmentMask(mask, w, h, minArea) {
    const lab = new Int32Array(w * h).fill(-1), comps = [], st = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || lab[s] >= 0) continue;
      const id = comps.length, c = { id, minx: w, maxx: 0, miny: h, maxy: 0, area: 0 };
      st.push(s); lab[s] = id;
      while (st.length) {
        const p = st.pop(), x = p % w, y = (p - x) / w, L = mask;
        c.area++;
        if (x < c.minx) c.minx = x; if (x > c.maxx) c.maxx = x; if (y < c.miny) c.miny = y; if (y > c.maxy) c.maxy = y;
        if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; st.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; st.push(p + 1); }
        if (y > 0 && mask[p - w] && lab[p - w] < 0) { lab[p - w] = id; st.push(p - w); }
        if (y < h - 1 && mask[p + w] && lab[p + w] < 0) { lab[p + w] = id; st.push(p + w); }
      }
      if (c.area >= minArea) { c.region = [c.minx, c.miny, c.maxx - c.minx + 1, c.maxy - c.miny + 1]; comps.push(c); }
    }
    return comps;
  }
  // a component's kind, from its own geometry (never a model's guess)
  function classifyRegion(c) {
    const [x, y, rw, rh] = c.region, area = c.area, fill = area / (rw * rh), ar = rw / rh;
    if (rh <= 3 && rw >= 14) return "rule";
    if (rh >= 5 && rh <= 46 && rw >= 6 && ar >= 0.6 && fill < 0.85) return "text";
    if (fill >= 0.5 && rw >= 40 && rh >= 40) return "figure";
    if (fill >= 0.6) return "block";
    return "mark";
  }
  // text lines by horizontal projection (robust where per-letter components are not)
  function textBands(mask, w, h) {
    const rowc = new Int32Array(h);
    for (let p = 0; p < w * h; p++) if (mask[p]) rowc[(p - (p % w)) / w]++;
    const bands = []; let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rowc[y] > Math.max(2, w * 0.004);
      if (on && start < 0) start = y;
      if ((!on) && start >= 0) { if (y - start >= 4) bands.push({ y: start, h: y - start, rows: y - start }); start = -1; }
    }
    return bands;
  }

  // classify the whole frame — the sceneKind is a PROPOSAL, not a fact
  function classifyScene(fs, bg, inkShare, pal, regionCounts) {
    const colors = fs.colors || pal.filter((p) => p.share > 0.02).length;
    const colorful = fs.saturation > 0.22;
    if (inkShare < 0.003 && fs.std < 10) return "blank";
    if (colorful && colors > 16 && fs.std > 25) return "photograph";   // many distinct tones, no flat page
    if (bg.lum <= 110 && fs.lightShare < 0.5) return "screenshot";     // dark UI
    if (bg.lum > 190 && colors <= 8 && regionCounts.rule >= 10 && regionCounts.text < 10) return "chart";
    if (bg.lum > 190 && colors <= 8 && regionCounts.rule >= 6 && regionCounts.text < 6) return "diagram";
    if (bg.lum > 170 && colors <= 16) return "document";
    if (regionCounts.text >= 1) return "document";
    return "unknown";
  }

  // THE READ: any image → a disclosed optical record
  function readImage(data, w, h, opts) {
    opts = opts || {};
    const fs = frameStats(data, w, h);
    const pal = palette(data, w, h, opts.palette || 8);
    const ink = inkMask(data, w, h, opts.epsilon);
    const minArea = opts.minArea || Math.max(12, Math.round(w * h / 20000));
    const comps = segmentMask(ink.mask, w, h, minArea);
    const regions = comps.map((c) => { const k = classifyRegion(c); return { region: c.region, area: c.area, kind: k, fill: +(c.area / (c.region[2] * c.region[3])).toFixed(2) }; });
    const bands = textBands(ink.mask, w, h);
    const counts = { rule: 0, text: 0, figure: 0, block: 0, mark: 0 };
    for (const r of regions) counts[r.kind] = (counts[r.kind] || 0) + 1;
    if (bands.length > counts.text) counts.text = bands.length;
    const sceneKind = classifyScene(fs, ink.background, ink.share, pal, counts);
    const gaps = [];
    if (sceneKind === "photograph") gaps.push({ kind: "no_vision_model", because: "a photograph has no text to read; only colour, luminance and structure were measured" });
    if (counts.figure) gaps.push({ kind: "figure_unread", n: counts.figure, because: "figure regions were located but their content was not read (no vision model)" });
    if (!counts.text && sceneKind !== "blank" && sceneKind !== "photograph") gaps.push({ kind: "no_text_found", because: "no text-like regions were found" });
    return {
      schema: "AlhazenSee@1", width: w, height: h,
      luminance: { mean: fs.mean, std: fs.std, contrast: fs.std, edge: fs.edge },
      saturation: fs.saturation, background: ink.background.hex, backgroundLum: ink.background.lum,
      polarity: ink.background.lum > 128 ? "dark-on-light" : "light-on-dark",
      inkShare: ink.share, palette: pal,
      sceneKind, regionCounts: counts, textLines: bands.length, regions, gaps,
      standing: "measured; sceneKind is a proposal, not a fact",
    };
  }

  // ── GET BETTER: propose rules from a reading + its ground truth ──────────
  // `truth` is a template of what the page truly holds:
  //   { kind, fields:[{label, value, box}], columns?, records? }
  // Returns rules the reader can apply to its NEXT look — the content of a
  // value never crosses; only the label's canonical name and the value's FORMAT.
  function learnFrom(read, truth) {
    const t = truth || {}, rules = [];
    const seen = new Map();
    for (const f of (t.fields || [])) {
      if (!f || !f.label) continue;
      const canonical = snake(f.label);
      if (!canonical) continue;
      const valueType = f.format && f.format !== "empty" ? f.format : valueFormat(f.value);
      const e = seen.get(canonical);
      if (e) { e.n++; if (e.valueType === "text" && valueType !== "text") e.valueType = valueType; }
      else { seen.set(canonical, { n: 1, valueType }); }
    }
    for (const [canonical, e] of seen) rules.push({ type: "key", canonical, valueType: e.valueType, witness: "ground-truth", n: e.n });
    if (t.kind) rules.push({ type: "kind", name: t.kind, witness: "ground-truth" });
    if (t.records && t.records.length) rules.push({ type: "struct", structure: "table", columns: t.columns || Object.keys(t.records[0]), nested: true, witness: "ground-truth" });
    return rules;
  }

  // apply learned rules to a look: use the label lexicon to bind pairs whose
  // format the plain pass would miss (no colon, no 2-space run)
  function applyRules(text, elements, rules) {
    const keyTypes = new Map();
    for (const r of rules || []) if (r.type === "key" && r.canonical) keyTypes.set(r.canonical, r.valueType);
    const base = inventTuples(text, elements);
    const tuples = [...base.tuples];
    const have = new Set(tuples.map((x) => x.canonical));
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      for (const [canonical, valueType] of keyTypes) {
        if (have.has(canonical)) continue;
        const words = canonical.split("_");
        const re = new RegExp("^\\s*" + words.map((w) => w.slice(0, 4)).join("[a-z]*[ .]*") + "[a-z]*[ .:]*[\\-–—]?\\s+(\\S.*)$", "i");
        const m = re.exec(line);
        if (m && m[1] && m[1].trim().length) {
          tuples.push({ label: line.slice(0, m.index + m[0].length - m[1].length).trim().replace(/[.:\-–—\s]+$/, ""), value: m[1].trim(), canonical, format: valueType, type: valueType, via: "learned-rule" });
          have.add(canonical); break;
        }
      }
    }
    return { ...base, tuples };
  }

  // a read's agreement with truth — the number the improvement loop climbs
  function scoreRead(read, truth) {
    const t = truth || {}, pred = (read && read.tuples) || [];
    const key = (canonical, value) => canonical + "=" + String(value).trim().toLowerCase();
    const P = new Set(pred.map((p) => key(p.canonical, p.value)));
    const G = (t.fields || []).map((f) => key(snake(f.label), f.value));
    const hit = G.filter((g) => P.has(g)).length;
    const fmtOk = pred.filter((p) => { const f = (t.fields || []).find((x) => snake(x.label) === p.canonical); return f && valueFormat(f.value) === p.format; }).length;
    return {
      gt: G.length, pred: pred.length,
      recall: G.length ? +(hit / G.length).toFixed(3) : null,
      precision: pred.length ? +(hit / pred.length).toFixed(3) : null,
      formatAccuracy: pred.length ? +(fmtOk / pred.length).toFixed(3) : null,
    };
  }

  // the append-only rule ledger — how the reader remembers what it learned
  function createRuleLedger() {
    const rules = [];
    return {
      schema: "AlhazenRules@1", rules,
      add(rs) { for (const r of rs || []) if (!rules.some((x) => x.type === r.type && x.canonical === r.canonical)) rules.push({ ...r, at: rules.length }); return this; },
      falsify(canonical, reason) { const r = rules.find((x) => x.canonical === canonical); if (r) { r.falsified = reason || true; r.at = rules.length; } return this; },
      active() { return rules.filter((r) => !r.falsified); },
      keyTypes() { const m = new Map(); for (const r of this.active()) if (r.type === "key") m.set(r.canonical, r.valueType); return m; },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MANY EYES — a reader that sniffs what it is, opens the right eyes, and
  // reconciles them into one reading with its dissent named.
  //
  // A single eye sees one thing well and is blind to the rest. So: an EYE is a
  // strategy over one channel (pixels, a text layer, a depth buffer, frames); a
  // SNIFF decides which eyes a thing deserves; the eyes run; RECONCILE reports
  // where they AGREE, where they give MEANINGFUL DELTAS (a disagreement that
  // changes the read), and what stays contested. Nothing here decides meaning
  // alone — a reading survives only the contention of the others.
  // ═══════════════════════════════════════════════════════════════════════════

  const rectArea = (r) => (r ? Math.max(0, r[2]) * Math.max(0, r[3]) : 0);
  function overlapFrac(a, b) {
    if (!a || !b) return 0;
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const min = Math.min(rectArea(a), rectArea(b));
    return min > 0 ? (ix * iy) / min : 0;
  }
  // two region-kinds are "the same class" when they'd agree about what it is
  const roleClass = (k) => {
    const s = String(k || "");
    if (/wash|colour|color|figure|photo|image|chart|highlight/.test(s)) return "ink-of-colour";
    if (/text|ink|line|mark|block|rule/.test(s)) return "ink-of-form";
    return s || "unknown";
  };

  // ── layers: extract the z-planes OF a 2D image (paper/ink/wash/faint/figure)
  function layersOf(data, w, h, opts) {
    opts = opts || {};
    const bg = backgroundOf(data, w, h);
    const bgR = parseHex(bg.hex, 0), bgG = parseHex(bg.hex, 1), bgB = parseHex(bg.hex, 2);
    const n = w * h, faintT = opts.faint == null ? 40 : opts.faint, inkT = opts.ink == null ? 120 : opts.ink;
    const roll = { paper: null, faint: null, wash: null, ink: null };
    const acc = {};
    const bump = (k, x, y, r, g, b, dist) => {
      const a = acc[k] || (acc[k] = { n: 0, x0: w, y0: h, x1: 0, y1: 0, r: 0, g: 0, b: 0, op: 0 });
      a.n++; if (x < a.x0) a.x0 = x; if (x > a.x1) a.x1 = x; if (y < a.y0) a.y0 = y; if (y > a.y1) a.y1 = y; a.r += r; a.g += g; a.b += b;
      a.op += Math.min(1, dist / 255);
    };
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const r = data[i], g = data[i + 1], b = data[i + 2], x = j % w, y = (j - x) / w;
      const L = _lum(r, g, b), d = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB), sat = _sat(r, g, b);
      let k;
      if (d < faintT) k = "paper";
      else if (sat > 0.25) k = "wash";
      else if (d > inkT) k = "ink";
      else k = "faint";
      bump(k, x, y, r, g, b, d);
    }
    const order = ["paper", "faint", "wash", "figure", "ink"];
    const layers = order.filter((k) => acc[k] && acc[k].n).map((k) => {
      const a = acc[k];
      return { role: k, share: +(a.n / n).toFixed(4), region: [a.x0, a.y0, a.x1 - a.x0 + 1, a.y1 - a.y0 + 1],
               color: _hex(a.r / a.n, a.g / a.n, a.b / a.n), opacity: +(a.op / a.n).toFixed(3) };
    });
    return { schema: "AlhazenLayers@1", width: w, height: h, background: bg.hex, layers, zOrder: order,
             note: "a 2D image read as stacked z-planes; z is a role ordering, not a measured depth" };
  }

  // ── 3D: a depth buffer → a surface read; or a point cloud → a mesh summary
  function read3D(input) {
    const w = input.width, h = input.height, depth = input.depth;
    if (!depth || !w || !h) return { schema: "Alhazen3D@1", gap: "needs_depth", because: "no depth buffer supplied" };
    const n = w * h; let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < n; i++) { const z = depth[i]; if (!isFinite(z)) continue; if (z < min) min = z; if (z > max) max = z; sum += z; }
    const mean = sum / n; let sq = 0;
    for (let i = 0; i < n; i++) { const z = depth[i]; if (isFinite(z)) sq += (z - mean) * (z - mean); }
    const std = Math.sqrt(sq / n), range = max - min || 1;
    // slope + facing histogram (which way the surface turns), from finite diffs
    let slopeSum = 0, slopeMax = 0, up = 0, tilt = 0, steep = 0;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x, dx = depth[i + 1] - depth[i], dy = depth[i + w] - depth[i], s = Math.sqrt(dx * dx + dy * dy);
      slopeSum += s; if (s > slopeMax) slopeMax = s;
      if (s < range * 0.02) up++; else if (s < range * 0.15) tilt++; else steep++;
    }
    const cells = (w - 1) * (h - 1);
    // relief segments: quantize depth into bands, report each band's region
    const B = 4, segs = [];
    for (let b = 0; b < B; b++) {
      const lo = min + (range * b) / B, hi = min + (range * (b + 1)) / B;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, c = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const z = depth[y * w + x]; if (z >= lo && (b === B - 1 ? z <= hi : z < hi)) { c++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
      if (c) segs.push({ band: b, z: [+lo.toFixed(3), +hi.toFixed(3)], share: +(c / n).toFixed(3), region: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] });
    }
    return { schema: "Alhazen3D@1", width: w, height: h,
             depth: { min: +min.toFixed(3), max: +max.toFixed(3), mean: +mean.toFixed(3), std: +std.toFixed(3), range: +range.toFixed(3) },
             relief: { meanSlope: +(slopeSum / cells).toFixed(3), maxSlope: +slopeMax.toFixed(3), bumpiness: +(std / range).toFixed(3) },
             facing: { flat: +(up / (up + tilt + steep || 1)).toFixed(3), tilt: +(tilt / (up + tilt + steep || 1)).toFixed(3), steep: +(steep / (up + tilt + steep || 1)).toFixed(3) },
             segments: segs,
             claims: segs.map((s, i) => ({ key: "depth_band_" + i, kind: "region", region: s.region, value: s.z.join("..") })) };
  }

  // a point cloud or mesh (ASCII "x y z" lines, .ply, .obj) → bounds/centroid
  function readPointCloud(text) {
    const pts = [];
    for (const line of String(text || "").split("\n")) {
      const t = line.trim(); if (!t || t[0] === "#" || /^(ply|end_header|solid|f|vn|vt|element|property|format|comment)/i.test(t)) continue;
      const m = t.match(/^(?:v\s+)?(-?[\d.]+)[ ,]+(-?[\d.]+)[ ,]+(-?[\d.]+)/);
      if (m) pts.push([+m[1], +m[2], +m[3]]);
    }
    if (!pts.length) return { schema: "AlhazenMesh@1", gap: "no_points" };
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], c = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; c[k] += p[k]; }
    const centroid = c.map((v) => +(v / pts.length).toFixed(3));
    const size = mx.map((v, k) => +(v - mn[k]).toFixed(3));
    const vol = size[0] * size[1] * size[2] || 1;
    return { schema: "AlhazenMesh@1", points: pts.length, bounds: { min: mn, max: mx }, size, centroid,
             density: +(pts.length / vol).toFixed(4), dimensional: size.filter((s) => s > 1e-6).length };
  }

  // ── lift 2D layers into a 3D scene graph (z from the layer's role) ───────
  const LAYER_Z = { paper: 0, faint: 0.25, wash: 0.5, figure: 0.75, ink: 1 };
  function liftTo3D(layers) {
    const ls = (layers && layers.layers) || layers || [];
    const planes = ls.map((l) => ({ role: l.role, z: LAYER_Z[l.role] != null ? LAYER_Z[l.role] : 0.5, region: l.region, color: l.color, share: l.share, opacity: l.opacity }));
    planes.sort((a, b) => a.z - b.z);
    return { schema: "AlhazenScene@1", source: "2D lifted to a z-stack", planes,
             standing: "z is a role-derived ordering, not measured depth — a hypothesis about layering" };
  }

  // ── the eye registry — one channel each, honest about what it cannot see ──
  function rasterEye(input, opts) {
    const r = readImage(input.data, input.width, input.height, opts);
    const claims = (r.regions || []).map((g, i) => ({ key: "region_" + i, kind: g.kind, region: g.region }));
    claims.push({ key: "sceneKind", kind: "meta", value: r.sceneKind, region: [0, 0, r.width, r.height] });
    return { kind: "raster", basis: "pixels + geometry", coverage: r.regions.length ? 1 : 0.2, data: r, claims };
  }
  function layerEye(input, opts) {
    const l = layersOf(input.data, input.width, input.height, opts);
    const claims = l.layers.map((x, i) => ({ key: "layer_" + i, kind: x.role, region: x.region }));
    return { kind: "layer", basis: "pixel decomposition into z-planes", coverage: l.layers.length ? 0.8 : 0, data: l, claims };
  }
  function textEye(input) {
    const t = input.text || "";
    if (!t) return { kind: "text", basis: "ocr / text layer", coverage: 0, gap: "needs_ocr",
                     because: "no text channel was supplied; this eye needs an OCR or embedded-text source", claims: [] };
    const tuples = extractFormFields(t).map((f) => ({ ...f, format: valueFormat(f.value), canonical: snake(f.label) }));
    return { kind: "text", basis: "ocr / text channel", coverage: tuples.length ? 1 : 0, data: { tuples },
             claims: tuples.map((f) => ({ key: f.canonical, kind: "value", value: f.value, format: f.format, region: null })) };
  }
  function gridEye(input) {
    const els = input.elements || [];
    const g = readGridFromElements(els);
    return { kind: "grid", basis: "cell geometry", coverage: g.records.length ? 1 : 0, data: g,
             claims: (g.records || []).map((r, i) => ({ key: "row_" + i, kind: "record", value: JSON.stringify(r) })) };
  }
  function depthEye(input) { const d = read3D(input); return { kind: "depth3d", basis: "depth buffer", coverage: d.segments ? 1 : 0, data: d, claims: d.claims || [] }; }
  function temporalEye(input) {
    const f = input.frames || [];
    if (f.length < 2) return { kind: "temporal3d", basis: "frames (x,y,t)", coverage: 0, gap: "needs_frames", claims: [] };
    let moved = 0, tot = 0, w = f[0].width, h = f[0].height;
    for (let k = 1; k < f.length; k++) { const a = f[k - 1].data, b = f[k].data; for (let i = 0; i < w * h; i += 4) { const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); tot++; if (d > 60) moved++; } }
    return { kind: "temporal3d", basis: "frame differencing (x,y,t)", coverage: 1, data: { frames: f.length, motion: +(moved / (tot || 1)).toFixed(3) },
             claims: [{ key: "motion", kind: "meta", value: +(moved / (tot || 1)).toFixed(3) }] };
  }
  const EYES = { raster: rasterEye, layer: layerEye, text: textEye, grid: gridEye, depth3d: depthEye, temporal3d: temporalEye };

  // ── sniff: what IS this, and which eyes does it deserve? ─────────────────
  function sniffMagic(u8) {
    const b = u8; if (!b || !b.length) return null;
    if (b[0] === 0x89 && b[1] === 0x50) return "raster";
    if (b[0] === 0xff && b[1] === 0xd8) return "raster";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "raster";
    if (b[0] === 0x42 && b[1] === 0x4d) return "raster";
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video";
    if (b.length > 8 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return "video";
    return null;
  }
  function sniffText(s) {
    const t = String(s).slice(0, 300).replace(/^\uFEFF/, "").trim();
    if (/^(ply\b|solid\s|#?\s*obj\b)/i.test(t)) return "mesh";
    if (/<(!doctype\s+html|html|div|p|body|table)\b/i.test(t)) return "html";
    if (/^\s*-?[\d.]+\s+[,\s]\s*-?[\d.]+\s+[,\s]\s*-?[\d.]+/m.test(t)) return "pointcloud";
    if (/^[\[{]/.test(t)) return "json";
    return "text";
  }
  function sniff(input) {
    if (!input) return { kind: "unknown", why: "no input" };
    if (input.depth && input.width && input.height) return { kind: "depth", why: "a depth buffer was supplied", eyes: ["depth3d", "layer"] };
    if (input.frames && input.frames.length) return { kind: "video", why: `${input.frames.length} frames (x,y,t)`, eyes: ["fourd", "raster", "layer"] };
    if (input.data && input.width && input.height) {
      const fs = frameStats(input.data, input.width, input.height), bg = backgroundOf(input.data, input.width, input.height);
      const colorful = fs.saturation > 0.22, lightDoc = bg.lum > 170 && fs.saturation < 0.2;
      if (colorful) return { kind: "photo", why: "high colour saturation, few text-like cues", eyes: ["raster", "layer"] };
      if (lightDoc) return { kind: "document", why: "light background, low colour: a page", eyes: ["raster", "layer", "text", "grid"] };
      return { kind: "raster", why: "pixels, ambiguous scene", eyes: ["raster", "layer", "text"] };
    }
    if (input.bytes && input.bytes.length) { const k = sniffMagic(input.bytes) || "unknown"; const eyes = k === "pdf" ? ["text", "grid", "raster"] : k === "video" ? ["temporal3d", "raster"] : k === "raster" ? ["raster", "layer"] : ["raster"]; return { kind: k, why: "magic bytes", eyes }; }
    if (typeof input === "string" || input.text) { const s = typeof input === "string" ? input : input.text; const k = sniffText(s); const eyes = k === "mesh" || k === "pointcloud" ? ["depth3d"] : k === "html" ? ["text", "grid"] : k === "json" ? ["text"] : ["text", "grid"]; return { kind: k, why: "text structure", eyes }; }
    return { kind: "unknown", why: "unrecognised input shape" };
  }

  // ── reconcile: agreement, meaningful deltas, and the named dissent ───────
  function reconcile(readings) {
    const claims = [];
    for (const r of readings || []) for (const c of (r.claims || [])) claims.push({ ...c, eye: r.eye });
    const byKey = new Map();
    for (const c of claims) { if (c.region === undefined) c.region = null; if (!byKey.has(c.key)) byKey.set(c.key, []); byKey.get(c.key).push(c); }
    const agreement = [], deltas = [];
    for (const [key, cs] of byKey) {
      const eyes = [...new Set(cs.map((c) => c.eye))];
      const vals = [...new Set(cs.filter((c) => c.value != null).map((c) => c.value))];
      if (eyes.length > 1 && vals.length > 1) deltas.push({ kind: "value_conflict", key, eyes, values: vals, magnitude: vals.length });
      else if (eyes.length > 1) agreement.push({ key, eyes, value: cs.find((c) => c.value != null)?.value ?? null, region: cs[0].region });
    }
    // region deltas: different eyes, overlapping regions, disagreeing roles.
    // Aggregated per (eye-pair, role-class pair) so the dissent is MEANINGFUL —
    // one named disagreement with its count and worst case, never 200 echoes.
    // A FIELD claim (background/paper, a full-frame meta claim) is not a
    // competitor about a sub-region; it is excluded rather than faked into a
    // conflict with everything it contains.
    const frame = (readings || []).reduce((m, r) => Math.max(m, (r.data && r.data.width && r.data.height) ? r.data.width * r.data.height : 0), 0);
    const isField = (c) => !c.region || c.kind === "meta" || c.kind === "paper" || (frame && c.region[2] * c.region[3] > 0.5 * frame);
    const rc = new Map();
    for (let i = 0; i < claims.length; i++) for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i], b = claims[j];
      if (a.eye === b.eye || !a.region || !b.region || isField(a) || isField(b)) continue;
      const ov = overlapFrac(a.region, b.region);
      if (ov <= 0.45 || roleClass(a.kind) === roleClass(b.kind)) continue;
      const ca = roleClass(a.kind), cb = roleClass(b.kind);
      const key = [a.eye, b.eye].sort().join("|") + ":" + [ca, cb].sort().join(">");
      const e = rc.get(key) || { kind: "role_conflict", eyes: [a.eye, b.eye].sort(), classes: [ca, cb], n: 0, maxOverlap: 0, region: a.region };
      e.n++; if (ov > e.maxOverlap) { e.maxOverlap = ov; e.region = a.region; }
      rc.set(key, e);
    }
    for (const e of rc.values()) deltas.push({ ...e, magnitude: +e.maxOverlap.toFixed(2) });
    const gaps = (readings || []).filter((r) => r.gap).map((r) => ({ eye: r.eye, gap: r.gap, because: r.because || null }));
    const coverage = (readings || []).reduce((m, r) => Math.max(m, r.coverage || 0), 0);
    return { schema: "AlhazenReconcile@1", eyes: (readings || []).map((r) => r.eye), claims: claims.length,
             agreement, deltas, gaps, coverage: +coverage.toFixed(3), converged: deltas.length === 0,
             dissent: deltas.length ? deltas.map((d) => `${d.eyes.join(" vs ")} disagree (${d.kind}${d.key ? ":" + d.key : ""}${d.classes ? " " + d.classes.join("~") : ""}${d.n ? " ×" + d.n : ""}${d.magnitude != null ? " mag " + d.magnitude : ""})`) : [] };
  }

  // ── LOOK: sniff → open the right eyes → reconcile into one reading ───────
  function look(input, opts) {
    opts = opts || {};
    input = prepare(input);
    const s = opts.sniff || sniff(input);
    const names = opts.eyes || s.eyes || ["raster"];
    const readings = [];
    for (const nm of names) { const eye = EYES[nm]; if (!eye) continue; try { readings.push({ ...eye(input, opts), eye: nm }); } catch (e) { readings.push({ eye: nm, error: String(e), claims: [], coverage: 0 }); } }
    const rec = reconcile(readings);
    const out = { schema: "AlhazenLook@1", sniff: s, eyes: readings.map((r) => r.eye), readings, reconciled: rec };
    if (readings.some((r) => r.kind === "layer")) out.scene3d = liftTo3D(readings.find((r) => r.kind === "layer").data);
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4D — things moving through time. A single frame is a slice; a sequence is a
  // world-line. These functions accumulate a decaying ACTIVITY TRAIL over time
  // (what moved and where it persisted), track the motion centroid, estimate
  // MOTION BLUR from the smear between frames, and render the long exposure so
  // the trails themselves become an image another eye can read.
  // ═══════════════════════════════════════════════════════════════════════════
  function trailToRGBA(trail, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < w * h; j++) { const v = Math.round(255 * Math.min(1, trail[j])); out[j * 4] = 255; out[j * 4 + 1] = v; out[j * 4 + 2] = Math.max(0, 140 - v); out[j * 4 + 3] = 255; }
    return out;
  }
  // track OBJECTS (not just motion) across frames of a static-camera scene:
  // foreground = pixels that differ from the frame's own background; each blob
  // carries a learned identity signature (its colour) and a size. Association
  // combines a scale-invariant POSITION gate with an APPEARANCE distance, so the
  // reader discovers which blob is which — it is never told how many there are,
  // what colours they are, or that size may change. Identity survives growth,
  // shrinkage and occlusion (coast + re-identify).
  function trackObjects(frames, opts) {
    opts = opts || {};
    const w = frames[0].width, h = frames[0].height;
    const maxOcc = opts.maxOcclusion == null ? Math.max(6, Math.round(frames.length * 0.6)) : opts.maxOcclusion;
    const baseR = opts.radius || Math.max(10, Math.hypot(w, h) * 0.09);
    const minArea = opts.minArea || Math.max(4, Math.round(w * h / 60000));
    const fgT = opts.fgThreshold == null ? 110 : opts.fgThreshold;
    const tracks = [];
    for (let k = 0; k < frames.length; k++) {
      const d = frames[k].data, bg = backgroundOf(d, w, h);
      const bgR = parseHex(bg.hex, 0), bgG = parseHex(bg.hex, 1), bgB = parseHex(bg.hex, 2);
      const fg = new Uint8Array(w * h);
      for (let j = 0; j < w * h; j++) { const i = j * 4; if (Math.abs(d[i] - bgR) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bgB) > fgT) fg[j] = 1; }
      const comps = segmentMask(fg, w, h, minArea).map((c) => ({ cx: c.region[0] + c.region[2] / 2, cy: c.region[1] + c.region[3] / 2, area: c.area, region: c.region, size: Math.sqrt(c.area), color: _meanColor(d, w, c.region), used: false }));
      for (const t of tracks) { if (t.dead) continue; t.px = t.x + (t.vx || 0); t.py = t.y + (t.vy || 0); t._m = false; }
      // cost: appearance (learned colour) first, position second — scale-agnostic
      const pairs = [];
      for (const t of tracks) { if (t.dead) continue; const gate = t.hidden ? baseR * 3.5 : baseR * 1.8;
        for (const c of comps) { if (c.used) continue; const dd = Math.hypot(c.cx - t.px, c.cy - t.py), cd = _colDist(c.color, t.color);
          if (dd <= gate || cd < 70) pairs.push({ t, c, score: cd / 765 + dd / (gate * 2) }); } }
      pairs.sort((A, B) => A.score - B.score);
      for (const { t, c } of pairs) {
        if (t._m || c.used) continue;
        const dx = c.cx - t.x, dy = c.cy - t.y; t.vx = t.vx == null ? dx : 0.6 * t.vx + 0.4 * dx; t.vy = t.vy == null ? dy : 0.6 * t.vy + 0.4 * dy;
        t.x = c.cx; t.y = c.cy; t.last = k; t._m = true; c.used = true;
        t.color = _mix(t.color, c.color, 0.5);
        t.areas.push(c.area); t.path.push([+c.cx.toFixed(1), +c.cy.toFixed(1)]);
        if (t.hidden) { t.occlusions.push({ from: t.hiddenSince, to: k, frames: k - t.hiddenSince, entry: t.hiddenAt, exit: [+c.cx.toFixed(1), +c.cy.toFixed(1)] }); t.hidden = false; t.reappeared = true; t.hiddenCount = 0; }
      }
      for (const c of comps) { if (c.used) continue; tracks.push({ id: tracks.length, path: [[+c.cx.toFixed(1), +c.cy.toFixed(1)]], areas: [c.area], x: c.cx, y: c.cy, vx: 0, vy: 0, color: c.color, start: k, last: k, hidden: false, hiddenCount: 0, occlusions: [], reappeared: false, _m: true }); }
      for (const t of tracks) { if (t.dead || t._m) continue;
        t.hiddenCount = (t.hiddenCount || 0) + 1;
        if (!t.hidden) { t.hidden = true; t.hiddenSince = k; t.hiddenAt = [+t.x.toFixed(1), +t.y.toFixed(1)]; }
        t.x = t.px; t.y = t.py;
        if (t.hiddenCount > maxOcc) { t.dead = true; t.lost = true; }
      }
    }
    for (const t of tracks) {
      t.span = t.last - t.start;
      if (t.path.length >= 2) { const dx = t.path[t.path.length - 1][0] - t.path[0][0], dy = t.path[t.path.length - 1][1] - t.path[0][1]; t.displacement = +Math.hypot(dx, dy).toFixed(1); } else t.displacement = 0;
      t.speed = +(t.displacement / Math.max(1, t.span)).toFixed(2);
      const a = t.areas || [0]; t.areaMin = Math.min(...a); t.areaMax = Math.max(...a); t.sizeChange = +(t.areaMax / Math.max(1, t.areaMin)).toFixed(2);
      t.occludedFrames = (t.occlusions || []).reduce((s, o) => s + o.frames, 0);
      t.permanent = t.occlusions && t.occlusions.length > 0 && t.reappeared;
      t.color = t.color.map((v) => Math.round(v));
      t.colorHex = _hex(t.color[0], t.color[1], t.color[2]);
    }
    return tracks.filter((t) => !t.lost && (t.path.length >= 3 || (t.occlusions && t.occlusions.length)));
  }
  // associated into tracks (id, path, velocity, colour signature). A track that
  // loses its blob is not killed — it COASTS on its last velocity (hidden), and
  // when a blob reappears near the predicted position with a matching colour it
  // is re-identified as the SAME object. Occlusion events are recorded, so a
  // ball that goes behind something and returns keeps one identity throughout.
  const _meanColor = (data, w, region) => { const [x0, y0, rw, rh] = region; let r = 0, g = 0, b = 0, n = 0; for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) { const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; } return n ? [r / n, g / n, b / n] : [0, 0, 0]; };
  const _colDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const _mix = (a, b, al) => [a[0] * (1 - al) + b[0] * al, a[1] * (1 - al) + b[1] * al, a[2] * (1 - al) + b[2] * al];
  function trackMotions(frames, opts) {
    opts = opts || {};
    const w = frames[0].width, h = frames[0].height, thr = opts.threshold == null ? 60 : opts.threshold;
    const maxOcc = opts.maxOcclusion == null ? Math.max(6, Math.round(frames.length * 0.5)) : opts.maxOcclusion;
    const baseR = Math.max(12, Math.hypot(w, h) * 0.12), minArea = Math.max(6, Math.round(w * h / 40000));
    const tracks = [];
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1].data, b = frames[k].data, mask = new Uint8Array(w * h);
      for (let j = 0; j < w * h; j++) { const i = j * 4; if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > thr) mask[j] = 1; }
      const comps = segmentMask(mask, w, h, minArea).map((c) => ({ cx: c.region[0] + c.region[2] / 2, cy: c.region[1] + c.region[3] / 2, area: c.area, region: c.region, used: false, color: _meanColor(b, w, c.region) }));
      // predict each live track forward on its own velocity
      for (const t of tracks) { if (t.dead) continue; t.px = t.x + (t.vx || 0); t.py = t.y + (t.vy || 0); t._m = false; }
      // 1) associate blobs to tracks by predicted position + colour (a hidden
      //    track gets a wider gate, which is how a returning object is reclaimed)
      const pairs = [];
      for (const t of tracks) { if (t.dead) continue; const r = t.hidden ? baseR * 2.4 : baseR;
        for (const c of comps) { if (c.used) continue; const d = Math.hypot(c.cx - t.px, c.cy - t.py); if (d <= r) pairs.push({ t, c, score: d / r + _colDist(c.color, t.color) * 0.0015 }); } }
      pairs.sort((A, B) => A.score - B.score);
      for (const { t, c } of pairs) {
        if (t._m || c.used) continue;
        const dx = c.cx - t.x, dy = c.cy - t.y;
        t.vx = t.vx == null ? dx : 0.6 * t.vx + 0.4 * dx; t.vy = t.vy == null ? dy : 0.6 * t.vy + 0.4 * dy;
        t.x = c.cx; t.y = c.cy; t.last = k; t._m = true; c.used = true;
        t.color = _mix(t.color, c.color, 0.5);
        t.path.push([+c.cx.toFixed(1), +c.cy.toFixed(1)]);
        if (t.hidden) { t.occlusions.push({ from: t.hiddenSince, to: k, frames: k - t.hiddenSince, entry: t.hiddenAt, exit: [+c.cx.toFixed(1), +c.cy.toFixed(1)] }); t.hidden = false; t.reappeared = true; t.hiddenCount = 0; }
      }
      // 2) unmatched blobs → new tracks
      for (const c of comps) { if (c.used) continue; tracks.push({ id: tracks.length, path: [[+c.cx.toFixed(1), +c.cy.toFixed(1)]], x: c.cx, y: c.cy, vx: 0, vy: 0, color: c.color, start: k, last: k, hidden: false, hiddenCount: 0, occlusions: [], reappeared: false, _m: true }); }
      // 3) unmatched tracks → HIDE and coast (permanence), die only if lost too long
      for (const t of tracks) { if (t.dead || t._m) continue;
        t.hiddenCount = (t.hiddenCount || 0) + 1;
        if (!t.hidden) { t.hidden = true; t.hiddenSince = k; t.hiddenAt = [+t.x.toFixed(1), +t.y.toFixed(1)]; }
        t.x = t.px; t.y = t.py;                                    // coast on velocity
        if (t.hiddenCount > maxOcc) { t.dead = true; t.lost = true; }
      }
    }
    for (const t of tracks) {
      if (t.path.length >= 2) { const dx = t.path[t.path.length - 1][0] - t.path[0][0], dy = t.path[t.path.length - 1][1] - t.path[0][1]; t.displacement = +Math.hypot(dx, dy).toFixed(1); t.heading = +(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1); }
      else { t.displacement = 0; t.heading = null; }
      t.span = t.last - t.start; t.speed = +(t.displacement / Math.max(1, t.span)).toFixed(2);
      t.occludedFrames = (t.occlusions || []).reduce((s, o) => s + o.frames, 0);
      t.permanent = t.occlusions && t.occlusions.length > 0 && t.reappeared;   // survived being hidden
    }
    return tracks.filter((t) => (t.path.length >= 2 || (t.occlusions && t.occlusions.length)) && !t.lost);
  }
  function read4D(input) {
    const frames = (input && input.frames) || [];
    if (frames.length < 2) return { schema: "Alhazen4D@1", gap: "needs_frames", because: "4D needs at least two frames (x, y, t)" };
    const w = frames[0].width, h = frames[0].height, n = frames.length, thr = input.threshold == null ? 60 : input.threshold;
    const trail = new Float32Array(w * h), centroids = [], frameMoved = [];
    for (let k = 0; k < n; k++) {
      if (k === 0) { centroids.push(null); frameMoved.push(0); continue; }
      const a = frames[k - 1].data, b = frames[k].data;
      let moved = 0, sx = 0, sy = 0;
      for (let j = 0; j < w * h; j++) {
        const i = j * 4, d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > thr) { moved++; const x = j % w, y = (j - x) / w; sx += x; sy += y; trail[j] = Math.min(1, trail[j] * 0.78 + 0.4); }
        else trail[j] *= 0.93; // evaporation: a trail fades where motion stops
      }
      centroids.push(moved ? [sx / moved, sy / moved] : null);
      frameMoved.push(+(moved / (w * h)).toFixed(4));
    }
    const velocities = [];
    for (let k = 2; k < n; k++) { const a = centroids[k - 1], b = centroids[k]; if (a && b) velocities.push([b[0] - a[0], b[1] - a[1]]); }
    const vmean = velocities.length ? [velocities.reduce((s, v) => s + v[0], 0) / velocities.length, velocities.reduce((s, v) => s + v[1], 0) / velocities.length] : null;
    const tmask = new Uint8Array(w * h);
    for (let j = 0; j < w * h; j++) if (trail[j] > 0.5) tmask[j] = 1;
    const trailRegions = segmentMask(tmask, w, h, Math.max(8, Math.round(w * h / 20000))).map((c) => ({ region: c.region, area: c.area }));
    const speed = vmean ? Math.hypot(vmean[0], vmean[1]) : 0;
    const angle = vmean && (vmean[0] || vmean[1]) ? +(Math.atan2(vmean[1], vmean[0]) * 180 / Math.PI).toFixed(1) : null;
    const persisted = trailRegions.reduce((s, r) => s + r.area, 0) / (w * h);
    const tracks = trackMotions(frames, { threshold: thr });
    const trackClaims = tracks.map((t, i) => {
      const xs = t.path.map((p) => p[0]), ys = t.path.map((p) => p[1]);
      const region = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
      return { key: "track_" + i, kind: "trail", region, value: t.displacement };
    });
    return {
      schema: "Alhazen4D@1", width: w, height: h,
      time: { frames: n, movedPerFrame: frameMoved },
      motion: { centroids: centroids.map((c) => (c ? c.map((x) => +x.toFixed(1)) : null)), netVelocity: vmean ? vmean.map((x) => +x.toFixed(2)) : null, speed: +speed.toFixed(2) },
      trails: { regions: trailRegions, count: trailRegions.length, persistence: +persisted.toFixed(4) },
      tracks: tracks.map((t) => ({ id: t.id, start: t.start, last: t.last, path: t.path, displacement: t.displacement, heading: t.heading, speed: t.speed, span: t.span, occlusions: t.occlusions || [], occludedFrames: t.occludedFrames || 0, reappeared: !!t.reappeared, permanent: !!t.permanent })),
      motionBlur: { direction: vmean ? vmean.map((x) => +x.toFixed(2)) : null, angleDeg: angle, length: +speed.toFixed(2), basis: "edge smear ≈ inter-frame displacement" },
      longExposure: { data: trailToRGBA(trail, w, h), width: w, height: h },
      claims: trackClaims,
    };
  }
  // motion blur from a SINGLE still: gradient-orientation anisotropy fixes the
  // AXIS (a still cannot fix the kernel length — that is disclosed, not guessed)
  function motionBlurOfImage(data, w, h) {
    const hist = new Float64Array(18); let mag = 0, cnt = 0;
    const L = (p) => _lum(data[p], data[p + 1], data[p + 2]);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4, gx = L(i + 4) - L(i - 4), gy = L(i + w * 4) - L(i - w * 4);
      const m = Math.abs(gx) + Math.abs(gy); if (m < 40) continue;
      const b = Math.floor((((Math.atan2(gy, gx) + Math.PI) % Math.PI)) / (Math.PI / 18)); hist[b] += m; mag += m; cnt++;
    }
    if (!cnt) return { schema: "AlhazenBlur@1", gap: "no_edges" };
    let bi = 0; for (let k = 1; k < 18; k++) if (hist[k] > hist[bi]) bi = k;
    const dom = (bi + 0.5) * (Math.PI / 18), peak = +(hist[bi] / mag).toFixed(3);
    return { schema: "AlhazenBlur@1", edgePixels: cnt, dominantNormalDeg: +(dom * 180 / Math.PI).toFixed(1), blurAxisDeg: +(dom * 180 / Math.PI + 90).toFixed(1), anisotropy: peak, blurred: peak > 0.2, basis: "gradient-orientation anisotropy (axis only; length needs frames)" };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHEROMONES + SWARM — stigmergy for the eyes.
  //
  // No eye is best in every scene. So the reader keeps a pheromone board: a
  // decaying strength per (sceneKind, eye). A swarm dispatches the eligible eyes
  // as independent ants; the ones whose claims SURVIVE reconciliation deposit,
  // a conflicted eye deposits a little, and every strength evaporates each pass.
  // Sniff consults the board to open the eyes that have paid off HERE — so the
  // reader gets better with use, with no model and no labels.
  // ═══════════════════════════════════════════════════════════════════════════
  function createPheromone(seed) {
    const board = (seed && seed.board) || {};
    return {
      schema: "AlhazenPheromone@1", board,
      strength(scene, eye) { return (board[scene] && board[scene][eye]) || 0; },
      deposit(scene, eye, amt) { const b = board[scene] || (board[scene] = {}); b[eye] = Math.min(1, (b[eye] || 0) + (amt == null ? 0.15 : amt)); return this; },
      evaporate(f) { f = f == null ? 0.02 : f; for (const s in board) for (const e in board[s]) { board[s][e] *= (1 - f); if (board[s][e] < 0.01) delete board[s][e]; } return this; },
      recommend(scene, eyes) { const b = board[scene] || {}; return [...eyes].sort((a, c) => (b[c] || 0) - (b[a] || 0)); },
    };
  }
  function prepare(input) {
    if (input && !input.data && input.frames && input.frames.length) {
      const f = input.frames[input.frames.length - 1];
      return { ...input, data: f.data, width: f.width, height: f.height };
    }
    return input;
  }
  function runEye(name, input, opts) {
    try { return { ...EYES[name](input, opts), eye: name }; }
    catch (e) { return { eye: name, error: String(e), claims: [], coverage: 0 }; }
  }
  function swarm(input, opts) {
    opts = opts || {};
    input = prepare(input);
    const s = opts.sniff || sniff(input);
    const phe = opts.pheromone || createPheromone();
    const eligible = opts.eyes || s.eyes || ["raster"];
    const ranked = phe.recommend(s.kind, eligible);           // trail order
    const chosen = opts.budget ? ranked.slice(0, opts.budget) : ranked; // cost: afford only k eyes
    const ants = chosen.map((nm) => runEye(nm, input, opts)); // one ant per eye
    const rec = reconcile(ants);
    const conflicted = new Set(rec.deltas.flatMap((d) => d.eyes));
    for (const a of ants) {
      if (a.gap || !a.claims || !a.claims.length) continue;     // a blind/no-op eye learns nothing
      phe.deposit(s.kind, a.eye, conflicted.has(a.eye) ? 0.03 : 0.15);
    }
    phe.evaporate();
    const out = { schema: "AlhazenSwarm@1", sniff: s, ranked, ants: ants.map((a) => ({ eye: a.eye, gap: a.gap || null, claims: (a.claims || []).length, coverage: a.coverage })),
                  reconciled: rec, pheromone: phe.board, converged: rec.converged, dissent: rec.dissent };
    const lay = ants.find((a) => a.kind === "layer");
    if (lay) out.scene3d = liftTo3D(lay.data);
    const four = ants.find((a) => a.kind === "fourd");
    if (four) out.fourd = { motion: four.data.motion, trails: four.data.trails, motionBlur: four.data.motionBlur };
    return out;
  }
  function fourdEye(input) { const d = read4D(input); return { kind: "fourd", basis: "frames (x, y, t): trails + motion", coverage: d.gap ? 0 : 1, data: d, gap: d.gap, claims: d.claims || [] }; }
  EYES.fourd = fourdEye;

  return { binarizeData, binarizeCanvas, valueFormat, extractFormFields, snake, titleLine, readGridFromElements, readGridFromText, inventTuples, structuralProposer,
           frameStats, palette, backgroundOf, inkMask, segmentMask, classifyRegion, textBands, classifyScene, readImage,
           learnFrom, applyRules, scoreRead, createRuleLedger,
           overlapFrac, roleClass, layersOf, read3D, readPointCloud, liftTo3D, EYES, sniff, reconcile, look,
           trailToRGBA, read4D, trackMotions, motionBlurOfImage, createPheromone, prepare, runEye, swarm };
});
