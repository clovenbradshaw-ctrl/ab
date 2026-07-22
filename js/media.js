// media.js — the media store: where encrypted file bytes actually live.
//
// The event log (store.js) only ever carries metadata + decryption keys for
// a document; this is the content-addressed blob store those keys point at.
// Two backends behind one interface, same pattern as store.js's DemoStore /
// MatrixStore:
//
//   DemoMedia   — IndexedDB on this device, standing in for a homeserver's
//                 content repository when there's no server to talk to.
//   MatrixMedia — the real Matrix content repository, via uploadContent().
//
// Both only ever handle ciphertext: encryption happens in crypto.js before
// put(), decryption happens after get(). Neither backend is told what it's
// storing.

const DB_NAME = "intake-media";
const STORE = "blobs";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class DemoMedia {
  async put(id, ciphertext) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(ciphertext, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return "mxc://demo/" + id;
  }
  async get(url) {
    const id = url.replace("mxc://demo/", "");
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => (req.result ? resolve(req.result) : reject(new Error("blob not found on this device")));
      req.onerror = () => reject(req.error);
    });
  }
}

export class MatrixMedia {
  constructor(client) { this.client = client; }
  async put(_id, ciphertext) {
    const res = await this.client.uploadContent(new Blob([ciphertext]), {
      rawResponse: false,
      onlyContentUri: true,
      type: "application/octet-stream", // the real mimetype is never sent — only the encrypted bytes are
    });
    return typeof res === "string" ? res : res.content_uri;
  }
  async get(url) {
    const httpUrl = this.client.mxcUrlToHttp(url);
    const res = await fetch(httpUrl);
    if (!res.ok) throw new Error("download failed: " + res.status);
    return res.arrayBuffer();
  }
}
