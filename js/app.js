// app.js — wires the controller + account layer to the DOM. No business logic
// lives here; it renders what the Intake controller emits, forwards user input,
// and drives the account/room flow through auth.js.

import { SCHEMA } from "./schema.js";
import { DemoStore, MatrixStore, OP, EVENT_TYPE, fold, answersOf } from "./store.js";
import { makeModel } from "./model.js";
import { Intake } from "./intake.js";
import { DEMO_KNOWLEDGE } from "./knowledge.js";
import { Auth, caseRef, adminMxid } from "./auth.js";

const $ = (id) => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const HHMM = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ANCHOR = "complaint";
const ROOM_KEY = "resolve_room_v1";       // this device's Matrix room id, when signed in
const DEMO_KEY = "resolve_demo_room_v1";  // a stable local room id for the on-device demo

const helpSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 17h.01M12 13a2 2 0 10-2-2"/></svg>';

let intake, store, currentField = null, confirmNode = null;

// ---- boot ------------------------------------------------------------------
async function boot() {
  Auth.restore();
  renderAccountPill();
  const model = await buildModel($("modelSel").value);

  const sess = Auth.current();
  if (sess && sess.admin) return renderAdmin(model);

  let roomId, caseReference;
  try {
    if (sess) {
      roomId = localStorage.getItem(ROOM_KEY);
      if (!roomId) {                              // signed in on a fresh device — recover their room
        const rooms = await Auth.listAppRooms({ acceptInvites: true });
        const mine = rooms.find((r) => r.membership === "join");
        if (mine) { roomId = mine.roomId; localStorage.setItem(ROOM_KEY, roomId); }
      }
      if (roomId) { store = await new MatrixStore(Auth, roomId).open(); caseReference = caseRef(roomId); }
    }
  } catch (e) { /* fall through to demo */ }

  if (!store) {
    let demoRoom = localStorage.getItem(DEMO_KEY);
    if (!demoRoom) { demoRoom = "!complaint-" + Math.random().toString(36).slice(2, 8) + ":local"; localStorage.setItem(DEMO_KEY, demoRoom); }
    store = await new DemoStore().open(demoRoom);
    caseReference = caseRef(demoRoom);
  }

  startIntake(model, caseReference);
}

async function buildModel(kind) {
  const model = makeModel(kind, { model: kind === "ollama" ? "llama3.2" : undefined });
  if (kind === "webllm") {
    try { await model.ready((t, p) => setPMeta(`loading model ${(p * 100 | 0)}%`)); }
    catch (e) { alert("WebLLM needs a WebGPU browser. Using the guided assistant instead.\n" + e.message); $("modelSel").value = "echo"; return makeModel("echo"); }
  } else if (kind === "ollama") {
    try { await model.ready(); }
    catch (e) { alert(e.message + "\nStart Ollama or pick another. Using the guided assistant instead."); $("modelSel").value = "echo"; return makeModel("echo"); }
  }
  return model;
}

function startIntake(model, caseReference) {
  intake = new Intake({ schema: SCHEMA, store, model, knowledge: DEMO_KNOWLEDGE, anchor: ANCHOR });
  $("docTitle").textContent = SCHEMA.title;
  $("caseref").textContent = caseReference;
  $("stream").innerHTML = ""; $("ledger").innerHTML = ""; confirmNode = null;
  showComposer(true);
  intake.on(onIntake);
  store.subscribe(renderSide);
  renderLedgerFromTimeline();
  renderSide();
  intake.begin();
}

// ---- controller events -> DOM ---------------------------------------------
let streamingNode = null;
function onIntake(kind, data) {
  if (kind === "message") {
    if (data.streaming && !data.text) { streamingNode = renderTyping(); return; }
    if (streamingNode) { streamingNode.remove(); streamingNode = null; }
    renderMessage(data);
  } else if (kind === "pending") {
    renderConfirm(data);
  } else if (kind === "context") {
    currentField = data.field;
    renderLens(data.stats);
  } else if (kind === "stored") {
    if (confirmNode) { confirmNode.remove(); confirmNode = null; }
    flashLedger(data.event);
    flashSave();
  } else if (kind === "field") {
    renderSide();
  } else if (kind === "complete") {
    renderSide(); renderDone(data);
  }
}

