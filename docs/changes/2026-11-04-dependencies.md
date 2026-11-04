# Dependency upgrade audit — 2026-11-04

Checked every direct/development dependency in every workspace against the official npm registry `latest` tag. No prerelease tag was selected. Internal `workspace:*` dependencies and the vendored engine WASM remain local contracts.

Bun: **1.4.4**, verified against [the official stable release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4). The system Bun installation was not changed.

| Workspace | Dependency | Before | Candidate | Registry latest |
| --- | --- | --- | --- | --- |
| packages/@starlab/types/package.json | [typescript](https://registry.npmjs.org/typescript) | `^7.0.2` | `^7.0.2` | `7.0.2` |
| apps/extension/package.json | [@ledgerhq/hw-app-eth](https://registry.npmjs.org/@ledgerhq/hw-app-eth) | `7.8.19` | `7.12.0` | `7.12.0` |
| apps/extension/package.json | [@ledgerhq/hw-app-solana](https://registry.npmjs.org/@ledgerhq/hw-app-solana) | `7.11.0` | `7.13.0` | `7.13.0` |
| apps/extension/package.json | [@ledgerhq/hw-transport](https://registry.npmjs.org/@ledgerhq/hw-transport) | `6.36.0` | `6.36.1` | `6.36.1` |
| apps/extension/package.json | [@ledgerhq/hw-transport-webhid](https://registry.npmjs.org/@ledgerhq/hw-transport-webhid) | `6.36.0` | `6.36.0` | `6.36.0` |
| apps/extension/package.json | [@solana/web3.js](https://registry.npmjs.org/@solana/web3.js) | `1.99.0` | `3.1.1` | `3.1.1` |
| apps/extension/package.json | [@tailwindcss/vite](https://registry.npmjs.org/@tailwindcss/vite) | `^4.3.3` | `^4.3.4` | `4.3.4` |
| apps/extension/package.json | [buffer](https://registry.npmjs.org/buffer) | `6.0.3` | `6.0.3` | `6.0.3` |
| apps/extension/package.json | [bs58](https://registry.npmjs.org/bs58) | `6.0.0` | `6.0.0` | `6.0.0` |
| apps/extension/package.json | [qrcode](https://registry.npmjs.org/qrcode) | `1.5.4` | `1.5.4` | `1.5.4` |
| apps/extension/package.json | [tailwindcss](https://registry.npmjs.org/tailwindcss) | `^4.3.3` | `^4.3.4` | `4.3.4` |
| apps/extension/package.json | [uuid](https://registry.npmjs.org/uuid) | `^14.0.2` | `^14.0.3` | `14.0.3` |
| apps/extension/package.json | [viem](https://registry.npmjs.org/viem) | `^2.56.9` | `^2.57.16` | `2.57.16` |
| apps/extension/package.json | [vite-plugin-wasm](https://registry.npmjs.org/vite-plugin-wasm) | `^3.6.0` | `^3.6.0` | `3.6.0` |
| apps/extension/package.json | [@playwright/test](https://registry.npmjs.org/@playwright/test) | `^1.63.0` | `^1.64.1` | `1.64.1` |
| apps/extension/package.json | [@tsconfig/svelte](https://registry.npmjs.org/@tsconfig/svelte) | `^5.0.8` | `^5.0.8` | `5.0.8` |
| apps/extension/package.json | [@types/bun](https://registry.npmjs.org/@types/bun) | `^1.4.2` | `^1.4.4` | `1.4.4` |
| apps/extension/package.json | [@types/chrome](https://registry.npmjs.org/@types/chrome) | `^0.3.0` | `^0.3.7` | `0.3.7` |
| apps/extension/package.json | [@types/node](https://registry.npmjs.org/@types/node) | `^26.6.3` | `^26.6.6` | `26.6.6` |
| apps/extension/package.json | [@types/qrcode](https://registry.npmjs.org/@types/qrcode) | `1.5.6` | `1.5.6` | `1.5.6` |
| apps/extension/package.json | [@types/uuid](https://registry.npmjs.org/@types/uuid) | `^11.0.0` | `removed` | `11.0.0` |
| apps/extension/package.json | [@typescript/native](https://registry.npmjs.org/typescript) | `npm:typescript@^7.0.2` | `npm:typescript@^7.0.2` | `7.0.2` |
| apps/extension/package.json | [@wxt-dev/module-svelte](https://registry.npmjs.org/@wxt-dev/module-svelte) | `^2.0.5` | `^2.0.5` | `2.0.5` |
| apps/extension/package.json | [svelte](https://registry.npmjs.org/svelte) | `^5.57.1` | `^5.57.3` | `5.57.3` |
| apps/extension/package.json | [svelte-check](https://registry.npmjs.org/svelte-check) | `^4.7.6` | `^4.7.8` | `4.7.8` |
| apps/extension/package.json | [tslib](https://registry.npmjs.org/tslib) | `^2.8.1` | `^2.9.1` | `2.9.1` |
| apps/extension/package.json | [typescript](https://registry.npmjs.org/typescript) | `~6.0.3` | `~6.0.3` | `7.0.2` |
| apps/extension/package.json | [wxt](https://registry.npmjs.org/wxt) | `^0.21.4` | `^0.21.5` | `0.21.5` |

## Compatibility and deprecated packages

- `typescript` in the extension stays at the latest 6.x, **6.0.3**. Latest `svelte-check` 4.7.8 rejects a TypeScript 7 default package and explicitly requires TypeScript 6 alongside the TypeScript 7 native alias. The actual `--tsgo` checker and shared-types compiler use **7.0.2**. Upgrading the default package to 7.0.2 was attempted and failed its version gate; no checker was bypassed.
- `@types/uuid` was removed: its official metadata marks it as a deprecated stub and `uuid` includes its own declarations.
- `@ledgerhq/hw-transport-webhid` **6.36.0** is the latest published stable version, but its maintainer marks it deprecated in favor of `@ledgerhq/device-transport-kit-web-hid`. That package belongs to the newer device SDK and is not a drop-in legacy `Transport` for the existing Ledger app clients. This change upgrades the existing app/transport packages without introducing a separate device-SDK migration. No physical Ledger device was available for verification.
- Solana web3.js **3.1.1** preserves the class API but makes key generation and PDA derivation asynchronous. Call sites and existing tests were migrated; Solana tests use real WebCrypto because v3 no longer tolerates the preload’s empty crypto stubs. A new real background transaction regression independently verifies the resulting Ed25519 signature; the expected canonical metadata PDA and transaction bridge assertions are preserved.
- The shared-types package now declares its actual ESM output through `type: module`.

## Audit limitations

Latest `deepmerge` **4.3.1** and `elliptic` **6.6.1** still have registry advisories and no newer stable fixed release. They are upstream dependencies of the Svelte Vite plugin and Ledger Ethereum client respectively. They have not been hidden with incompatible overrides. Final `bun audit --json` reports only these two low-severity package advisories (exit 1); the prior high-severity `follow-redirects`, `source-map-js`, and Vite findings were removed by a compatible lockfile refresh to 1.16.2, 1.2.2, and 8.3.5.

## Validation

- Bun 1.4.4: **948 tests passed, 0 failed**, 2585 assertions across 109 files (265.65 s). All prior 947 tests remain; one background transaction regression was added.
- Svelte check: **0 errors, 0 warnings**. Frozen installation made no lockfile changes.
- Actual updated Nix shell: **Bun 1.4.4 / Node 26.13.0**; check, production build and ZIP all passed.
- Actual Chromium production provider regression: **1 passed** (3.7 s). Initialization/discovery happens once; account discovery is read-only.
- Eight public-fixture screenshots cover light/dark popup and wide Home/Settings; all have zero page errors. Representative full images were inspected; compact layout and glass materials remain intact. These are fixture renders, not chain transaction proof.
- Production manifest has exactly one content script; neither the insecure-primes hook nor a popup import in the offscreen chunk is present.
- Production Chrome ZIP SHA256: `cd9b411a2feb07c788deea0fa19dc401a0075feb7e2f9cbbd32dbb1a46d32582`.
- Full cross-curve native/browser interop and physical Ledger signing have **not** been rerun for this candidate. They remain final integration gates; no fixture result substitutes for them.

The detailed raw logs and per-image/build SHA256 records are retained with the review artifacts. Historical gallery screenshots are not claimed to represent this upgrade.
