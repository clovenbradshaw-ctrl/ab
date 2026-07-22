// questions-admin.js — the question-authoring surface. Edits the shared
// question-config room (questions.js). Distinct from admin.js, which is the
// document-review dashboard.
//
// No business logic beyond translating admin gestures into config events. It
// opens the SHARED config room (not any user's answers room), folds it to the
// live question set, and renders editors that each emit one event on save. The
// right-rail ledger is that same room shown as the append-only log it is.

import { DemoStore, MatrixStore } from "./store.js";
import {
  CONFIG_ROOM, foldConfig, ensureSeeded, DEFAULT_CONFIG,
  putField, deleteField, setFieldOrder, setSystemPrompt, setMeta,
  putKnowledge, deleteKnowledge,
} from "./questions.js";
import { MINIMAL_SYSTEM } from "./context.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const HHMM = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const TYPES = ["text", "date", "email", "number", "enum"];

let store, cfg;                 // store = config room; cfg = folded config
const openCards = new Set();    // which question cards are expanded (path set)

function setStatus(txt, cls = "") { $("statusTxt").textContent = txt; $("dot").className = "dot " + cls; }

// ---- boot ------------------------------------------------------------------
async function boot() {
  const kind = $("storeSel").value;
  let roomId = CONFIG_ROOM;
  if (kind === "matrix") {
    const homeserver = prompt("Homeserver URL", "https://matrix.org");
    const userId = prompt("Matrix user ID (an admin account)", "@you:matrix.org");
    const password = prompt("Password");
    if (!homeserver || !userId || !password) { $("storeSel").value = "demo"; return boot(); }
    roomId = prompt("Shared config room id (all users read this)", CONFIG_ROOM) || CONFIG_ROOM;
    setStatus("signing in…", "warn");
    try {
      const base = await MatrixStore.login({ homeserver, userId, password });
      store = await new MatrixStore(base.client).open(roomId);
      setStatus("live · shared room", "live");
    } catch (e) { alert("Login failed: " + e.message + "\nFalling back to demo."); $("storeSel").value = "demo"; return boot(); }
  } else {
    store = await new DemoStore("@admin:local").open(roomId);
    setStatus("demo · this device");
  }

  cfg = ensureSeeded(store);          // open onto the example doc if the room is empty
  store.subscribe(() => { cfg = foldConfig(store.timeline()); renderLedger(); });
  renderAll();
}

function refold() { cfg = foldConfig(store.timeline()); }
function renderAll() { renderMeta(); renderQuestions(); renderSystem(); renderMemory(); renderLedger(); }

// ---- document meta ---------------------------------------------------------
function renderMeta() {
  $("mTitle").value = cfg.schema.title || "";
  $("mBlurb").value = cfg.schema.blurb || "";
}
$("mSave").onclick = () => {
  setMeta(store, "title", $("mTitle").value.trim());
  setMeta(store, "blurb", $("mBlurb").value.trim());
  refold(); flash($("mSave"), "Saved");
};

// ---- questions -------------------------------------------------------------
function renderQuestions() {
  const list = $("qlist"); list.innerHTML = "";
  const fields = cfg.schema.fields;
  $("qCount").textContent = fields.length;
  if (!fields.length) { list.appendChild(el("p", "note", "No questions yet. Add the first one below.")); return; }
  fields.forEach((f, i) => list.appendChild(questionCard(f, i, fields.length)));
}

