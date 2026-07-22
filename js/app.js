// app.js — wires the controller to the DOM. No business logic lives here;
// it renders what the Intake controller emits and forwards user input back.
//
// Two rooms, by design (see questions.js):
//   configStore  — the SHARED room every user reads. The questions, their order,
//                  and the help material live here; the questions surface writes it.
//                  We only fold it (read) to learn the current document.
//   store        — this user's PRIVATE room. Everything they confirm, every
//                  document they upload, and everything specific to them is
//                  written here, never mixed with another user's timeline.

import { DemoStore, MatrixStore, OP, newId } from "./store.js";
import { makeModel } from "./model.js";
import { Intake } from "./intake.js";
import { KnowledgeStore } from "./knowledge.js";
import { MINIMAL_SYSTEM } from "./context.js";
import { CONFIG_ROOM, answerRoomFor, foldConfig, ensureSeeded, DEFAULT_CONFIG } from "./questions.js";
import { encryptBytes } from "./crypto.js";
import { DemoMedia, MatrixMedia } from "./media.js";
import { previewDocument } from "./docview.js";
import { initAdminView } from "./admin.js";
import { ADMIN_USER_ID } from "./config.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const HHMM = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const MAX_DOC_BYTES = 25 * 1024 * 1024;

// store = this user's private answers+documents room; configStore = the shared
// question-config room (read-only here). currentStoreKind gates the media
// backend + admin-dashboard access below.
let intake, store, configStore, knowledge, currentStoreKind = "demo";

function setStatus(txt, cls = "") { $("statusTxt").textContent = txt; $("dot").className = "dot " + cls; }

// ---- model loading overlay -------------------------------------------------
function showLoader() {
  const l = $("loader"); if (!l) return;
  $("loadBar").classList.add("indet");
  $("loadBar").style.width = "";
  $("loadPct").textContent = "0%";
  $("loadName").textContent = "Preparing Llama 3.2 (1B)…";
  $("loadStage").textContent = "Starting the in-browser engine";
  l.classList.add("on");
  setStatus("loading model…", "warn");
}
function updateLoader(text, p) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100)));
  const bar = $("loadBar");
  if (p > 0) {                                   // real progress → determinate bar
    bar.classList.remove("indet");
    bar.style.width = pct + "%";
    $("loadPct").textContent = pct + "%";
  }
  $("loadName").textContent = pct >= 100 ? "Almost ready — finishing up…" : "Downloading Llama 3.2 (1B)";
  if (text) $("loadStage").textContent = text;
  setStatus(`model ${pct}%`, "warn");
}
function hideLoader() {
  const l = $("loader"); if (!l) return;
  l.classList.remove("on");
  $("loadBar").classList.remove("indet");
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  hideLoader();
  const modelKind = $("modelSel").value;
  const storeKind = $("storeSel").value;
  currentStoreKind = storeKind;

  // stores — shared config room (read) + this user's private answers room.
  if (storeKind === "matrix") {
    const homeserver = prompt("Homeserver URL", "https://matrix.org");
    const userId = prompt("Matrix user ID", "@you:matrix.org");
    const password = prompt("Password");
    if (!homeserver || !userId || !password) { $("storeSel").value = "demo"; return boot(); }
    const configRoom = prompt("Shared config room id (questions — all users read)", CONFIG_ROOM) || CONFIG_ROOM;
    const answersRoom = prompt("Your private answers room id", answerRoomFor(userId)) || answerRoomFor(userId);
    setStatus("signing in…", "warn");
    try {
      const base = await MatrixStore.login({ homeserver, userId, password });
      configStore = await new MatrixStore(base.client).open(configRoom);
      store = await new MatrixStore(base.client).open(answersRoom);
      setStatus("live · " + userId, "live");
    } catch (e) { alert("Login failed: " + e.message + "\nFalling back to demo."); $("storeSel").value = "demo"; return boot(); }
  } else {
    const userId = "@demo:local";
    configStore = await new DemoStore("@admin:local").open(CONFIG_ROOM);
    store = await new DemoStore(userId).open(answerRoomFor(userId));
    setStatus("demo · this device");
  }

  // model
  const model = makeModel(modelKind, { model: modelKind === "ollama" ? "llama3.2" : undefined });
  if (modelKind === "webllm") {
    if (!navigator.gpu) {                        // no WebGPU — quietly use the demo model
      setStatus("demo · this browser has no WebGPU", "warn");
      $("modelSel").value = "echo";
      return boot();
    }
    showLoader();
    try {
      await model.ready((text, p) => updateLoader(text, p));
      hideLoader();
      setStatus("Llama 3.2 1B · ready", "live");
    } catch (e) {
      hideLoader();
      setStatus("demo · model unavailable", "warn");
      $("modelSel").value = "echo";
      return boot();
    }
  } else if (modelKind === "ollama") {
    try { await model.ready(); setStatus("ollama ready", "live"); }
    catch (e) { alert(e.message + "\nStart Ollama or pick another model."); $("modelSel").value = "echo"; return boot(); }
  }

  // Fold the SHARED config room into the live document (seed the example if the
  // room is empty). The schema, help, system prompt, and memory the model works
  // from all come from here — authored in questions.html, read-only for the user.
  const cfg = ensureSeeded(configStore);
  const schema = {
    id: cfg.schema.id,
    title: cfg.schema.title,
    blurb: cfg.schema.blurb || DEFAULT_CONFIG.meta.blurb,
    fields: cfg.schema.fields.length ? cfg.schema.fields : DEFAULT_CONFIG.fields,
  };
  const systemPrompt = cfg.systemPrompt || MINIMAL_SYSTEM;
  knowledge = KnowledgeStore.fromJSON(cfg.knowledge);

  // controller — answers go to the private room; questions/help come from config.
  intake = new Intake({ schema, store, model, knowledge, systemPrompt });
  $("docTitle").textContent = schema.title;
  $("stream").innerHTML = ""; $("ledger").innerHTML = "";

  intake.on(onIntake);
  store.subscribe(renderSide);
  store.subscribe(renderDocs);
  configStore.subscribe(onConfigChange);  // admin edits (live over Matrix) prompt a reload
  renderLedgerFromTimeline();
  renderSide();
  renderDocs();
  await intake.begin();
}

