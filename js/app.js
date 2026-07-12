// app.js — wires the controller to the DOM. No business logic lives here;
// it renders what the Intake controller emits and forwards user input back.

import { SCHEMA } from "./schema.js";
import { DemoStore, MatrixStore, OP } from "./store.js";
import { makeModel } from "./model.js";
import { Intake } from "./intake.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const HHMM = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ROOM = "!intake-i589:local"; // demo room id; a real Matrix room id when live

let intake, store;

function setStatus(txt, cls = "") { $("statusTxt").textContent = txt; $("dot").className = "dot " + cls; }

// ---- boot ------------------------------------------------------------------
async function boot() {
  const modelKind = $("modelSel").value;
  const storeKind = $("storeSel").value;

  // store
  if (storeKind === "matrix") {
    const homeserver = prompt("Homeserver URL", "https://matrix.org");
    const userId = prompt("Matrix user ID", "@you:matrix.org");
    const password = prompt("Password");
    if (!homeserver || !userId || !password) { $("storeSel").value = "demo"; return boot(); }
    setStatus("signing in…", "warn");
    try { store = await MatrixStore.login({ homeserver, userId, password }); await store.open(ROOM); setStatus("live · " + userId, "live"); }
    catch (e) { alert("Login failed: " + e.message + "\nFalling back to demo."); $("storeSel").value = "demo"; return boot(); }
  } else {
    store = await new DemoStore().open(ROOM);
    setStatus("demo · this device");
  }

  // model
  const model = makeModel(modelKind, { model: modelKind === "ollama" ? "llama3.2" : undefined });
  if (modelKind === "webllm") {
    setStatus("loading model…", "warn");
    try { await model.ready((t, p) => setStatus(`model ${(p * 100 | 0)}%`, "warn")); setStatus("webllm ready", "live"); }
    catch (e) { alert("WebLLM needs a WebGPU browser. Falling back to Echo.\n" + e.message); $("modelSel").value = "echo"; return boot(); }
  } else if (modelKind === "ollama") {
    try { await model.ready(); setStatus("ollama ready", "live"); }
    catch (e) { alert(e.message + "\nStart Ollama or pick another model."); $("modelSel").value = "echo"; return boot(); }
  }

  // controller
  intake = new Intake({ schema: SCHEMA, store, model });
  $("docTitle").textContent = SCHEMA.title;
  $("stream").innerHTML = ""; $("ledger").innerHTML = "";

  intake.on(onIntake);
  store.subscribe(renderSide);
  renderLedgerFromTimeline();
  renderSide();
  await intake.begin();
}

// ---- controller events -> DOM ---------------------------------------------
let streamingNode = null;
function onIntake(kind, data) {
  if (kind === "message") {
    if (data.streaming && !data.text) { streamingNode = renderTyping(data); return; }
    if (streamingNode && data.streaming === false) { streamingNode.remove(); streamingNode = null; }
    renderMessage(data);
  } else if (kind === "stored") {
    flashLedger(data.event);
  } else if (kind === "field") {
    renderSide();
  } else if (kind === "complete") {
    renderSide();
  }
}

function renderMessage(m) {
  const node = el("div", "msg " + (m.role === "user" ? "user" : "assistant") + (m.support ? " support" : ""));
  if (m.support) node.appendChild(el("span", "tag", "here to help"));
  node.appendChild(document.createTextNode(m.text));
  $("stream").appendChild(node); scrollChat();
}
function renderTyping(m) {
  const node = el("div", "msg assistant");
  const t = el("span", "typing"); t.innerHTML = "<i></i><i></i><i></i>";
  node.appendChild(t); $("stream").appendChild(node); scrollChat(); return node;
}
function scrollChat() { const s = $("stream"); s.scrollTop = s.scrollHeight; }

// ---- right rail ------------------------------------------------------------
function renderSide() {
  if (!intake) return;
  const prog = intake.progress();
  const done = prog.filter((p) => p.done).length;
  const total = prog.length;
  const active = intake.nextField()?.path;

  // progress ring
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("ring").style.setProperty("--p", pct);
  $("ringN").textContent = `${done}/${total}`;
  $("progTxt").textContent = done === total ? "All set — review anytime." : `${total - done} left · answer or ask a question`;

  // checklist
  const list = $("check"); list.innerHTML = "";
  $("checkCount").textContent = `${done}/${total}`;
  for (const f of prog) {
    const li = el("li", (f.done ? "done " : "") + (f.path === active ? "active" : ""));
    li.appendChild(el("span", "box"));
    const wrap = el("div");
    wrap.appendChild(el("span", "lab", f.label + (f.required ? "" : " (optional)")));
    if (f.done) wrap.appendChild(el("span", "val", String(f.value)));
    li.appendChild(wrap);
    li.onclick = () => editFromChecklist(f);
    list.appendChild(li);
  }
}

function editFromChecklist(f) {
  const cur = intake.answers()[f.path] ?? "";
  const next = prompt(`Edit "${f.label}"`, cur);
  if (next == null) return;
  const r = intake.editField(f.path, next);
  if (!r.ok) alert(r.error);
}

// ---- provenance ledger -----------------------------------------------------
function renderLedgerFromTimeline() {
  const tl = store.timeline();
  const ul = $("ledger"); ul.innerHTML = "";
  if (!tl.length) { ul.appendChild(Object.assign(el("li", "empty", "Nothing stored yet. Each answer you confirm is written here as one event.")), 0); }
  else tl.forEach((ev) => ul.appendChild(ledgerRow(ev, false)));
  updateLedgerCount();
}
function ledgerRow(ev, animate = true) {
  const li = el("li", ev.op.toLowerCase());
  if (!animate) li.style.animation = "none";
  const r1 = el("div", "row1");
  r1.appendChild(el("span", "op", ev.op));
  r1.appendChild(el("span", "path", ev.payload.path || ev.payload.entity || ev.payload.kind || ""));
  r1.appendChild(el("span", "time", HHMM(ev.at)));
  li.appendChild(r1);
  if (ev.payload.value != null) { const v = el("div", "val"); v.textContent = "“" + ev.payload.value + "”"; li.appendChild(v); }
  li.appendChild(el("div", "eid", ev.id));
  return li;
}
function flashLedger(ev) {
  const ul = $("ledger");
  const empty = ul.querySelector(".empty"); if (empty) empty.remove();
  ul.insertBefore(ledgerRow(ev, true), ul.firstChild);
  updateLedgerCount();
}
function updateLedgerCount() {
  const n = store.timeline().length;
  $("ledgerCount").textContent = n + " event" + (n === 1 ? "" : "s");
}

// ---- compose ---------------------------------------------------------------
function wireCompose() {
  const input = $("input");
  const send = () => {
    const v = input.value.trim(); if (!v || !intake) return;
    input.value = ""; input.style.height = "auto";
    intake.submit(v);
  };
  $("send").onclick = send;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
}

// ---- setup controls --------------------------------------------------------
$("modelSel").onchange = boot;
$("storeSel").onchange = boot;
$("resetBtn").onclick = async () => {
  if (!confirm("Clear this document's stored answers?")) return;
  if (store.reset) await store.reset();
  boot();
};

wireCompose();
boot();
