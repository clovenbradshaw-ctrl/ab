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
