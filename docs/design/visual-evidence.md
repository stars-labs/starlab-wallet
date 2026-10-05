# Visual evidence and remaining runtime coverage

The stable extension capture directory is `/tmp/starlab-extension-design-acceptance`, produced from the isolated production bundle `/tmp/starlab-design-build/chrome-mv3`. Every manifest entry is explicitly `fixture: true`; public Chrome API and JSON-RPC responses exercise the production presentation without secrets or broadcasts. Light and dark variants use the same names with `-light.png` / `-dark.png`. Settings cards are captured individually, not merely as a collapsed Settings landing page.

| Acceptance row | Extension image prefixes | Evidence and scope |
|---|---|---|
| App shell/home | home-funded, home-zero, home-offline, home-tab | 380px popup / 1280px tab; desktop normal/narrow |
| Wallet selection | wallet-picker, home-onboarding | wallet-multiple and wallet-switched exercise the real picker and selected wallet identity; wallet-add-navigation and wallet-settings-navigation verify existing destinations |
| Account switch/add | account-picker, account-options, home-hardware, home-watch-only | hardware-discovery-error returns actual YubiKey RPC failure; inline error and retry entry remain visible |
| Portfolio/assets | home-funded, home-zero, home-loading, home-error | Canonical USDC/USDT/DAI and missing-contract/custom USDC neutral fallback shown |
| Send | send, send-validation, send-review, send-submitted, send-rejected | Valid fee review uses synthetic raw RPC; real broadcast/receipt remains separate gate |
| Receive | receive, receive-bitcoin, receive-solana, receive-sui, receive-qr-error | Four native chain QR presentation; oversized public fixture exercises actual QR generation error |
| Activity | home-funded, home-zero | Confirmed/pending/failed rows plus activity-loading and activity-error |
| Collectibles | collectibles, home-funded | Artwork, broken image and no-image fallback; nft-loading and nft-error capture actual fetch states |
| Onboarding/unlock | home-onboarding, home-locked, unlock | password-error and password-busy exercise real modal; wrong-password retry remains available |
| Create wallet | create, home-setup-waiting | create-error shows actual backend failure guidance |
| Join/invitations | home-invite, home-setup-waiting | invite-declined verifies removal through the real Decline button; expired is N/A, source explained below |
| DKG/setup progress | home-setup-waiting, home-setup-primes, home-setup-keygen, home-save-wallet | dkg-failed exercises the existing Failed phase and failure guidance without falsely showing generating/ready |
| Save encrypted wallet | home-save-wallet | save-validation shows mismatched passwords; persisted wallet and real signing remain independent functional evidence |
| Sign message | sign, home-signing-progress | sign-validation, sign-preview, sign-completed capture production states; synthetic completion does not claim verified cryptography |
| Threshold co-sign approval | home-cosign-request, home-signing-progress | Desktop password/working/declined states captured; send-rejected also shows co-signer refusal |
| dApp connection | home-dapp-connect, settings-section-connected-dapps | Presentation request; not an external dApp interoperability test |
| dApp signature/transaction | home-dapp-sign | dapp-unknown, dapp-busy, dapp-error and dapp-rejected-dismissed; message-only component has no transaction-preflight surface, so preflight warning is not applicable |
| Backup/restore | settings-section-backup, backup-validation, backup-export, restore-ready, restore-error, restore-success | Restore UI success is fixture; backend import/reload/sign tests are separate |
| Device replacement/refresh | settings-section-manage-wallet-devices, devices-replacement | Ethereum retirement limitation remains visible; refresh-waiting, refresh-round1, refresh-round2, refresh-failed, refresh-complete, refresh-save-failed render existing FROST-only state branches |
| Connected apps | settings-section-connected-dapps, settings | connected-app-disconnected invokes actual permission-service removal and asserts the empty state and no remaining Disconnect action |
| Contacts/address book | settings-section-address-book | contacts-invalid and contacts-updated; existing address book updates via Add at the same address, no separate Edit feature |
| Token management | settings-section-tokens | token-invalid and token-loading show actual existing import/discovery states |
| Token approvals | settings-section-token-approvals | allowance-unlimited, allowance-busy and allowance-error; real on-chain revocation remains separate |
| Spending policy | settings-section-spending-policy, policy-saved | Policy save feedback fixture; enforcement tests remain functional |
| Sandbox | settings-section-sandbox-mode, home-watch-only | Mode setting presentation; simulation execution is not claimed |
| Network/room/custom RPC | settings-section-network, settings-section-signal-server-room, custom-network, home-offline | Editable network form and offline connection; custom-rpc-invalid shows real http/https validation; localhost HTTP remains allowed |
| Errors/toasts/status | home-error, send-validation, send-rejected, backup-validation, restore-error, restore-success, policy-saved | Recoverable visible states use text, not color alone |

The matrix accounts for all 27 implemented feature surfaces. Required edge states have supplemental production-component captures. Screenshot fixtures do not replace cryptographic and network validation. Additional runtime transitions in the original matrix (for example physical hardware interoperability) are not claims of functionality completion.

Designer inspected full-resolution home, valid fee review, collectible artwork/fallback, recovery, settings sections, co-sign request and setup phases. Desktop first 56-state contact sheet was inspected; final narrow waiting/approval/key-generation pages were independently checked after designer findings were implemented. The header is sticky: full-page browser screenshots taken after a lower-page action can composite it at the current scroll offset; this is a capture artifact, not a second header in the DOM.