function questionCard(f, idx, total) {
  const card = el("div", "q" + (openCards.has(f.path) ? " open" : ""));
  const markDirty = () => card.classList.add("dirty");

  // header — summary + move/expand controls
  const head = el("div", "qhead");
  head.appendChild(el("span", "qnum", String(idx + 1)));
  head.appendChild(el("span", "qlbl", f.label || "(untitled)"));
  head.appendChild(el("span", "qtype", f.type || "text"));
  if (f.required) head.appendChild(el("span", "req", "required"));
  head.appendChild(el("span", "qspacer"));
  const move = el("div", "qmove");
  const up = el("button", "iconbtn", "▲"); up.title = "Move up"; up.disabled = idx === 0;
  const dn = el("button", "iconbtn", "▼"); dn.title = "Move down"; dn.disabled = idx === total - 1;
  up.onclick = (e) => { e.stopPropagation(); moveField(idx, idx - 1); };
  dn.onclick = (e) => { e.stopPropagation(); moveField(idx, idx + 1); };
  move.appendChild(up); move.appendChild(dn); head.appendChild(move);
  const toggle = el("button", "iconbtn", openCards.has(f.path) ? "Close" : "Edit");
  toggle.onclick = () => { if (openCards.has(f.path)) openCards.delete(f.path); else openCards.add(f.path); renderQuestions(); };
  head.appendChild(toggle);
  card.appendChild(head);

  // body — the editors
  const body = el("div", "qbody");

  const r1 = el("div", "row");
  const lblWrap = el("div"); lblWrap.appendChild(labeled("Label")); const label = input(f.label, markDirty); lblWrap.appendChild(label);
  const pathWrap = el("div"); pathWrap.appendChild(labeled("Path (stable id)"));
  const path = input(f.path); path.className = "f mono"; path.disabled = true; path.title = "The path is the stable key for stored answers and can't be changed."; pathWrap.appendChild(path);
  r1.appendChild(lblWrap); r1.appendChild(pathWrap); body.appendChild(wrapGrp(r1));

  const r2 = el("div", "row");
  const typeWrap = el("div"); typeWrap.appendChild(labeled("Type"));
  const type = el("select", "f"); for (const t of TYPES) { const o = el("option", null, t); o.value = t; type.appendChild(o); } type.value = f.type || "text";
  typeWrap.appendChild(type);
  const reqWrap = el("div"); const reqLab = el("label", "check-inline");
  const req = el("input"); req.type = "checkbox"; req.checked = !!f.required; req.onchange = markDirty;
  reqLab.appendChild(req); reqLab.appendChild(document.createTextNode("Required to finish")); reqWrap.appendChild(reqLab);
  r2.appendChild(typeWrap); r2.appendChild(reqWrap); body.appendChild(wrapGrp(r2));

  const enumWrap = el("div", "enumwrap fieldgrp"); enumWrap.appendChild(labeled("Choices (comma-separated) — for enum type"));
  const enums = input((f.enum || []).join(", "), markDirty); enums.className = "f mono"; enumWrap.appendChild(enums);
  enumWrap.style.display = type.value === "enum" ? "" : "none";
  type.onchange = () => { markDirty(); enumWrap.style.display = type.value === "enum" ? "" : "none"; };
  body.appendChild(enumWrap);

  const promptWrap = el("div", "fieldgrp"); promptWrap.appendChild(labeled("Prompt — how the assistant asks it"));
  const promptT = textarea(f.prompt, 2, markDirty); promptWrap.appendChild(promptT); body.appendChild(promptWrap);

  const helpWrap = el("div", "fieldgrp"); helpWrap.appendChild(labeled("Help — shown when the user is stuck (folded in only for this field)"));
  const helpT = textarea(f.help, 3, markDirty); helpWrap.appendChild(helpT); body.appendChild(helpWrap);

  const foot = el("div", "btns");
  const save = el("button", "primary", "Save question");
  const del = el("button", "danger", "Delete");
  save.onclick = () => {
    const next = {
      path: f.path,
      label: label.value.trim(),
      type: type.value,
      required: req.checked,
      prompt: promptT.value.trim(),
      help: helpT.value.trim(),
      enum: type.value === "enum" ? enums.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
    putField(store, next); refold(); card.classList.remove("dirty");
    flash(save, "Saved"); renderQuestions();
  };
  del.onclick = () => {
    if (!confirm(`Delete "${f.label || f.path}"? This removes the question for every user.`)) return;
    deleteField(store, f.path);
    setFieldOrder(store, cfg.schema.fields.map((x) => x.path).filter((p) => p !== f.path));
    openCards.delete(f.path); refold(); renderQuestions();
  };
  foot.appendChild(save); foot.appendChild(del);
  body.appendChild(foot);

  card.appendChild(body);
  return card;
}

function moveField(from, to) {
  const ids = cfg.schema.fields.map((f) => f.path);
  if (to < 0 || to >= ids.length) return;
  const [id] = ids.splice(from, 1); ids.splice(to, 0, id);
  setFieldOrder(store, ids); refold(); renderQuestions();
}

$("qAdd").onclick = () => {
  const label = prompt("New question — short label (e.g. \"Phone number\")");
  if (!label || !label.trim()) return;
  const path = uniquePath(label.trim());
  putField(store, { path, label: label.trim(), type: "text", required: false, prompt: label.trim() + "?", help: "", enum: [] });
  setFieldOrder(store, [...cfg.schema.fields.map((f) => f.path), path]);
  openCards.add(path); refold(); renderQuestions();
  $("qlist").lastElementChild?.scrollIntoView({ block: "nearest" });
};

function uniquePath(label) {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  const taken = new Set(cfg.schema.fields.map((f) => f.path));
  if (!taken.has(base)) return base;
  let n = 2; while (taken.has(base + "_" + n)) n++; return base + "_" + n;
}

// ---- system prompt ---------------------------------------------------------
function renderSystem() { $("sysEdit").value = cfg.systemPrompt ?? MINIMAL_SYSTEM; }
$("sysSave").onclick = () => { setSystemPrompt(store, $("sysEdit").value); refold(); flash($("sysSave"), "Saved"); };
$("sysReset").onclick = () => { setSystemPrompt(store, MINIMAL_SYSTEM); refold(); renderSystem(); };

// ---- memory ----------------------------------------------------------------
function renderMemory() {
  const list = $("memList"); list.innerHTML = "";
  const items = cfg.knowledge;
  $("memCount").textContent = items.length;
  if (!items.length) list.appendChild(el("p", "note", "No memory notes. Add one — it'll fold in when its question comes up."));
  for (const it of items) list.appendChild(memCard(it));
}

function fieldOptions(selected) {
  const sel = el("select", "f mono");
  const none = el("option", null, "— any question (keyword-matched) —"); none.value = ""; sel.appendChild(none);
  for (const f of cfg.schema.fields) { const o = el("option", null, `${f.label}  ·  ${f.path}`); o.value = f.path; sel.appendChild(o); }
  sel.value = selected || "";
  return sel;
}

function memCard(it) {
  const card = el("div", "mem");
  const markDirty = () => card.classList.add("dirty");

  const r1 = el("div", "row");
  const topWrap = el("div"); topWrap.appendChild(labeled("Topic")); const topic = input(it.topic, markDirty); topWrap.appendChild(topic);
  const scWrap = el("div"); scWrap.appendChild(labeled("Folds in for")); const scope = fieldOptions(it.scope?.field); scope.onchange = markDirty; scWrap.appendChild(scope);
  r1.appendChild(topWrap); r1.appendChild(scWrap); card.appendChild(wrapGrp(r1));

  const tagWrap = el("div", "fieldgrp"); tagWrap.appendChild(labeled("Tags (comma-separated)"));
  const tags = input((it.tags || []).join(", "), markDirty); tags.className = "f mono"; tagWrap.appendChild(tags); card.appendChild(tagWrap);

  const txtWrap = el("div", "fieldgrp"); txtWrap.appendChild(labeled("Text")); const text = textarea(it.text, 3, markDirty); txtWrap.appendChild(text); card.appendChild(txtWrap);

  const foot = el("div", "memfoot");
  foot.appendChild(el("span", "scoped", it.scope?.field ? "pinned to a question" : "matched by keywords"));
  const save = el("button", "primary", "Save"); const del = el("button", "danger", "Delete");
  save.onclick = () => {
    putKnowledge(store, {
      id: it.id, topic: topic.value.trim(), text: text.value.trim(),
      tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean),
      scope: scope.value ? { field: scope.value } : {},
    });
    refold(); card.classList.remove("dirty"); flash(save, "Saved"); renderMemory();
  };
  del.onclick = () => { if (!confirm(`Delete memory "${it.topic || it.id}"?`)) return; deleteKnowledge(store, it.id); refold(); renderMemory(); };
  foot.appendChild(save); foot.appendChild(del); card.appendChild(foot);
  return card;
}

