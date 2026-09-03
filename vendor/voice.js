// voice.js — speak your answer. A microphone -> in-browser speech-to-text,
// so a person can say an answer instead of typing it. Nothing leaves the
// browser: the waveform is captured, decoded, and heard by a model that
// runs entirely on this device. Ported from the earlier
// claude/audio-transcription-yqn5l4 branch's js/voice.js (an ES module, in
// the app's older multi-file layout) into this file's classic-script /
// window-global shape to match how vendor/steer.js loads in the current
// single-file index.html — logic unchanged, only the module wrapper.
//
// Which model, per language (see MODELS below): English uses Moonshine
// (onnx-community/moonshine-tiny-ONNX) — a model family built specifically
// for fast, small, on-device ASR rather than adapted to it, published
// benchmarks put its tiny (27M-parameter) checkpoints ahead of Whisper
// models several times its size, and it needs no 30-second padding the way
// Whisper does. Spanish stays on Whisper for now: Moonshine AI's only
// published Spanish checkpoint (moonshine-ai/moonshine-es) ships ONNX
// weights in a different runtime's layout — a proprietary tokenizer.bin,
// not the tokenizer.json/config.json set transformers.js expects — and
// re-targeting that without a way to verify the result against real speech
// in a real browser (unavailable in the sandbox this was written in) risks
// silently corrupting Spanish transcripts on a form that becomes an actual
// legal complaint. Move it to Moonshine once a transformers.js-compatible
// Spanish checkpoint exists (from onnx-community or a verified conversion),
// by adding its entry to MODELS/ARCH below — everything else here is
// already written to be architecture-agnostic per language.
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
//   onPartial (opt)  — while recording, a timer re-transcribes recent audio
//                       and reports it, so the compose box fills in as the
//                       person talks instead of staying blank until they
//                       stop. Whisper has no incremental mode, so each tick
//                       re-hears the last PARTIAL_WINDOW_S seconds (not the
//                       whole clip-to-date — that would make each tick
//                       slower the longer someone talks, and streaming would
//                       stall out on a long recording); stop() still re-runs
//                       the final, complete clip once so a partial preview
//                       is never the answer of record.
//                       Only actually runs when a device looks capable
//                       enough to absorb a repeated ASR pass without
//                       janking the UI (see isCapableDevice()) — on a
//                       constrained device this silently degrades to the
//                       pre-streaming behavior: one pass, on stop().
//
// The model is loaded at the library's own default precision — an earlier
// version requested 8-bit/fp16 quantization to shrink the download, but
// quantized ONNX speech weights are a known source of degenerate output
// (a short hallucinated phrase in place of a real transcript) that a
// try/catch around the *load* can't catch, since the quantized model still
// loads fine and only produces bad transcriptions. Full precision is a
// larger one-time download in exchange for output you can trust.
//
// One deterministic cleanup runs on every transcript, partial and final
// alike: spoken email addresses. Nobody dictates "@" or "." — they say
// "john dot smith at gmail dot com" (or, in Spanish, "arroba"/"punto") — so
// the model hears and prints exactly those words, and a legal complaint
// form is a bad place to leave "at"/"arroba" and "dot"/"punto" sitting
// where an address was meant. See normalizeSpokenEmails below.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Voice = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const SR = 16000; // native rate for both Moonshine and Whisper
  // One model id + architecture per supported language; MODELS[lang] falls
  // back to English for anything not listed. "arch" picks which options
  // shape asrOptions() below builds — Moonshine and Whisper take different
  // generation options (see there for why) despite both running through
  // the exact same pipeline("automatic-speech-recognition", ...) call.
  const MODELS = {
    en: { id: "onnx-community/moonshine-tiny-ONNX", arch: "moonshine" },
    es: { id: "onnx-community/whisper-base", arch: "whisper" },
  };
  function resolveModel(lang) {
    return MODELS[lang] || MODELS.en;
  }
  const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm";
  // How much trailing audio a partial pass actually hears. Re-transcribing
  // the whole clip-to-date every tick is O(n) in recording length, so on a
  // long recording each tick eventually takes longer than
  // partialIntervalMs and starts getting dropped by the streamBusy guard —
  // "live" streaming would silently stall out exactly when someone records
  // something long. Capping the ASR call to the most recent PARTIAL_WINDOW_S
  // seconds keeps each tick's cost roughly constant no matter how long the
  // recording has run so far; stop()'s final pass still hears the entire
  // clip, so nothing spoken is ever lost from the answer of record.
  const PARTIAL_WINDOW_S = 20;

  // ---- WebM duration fix ----
  // Chrome's MediaRecorder writes WebM files with no Duration in the
  // Segment/Info header — a long-standing, well-known Chromium bug
  // (crbug.com/642012). decodeAudioData() on a blob assembled from such a
  // recording can decode to a bogus/near-zero duration, so a real recording
  // silently turns into next to no audio for the model to hear — which is
  // exactly the shape of bug that has Whisper output a short throwaway
  // phrase instead of an actual transcript, every time, regardless of what
  // was said. This is a straight, trimmed port of the well-tested community
  // fix (npm: fix-webm-duration, used by e.g. huggingface/whisper-web) — a
  // small hand-rolled EBML reader/writer, not a homegrown parser. Trimmed to
  // just the element IDs needed to reach Segment -> Info -> {TimecodeScale,
  // Duration}; every other element is carried through as opaque bytes,
  // which is safe because the parser never needs to interpret anything it
  // doesn't recurse into.
  const EBML_SECTIONS = {
    0x8538067: { type: "Container" }, // Segment
    0x549a966: { type: "Container" }, // Info
    0xad7b1: { type: "Uint" }, // TimecodeScale
    0x489: { type: "Float" }, // Duration
  };

  function EbmlBase() {}
  EbmlBase.prototype.setSource = function (source) { this.source = source; this.updateBySource(); };
  EbmlBase.prototype.updateBySource = function () {};

  function EbmlUint() {}
  EbmlUint.prototype = Object.create(EbmlBase.prototype);
  function padHex(hex) { return hex.length % 2 === 1 ? "0" + hex : hex; }
  EbmlUint.prototype.setValue = function (value) {
    const hex = padHex(value.toString(16));
    const len = hex.length / 2;
    this.source = new Uint8Array(len);
    for (let i = 0; i < len; i++) this.source[i] = parseInt(hex.substr(i * 2, 2), 16);
  };

  function EbmlFloat() {}
  EbmlFloat.prototype = Object.create(EbmlBase.prototype);
  EbmlFloat.prototype.getValue = function () {
    const bytes = this.source.slice().reverse();
    const FloatType = bytes.length === 4 ? Float32Array : Float64Array;
    return new FloatType(bytes.buffer)[0];
  };
  EbmlFloat.prototype.setValue = function (value) {
    const FloatType = this.source && this.source.length === 4 ? Float32Array : Float64Array;
    this.source = new Uint8Array(new FloatType([value]).buffer).reverse();
  };

  function EbmlContainer() {}
  EbmlContainer.prototype = Object.create(EbmlBase.prototype);
  EbmlContainer.prototype.readUint = function () {
    const first = this.source[this.offset++];
    const bytes = 8 - first.toString(2).length;
    let value = first - (1 << (7 - bytes));
    for (let i = 0; i < bytes; i++) { value = value * 256 + this.source[this.offset++]; }
    return value;
  };
  EbmlContainer.prototype.updateBySource = function () {
    this.data = [];
    this.offset = 0;
    while (this.offset < this.source.length) {
      const id = this.readUint();
      const len = this.readUint();
      const end = Math.min(this.offset + len, this.source.length);
      const chunk = this.source.slice(this.offset, end);
      this.offset = end;
      const info = EBML_SECTIONS[id];
      const El = info && info.type === "Container" ? EbmlContainer : info && info.type === "Uint" ? EbmlUint : info && info.type === "Float" ? EbmlFloat : EbmlBase;
      const section = new El();
      section.setSource(chunk);
      this.data.push({ id, el: section });
    }
  };
  EbmlContainer.prototype.writeUint = function (x) {
    let bytes = 1, flag = 0x80;
    while (x >= flag && bytes < 8) { bytes++; flag *= 0x80; }
    let value = flag + x;
    for (let i = bytes - 1; i >= 0; i--) {
      const c = value % 256;
      this.source[this.offset + i] = c;
      value = (value - c) / 256;
    }
    this.offset += bytes;
  };
  EbmlContainer.prototype.updateByData = function () {
    let length = 0;
    for (const item of this.data) length += byteLenOfUint(item.id) + byteLenOfUint(item.el.source.length) + item.el.source.length;
    this.source = new Uint8Array(length);
    this.offset = 0;
    for (const item of this.data) {
      this.writeUint(item.id);
      this.writeUint(item.el.source.length);
      this.source.set(item.el.source, this.offset);
      this.offset += item.el.source.length;
    }
  };
  EbmlContainer.prototype.getSectionById = function (id) {
    for (const item of this.data) if (item.id === id) return item.el;
    return null;
  };
  function byteLenOfUint(x) {
    let bytes = 1, flag = 0x80;
    while (x >= flag && bytes < 8) { bytes++; flag *= 0x80; }
    return bytes;
  }

  // Patch (or insert) a correct Duration into a WebM blob's header. Returns
  // the original blob unchanged if the header shape isn't what's expected,
  // or if a real (positive) duration is already present — never throws.
  async function fixWebmDuration(blob, durationMs) {
    try {
      const file = new EbmlContainer();
      file.setSource(new Uint8Array(await blob.arrayBuffer()));
      const segment = file.getSectionById(0x8538067);
      const info = segment && segment.getSectionById(0x549a966);
      const timeScale = info && info.getSectionById(0xad7b1);
      if (!info || !timeScale) return blob;
      let duration = info.getSectionById(0x489);
      if (duration && duration.getValue() > 0) return blob; // already correct
      if (!duration) {
        duration = new EbmlFloat();
        duration.setValue(durationMs);
        info.data.push({ id: 0x489, el: duration });
      } else {
        duration.setValue(durationMs);
      }
      timeScale.setValue(1000000); // 1ms precision, matching the ms duration above
      info.updateByData();
      segment.updateByData();
      file.updateByData();
      return new Blob([file.source], { type: blob.type });
    } catch (e) {
      return blob; // never let a header patch attempt break the actual recording
    }
  }

  // The heavy pieces load lazily, exactly once per model, and only when the
  // mic is first used for that language. Keyed by model id (not by "en"/
  // "es") so autoDownload() and createVoice() never disagree about which
  // pipeline instance a given model resolves to.
  const _asrCache = new Map(); // model id -> Promise<pipeline>
  let _device = null; // 'webgpu' | 'wasm'

  async function device() {
    if (_device) return _device;
    _device = "wasm";
    try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) _device = "webgpu"; } catch {}
    return _device;
  }

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

  // Load (and cache) a speech model by id. onProgress(fraction) fires during
  // the one-time download so the UI can show it filling in.
  function loadASR(modelId, onProgress) {
    if (!_asrCache.has(modelId)) {
      const promise = (async () => {
        const dev = await device();
        const { pipeline } = await import(/* webpackIgnore: true */ TRANSFORMERS);
        return pipeline("automatic-speech-recognition", modelId, {
          device: dev,
          progress_callback: (p) => {
            if (typeof onProgress === "function" && p && p.status === "progress" && p.progress != null)
              onProgress(Math.max(0, Math.min(1, p.progress / 100)));
          },
        });
      })().catch((e) => { _asrCache.delete(modelId); throw e; }); // a failed load must not poison the cache
      _asrCache.set(modelId, promise);
    }
    return _asrCache.get(modelId);
  }

  // Moonshine and Whisper take different generation options through the
  // exact same pipeline() call. Whisper needs chunk_length_s/stride_length_s
  // to handle audio past its fixed 30s window and a language hint to avoid
  // guessing wrong on a short clip; Moonshine has no such window (it scales
  // to the audio it's given) and has no multilingual weights to hint at all
  // — the language choice already happened by picking which checkpoint to
  // load. Passing Whisper's options to Moonshine wouldn't necessarily
  // error, but they'd be silently meaningless, so build the right shape per
  // architecture instead of hoping the unused ones are ignored.
  function asrOptions(arch, lang) {
    if (arch === "whisper") {
      return { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false, language: lang === "es" ? "spanish" : "english" };
    }
    return undefined;
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

  // "john dot smith at gmail dot com" -> "john.smith@gmail.com", in either
  // language this app speaks: "arroba"/"punto" work the same as "at"/"dot"
  // for a constituent dictating in Spanish. Scoped tightly on purpose: it
  // only fires on a run that has BOTH an "at" word and a "dot" word after
  // it, which is how people actually dictate an address and not how "at"
  // (or "en"/ordinary "punto") turns up in ordinary sentences ("I was at
  // the store" / "estaba en la tienda" have no following dot-word and are
  // left untouched). Local and domain parts may themselves be joined by any
  // of these connector words ("maria underscore lopez at hotmail dot com",
  // "maria guion bajo lopez arroba gmail punto com"), and a domain may
  // carry more than one label ("co dot state dot tn dot us"). The match is
  // lowercased, since addresses are conventionally lowercase and the model
  // capitalizes whatever word opens a sentence, dictated address or not.
  const EMAIL_WORD = "[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?";
  const EMAIL_DOT = "(?:dot|period|punto)";
  const EMAIL_AT = "(?:at|arroba)";
  const EMAIL_SEP = `(?:${EMAIL_DOT}|underscore|guion\\s+bajo|dash|hyphen|guion)`;
  const EMAIL_PART = `${EMAIL_WORD}(?:\\s+${EMAIL_SEP}\\s+${EMAIL_WORD})*`;
  const EMAIL_RE = new RegExp(
    `\\b(${EMAIL_PART})\\s+${EMAIL_AT}\\s+(${EMAIL_PART}\\s+${EMAIL_DOT}\\s+${EMAIL_WORD}(?:\\s+${EMAIL_DOT}\\s+${EMAIL_WORD})*)\\b`,
    "gi"
  );
  function normalizeSpokenEmails(text) {
    if (!text) return text;
    return text.replace(EMAIL_RE, (whole, local, domain) => {
      const email = (local + "@" + domain)
        .replace(/\s+(?:dot|period|punto)\s+/gi, ".")
        .replace(/\s+guion\s+bajo\s+/gi, "_") // must run before the bare "guion" (dash) pass below
        .replace(/\s+underscore\s+/gi, "_")
        .replace(/\s+(?:dash|hyphen|guion)\s+/gi, "-")
        .replace(/\s+/g, "");
      return email.toLowerCase();
    });
  }

  // Start the model download for `lang` as soon as the page can, not lazily
  // on first mic tap — loadASR() caches per model id either way, so calling
  // this early just means the download is already finished (or well
  // underway) by the time someone actually wants to speak. onProgress
  // (fraction) reports the same 0..1 download progress createVoice would.
  // Never rejects: a failed pre-warm just means the first real recording
  // retries the load and surfaces the failure there, same as before this
  // existed. A no-op where voice input isn't usable at all — no sense
  // pulling down a model nobody can use.
  function autoDownload(lang, onProgress) {
    if (!isSupported()) return Promise.resolve();
    return loadASR(resolveModel(lang).id, onProgress).catch(() => {});
  }

  // A single recorder instance. onState(state) drives the button;
  // onProgress(fraction) reports the first-load model download; onPartial
  // (text) reports a growing live-preview transcript while recording is
  // still in progress (see the file header note on how that works).
  // `lang`: "en" | "es" — picks which model (and, for Whisper, which
  // language hint) transcribes this take. See MODELS above for why English
  // and Spanish currently run different architectures.
  // onSilence (opt) fires once, while still recording, after the take has
  // heard speech and then gone quiet for `silenceMs`. The caller decides
  // what that means — this module never stops a recording on its own.
  function createVoice({ onState = () => {}, onProgress = () => {}, onPartial = null, onSilence = null, lang = "en", partialIntervalMs = 2500, silenceMs = 2600 } = {}) {
    const model = resolveModel(lang);
    let stream = null, rec = null, chunks = [];
    let state = "idle"; // idle | recording | transcribing
    let streamTimer = null;
    let startedAt = 0; // Date.now() at start() — how the WebM duration fix knows the true elapsed time
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

    // A snapshot of the chunks recorded so far, with a real Duration patched
    // into the WebM header (see fixWebmDuration above) — without this,
    // decodeAudioData on a mid-recording (unfinalized) or even a stopped
    // MediaRecorder blob can decode to bogus near-zero audio, silently
    // starving the model of anything to actually hear.
    async function snapshotBlob() {
      const raw = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      return /webm/.test(raw.type) ? fixWebmDuration(raw, elapsedMs) : raw;
    }

    // Re-transcribes everything heard so far. A snapshot of the chunks
    // MediaRecorder has flushed to date is, for the codecs browsers actually
    // use here (webm/opus), itself a valid decodable clip — that's what
    // makes a "live" preview possible at all without a streaming-native
    // model.
    async function runPartial() {
      if (streamBusy || state !== "recording" || !chunks.length) return;
      streamBusy = true;
      try {
        const snapshot = await snapshotBlob();
        const mono = await decodeMono(snapshot);
        const windowSamples = PARTIAL_WINDOW_S * SR;
        const heard = mono.length > windowSamples ? mono.subarray(mono.length - windowSamples) : mono;
        if (heard.length && state === "recording") {
          const asr = await loadASR(model.id, onProgress);
          const out = await asr(heard, asrOptions(model.arch, lang));
          if (state === "recording") onPartial(normalizeSpokenEmails(String((out && out.text) || "").trim()));
        }
      } catch (e) { /* a partial pass failing is never fatal — stop()'s final pass is authoritative */ }
      streamBusy = false;
    }

    // ---- knowing when someone has finished speaking -------------------------
    // Nobody should have to find a button to say "I'm done" — least of all
    // someone mid-sentence about their child. A small RMS meter on the same
    // MediaStream the recorder is reading decides it instead: once the take
    // has actually heard speech, a stretch of quiet ends it.
    //
    // One-directional on purpose. Silence BEFORE anything is said never ends
    // anything, because someone gathering themselves before answering a hard
    // question is the most ordinary thing that happens here. The threshold is
    // low enough to count a quiet voice as speech and let room tone read as
    // silence; being wrong in the generous direction costs a few extra
    // seconds of recording, being wrong the other way cuts someone off.
    const SILENCE_RMS = 0.012;
    let vadCtx = null, vadTimer = null, heardSpeech = false, quietSince = 0;

    function startSilenceWatch() {
      if (typeof onSilence !== "function" || !stream) return;
      const Ctx = typeof AudioContext !== "undefined" ? AudioContext : self.webkitAudioContext;
      if (!Ctx) return;
      try {
        vadCtx = new Ctx();
        const analyser = vadCtx.createAnalyser();
        analyser.fftSize = 1024;
        vadCtx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        heardSpeech = false;
        quietSince = 0;
        vadTimer = setInterval(() => {
          if (state !== "recording") return;
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (rms > SILENCE_RMS) { heardSpeech = true; quietSince = 0; return; }
          if (!heardSpeech) return;
          const now = Date.now();
          if (!quietSince) { quietSince = now; return; }
          if (now - quietSince >= silenceMs) {
            stopSilenceWatch();
            try { onSilence(); } catch {}
          }
        }, 100);
      } catch (e) {
        // No Web Audio here — the recording simply keeps going until the
        // person ends it themselves, exactly as before.
        stopSilenceWatch();
      }
    }

    function stopSilenceWatch() {
      if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
      if (vadCtx) { try { vadCtx.close(); } catch {} vadCtx = null; }
    }

    async function start() {
      if (state !== "idle") return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      startedAt = Date.now();
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
      startSilenceWatch();
    }

    function releaseMic() { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {} stream = null; }

    // Stop recording, hear the clip, resolve { text, blob }. text is ''
    // when nothing was said; blob is always the raw recording (even on a
    // failed transcription) so the caller can still keep it for review.
    function stop() {
      return new Promise((resolve, reject) => {
        stopStreamTimer();
        stopSilenceWatch();
        if (state !== "recording" || !rec) return resolve({ text: "", blob: null });
        rec.onstop = async () => {
          releaseMic();
          const blob = await snapshotBlob();
          chunks = [];
          // A partial pass can still be mid-flight here — it shares the one
          // cached ASR pipeline instance, and two concurrent calls into it
          // would fight over the same inference session. Wait it out before
          // starting the final, authoritative pass rather than racing it.
          while (streamBusy) await new Promise((r) => setTimeout(r, 50));
          try {
            set("transcribing");
            const mono = await decodeMono(blob);
            if (!mono.length) { set("idle"); return resolve({ text: "", blob }); }
            const asr = await loadASR(model.id, onProgress);
            // For Whisper, chunk_length_s lets it handle a clip longer than
            // its 30s context (a short answer is still a single pass);
            // Moonshine needs no such option (see asrOptions above).
            const out = await asr(mono, asrOptions(model.arch, lang));
            set("idle");
            resolve({ text: normalizeSpokenEmails(String((out && out.text) || "").trim()), blob });
          } catch (e) { set("idle"); reject(e); }
        };
        try { rec.stop(); } catch (e) { releaseMic(); set("idle"); reject(e); }
      });
    }

    // Abandon a recording without transcribing (e.g. the user pressed Escape).
    function cancel() {
      stopStreamTimer();
      stopSilenceWatch();
      if (rec && state === "recording") { rec.onstop = () => {}; try { rec.stop(); } catch {} }
      releaseMic();
      chunks = [];
      set("idle");
    }

    // Exposed so a caller can drive its own visualization (e.g. a live
    // waveform) off the exact same MediaStream the recorder is reading,
    // instead of opening a second getUserMedia stream just to look at it.
    return { start, stop, cancel, get state() { return state; }, get stream() { return stream; } };
  }

  return { isSupported, createVoice, autoDownload };
});