function renderMessage(m) {
  if (m.role === "user" && confirmNode) { confirmNode.remove(); confirmNode = null; }
  const node = el("div", "msg " + (m.role === "user" ? "u" : "a") + (m.support ? " support" : ""));
  if (m.support) { const tag = el("span", "tag"); tag.innerHTML = helpSVG + "<span>here to help</span>"; node.appendChild(tag); }
  node.appendChild(document.createTextNode(m.text));
  if (m.reference && m.reference.items && m.reference.items.length) {
    const r = el("div", "ref");
    r.innerHTML = "<b>Good to know:</b> ";
    r.appendChild(document.createTextNode(m.reference.items[0].text));
    node.appendChild(r);
  }
  $("stream").appendChild(node); scrollChat();
}
function renderTyping() {
  const node = el("div", "msg a");
  const t = el("span", "typing"); t.innerHTML = "<i></i><i></i><i></i>";
  node.appendChild(t); $("stream").appendChild(node); scrollChat(); return node;
}
function renderConfirm(pending) {
  if (confirmNode) confirmNode.remove();
  const c = el("div", "confirm");
  const head = el("div", "head", "✎ Ready to log — please confirm");
  const val = el("div", "val"); val.textContent = "“" + pending.value + "”";
  const field = el("div", "field"); field.innerHTML = "into "; field.appendChild(Object.assign(el("span", "mono"), { textContent: pending.field.path }));
  const acts = el("div", "acts");
  const yes = el("button", "yes", "Yes, log it");
  const edit = el("button", "edit", "Edit");
  yes.onclick = () => { if (confirmNode) { confirmNode.remove(); confirmNode = null; } intake.confirm(); };
  edit.onclick = () => { if (confirmNode) { confirmNode.remove(); confirmNode = null; } intake.reject(); $("input").focus(); };
  acts.append(yes, edit);
  c.append(head, val, field, acts);
  $("stream").appendChild(c); confirmNode = c; scrollChat();
}
function scrollChat() { const s = $("stream"); s.scrollTop = s.scrollHeight; }

function renderLens(stats) {
  const n = stats ? stats.knowledgeItems : 0;
  $("lens").querySelector(".mono").textContent = n > 0 ? `using ${n} help note${n === 1 ? "" : "s"} for this question` : "no extra notes for this question";
}

// ---- right rail ------------------------------------------------------------
function renderSide() {
  if (!intake) return;
  const prog = intake.progress();
  const done = prog.filter((p) => p.done).length, total = prog.length;
  const active = intake.nextField()?.path;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("ring").style.setProperty("--p", pct);
  $("ringN").textContent = `${done}/${total}`;
  setPMeta(done === total ? "Complaint filed" : `${total - done} left · answer or ask a question`);
  const list = $("check"); list.innerHTML = "";
  $("ckc").textContent = `${done}/${total}`;
  for (const f of prog) {
    const li = el("li", (f.done ? "done " : "") + (f.path === active ? "active" : ""));
    li.appendChild(el("span", "box"));
    const w = el("div");
    w.appendChild(el("span", "lab", f.label + (f.required ? "" : " (optional)")));
    if (f.done) w.appendChild(el("span", "val", String(f.value)));
    li.appendChild(w);
    li.onclick = () => editFromChecklist(f);
    list.appendChild(li);
  }
}
function setPMeta(t) { $("pmeta").textContent = t; }
function editFromChecklist(f) {
  const cur = intake.answers()[f.path] ?? "";
  const next = prompt(`Edit "${f.label}"`, cur);
  if (next == null) return;
  const r = intake.editField(f.path, next);
  if (!r.ok) alert(r.error);
}

// ---- the "logged to your case" ledger --------------------------------------
function renderLedgerFromTimeline() {
  const tl = store.timeline();
  const ul = $("ledger"); ul.innerHTML = "";
  if (!tl.length) ul.appendChild(el("li", "empty", "Nothing logged yet. Each answer you confirm is written here as one entry."));
  else tl.forEach((ev) => ul.appendChild(ledgerRow(ev, false)));
  updateLedgerCount();
}
function ledgerRow(ev, animate = true) {
  const li = el("li", "e"); if (!animate) li.style.animation = "none";
  const r1 = el("div", "r1");
  r1.appendChild(el("span", "op", "LOGGED"));
  r1.appendChild(el("span", "path", ev.payload.path || ev.payload.entity || ""));
  r1.appendChild(el("span", "t", HHMM(ev.at)));
  li.appendChild(r1);
  if (ev.payload.value != null) { const v = el("div", "v"); v.textContent = "“" + ev.payload.value + "”"; li.appendChild(v); }
  li.appendChild(el("div", "id", ev.id));
  return li;
}
function flashLedger(ev) {
  const ul = $("ledger"); const empty = ul.querySelector(".empty"); if (empty) empty.remove();
  ul.insertBefore(ledgerRow(ev, true), ul.firstChild);
  updateLedgerCount();
}
function updateLedgerCount() { const n = store.timeline().length; $("lgc").textContent = n + " entr" + (n === 1 ? "y" : "ies"); }
function flashSave() { const s = $("save"); s.classList.add("show"); setTimeout(() => s.classList.remove("show"), 1800); }

