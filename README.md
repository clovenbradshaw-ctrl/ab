# Resolve — guided intake over an event log

A chatbot that walks someone through a document one field at a time, gives
support when they're stuck, and logs every confirmed answer to a Matrix room as
one timestamped, append-only entry. The bundled document — a telecom
**customer-service complaint** — is only a *sample*; swap `js/schema.js` to fill
anything else. Built on patterns from the sibling repos:

- **Storage = amino.** A room is a table, events are rows, `fold(timeline)` is
  the query. Each confirmed answer is one `DEF` operator (`anchor`, `path`,
  `value`). State is never stored — the checklist is recomputed from the log,
  so the flow is resumable by construction.
- **Model = eoreader4.2.** One membrane, swappable backends (`webllm` /
  `ollama` / a guided `echo`), a small turn loop (`turn/converse`, cut down), and
  the **session-register fold** for the prompt (`turn/converse/history.js`).
- **Accounts = NPJ.** `js/auth.js` is ported from NPJ's `matrix-auth.js`:
  dependency-free, raw client-server API, real verified identity.

## Run

```
python3 -m http.server 8000    # then open http://localhost:8000
```

Opens straight into the **guided + on-device** path — no model download, no
account, answers persist to `localStorage`. Walk the whole intake immediately.
The assistant dropdown swaps in real models; the **Account** button turns the
on-device draft into a real, synced case (below).

## Accounts, per-user rooms, and admin access

The tenancy model, enforced by Matrix ACLs rather than by app code:

- **Fast account generation.** *Account → Create my case* mints a brand-new,
  **anonymous** account on the site homeserver — a CSPRNG localpart
  (`guest-xxxxx`, alphabet with no vowels or look-alikes) and a random password,
  registered and signed in in one round trip (`Auth.signUp`). No email, no
  chosen name. The user can download those credentials to return on any device.
- **A room per user.** Each new user gets their **own private room**
  (`Auth.createRoom`); their intake `DEF`s are logged there and nowhere else.
- **Admin invited to every room.** On room creation the configured `ADMIN_MXID`
  is auto-invited, so the admin is a member of every case room and the
  homeserver lets them read it. That membership *is* the access grant — nothing
  app-side decides it. The admin signs in with real credentials (`Auth.login`;
  `admin` unlocks only when `whoami` returns `ADMIN_MXID`) and gets a folded list
  of every case (`Auth.listAppRooms` → `roomEvents` → `fold`).

Configure the homeserver + admin in `js/auth.js` (`CONFIG`), or at runtime with
`Auth.configure({ homeserver, adminMxid })`.

## Backends (assistant dropdown)

`Echo` (deterministic, no setup) · `WebLLM` (in-browser, WebGPU) · `Ollama`
(local daemon). Backend-agnostic: the controller only calls
`model.chat(messages)` and `store.emit(op, payload)`, so either axis swaps
without touching the loop.

## Files

```
index.html        the Resolve shell + design tokens (the case ledger is the signature)
js/schema.js      the document — an ordered field set (the telecom complaint is a SAMPLE; swap it)
js/knowledge.js   the reference log — INS-shaped items folded per field on demand
js/context.js     the prompt fold: assemble the model input as a projection of the logs
js/store.js       DemoStore + a raw-CS-API MatrixStore behind one interface; OP.DEF/INS/CON + fold()
js/auth.js        Matrix accounts (ported from NPJ): signUp / login / createRoom / invite / admin view
js/model.js       WebLLM / Ollama / Echo backends + shared validate()
js/intake.js      the turn loop: fold -> next question -> support/answer -> confirm -> emit
js/app.js         DOM wiring only (no logic)
```

## The prompt is a projection too

State is never stored — and neither is the prompt. Each turn's messages are
*folded* from the logs by `js/context.js`, the same move `store.js` makes for
document state. Two things get folded in:

- **Knowledge** (`js/knowledge.js`) — the "lot of information" that would
  normally be stuffed into the prompt lives as `INS`-shaped events and is folded
  on demand to the slice a field needs (eoreader4.2's surfer/retrieve seam: a
  scored, size-budgeted picker). The UI shows the same slice — the "Good to
  know" note on a help turn and the "🔎 N help notes" lens both render straight
  off `assemble`'s returned `reference`.
- **Discourse** — every confirmed answer is a stored `DEF`, so the turns that
  produced it are redundant with `fold(timeline)`. Resolved turns are **dropped**
  and re-represented as a compact answer digest (`Already recorded — do not
  re-ask`); only the **live** window rides verbatim — the turns since the last
  store, tagged by epoch so the boundary is order-based and collision-proof.

The prompt stays roughly constant in size no matter how long the session runs.
`context.assemble` also returns `stats` (items folded in, turns kept vs. dropped,
prompt chars) — context is provenance too.

## The model contract

Even a 3B local model stays on the rails because every turn returns one JSON
envelope, parsed leniently (prose/fences tolerated, falls back to treating a
valid raw answer as the value):

```json
{ "reply": "…", "support": false, "ready": true, "extracted": "clean value" }
```

`support` = this turn is help, not an answer (the UI shows the "Good to know"
reference under it). `ready` + `extracted` = a clean value awaiting confirmation;
the inline confirm card's **Yes** appends one `DEF`.

## Notes for wiring into a real deployment

- **Homeserver.** `signUp` needs open registration (`m.login.dummy`) or a
  registration token; `auth.js` detects CAPTCHA / email / token flows and returns
  a plain-language reason when the browser can't complete them.
- **Events** are tagged `io.matrix-events.op`, so they fold alongside amino data
  in the same room. `MatrixStore` reads them over `/messages` and writes over
  `/send`; no SDK, no CDN.
- **E2EE.** The current `MatrixStore` sends cleartext state to a private room.
  For the encrypted-room path, layer NPJ's `app/identity/e2ee.js` group sessions
  over the same send/read seam.

## Tests

Core logic has a Node smoke test (`node` alone, no browser): the telecom schema
+ knowledge scoping, the auth pure functions (`hashid` / `randomLocalpart` /
`randomPassword` / `parseMxid` / `caseRef`), the folded reference, the full
confirm-and-store loop with the guided assistant, resumability, the support
path, and a `MatrixStore` round-trip against a faked account session. The
guided + on-device UI path (confirm card, "Good to know", lens, ledger, account
sheet) is verified end-to-end in a headless browser.
