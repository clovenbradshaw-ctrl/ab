// voice.js — speak your answers. A microphone → in-browser speech-to-text, so a
// person can say an answer instead of typing it. Nothing leaves the browser: the
// waveform is captured, decoded, and heard by a Whisper model that runs entirely
// on this device (the same ear eoreader uses in organs/in/audio.js), keeping the
// app's promise that nothing you say or type is sent anywhere.
//
// The contract to the app is small, matching the rest of the codebase: create a
// recorder, `start()` it, `stop()` returns the transcript. State transitions
// (idle → recording → transcribing → idle) and the one-time model download report
// through callbacks, so app.js only paints — no speech logic lives in the DOM.

const SR = 16000;                         // whisper's native rate
const MODEL = "onnx-community/whisper-base";
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm";

// The heavy pieces load lazily, exactly once, and only when the mic is first used —
// the same "inject the library, bundle nothing" seam eoreader's organs assume.
let _asr = null;                          // Promise<pipeline>, shared across recordings
let _device = null;                       // 'webgpu' | 'wasm'

// WebGPU if the browser offers it, else WASM — the probe eoreader's import-file uses.
async function device() {
  if (_device) return _device;
  _device = "wasm";
  try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) _device = "webgpu"; } catch {}
  return _device;
}

// Load (and cache) the speech model. `onProgress(fraction)` fires during the
// one-time download so the UI can show it filling in.
function loadASR(onProgress) {
  if (!_asr) {
    _asr = (async () => {
      const dev = await device();
      const { pipeline } = await import(TRANSFORMERS);
      return pipeline("automatic-speech-recognition", MODEL, {
        device: dev,
        progress_callback: (p) => {
          if (typeof onProgress === "function" && p && p.status === "progress" && p.progress != null)
            onProgress(Math.max(0, Math.min(1, p.progress / 100)));
        },
      });
    })().catch((e) => { _asr = null; throw e; });   // a failed load must not poison the cache
  }
  return _asr;
}

// Decode a recorded blob to mono 16 kHz Float32 — the shape the model eats — via an
// offline graph, byte-for-byte the decode path eoreader's fromMedia uses.
async function decodeMono(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("this browser cannot decode audio");
  const bytes = await blob.arrayBuffer();
  const tmp = new AC();
  let decoded;
  try { decoded = await tmp.decodeAudioData(bytes.slice(0)); } finally { try { tmp.close(); } catch {} }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SR)), SR);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}

// Is voice input possible here at all? (Secure context + mic + recorder + decoder.)
export function isSupported() {
  return typeof navigator !== "undefined"
    && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"
    && typeof window !== "undefined"
    && typeof window.MediaRecorder !== "undefined"
    && !!(window.AudioContext || window.webkitAudioContext);
}

// A single recorder instance. onState(state) drives the button; onProgress(fraction)
// reports the first-load download.
export function createVoice({ onState = () => {}, onProgress = () => {} } = {}) {
  let stream = null, rec = null, chunks = [];
  let state = "idle";                     // idle | recording | transcribing
  const set = (s) => { if (s !== state) { state = s; try { onState(s); } catch {} } };

  async function start() {
    if (state !== "idle") return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start();
    set("recording");
  }

  function releaseMic() { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {} stream = null; }

  // Stop recording, hear the clip, resolve the transcript ('' when nothing was said).
  function stop() {
    return new Promise((resolve, reject) => {
      if (state !== "recording" || !rec) return resolve("");
      rec.onstop = async () => {
        releaseMic();
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        chunks = [];
        try {
          set("transcribing");
          const mono = await decodeMono(blob);
          if (!mono.length) { set("idle"); return resolve(""); }
          const asr = await loadASR(onProgress);
          // chunk_length_s lets whisper handle a clip longer than its 30s context;
          // a short answer is a single pass.
          const out = await asr(mono, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
          set("idle");
          resolve(String((out && out.text) || "").trim());
        } catch (e) { set("idle"); reject(e); }
      };
      try { rec.stop(); } catch (e) { releaseMic(); set("idle"); reject(e); }
    });
  }

  // Abandon a recording without transcribing (e.g. the user pressed Escape).
  function cancel() {
    if (rec && state === "recording") { rec.onstop = () => {}; try { rec.stop(); } catch {} }
    releaseMic();
    chunks = [];
    set("idle");
  }

  return { start, stop, cancel, get state() { return state; } };
}