// ---- done screen -----------------------------------------------------------
function renderDone() {
  showComposer(false);
  const ref = $("caseref").textContent;
  const s = $("stream"); s.innerHTML = "";
  const wrap = el("div", "done");
  wrap.innerHTML =
    `<div class="seal">✓</div>` +
    `<h2>Your complaint is filed</h2>` +
    `<p>Every answer is logged to your case. Keep this reference — it's how you and any agent track the same record.</p>` +
    `<div class="caseref"><span class="k">Case reference</span><span class="v">${ref}</span></div>` +
    `<p class="next">A handler has a set number of business days to respond and can't close the case without replying. You can reopen this anytime to add detail; if the deadline lapses, escalation to the industry ombudsman is one step away.</p>`;
  const btns = el("div", "rowbtns");
  const track = el("button", "primary", "Download a copy");
  track.onclick = downloadCase;
  const back = el("button", "ghost", "Back to my answers");
  back.onclick = () => { showComposer(true); startIntake(intake.model, ref); };
  btns.append(track, back);
  wrap.appendChild(btns);
  s.appendChild(wrap);
}
function downloadCase() {
  const data = { caseRef: $("caseref").textContent, document: SCHEMA.title, timeline: store.timeline() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = data.caseRef + ".json"; a.click();
  URL.revokeObjectURL(a.href);
}
function showComposer(on) { $("composer").style.display = on ? "flex" : "none"; $("hintbar").style.display = on ? "flex" : "none"; }

// ---- compose ---------------------------------------------------------------
function wireCompose() {
  const input = $("input");
  const send = () => { const v = input.value.trim(); if (!v || !intake) return; input.value = ""; input.style.height = "auto"; intake.submit(v); };
  $("send").onclick = send;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 150) + "px"; });
}
$("modelSel").onchange = boot;

// ---- account pill + sheet --------------------------------------------------
function renderAccountPill() {
  const sess = Auth.current();
  const dot = $("acctDot"), txt = $("acctTxt");
  if (!sess) { dot.className = "d"; txt.textContent = "On this device"; }
  else if (sess.admin) { dot.className = "d warn"; txt.textContent = "Admin"; }
  else { dot.className = "d live"; const id = sess.user_id.split(":")[0]; txt.innerHTML = `Signed in · <span class="mono">${id}</span>`; }
}
function openSheet() { renderSheet(); $("sheet").classList.add("open"); }
function closeSheet() { $("sheet").classList.remove("open"); }
$("acctBtn").onclick = openSheet;
$("sheetX").onclick = closeSheet;
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });

