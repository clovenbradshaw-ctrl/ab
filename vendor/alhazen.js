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
  function binarizeData(data, w, h) {
    const n = w * h;
    if (!n || !data) return data;
    const hist = new Array(256).fill(0);
    const gray = new Uint8ClampedArray(n);
    let sumL = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const g = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      gray[j] = g; hist[g]++; sumL += g;
    }
    if (sumL / n < 120) return data; // dark / UI: leave it
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

  return { binarizeData, binarizeCanvas, valueFormat, extractFormFields, snake, titleLine, readGridFromElements, readGridFromText, inventTuples, structuralProposer };
});