$("memAdd").onclick = () => {
  const id = "k_" + Math.random().toString(36).slice(2, 9);
  putKnowledge(store, { id, topic: "New reference", text: "", tags: [], scope: {} });
  refold(); renderMemory(); $("memList").lastElementChild?.scrollIntoView({ block: "nearest" });
};

// ---- ledger: the shared room as an event log -------------------------------
function renderLedger() {
  const ul = $("ledger"); ul.innerHTML = "";
  const tl = store.timeline();
  $("ledgerCount").textContent = tl.length + " event" + (tl.length === 1 ? "" : "s");
  if (!tl.length) { ul.appendChild(el("li", "empty", "Empty. Your edits will appear here as events.")); return; }
  for (const ev of tl.slice().reverse()) ul.appendChild(ledgerRow(ev));
}
function ledgerRow(ev) {
  const li = el("li", ev.op.toLowerCase());
  const r1 = el("div", "row1");
  r1.appendChild(el("span", "op", ev.op));
  const label = ev.op === "INS" ? `${ev.payload.entity}:${ev.payload.id}` : (ev.payload.path || "");
  r1.appendChild(el("span", "path", label));
  r1.appendChild(el("span", "time", HHMM(ev.at)));
  li.appendChild(r1);
  const val = ev.op === "INS" ? summarizeAttrs(ev.payload.attrs) : formatVal(ev.payload.value);
  if (val) { const v = el("div", "val"); v.textContent = val; li.appendChild(v); }
  return li;
}
function summarizeAttrs(a = {}) {
  if (a.deleted) return "deleted";
  if (a.label != null) return a.label;
  if (a.topic != null) return a.topic;
  return Object.keys(a).join(", ");
}
function formatVal(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return "[" + v.join(", ") + "]";
  const s = String(v); return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

// ---- small DOM helpers -----------------------------------------------------
function labeled(t) { return el("label", "lab", t); }
function input(val, oninput) { const e = el("input", "f"); e.value = val ?? ""; if (oninput) e.oninput = oninput; return e; }
function textarea(val, rows, oninput) { const e = el("textarea", "f"); e.rows = rows; e.value = val ?? ""; if (oninput) e.oninput = oninput; return e; }
function wrapGrp(node) { const d = el("div", "fieldgrp"); d.appendChild(node); return d; }
function flash(btn, txt) { const old = btn.textContent; btn.textContent = txt; btn.disabled = true; setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 900); }

// ---- controls --------------------------------------------------------------
$("storeSel").onchange = boot;
$("resetBtn").onclick = async () => {
  if (!confirm("Clear the shared config room and re-seed the example question set? This affects every user.")) return;
  if (store?.reset) await store.reset();
  cfg = ensureSeeded(store); renderAll();
};

boot();