function sheetMsg(body, text, cls) { const m = el("div", "msg-line " + (cls || ""), text); body.appendChild(m); return m; }
function renderSheet() {
  const body = $("sheetBody"); body.innerHTML = "";
  const sess = Auth.current();
  if (sess) {
    $("sheetTitle").firstChild.textContent = sess.admin ? "Admin" : "Your account ";
    body.appendChild(el("p", "hintp", sess.admin ? "Signed in as the site admin — you're invited to every case room and can read them all." : "Your complaint is stored to your own private room. Only you and the case handler can read it."));
    const who = el("div", "row"); who.appendChild(el("label", null, "Signed in as")); const w = el("input"); w.value = sess.user_id; w.readOnly = true; who.appendChild(w); body.appendChild(who);
    const cred = Auth.credentials();
    const actions = el("div", "actions");
    if (cred && cred.password) { const dl = el("button", null, "Download my credentials"); dl.onclick = () => downloadCreds(cred); actions.appendChild(dl); }
    const out = el("button", null, "Sign out"); out.onclick = async () => { await Auth.logout(); localStorage.removeItem(ROOM_KEY); closeSheet(); boot(); };
    actions.appendChild(out);
    body.appendChild(actions);
    return;
  }
  // signed out — create or sign in
  $("sheetTitle").firstChild.textContent = "Start your complaint ";
  body.appendChild(el("p", "hintp", "Right now your answers are kept on this device only. Create a private case to sync it, get a case reference the handler shares, and pick it back up on any device."));
  const hsRow = el("div", "row"); hsRow.appendChild(el("label", null, "Homeserver")); const hs = el("input"); hs.id = "hsInput"; hs.value = defaultHomeserver(); hsRow.appendChild(hs); body.appendChild(hsRow);
  const actions = el("div", "actions");
  const create = el("button", "solid", "Create my case"); create.onclick = () => doSignUp($("hsInput").value.trim(), body);
  actions.appendChild(create); body.appendChild(actions);
  body.appendChild(el("div", "sep"));
  body.appendChild(el("p", "hintp", "Already have an account (or you're the admin)? Sign in:"));
  const idRow = el("div", "row"); idRow.appendChild(el("label", null, "Matrix ID")); const mx = el("input"); mx.id = "mxInput"; mx.placeholder = "@you:server"; idRow.appendChild(mx); body.appendChild(idRow);
  const pwRow = el("div", "row"); pwRow.appendChild(el("label", null, "Password")); const pw = el("input"); pw.id = "pwInput"; pw.type = "password"; pwRow.appendChild(pw); body.appendChild(pwRow);
  const a2 = el("div", "actions"); const login = el("button", null, "Sign in"); login.onclick = () => doLogin($("mxInput").value.trim(), $("pwInput").value, body); a2.appendChild(login); body.appendChild(a2);
}
function defaultHomeserver() { const a = adminMxid(); const p = a && a.split(":"); return (p && p[1]) || "matrix.org"; }

async function doSignUp(homeserver, body) {
  if (!homeserver) return sheetMsg(body, "Enter a homeserver to create your case on.", "err");
  const m = sheetMsg(body, "Creating your private case…", "ok");
  try {
    Auth.configure({ homeserver });
    const sess = await Auth.signUp({ domain: homeserver });
    const { roomId } = await Auth.createRoom("Complaint — " + caseRef(sess.user_id));  // admin auto-invited
    localStorage.setItem(ROOM_KEY, roomId);
    m.textContent = "Case created. Loading…";
    closeSheet(); boot();
  } catch (e) { m.className = "msg-line err"; m.textContent = friendly(e); }
}
async function doLogin(mxid, password, body) {
  if (!mxid || !password) return sheetMsg(body, "Enter your Matrix ID and password.", "err");
  const m = sheetMsg(body, "Signing in…", "ok");
  try {
    await Auth.login(mxid, password);
    m.textContent = "Signed in. Loading…";
    closeSheet(); boot();
  } catch (e) { m.className = "msg-line err"; m.textContent = friendly(e); }
}
function friendly(e) { return (e && e.message) ? e.message : "Something went wrong — please try again."; }
function downloadCreds(cred) {
  const blob = new Blob([JSON.stringify(cred, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "resolve-credentials.json"; a.click();
  URL.revokeObjectURL(a.href);
}

// ---- admin: every case, folded --------------------------------------------
async function renderAdmin() {
  showComposer(false);
  $("docTitle").textContent = "All cases";
  $("caseref").textContent = "admin";
  const s = $("stream"); s.innerHTML = "";
  const loading = el("div", "msg a", "Loading every case you're invited to…"); s.appendChild(loading);
  try {
    const rooms = await Auth.listAppRooms({ acceptInvites: true });
    s.innerHTML = "";
    if (!rooms.length) { s.appendChild(el("div", "msg a", "No cases yet. When a user creates a complaint, it appears here.")); return; }
    for (const r of rooms) {
      let evs = [];
      try { evs = await Auth.roomEvents(r.roomId, EVENT_TYPE); } catch (e) {}
      const events = evs.map((e) => ({ id: e.id, op: e.content.op, payload: e.content.payload, at: new Date(e.ts).toISOString(), by: e.sender }));
      const answers = answersOf(fold(events), ANCHOR);
      const done = SCHEMA.fields.filter((f) => answers[f.path] != null && answers[f.path] !== "").length;
      const card = el("div", "msg a");
      card.innerHTML = `<b>${caseRef(r.roomId)}</b> — ${done}/${SCHEMA.fields.length} answered · <span class="mono">${events.length}</span> entries`;
      s.appendChild(card);
    }
  } catch (e) { s.innerHTML = ""; s.appendChild(el("div", "msg a support", "Couldn't load cases: " + friendly(e))); }
}

// ---- go --------------------------------------------------------------------
wireCompose();
boot();