// The admin changed the shared question set while a user is mid-session. We
// don't yank the conversation out from under them — we flag it so they can
// reload to pick up the new questions when they're ready.
let configDirty = false;
function onConfigChange() {
  if (configDirty) return;
  configDirty = true;
  setStatus("questions updated by admin — reload to apply", "warn");
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
  } else if (kind === "context") {
    renderFold(data);
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

// ---- supporting documents ---------------------------------------------------
// Uploads never touch the store or the media backend as plaintext: each file
// is AES-encrypted in the browser (crypto.js), the ciphertext goes to the
// media store (media.js), and only the resulting url + key/iv/hash — never
// the file itself — is written to the room as one INS "document" record.
function mediaBackend() { return currentStoreKind === "matrix" ? new MatrixMedia(store.client) : new DemoMedia(); }
function fmtBytes(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}
const DOC_STATUS_LABEL = { new: "New", in_review: "In review", verified: "Verified", flagged: "Flagged" };

function wireDocs() {
  const drop = $("docsDrop"), input = $("docsInput");
  $("docsBrowse").onclick = () => input.click();
  input.onchange = () => { handleFiles(input.files); input.value = ""; };
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handleFiles(e.dataTransfer.files); });
}

async function handleFiles(fileList) {
  if (!store) return;
  for (const file of Array.from(fileList)) {
    if (file.size > MAX_DOC_BYTES) { alert(`"${file.name}" is over the 25 MB limit.`); continue; }
    const row = el("li", "doc pending");
    row.appendChild(el("div", "drow1", file.name));
    const status = el("div", "docs-status", "Encrypting & uploading…");
    row.appendChild(status);
    $("docsList").prepend(row);
    try {
      const buf = await file.arrayBuffer();
      const { ciphertext, key, iv, hash } = await encryptBytes(buf);
      const id = newId("doc");
      const url = await mediaBackend().put(id, ciphertext);
      store.emit(OP.INS, {
        entity: "document",
        id,
        attrs: { filename: file.name, mimetype: file.type || "application/octet-stream", size: file.size, url, key, iv, hash, status: "new" },
      });
      row.remove(); // renderDocs() picks the stored record up from the timeline
    } catch (e) {
      status.textContent = "Failed: " + e.message;
      row.classList.add("error");
    }
  }
}

function renderDocs() {
  if (!store) return;
  const folded = store.fold();
  const docs = Object.entries(folded.records)
    .filter(([, r]) => r.entity === "document")
    .map(([id, r]) => ({ id, ...r.attrs, uploadedAt: r.at }));
  const list = $("docsList");
  list.querySelectorAll(".doc:not(.pending)").forEach((n) => n.remove());
  $("docsCount").textContent = docs.length ? String(docs.length) : "";
  for (const d of docs.reverse()) list.appendChild(docRow(d));
}

