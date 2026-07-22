// docview.js — shared "decrypt and show" modal for document records.
//
// Used by both the applicant's own upload list (app.js) and the admin
// dashboard (admin.js): same event shape, same decrypt path, just a
// different set of documents in scope. The file is only ever plaintext in
// memory, as a blob: URL scoped to this tab — it's never written back
// anywhere decrypted.

import { decryptBytes } from "./crypto.js";

let modalEl = null;
let lastObjectUrl = null;

function ensureModal() {
  if (modalEl) return modalEl;
  const scrim = document.createElement("div");
  scrim.className = "docscrim";
  scrim.innerHTML = `
    <div class="docmodal">
      <button class="docclose" type="button" aria-label="Close">&times;</button>
      <div class="dochead"></div>
      <div class="docbody"></div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeDoc(); });
  scrim.querySelector(".docclose").onclick = closeDoc;
  modalEl = scrim;
  return scrim;
}

export function closeDoc() {
  if (!modalEl) return;
  modalEl.classList.remove("on");
  if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDoc(); });

export async function previewDocument(doc, media) {
  const scrim = ensureModal();
  const head = scrim.querySelector(".dochead");
  const body = scrim.querySelector(".docbody");
  head.textContent = doc.filename || "Document";
  body.innerHTML = `<p class="docstatus">Fetching encrypted file and decrypting in your browser…</p>`;
  scrim.classList.add("on");

  try {
    const ciphertext = await media.get(doc.url);
    const plainBuf = await decryptBytes(ciphertext, doc.key, doc.iv, doc.hash);
    const blob = new Blob([plainBuf], { type: doc.mimetype || "application/octet-stream" });
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    const objUrl = URL.createObjectURL(blob);
    lastObjectUrl = objUrl;

    body.innerHTML = "";
    if ((doc.mimetype || "").startsWith("image/")) {
      const img = document.createElement("img"); img.className = "docimg"; img.src = objUrl;
      body.appendChild(img);
    } else if (doc.mimetype === "application/pdf") {
      const frame = document.createElement("iframe"); frame.className = "docframe"; frame.src = objUrl;
      body.appendChild(frame);
    } else {
      const p = document.createElement("p"); p.className = "docstatus"; p.textContent = "No inline preview for this file type — download it below.";
      body.appendChild(p);
    }
    const dl = document.createElement("a");
    dl.className = "docdownload"; dl.href = objUrl; dl.download = doc.filename || "document";
    dl.textContent = "Download decrypted file";
    body.appendChild(dl);
  } catch (e) {
    body.innerHTML = `<p class="docstatus error">Couldn't decrypt this file: ${e.message}</p>`;
  }
}
