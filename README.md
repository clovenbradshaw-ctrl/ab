# Intake — guided document-filling over an event log

A chatbot that walks someone through a document one field at a time, gives
support when they're stuck, and stores every confirmed answer to a Matrix room.
Net new, but built on the two patterns from your repos:

- **Storage = amino.** A room is a table, events are rows, `fold(timeline)` is
  the query. Each confirmed answer is one `DEF` operator (`anchor`, `path`,
  `value`). State is never stored — the checklist is recomputed from the log,
  so the flow is resumable by construction.
- **Model = eoreader4.2.** One membrane, swappable backends (`webllm` /
  `ollama` / `echo`), driven by a small turn loop (`turn/converse`, cut down).

## Run

```
python3 -m http.server 8000    # then open http://localhost:8000
```

Opens straight into the **Echo + Demo** path — no model download, no homeserver,
answers persist to `localStorage`. Walk the whole intake immediately. Then flip
the two dropdowns top-right to swap in real backends.

## The two forks you chose

| | Options (top-right dropdowns) |
|---|---|
| **Model** | `Echo` (deterministic, no setup) · `WebLLM` (in-browser, WebGPU) · `Ollama` (local daemon) |
| **Store** | `Demo` (this device) · `Matrix` (sign in — homeserver + user + password) |

Backend-agnostic: the controller only calls `model.chat(messages)` and
`store.emit(op, payload)`, so either axis swaps without touching the loop.

## Files

```
index.html        shell + design tokens (the provenance ledger is the signature)
js/schema.js      the document — an ordered field set (swap this to fill a different form)
js/store.js       DemoStore + MatrixStore behind one interface; OP.DEF/INS/CON + fold()
js/model.js       WebLLM / Ollama / Echo backends + shared validate()
js/fold.js        the prompt fold: the model's context is a projection of the log
js/intake.js      the turn loop: fold -> next question -> support/answer -> confirm -> emit
js/app.js         DOM wiring only (no logic)
```

## The prompt is a fold too

State is never stored — and neither is the prompt. Instead of growing the
context with every turn, each turn recomputes it from the log (`js/fold.js`),
the same move `store.js` makes for document state. Mirrors eoreader4.2's
session-register fold (`turn/converse/history.js`): recent turns **verbatim** +
a **surfed recap** of the older ones. Because intake is a far more *structured*
conversation, the two registers specialize:

- **Document register** — the confirmed answers, folded to a compact `ANSWERED
  SO FAR` block. The "lot of information" reduced to minimal structure, so the
  model reads what's settled instead of re-deriving it from raw transcript (and
  never re-asks it).
- **Session register** — only the **current field's** turns, verbatim within a
  token budget. A long support detour beyond the budget condenses to a one-line
  recap rather than being dropped. Cross-field chatter isn't recapped in prose:
  the only thing an earlier field "moved" is its answer, and that already lives
  in the document register.

The prompt therefore stays as small as the current question, however long the
session ran.

## The model contract

Even a 3B local model stays on the rails because every turn returns one JSON
envelope, parsed leniently (prose/fences tolerated, falls back to treating a
valid raw answer as the value):

```json
{ "reply": "…", "support": false, "ready": true, "extracted": "clean value" }
```

`support` = this turn is help, not an answer. `ready` + `extracted` = a clean
value awaiting the person's confirmation. On "yes" → one `DEF` is appended.

## Wiring into your stack

- **Reuse your real Matrix layer.** `MatrixStore` wraps `matrix-js-sdk`
  directly. To use amino's foundation instead, replace its body with
  `MatrixLive.emit(room, OP.DEF, payload)` and `MatrixEngine.fold` — the
  controller doesn't care. Events are tagged `io.matrix-events.op` so they fold
  alongside amino data in the same room.
- **Reuse your real model.** Point `WebLLMModel` at your `model/webllm` backend,
  or delete it and pass eoreader4.2's `runTurn` as the `model` object (anything
  with a `chat(messages)` method works).
- **E2EE.** `MatrixStore.login` uses password login; enable the SDK's crypto
  (`initCrypto`) for the encrypted-room path amino assumes.

## Tests

Core logic (fold, validation, the full confirm-and-store loop, resumability,
the support path) has a Node smoke test — see the `smoke.mjs` block in the
build notes; it runs with plain `node` and no browser.
