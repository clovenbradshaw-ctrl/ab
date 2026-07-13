// app.js — wires the controller to the DOM. No business logic lives here;
// it renders what the Intake controller emits and forwards user input back.

import { SCHEMA } from "./schema.js";
import { DemoStore, MatrixStore, OP } from "./store.js";
import { makeModel } from "./model.js";
import { Intake } from "./intake.js";
import { KnowledgeStore, DEMO_KNOWLEDGE } from "./knowledge.js";
import { MINIMAL_SYSTEM } from "./context.js";
import { createVoice, isSupported as voiceSupported } from "./voice.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const HHMM = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ROOM = "!intake-i589:local"; // demo room id; a real Matrix room id when live

let intake, store, knowledge;

// ---- context config: the editable parts of the fold, persisted per room -----
// The system prompt and memory items are the two things the user can edit; both
// fold into the prompt each turn (see context.js). We keep them out of the event
// log (they're config, not answers) and mirror them to localStorage.
const CTX_KEY = "intake:ctx:" + ROOM;
const DEFAULT_KNOWLEDGE = DEMO_KNOWLEDGE.toJSON();
function loadCtxCfg() {
  try { const c = JSON.parse(localStorage.getItem(CTX_KEY) || "null"); if (c) return c; } catch {}
  return { systemPrompt: MINIMAL_SYSTEM, knowledge: DEFAULT_KNOWLEDGE };
}
function saveCtxCfg() {
  const cfg = { systemPrompt: intake?.systemPrompt ?? MINIMAL_SYSTEM, knowledge: knowledge ? knowledge.toJSON() : DEFAULT_KNOWLEDGE };
  try { localStorage.setItem(CTX_KEY, JSON.stringify(cfg)); } catch {}
}

function setStatus(txt, cls = "") { $("statusTxt").textContent = txt; $("dot").className = "dot " + cls; }

// ---- model loading overlay -------------------------------------------------
function showLoader() {
  const l = $("loader"); if (!l) return;
  $("loadBar").classList.add("indet");
  $("loadBar").style.width = "";
  $("loadPct").textContent = "0%";
  $("loadName").textContent = "Preparing Llama 3.2 (3B)…";
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
  $("loadName").textContent = pct >= 100 ? "Almost ready — finishing up…" : "Downloading Llama 3.2 (3B)";
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
    if (!navigator.gpu) {                        // no WebGPU — quietly use the demo model
      setStatus("demo · this browser has no WebGPU", "warn");
      $("modelSel").value = "echo";
      return boot();
    }
    showLoader();
    try {
      await model.ready((text, p) => updateLoader(text, p));
      hideLoader();
      setStatus("Llama 3.2 · ready", "live");
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

  // controller — seed the editable fold (system prompt + memory) from config.
  const cfg = loadCtxCfg();
  knowledge = KnowledgeStore.fromJSON(cfg.knowledge);
  intake = new Intake({ schema: SCHEMA, store, model, knowledge, systemPrompt: cfg.systemPrompt });
  $("docTitle").textContent = SCHEMA.title;
  $("stream").innerHTML = ""; $("ledger").innerHTML = "";

  intake.on(onIntake);
  store.subscribe(renderSide);
  renderLedgerFromTimeline();
  renderSide();
  renderSystemEditor();
  renderMemoryEditor();
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

// ---- context inspector: view the fold, edit its parts ----------------------
// The drawer shows the live folded prompt and lets you edit the two parts you
// own — the system prompt and the memory items — with the fold recomputing as
// you go, so the projection stays legible.

// (1) Live folded prompt. `data` is intake's assemble() result: labeled parts +
// the live conversation window + the fold stats.
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

// (2) System-prompt editor.
function renderSystemEditor() { $("sysEdit").value = intake ? intake.systemPrompt : MINIMAL_SYSTEM; }
$("sysSave").onclick = () => {
  if (!intake) return;
  intake.setSystemPrompt($("sysEdit").value);   // re-emits context -> renderFold
  saveCtxCfg();
  flashSaved($("sysSave"), "Saved");
};
$("sysReset").onclick = () => {
  if (!intake) return;
  intake.setSystemPrompt(MINIMAL_SYSTEM);
  renderSystemEditor(); saveCtxCfg();
};

// (3) Memory editor. Each card edits one knowledge item in place; saving folds
// it into the very next prompt.
function renderMemoryEditor() {
  const list = $("memList"); if (!list) return;
  list.innerHTML = "";
  const items = knowledge ? knowledge.list() : [];
  $("memCount").textContent = items.length;
  if (!items.length) list.appendChild(el("div", "empty-turns", "No memory items. Add one — it'll fold in when its field comes up."));
  for (const it of items) list.appendChild(memCard(it));
}

function fieldOptions(selected) {
  const sel = el("select"); sel.className = "mono";
  const none = el("option", null, "— any field (keyword-matched) —"); none.value = ""; sel.appendChild(none);
  for (const f of SCHEMA.fields) { const o = el("option", null, `${f.label}  ·  ${f.path}`); o.value = f.path; sel.appendChild(o); }
  sel.value = selected || "";
  return sel;
}

function memCard(it) {
  const card = el("div", "mem");
  const markDirty = () => card.classList.add("dirty");

  const topRow = el("div", "row");
  const topWrap = el("div"); topWrap.appendChild(labeled("Topic"));
  const topic = el("input"); topic.value = it.topic || ""; topic.oninput = markDirty; topWrap.appendChild(topic);
  const scopeWrap = el("div"); scopeWrap.appendChild(labeled("Folds in for"));
  const scope = fieldOptions(it.scope?.field); scope.onchange = markDirty; scopeWrap.appendChild(scope);
  topRow.appendChild(topWrap); topRow.appendChild(scopeWrap); card.appendChild(topRow);

  const tagWrap = el("div"); tagWrap.appendChild(labeled("Tags (comma-separated)"));
  const tags = el("input"); tags.className = "mono"; tags.value = (it.tags || []).join(", "); tags.oninput = markDirty; tagWrap.appendChild(tags);
  card.appendChild(tagWrap);

  const textWrap = el("div"); textWrap.appendChild(labeled("Text"));
  const text = el("textarea"); text.rows = 3; text.value = it.text || ""; text.oninput = markDirty; textWrap.appendChild(text);
  card.appendChild(textWrap);

  const foot = el("div", "memfoot");
  const scoped = el("span", "scoped"); scoped.textContent = it.scope?.field ? "pinned to a field" : "matched by keywords";
  const save = el("button", "primary", "Save");
  const del = el("button", "danger", "Delete");
  save.onclick = () => {
    knowledge.update(it.id, {
      topic: topic.value.trim(),
      text: text.value.trim(),
      tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean),
      scope: scope.value ? { field: scope.value } : {},
    });
    card.classList.remove("dirty");
    saveCtxCfg();
    if (intake) intake._emitContext();   // refresh the live fold view
    flashSaved(save, "Saved");
    renderMemoryEditor();
  };
  del.onclick = () => {
    if (!confirm(`Delete memory "${it.topic || it.id}"?`)) return;
    knowledge.remove(it.id); saveCtxCfg();
    if (intake) intake._emitContext();
    renderMemoryEditor();
  };
  foot.appendChild(scoped); foot.appendChild(save); foot.appendChild(del);
  card.appendChild(foot);
  return card;
}

function labeled(t) { return el("label", null, t); }

$("memAdd").onclick = () => {
  if (!knowledge) return;
  knowledge.add({ topic: "New reference", text: "", scope: {}, tags: [] });
  saveCtxCfg(); renderMemoryEditor();
  $("memList").lastElementChild?.scrollIntoView({ block: "nearest" });
};
$("memReset").onclick = () => {
  if (!confirm("Restore the default memory items? Your edits here will be lost.")) return;
  knowledge = KnowledgeStore.fromJSON(DEFAULT_KNOWLEDGE);
  if (intake) intake.knowledge = knowledge;
  saveCtxCfg(); renderMemoryEditor();
  if (intake) intake._emitContext();
};

function flashSaved(btn, txt) {
  const old = btn.textContent; btn.textContent = txt; btn.disabled = true;
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 900);
}

