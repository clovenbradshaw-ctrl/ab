// voice.js — speak your answer. A microphone -> in-browser speech-to-text,
// so a person can say an answer instead of typing it. Nothing leaves the
// browser: the waveform is captured, decoded, and heard by a Whisper model
// that runs entirely on this device. Ported from the earlier
// claude/audio-transcription-yqn5l4 branch's js/voice.js (an ES module, in
// the app's older multi-file layout) into this file's classic-script /
// window-global shape to match how vendor/steer.js loads in the current
// single-file index.html — logic unchanged, only the module wrapper.
//
// The contract to the app is small: create a recorder, start() it, stop()
// resolves { text, blob } — the transcript AND the raw recording, so the
// caller can keep the audio (encrypted) for a transcription-accuracy audit
// without this module knowing anything about encryption or storage.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Voice = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const SR = 16000; // whisper's native rate
  const MODEL = "onnx-community/whisper-base";
  const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm";

  // The heavy pieces load lazily, exactly once, and only when the mic is
  // first used.
  let _asr = null; // Promise<pipeline>, shared across recordings
  let _device = null; // 'webgpu' | 'wasm'

  async function device() {
    if (_device) return _device;
    _device = "wasm";
    try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) _device = "webgpu"; } catch {}
    return _device;
  }

  // Load (and cache) the speech model. onProgress(fraction) fires during
  // the one-time download so the UI can show it filling in.
  function loadASR(onProgress) {
    if (!_asr) {
      _asr = (async () => {
        const dev = await device();
        const { pipeline } = await import(/* webpackIgnore: true */ TRANSFORMERS);
        return pipeline("automatic-speech-recognition", MODEL, {
          device: dev,
          progress_callback: (p) => {
            if (typeof onProgress === "function" && p && p.status === "progress" && p.progress != null)
              onProgress(Math.max(0, Math.min(1, p.progress / 100)));
          },
        });
      })().catch((e) => { _asr = null; throw e; }); // a failed load must not poison the cache
    }
    return _asr;
  }

  // Decode a recorded blob to mono 16 kHz Float32 — the shape the model eats.
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
  function isSupported() {
    return typeof navigator !== "undefined"
      && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"
      && typeof window !== "undefined"
      && typeof window.MediaRecorder !== "undefined"
      && !!(window.AudioContext || window.webkitAudioContext);
  }

  // A single recorder instance. onState(state) drives the button;
  // onProgress(fraction) reports the first-load model download.
  // `lang`: "en" | "es" — passed through to Whisper as a language hint,
  // since guessing the wrong language on a short clip costs more accuracy
  // than a bilingual UI should have to pay for.
  function createVoice({ onState = () => {}, onProgress = () => {}, lang = "en" } = {}) {
    let stream = null, rec = null, chunks = [];
    let state = "idle"; // idle | recording | transcribing
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

    // Stop recording, hear the clip, resolve { text, blob }. text is ''
    // when nothing was said; blob is always the raw recording (even on a
    // failed transcription) so the caller can still keep it for review.
    function stop() {
      return new Promise((resolve, reject) => {
        if (state !== "recording" || !rec) return resolve({ text: "", blob: null });
        rec.onstop = async () => {
          releaseMic();
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          chunks = [];
          try {
            set("transcribing");
            const mono = await decodeMono(blob);
            if (!mono.length) { set("idle"); return resolve({ text: "", blob }); }
            const asr = await loadASR(onProgress);
            // chunk_length_s lets whisper handle a clip longer than its 30s
            // context; a short answer is a single pass.
            const out = await asr(mono, {
              chunk_length_s: 30, stride_length_s: 5, return_timestamps: false,
              language: lang === "es" ? "spanish" : "english",
            });
            set("idle");
            resolve({ text: String((out && out.text) || "").trim(), blob });
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

  return { isSupported, createVoice };
});
