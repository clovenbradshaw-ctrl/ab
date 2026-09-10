# matrix-sdk-bundle.js

A self-hosted, browser-ready build of `matrix-js-sdk`, including the Rust
crypto (`@matrix-org/matrix-sdk-crypto-wasm`) backend needed for real
end-to-end encryption.

## Why this exists

`matrix-js-sdk` does not publish a browser global/UMD build — its `dist/`
folder doesn't exist on npm at all. There is no `unpkg`/`jsdelivr` field in
its `package.json`. Any `<script src="https://unpkg.com/matrix-js-sdk/.../dist/browser-matrix.min.js">`
tag 404s, silently leaving `window.matrixcs` undefined. This bundle is built
from the real npm package so the app has a working SDK in the browser
without a build step at deploy time.

## Rebuilding / upgrading

```sh
mkdir /tmp/sdkbuild && cd /tmp/sdkbuild
npm init -y
npm install matrix-js-sdk@<version> esbuild
cat > entry.js <<'EOF'
import * as sdk from "matrix-js-sdk";
window.matrixcs = sdk;
EOF
npx esbuild entry.js --bundle --minify --format=iife --platform=browser \
  --target=es2020 --define:global=globalThis \
  --outfile=matrix-sdk-bundle.js
cp matrix-sdk-bundle.js /path/to/ab/vendor/matrix-sdk-bundle.js
```

The `--define:global=globalThis` is required — without it, calling
`client.createClient(...)` throws `global is not defined` in the browser.

The rust-crypto WASM binary ships base64-inlined inside
`@matrix-org/matrix-sdk-crypto-wasm`'s `pkg/matrix_sdk_crypto_wasm_bg.wasm.js`,
so no separate `.wasm` asset or loader plugin is needed — it bundles as
plain JS and decodes/instantiates itself at runtime.

Verified working (in a real browser, not jsdom): `window.matrixcs.createClient(...)`
returns a client whose `.initRustCrypto()` resolves successfully and whose
`.getCrypto()` returns a live crypto API object.

## Local patch — reapply after every rebuild

The SDK's `encodeBase64` falls back to `btoa` in the browser only for a
`Uint8Array`, but secret storage hands it the `ArrayBuffer`s that WebCrypto
returns. Without Node's `Buffer` that throws `No base64 impl found!`, and
secret storage (so the office's password-unlocked history backup) can't store
anything. The bundled copy is patched to wrap any buffer or view first:

```js
// before
if(typeof btoa=="function"&&Q instanceof Uint8Array)return btoa(Q.reduce((A,g)=>A+String.fromCharCode(g),""));
// after
if(typeof btoa=="function"){var U=Q instanceof Uint8Array?Q:ArrayBuffer.isView(Q)?new Uint8Array(Q.buffer,Q.byteOffset,Q.byteLength):new Uint8Array(Q);return btoa(U.reduce((A,g)=>A+String.fromCharCode(g),""))}
```

Find it by the `No base64 impl found!` string (the encoder is the first of the
two). A rebuilt bundle whose SDK already accepts `ArrayBuffer` there doesn't
need it.

Second patch, same reason: the Rust crypto backend's
`getSessionBackupPrivateKey()` calls `Buffer.from(…, "base64")` with no
fallback, which is on the path every history restore takes.

```js
// before
g.decryptionKey?Buffer.from(g.decryptionKey.toBase64(),"base64"):null
// after
g.decryptionKey?Uint8Array.from(atob(g.decryptionKey.toBase64()),function(x){return x.charCodeAt(0)}):null
```

The other `Buffer` uses in the bundle belong to the legacy (non-Rust) crypto
stack, device dehydration, QR verification and recovery-key formatting, none
of which this app calls — which is also why `crypto.createRecoveryKeyFromPassphrase`
isn't used.