// ---- drawer open/close -----------------------------------------------------
function openCtx() {
  $("ctxScrim").classList.add("on");
  $("ctxDrawer").classList.add("on");
  $("ctxDrawer").setAttribute("aria-hidden", "false");
  renderSystemEditor(); renderMemoryEditor();
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

// ---- voice input (speak your answer) ---------------------------------------
// A mic button beside Send: hold a recording, then Whisper hears it locally and
// drops the transcript into the composer for review before it's sent. The button
// carries all state (idle / recording+timer / transcribing); nothing leaves the
// browser. Hidden entirely where the browser can't record.
function wireVoice() {
  const btn = $("mic"), input = $("input"), note = $("micNote");
  if (!btn) return;
  if (!voiceSupported()) { btn.hidden = true; return; }
  btn.hidden = false;

  let tick = null, downloaded = false;
  const setNote = (msg, err = false) => { note.textContent = msg || ""; note.classList.toggle("err", !!err); };
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };

  const voice = createVoice({
    onState: (s) => {
      btn.classList.toggle("rec", s === "recording");
      btn.classList.toggle("busy", s === "transcribing");
      btn.setAttribute("aria-pressed", String(s === "recording"));
      btn.disabled = s === "transcribing";
      const time = btn.querySelector(".mic-time");
      if (s === "recording") {
        btn.title = "Stop and transcribe";
        const t0 = Date.now();
        const paint = () => { const s = Math.floor((Date.now() - t0) / 1000); time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
        paint(); stopTick(); tick = setInterval(paint, 500);
        setNote("Listening… click the mic again to stop.");
      } else if (s === "transcribing") {
        stopTick(); time.textContent = "";
        btn.title = "Transcribing…";
        setNote(downloaded ? "Transcribing…" : "Preparing the speech model (one-time download)…");
      } else {
        stopTick(); time.textContent = "";
        btn.title = "Speak your answer";
      }
    },
    onProgress: (frac) => { downloaded = true; setNote(`Downloading the speech model… ${Math.round(frac * 100)}%`); },
  });

  btn.addEventListener("click", async () => {
    try {
      if (voice.state === "idle") { setNote(""); await voice.start(); return; }
      if (voice.state === "recording") {
        const text = await voice.stop();
        if (text) {
          input.value = (input.value.trim() ? input.value.replace(/\s+$/, "") + " " : "") + text;
          input.dispatchEvent(new Event("input"));   // re-run auto-resize
          input.focus();
          setNote("Heard it — edit if needed, then Send.");
        } else {
          setNote("Didn't catch any speech — try again.", true);
        }
      }
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setNote(denied ? "Microphone permission is needed to speak an answer." : "Couldn't transcribe — you can type instead.", true);
    }
  });

  // Escape while recording abandons the take without transcribing.
  input.addEventListener("keydown", (e) => { if (e.key === "Escape" && voice.state === "recording") { voice.cancel(); setNote(""); } });
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
wireVoice();
boot();
