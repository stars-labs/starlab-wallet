# Wallet visual fixtures

`capture-wallet.mjs` renders the real production popup bundle with public Chrome API fixtures. It exercises home, onboarding, wallet and account pickers, hardware/watch-only account contexts, send/receive, signing, dApp permissions, setup progress, save, settings and custom networks in light and dark themes. Settings captures include contacts, spending policy, encrypted backup, devices, token management, approvals, sandbox and network controls.

Build the extension into an isolated directory before running, leaving the interop bundle untouched. Set `WALLET_VISUAL_BUILD` to its `chrome-mv3` directory, `WALLET_VISUAL_OUTPUT` to a screenshot directory, and `PLAYWRIGHT_CHROME_PATH` to the installed Chromium executable. Run `node tests/visual/capture-wallet.mjs` from this package.

The manifest marks every screenshot as a fixture and records page exceptions. External HTTP requests are blocked; the fee review uses synthetic JSON-RPC responses. No key shares, real RPCs or real transactions occur. This checks visual presentation and render stability, not protocol correctness or live financial balances. Real signing and broadcast gates remain separate.

Review against `docs/design/wallet-visual-acceptance.md`. Missing states (for example populated external NFT artwork and completed chain receipts) need additional live or component evidence before claiming complete visual coverage.