function docRow(d) {
  const li = el("li", "doc status-" + d.status);
  const top = el("div", "drow1");
  top.appendChild(el("span", "dname", d.filename));
  top.appendChild(el("span", "dsize", fmtBytes(d.size)));
  li.appendChild(top);
  const bottom = el("div", "drow2");
  const view = el("button", "dview", "View"); view.onclick = () => previewDocument(d, mediaBackend());
  bottom.appendChild(view);
  bottom.appendChild(el("span", "dstatus", DOC_STATUS_LABEL[d.status] || d.status));
  li.appendChild(bottom);
  return li;
}

// ---- admin dashboard ---------------------------------------------------------
const adminCtl = initAdminView({
  onClose: () => { $("adminView").classList.add("hidden"); document.querySelector(".wrap").classList.remove("hidden"); },
});
$("adminBtn").onclick = () => {
  if (!store) return;
  if (currentStoreKind === "matrix" && store.user !== ADMIN_USER_ID) {
    alert(`Sign in as the admin account (${ADMIN_USER_ID}) to view submissions.`);
    return;
  }
  document.querySelector(".wrap").classList.add("hidden");
  $("adminView").classList.remove("hidden");
  adminCtl.show({ storeKind: currentStoreKind, client: store.client, currentUserId: store.user });
};

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

// ---- context inspector: view the live fold ---------------------------------
// The prompt is computed, so it can be shown. The drawer renders the live fold
// for the current field — instructions, the field descriptor, the memory slice
// retrieved for it, the answer digest, and the live window. Authoring these (the
// instructions, the memory, the questions) happens in the admin surface, which
// writes the shared config room; here they are read-only.
function renderFold(data) {
  if (!data) return;
  const { parts = [], messages = [], stats = {} } = data;

  const chips = $("foldStats"); chips.innerHTML = "";
  const chip = (label, val) => { const c = el("span", "chip"); c.innerHTML = `${label} <b>${val}</b>`; chips.appendChild(c); };
  chip("memory folded", stats.knowledgeItems ?? 0);
  chip("live turns", stats.liveTurns ?? 0);
  chip("dropped", stats.droppedTurns ?? 0);
  chip("digest lines", stats.digestedAnswers ?? 0);
  chip("prompt chars", stats.promptChars ?? 0);

  const box = $("foldParts"); box.innerHTML = "";
  for (const p of parts) {
    const wrap = el("div", "part " + (p.kind || ""));
    const lab = el("div", "plab"); lab.appendChild(el("span", "k", p.kind || "part"));
    lab.appendChild(document.createTextNode(p.label)); wrap.appendChild(lab);
    const pre = el("pre"); pre.textContent = p.text; wrap.appendChild(pre);
    box.appendChild(wrap);
  }

  const turns = $("foldTurns"); turns.innerHTML = "";
  const live = messages.filter((m) => m.role !== "system");
  if (!live.length) { turns.appendChild(el("div", "empty-turns", "No live turns yet — the first exchange for this field will appear here.")); }
  else for (const m of live) {
    const t = el("div", "turn " + m.role);
    t.appendChild(el("span", "r", m.role));
    t.appendChild(document.createTextNode(m.content));
    turns.appendChild(t);
  }
}

// ---- drawer open/close -----------------------------------------------------
function openCtx() {
  $("ctxScrim").classList.add("on");
  $("ctxDrawer").classList.add("on");
  $("ctxDrawer").setAttribute("aria-hidden", "false");
  if (intake) renderFold(intake.previewContext());   // show the fold as it stands now
}
function closeCtx() {
  $("ctxScrim").classList.remove("on");
  $("ctxDrawer").classList.remove("on");
  $("ctxDrawer").setAttribute("aria-hidden", "true");
}
$("ctxBtn").onclick = openCtx;
$("ctxClose").onclick = closeCtx;
$("ctxScrim").onclick = closeCtx;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtx(); });

// ---- setup controls --------------------------------------------------------
$("modelSel").onchange = boot;
$("storeSel").onchange = boot;
$("resetBtn").onclick = async () => {
  if (!confirm("Clear this document's stored answers?")) return;
  if (store.reset) await store.reset();
  boot();
};

wireCompose();
wireDocs();
boot();
