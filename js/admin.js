// admin.js — the admin dashboard: table + kanban views over every
// applicant's uploaded documents, decrypted on demand.
//
// Nothing here ever handles plaintext bytes directly — collectSubmissions()
// only reads the metadata + keys carried on each document's INS record
// (filename, mimetype, size, the AES key/iv/hash). Actually opening a file
// (decrypting it) happens in docview.js, triggered per document, so the
// dashboard itself stays a thin, fast list even with many large files.
//
// "The admin can see everything" comes from two things working together:
//   1. Matrix room membership — MatrixStore invites the admin into every
//      applicant's room as it's opened (see store.js), so client.getRooms()
//      naturally includes them all once accepted.
//   2. In demo mode there's no real multi-user backend, so this device's
//      localStorage stands in for "the server" and every room ever opened
//      here is visible (see DemoStore.listRoomIds).

import { fold, OP, EVENT_TYPE, newId, DemoStore, MatrixStore } from "./store.js";
import { DemoMedia, MatrixMedia } from "./media.js";
import { previewDocument } from "./docview.js";
import { ADMIN_USER_ID } from "./config.js";

export { ADMIN_USER_ID };
export const isAdmin = (userId) => userId === ADMIN_USER_ID;

export const STATUSES = [
  { key: "new", label: "New" },
  { key: "in_review", label: "In review" },
  { key: "verified", label: "Verified" },
  { key: "flagged", label: "Flagged" },
];
// Every room's worth of events -> one entry per applicant, each carrying its
// document records with the current status folded in (status changes are
// just another DEF, anchored on the document's own record id).
export function collectSubmissions({ storeKind, client }) {
  const roomIds = storeKind === "matrix" ? MatrixStore.joinedRoomIds(client) : DemoStore.listRoomIds();
  const submissions = [];
  for (const roomId of roomIds) {
    const events = storeKind === "matrix" ? MatrixStore.foldRoomEvents(client, roomId) : DemoStore.loadEvents(roomId);
    if (!events.length) continue;
    const folded = fold(events);
    const applicantName = folded.anchors?.applicant?.full_legal_name?.value;
    const docs = Object.entries(folded.records)
      .filter(([, r]) => r.entity === "document")
      .map(([id, r]) => ({
        id,
        roomId,
        ...r.attrs,
        status: folded.anchors?.[id]?.status?.value || r.attrs.status || "new",
        uploadedAt: r.at,
      }));
    if (!docs.length) continue;
    submissions.push({ roomId, applicantName: applicantName || roomId, docs });
  }
  return submissions;
}

function setStatus(ctx, doc, status) {
  const payload = { anchor: doc.id, path: "status", value: status };
  if (ctx.storeKind === "matrix") ctx.client.sendEvent(doc.roomId, EVENT_TYPE, { op: OP.DEF, payload });
  else DemoStore.appendEvent(doc.roomId, OP.DEF, payload, ctx.currentUserId);
}

function mediaFor(ctx) { return ctx.storeKind === "matrix" ? new MatrixMedia(ctx.client) : new DemoMedia(); }

function fmtBytes(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtDate(iso) { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return iso || ""; } }

const $e = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

export function initAdminView({ onClose }) {
  const root = document.getElementById("adminView");
  const body = document.getElementById("adminBody");
  const who = document.getElementById("adminWho");
  const tabs = Array.from(root.querySelectorAll(".atab"));
  let active = "table";
  let ctx = null;

  tabs.forEach((btn) => {
    btn.onclick = () => {
      active = btn.dataset.view;
      tabs.forEach((b) => b.classList.toggle("on", b === btn));
      renderActive();
    };
  });
  document.getElementById("adminClose").onclick = onClose;

  function renderActive() {
    if (!ctx) return;
    const submissions = collectSubmissions(ctx);
    const docs = submissions.flatMap((s) => s.docs.map((d) => ({ ...d, applicantName: s.applicantName })));
    body.innerHTML = "";
    if (!docs.length) {
      body.appendChild($e("div", "aempty", "No documents uploaded yet. As applicants attach supporting documents, they'll show up here — decrypted for you, encrypted everywhere else."));
      return;
    }
    body.appendChild(active === "table" ? renderTable(docs) : renderKanban(docs));
  }

  function viewBtn(d) {
    const btn = $e("button", "aview", "View");
    btn.onclick = () => previewDocument(d, mediaFor(ctx));
    return btn;
  }

  function statusSelect(d) {
    const sel = document.createElement("select");
    sel.className = "astatus-sel status-" + d.status;
    for (const s of STATUSES) { const o = new Option(s.label, s.key, false, s.key === d.status); sel.appendChild(o); }
    sel.onchange = () => { setStatus(ctx, d, sel.value); renderActive(); };
    return sel;
  }

  function renderTable(docs) {
    const wrap = $e("div", "atable-wrap");
    const table = document.createElement("table"); table.className = "atable";
    table.innerHTML = "<thead><tr><th>Applicant</th><th>Document</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Status</th><th></th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const d of docs.slice().sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""))) {
      const tr = document.createElement("tr");
      tr.appendChild($e("td", "acell-name", d.applicantName));
      tr.appendChild($e("td", "acell-doc", d.filename));
      tr.appendChild($e("td", "acell-mime mono", d.mimetype));
      tr.appendChild($e("td", "acell-size mono", fmtBytes(d.size)));
      tr.appendChild($e("td", "acell-date mono", fmtDate(d.uploadedAt)));
      const statusTd = document.createElement("td"); statusTd.appendChild(statusSelect(d)); tr.appendChild(statusTd);
      const actionTd = document.createElement("td"); actionTd.appendChild(viewBtn(d)); tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table);
    return wrap;
  }

  function renderKanban(docs) {
    const board = $e("div", "kanban");
    for (const s of STATUSES) {
      const col = $e("div", "kcol");
      const head = $e("div", "khead");
      head.appendChild($e("span", null, s.label));
      head.appendChild($e("span", "kcount", String(docs.filter((d) => d.status === s.key).length)));
      col.appendChild(head);
      const list = $e("div", "klist");
      list.dataset.status = s.key;
      list.addEventListener("dragover", (e) => { e.preventDefault(); list.classList.add("over"); });
      list.addEventListener("dragleave", () => list.classList.remove("over"));
      list.addEventListener("drop", (e) => {
        e.preventDefault(); list.classList.remove("over");
        const [roomId, id] = (e.dataTransfer.getData("text/plain") || "").split("::");
        const d = docs.find((x) => x.roomId === roomId && x.id === id);
        if (d && d.status !== s.key) { setStatus(ctx, d, s.key); renderActive(); }
      });
      for (const d of docs.filter((x) => x.status === s.key)) list.appendChild(kanbanCard(d));
      col.appendChild(list);
      board.appendChild(col);
    }
    return board;
  }

  function kanbanCard(d) {
    const card = $e("div", "kcard");
    card.draggable = true;
    card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", `${d.roomId}::${d.id}`));
    card.appendChild($e("div", "kname", d.filename));
    card.appendChild($e("div", "kapp", d.applicantName));
    const meta = $e("div", "kmeta"); meta.textContent = `${fmtBytes(d.size)} · ${fmtDate(d.uploadedAt)}`;
    card.appendChild(meta);
    card.appendChild(viewBtn(d));
    return card;
  }

  return {
    show(newCtx) {
      ctx = newCtx;
      who.textContent = ctx.storeKind === "matrix" ? ctx.currentUserId : "Demo · this device (every room opened here)";
      renderActive();
    },
  };
}