## Supplemental evidence

- `/tmp/starlab-extension-edge-settings/manifest.json`: 28 captures, zero action/page errors.
- `/tmp/starlab-extension-edge-approvals-final/manifest.json`: 20 captures, zero action/page errors.
- `/tmp/starlab-extension-send-reset/manifest.json` and `/tmp/starlab-extension-account-reset/manifest.json`: each one actual browser regression, zero errors. Prepare valid fee review, change the real network selector or AccountPicker to a different identity, require Confirm send to disappear. A supported network returns to Review transfer; unsupported Account 1 closes Send and disables its primary action.
- `/tmp/starlab-desktop-visual-final-shots/manifest.json`: 58 normal/narrow captures including actual DKG failure branch. All final contact-sheet states and critical full images independently reviewed. Actual release `/tmp/starlab-desktop-validation/live-shots/16-final-desktop-skia.png` also reviewed; CPU-only Xvfb uses TinySkia because its software GPU glyph renderer produces spacing artifacts.

Presentation source is frozen at extension commit `7e41efb`; shared assets and source were already packaged in earlier visual commits. Svelte check reports zero errors and zero warnings; isolated production build succeeds. The integrated acceptance manifest contains 198 unique images with zero action/page errors: 180 cases from source `7ca2ccd`, with two signing-roster and two Account 1 images replaced plus two explicit signing-session regression images from final source `07023d5`. Per-image `sourceRevision` records this provenance. Sixteen final matrix-gap cases were added and the original wallet-picker pair refreshed from source `7e41efb`. Outside the newly captured navigation and DKG-failure surfaces, other layouts are reused: the earlier source changes gate stale setup during signing, close unsupported Account 1 Send, and clarify an unknown-device hint. Guidance regression: 9 passing tests / 18 assertions.

Signing/account source browser regression manifest: `/tmp/starlab-extension-final-regressions/manifest.json`, six cases / zero errors. Production Svelte check: `/tmp/starlab-final-design-check.log`, zero errors / zero warnings; build: `/tmp/starlab-final-source-build.log`, success. Native primary Copy address contrast inspected after the legacy transparent override was removed.

## Closed final matrix gaps

`/tmp/starlab-extension-last-navigation/manifest.json`: 16 light/dark captures, zero errors. Multiple wallet list/switch, existing Add Wallet/create-form route, Wallet settings/device-backup route, actual hardware-discovery error, local invitation decline/dismissal, connected-app disconnection and DKG Failed presentation are exercised. Source `7e41efb` wires previously inert wallet-menu navigation to existing destinations and removes the misleading generating-keys placeholder from a Failed DKG. Original wallet-picker images are refreshed to the new footer label.

Expired invitation artwork is **not applicable to the current product**. `src/utils/wallet-id.ts:31` filters signing invitations and held completed-DKG wallet identities; it has no deadline/TTL/expiry predicate. `src/entrypoints/popup/signingInvite.ts:25` gates proposer, participants, local dismissal and busy/modal state, with no expiry input or renderer. App invitation cards therefore show eligible current invitations and remove locally declined ones; no independent expired state exists to capture. App's `expiresAt` fields only dismiss transient decline/error toasts and are not invitation expiration. The original acceptance matrix now states this N/A explicitly rather than promising nonexistent artwork.

Final navigation source validation: `/tmp/starlab-last-navigation-check.log` (zero errors/warnings), `/tmp/starlab-last-navigation-build.log` (successful isolated production build), `/tmp/starlab-extension-final-wallet-picker/manifest.json` (two refreshed picker captures, zero errors).

Shared Ethereum signature-result badge correction: the generic result now reads `Ethereum · threshold ECDSA`, covering personal-message, typed-data and transaction-prehash signatures without mislabeling all results EIP-191. The explicit EIP-191 message preview remains unchanged. `sign-completed-light` and `sign-completed-dark` were recaptured in `/tmp/starlab-signature-label-shots`, inspected and replaced in the 198-image acceptance manifest (zero capture errors). Their immutable source revision is `5648ee6`, with exact `sourceAppSha256`. Isolated build `/tmp/starlab-signature-label-build/chrome-mv3` passes; Svelte check has zero errors and warnings. No live production bundle was replaced.

Hero pricing correction (`e18da4c`): unavailable fiat renders a dash; the request identity includes chain/address/network and clears previous fiat before fetch. Held assets require finite fiat pricing; missing prices on zero balances do not invalidate a priced portfolio. All prices missing stays unavailable. Ten real-component fixture captures/assertions pass with zero errors: missing-price, network-reset, account-reset, stale old-network response and final signature result, each in light/dark. Artifacts `/tmp/starlab-hero-pricing-shots` and `/tmp/starlab-hero-pricing-stale-shots`; the acceptance manifest now contains 206 unique captures and records immutable source revisions. Svelte check has zero errors/warnings; isolated production build `/tmp/starlab-hero-pricing-build/chrome-mv3` succeeds. Previous captures are historical per-image evidence, not claims of unchanged pricing behavior.

## Glass and light refinement after the original acceptance

The user subsequently requested transparent glass, light/shadow and premium
interaction. The older per-image provenance above remains historical.
[New acceptance](glass-and-motion.md) recaptures every prior 206 scenario and
adds 24 material/interaction cases, for 230 unique zero-error captures.
It documents actual blur, ordinary-card compositing, meaningful press feedback,
reduced motion, source hashes and interrupted-run metadata recovery.
