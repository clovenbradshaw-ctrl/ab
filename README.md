# Intake — guided document-filling over an event log

A chatbot that walks someone through a document one field at a time, gives
support when they're stuck, and stores every confirmed answer to a Matrix room.
An **admin surface** authors the questions — what's asked, in what order, and
the material used to help the user — as a shared configuration everyone reads.
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

The **Admin** button (top-right, or open `admin.html`) is where you author the
questions: add/reorder/edit them, write the help each one shows, and edit the
assistant's instructions and memory. Everything you do there is walkable with
zero setup too.

## Two rooms: shared questions, private answers

The questions live apart from the answers, on purpose.

- **Shared config room** (`!intake-config:local` in demo) — the questions, their
  order, the assistant's instructions, and the memory notes used to help the
  user. *Every* user reads it; nothing in it is specific to any one person. The
  admin surface writes it. It's an event log like everything else, so the live
  question set is `foldConfig(timeline)` — recomputed, never stored — and an
  admin edit reaches every user the next time they fold, with full provenance.
- **Per-user answers room** (`!intake-answers-<user>:local` in demo) — one per
  person. Everything they confirm and everything they type lands here and
  nowhere else, so one person's content is never visible in another's timeline.
  This is the safety/privacy boundary.

The intake app reads the shared room to learn *what* to ask and writes only the
signed-in user's room with *their* answers. Because a small local model has a
limited context window, the fold matters here: the per-field help and memory
come from the shared room folded to just this field's slice, and the answer
digest comes from the user's room — so the prompt only ever carries what's
salient for the question in front of the user, no matter how big either room
grows.

## The two forks you chose

| | Options (top-right dropdowns) |
|---|---|
| **Model** | `Echo` (deterministic, no setup) · `WebLLM` (in-browser, WebGPU) · `Ollama` (local daemon) |
| **Store** | `Demo` (this device) · `Matrix` (sign in — homeserver + user + password) |

Backend-agnostic: the controller only calls `model.chat(messages)` and
`store.emit(op, payload)`, so either axis swaps without touching the loop.

## Files

```
index.html        intake shell + design tokens (the provenance ledger is the signature)
admin.html        the admin surface — author questions/order/help + instructions/memory
js/config.js      the shared config room: config events + foldConfig() + seeding; room ids
js/schema.js      the seed document — the ordered field set a fresh config room starts from
js/store.js       DemoStore + MatrixStore behind one interface; OP.DEF/INS/CON + fold()
js/model.js       WebLLM / Ollama / Echo backends + shared validate()
js/knowledge.js   the reference log — INS-shaped items folded per field on demand
js/context.js     the prompt fold: assemble the model input as a projection of the logs
js/intake.js      the turn loop: fold -> next question -> support/answer -> confirm -> emit
js/app.js         intake DOM wiring — folds the shared room, writes the user's room
js/admin.js       admin DOM wiring — edits the shared config room, one event per change
test/             Node smoke tests (config fold + the two-room flow end to end)
```

## The prompt is a projection too

State is never stored — and neither is the prompt. Instead of a fixed system
prompt plus the whole transcript, each turn's messages are *folded* from the
logs by `js/context.js`, the same move `store.js` makes for document state. Two
things get folded in:

- **Knowledge** (`js/knowledge.js`) — the "lot of information" that would
  normally be stuffed into the prompt lives as `INS`-shaped events and is folded
  on demand to the slice a field needs. This is eoreader4.2's surfer/retrieve
  seam: a scorer picks the items scoped or relevant to the current field,
  budgeted by size, so the prompt carries minimal structure and the system
  supplies the rest per turn. Swap `retrieve` for a real retriever and nothing
  else changes.
- **Discourse** — every confirmed answer is a stored `DEF`, so the turns that
  produced it are redundant with `fold(timeline)`. Resolved turns aren't
  summarized, they're **dropped** and re-represented as a compact answer digest
  (`Already recorded — do not re-ask`). Only the **live** window rides
  verbatim — the turns since the last store, tagged by epoch so the boundary is
  order-based and collision-proof.

The prompt therefore stays roughly constant in size no matter how long the
session runs. `context.assemble` also returns `stats` (items folded in, turns
kept vs. dropped, prompt chars) — context is provenance too.

### See it, and edit what you own

Because the prompt is *computed*, it can be shown. The **Context** button
(top-right) opens an inspector that renders the live fold for the current
field — the system instructions, the field descriptor, the **memory** slice
retrieved for this field, the answer digest, and the live conversation window —
alongside the same `stats`. `assemble` returns these as labeled `parts`, so the
view is the projection itself, not a reconstruction.

Two of those parts are yours to edit, and the change lands in the very next
fold:

- **System prompt** — the fixed instructions (`MINIMAL_SYSTEM`) folded in ahead
  of everything else. Editable, with reset-to-default.
- **Memory** (`js/knowledge.js`) — add, edit, delete, and re-scope reference
  items. Pin an item to a field `path` so it always folds in for that field, or
  leave scope blank and let the keyword scorer decide. Only items scoped or
  relevant to the current field ever reach the prompt.

Edits are config, not answers, so they live outside the event log — mirrored to
`localStorage` per room and reloaded on boot. Clearing the timeline (Reset)
leaves them intact.

## The model contract

Even a small local model stays on the rails because every turn returns one JSON
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

Core logic has Node smoke tests that run with plain `node` and no browser:

```
node test/config.smoke.mjs        # the shared config fold: define/edit/reorder/delete questions,
                                   # system prompt + memory, seeding idempotence
node test/integration.smoke.mjs   # the two-room flow end to end: an admin authors the shared
                                   # room, the intake folds it, a user answers into their OWN
                                   # room — asserting no answer ever leaks into the shared room,
                                   # and that a fresh controller resumes purely from fold()
```
