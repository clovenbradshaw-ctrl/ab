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
//
// Two extras on top of that minimal contract:
//   autoDownload()   — warms the model on page load instead of waiting for
//                       the first mic tap, so by the time someone actually
//                       wants to speak, the (large, one-time) download is
//                       already done or well underway.
//   onPartial (opt)  — while recording, a timer re-transcribes everything
//                       heard so far and reports it, so the compose box
//                       fills in as the person talks instead of staying
//                       blank until they stop. Whisper has no incremental
//                       mode, so each tick re-hears the whole clip-to-date;
//                       stop() still re-runs the final, complete clip once
//                       so a partial preview is never the answer of record.
//                       Only actually runs when a device looks capable
//                       enough to absorb a repeated ASR pass without
//                       janking the UI (see isCapableDevice()) — on a
//                       constrained device this silently degrades to the
//                       pre-streaming behavior: one pass, on stop().
//
// The model itself is requested in a quantized form (see dtypeFor()) —
// smaller download, faster inference, on every device — rather than the
// library's full-precision default.

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

  // Quantization to request per device: 8-bit on CPU/WASM shrinks the
  // download to a fraction of full precision and runs far faster per pass
  // — this model may run once every 2.5s while streaming, with no GPU to
  // lean on, so that matters a lot more than it would for a one-shot call.
  // WebGPU has real memory bandwidth to spare, so fp16 keeps quality high
  // while still halving fp32's footprint. Either way this is strictly
  // lighter than the library's own default, never heavier.
  function dtypeFor(dev) { return dev === "webgpu" ? "fp16" : "q8"; }

  // Roughly: is this a phone/low-power device, or a real desktop/laptop?
  // hardwareConcurrency is universally available; deviceMemory is Chromium-
  // only and omitted elsewhere by design (privacy), so it only vetoes when
  // actually reported — never assumed absent-means-constrained.
  function isCapableDevice() {
    if (typeof navigator === "undefined") return true;
    const cores = navigator.hardwareConcurrency || 4;
    if (cores < 4) return false;
    if (typeof navigator.deviceMemory === "number" && navigator.deviceMemory < 4) return false;
    return true;
  }

  // Load (and cache) the speech model. onProgress(fraction) fires during
  // the one-time download so the UI can show it filling in.
  function loadASR(onProgress) {
    if (!_asr) {
      _asr = (async () => {
        const dev = await device();
        const { pipeline } = await import(/* webpackIgnore: true */ TRANSFORMERS);
        const progress_callback = (p) => {
          if (typeof onProgress === "function" && p && p.status === "progress" && p.progress != null)
            onProgress(Math.max(0, Math.min(1, p.progress / 100)));
        };
        try {
          return await pipeline("automatic-speech-recognition", MODEL, { device: dev, dtype: dtypeFor(dev), progress_callback });
        } catch (e) {
          // Not every model repo publishes every quantization variant —
          // fall back to the library's own default rather than permanently
          // breaking voice input over a size optimization.
          return await pipeline("automatic-speech-recognition", MODEL, { device: dev, progress_callback });
        }
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

  // Start the model download as soon as the page can, not lazily on first
  // mic tap — loadASR() caches on the same shared promise either way, so
  // calling this early just means the download is already finished (or
  // well underway) by the time someone actually wants to speak.
  // onProgress(fraction) reports the same 0..1 download progress createVoice
  // would. Never rejects: a failed pre-warm just means the first real
  // recording retries the load and surfaces the failure there, same as
  // before this existed. A no-op where voice input isn't usable at all —
  // no sense pulling down a ~100MB model nobody can use.
  function autoDownload(onProgress) {
    if (!isSupported()) return Promise.resolve();
    return loadASR(onProgress).catch(() => {});
  }

  // A single recorder instance. onState(state) drives the button;
  // onProgress(fraction) reports the first-load model download; onPartial
  // (text) reports a growing live-preview transcript while recording is
  // still in progress (see the file header note on how that works).
  // `lang`: "en" | "es" — passed through to Whisper as a language hint,
  // since guessing the wrong language on a short clip costs more accuracy
  // than a bilingual UI should have to pay for.
  function createVoice({ onState = () => {}, onProgress = () => {}, onPartial = null, lang = "en", partialIntervalMs = 2500 } = {}) {
    let stream = null, rec = null, chunks = [];
    let state = "idle"; // idle | recording | transcribing
    let streamTimer = null;
    // Guards against a slow partial pass still running when the next tick
    // (or the final stop()) fires — transcribe calls must never overlap,
    // since two concurrent asr() calls would fight over the one pipeline.
    let streamBusy = false;
    // Live streaming costs real, recurring CPU/battery (a full ASR pass
    // every partialIntervalMs) — only pay it when someone's actually
    // listening for partials, and only on a device that can absorb it
    // without the UI turning janky. A caller that skips onPartial gets the
    // exact pre-streaming behavior back: no timeslice, no timer, one
    // transcription pass on stop().
    const streamingEnabled = typeof onPartial === "function" && isCapableDevice();
    const set = (s) => { if (s !== state) { state = s; try { onState(s); } catch {} } };

    function stopStreamTimer() { if (streamTimer) { clearInterval(streamTimer); streamTimer = null; } }

    // Re-transcribes everything heard so far. A snapshot of the chunks
    // MediaRecorder has flushed to date is, for the codecs browsers actually
    // use here (webm/opus), itself a valid decodable clip — that's what
    // makes a "live" preview possible at all without a streaming-native
    // model.
    async function runPartial() {
      if (streamBusy || state !== "recording" || !chunks.length) return;
      streamBusy = true;
      try {
        const snapshot = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const mono = await decodeMono(snapshot);
        if (mono.length && state === "recording") {
          const asr = await loadASR(onProgress);
          const out = await asr(mono, {
            chunk_length_s: 30, stride_length_s: 5, return_timestamps: false,
            language: lang === "es" ? "spanish" : "english",
          });
          if (state === "recording") onPartial(String((out && out.text) || "").trim());
        }
      } catch (e) { /* a partial pass failing is never fatal — stop()'s final pass is authoritative */ }
      streamBusy = false;
    }

    async function start() {
      if (state !== "idle") return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      if (streamingEnabled) {
        // A 1s timeslice — without one, MediaRecorder holds everything back
        // until stop() and `chunks` never has anything for runPartial() to
        // snapshot while the person is still talking. Skipped entirely when
        // nobody wants partials: no reason to chunk the recording finer
        // than MediaRecorder's own default.
        rec.start(1000);
        streamTimer = setInterval(runPartial, partialIntervalMs);
      } else {
        rec.start();
      }
      set("recording");
    }

    function releaseMic() { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {} stream = null; }

    // Stop recording, hear the clip, resolve { text, blob }. text is ''
    // when nothing was said; blob is always the raw recording (even on a
    // failed transcription) so the caller can still keep it for review.
    function stop() {
      return new Promise((resolve, reject) => {
        stopStreamTimer();
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
      stopStreamTimer();
      if (rec && state === "recording") { rec.onstop = () => {}; try { rec.stop(); } catch {} }
      releaseMic();
      chunks = [];
      set("idle");
    }

    return { start, stop, cancel, get state() { return state; } };
  }

  return { isSupported, createVoice, autoDownload };
});
