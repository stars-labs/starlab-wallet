# Glass, light and interaction refinement

User direction: a more modern, premium interface with transparent frosted
glass, light/shadow and responsive UI interaction. Extend the accepted
Rabby/MetaMask/Phantom hierarchy and Starlab violet palette across the
extension and desktop.

## Visible result

- Soft ambient violet/cool light provides depth behind translucent layers.
- Cards, menus and approval surfaces have restrained edge highlights;
  browser layers also use diffused shadows. High-value balances, addresses, fees and warnings remain
  clear in light and dark extension themes.
- Main actions respond to pointer hover, press and keyboard focus. Popovers
  and modals settle quickly without changing document flow or moving text.
- Decorative layers do not capture pointer input or obscure approvals.
- Reduced-motion preferences suppress decorative movement and transitions;
  lack of browser backdrop-filter retains a readable surface.
- The desktop uses native translucent gradients, soft ambient artwork and
  edge lighting. Iced does not expose CSS backdrop-filter; desktop acceptance is
  its native visual treatment, not a claim of dynamic background blur.

## Scope and verification

Presentation only: existing functions, business state, cryptography and
engine dependency pins remain unchanged. Keep one shared style system per
client, without a new renderer, shader pipeline or continuously running
animation timer.

Capture production extension home, Send review, settings and modal in both
light and dark, plus hover/pressed/focus and reduced-motion evidence. Check
380px popup and wide-tab layouts for clipping, readable amounts/addresses,
visible warnings and unchanged action destinations. Run Svelte check and
production build, including absence of insecure fixture-prime hooks.

Capture desktop normal and narrow states using the existing native snapshot
harness. Inspect wallet, approval, setup, backup and navigation interaction
styles; run formatting, locked Clippy/check and existing relevant UI tests.
Preserve prior functional and live-chain evidence separately from this
presentation acceptance.

Native runtime Shadow was removed after an actual software-rendered hover/focus
check revealed rectangular repaint trails. The same defect could affect automatic
renderer fallback, so the solution uses no environment-dependent compatibility
branch. Native ambient light, translucent gradients and illuminated borders
preserve depth while remaining safe under partial redraw.

## Verified acceptance

Extension source: `b59bcee`, with pressed-state correction `b2507f2`.
Svelte reports zero errors/warnings; the final isolated production build
passes and contains no fixed-prime injection hook.

[Final capture index](evidence/glass-extension-2026-10-04.json): 230 unique
captures, zero action/page errors, all prior 206 scenario names plus 24
premium cases. Light/dark and 380px/1280px views cover home, Send review,
settings, modal, hover, press, focus and reduced motion. A true press asserts
active state, scale 0.985 and downward 1px; hover moves upward 1px. Reduced
motion asserts animation none and transition 0s.

The designer inspected all ten contact sheets and full critical screens.
Ordinary cards have computed backdrop-filter none; header and hero use real
blur. The unsupported-backdrop fallback was reviewed in CSS, not executed
in an unsupported browser. [Verification record](evidence/glass-verification-2026-10-04.json)
records source hashes and logs.

226 rows retain source b59bcee; four pressed/reduced-motion rows were
recaptured from b2507f2. Interrupted screenshot runs were resumed without
dropping cases. Recovered metadata is explicitly flagged and follows the
declared fixture modes plus retained successful logs/PNGs; this evidence
does not claim one uninterrupted green process.

Root independently inspected light home/Send/modal and dark/wide home/Send.
A real saved-wallet production view also shows the same MPC address, actual
balance and confirmed activity (`/tmp/starlab-stage5/shots/39-glass-production-live.png`).
That base-glass view predates only the pressed-feedback fix and does not
claim a newly signed transaction. Final source production bundle:
`/tmp/starlab-glass-interaction-build/chrome-mv3`.

Desktop source 9bbb52d passes 49 tests, strict Clippy, formatting and release.
All 58 final native screenshots across 29 states pass; actual hover, press,
keyboard focus, repeated navigation and resize remain free of redraw trails.
Native evidence is committed in starlab-desktop `docs/design/glass-and-light.md`.

## Compact layout follow-up

Reduce popup gutters from 16 to 12px, card padding from 16 to 12px,
section gaps from 16 to 10px, and asset-row vertical padding from 12 to 8px.
Combine address/copy in one row and use horizontal wallet tool cards. Keep
font sizes and 44px Send/Receive targets. Remove forced minimum page height.
Wide pages use a content-sized 900px shell, parallel assets/activity columns,
and two-column settings and Send fields. Activity and collectibles form one
vertical stack with a measured 12px gap.

Final source `7835150`: Svelte reports zero errors/warnings and the production
build passes. [Acceptance](evidence/density-2026-10-04.json) records all 16
representative light/dark popup/wide states and 32 image hashes. Every state
has a full-page and actual 600px viewport image, with zero action/page errors
and no horizontal overflow. Root independently reviewed the final narrow
home, wide dark home and unlock modal; Send review and populated Settings
were also inspected. Popup fixture home shrinks from approximately 1636px
to 1353px while preserving text sizes and materials. This is presentation
fixture evidence, not a new live transaction or complete 230-case rerun.

## Product closeout verification

The compact presentation is retained in the final product review.
[Capture and packaging evidence](evidence/product-closeout-2026-10-05.json)
records 242 unique fixture states, zero page/action errors and zero horizontal
overflow. Coverage includes narrow/wide layouts, light/dark themes, long asset
names and balances, keyboard focus, modal focus return and reduced motion.
The designer reviewed all twelve contact sheets and critical full screens.

This is a collection across three declared presentation versions, not one
uninterrupted or single-bundle run: 224 captures use cd32ef1, fourteen affected
modal/locale captures use a0aa53f, and four NFT captures use a4b8ee3. Each row
records its screenshot hash and bundle provenance. Production packaging and
a real Chromium provider initialization check are recorded separately.

Normal root build and extension ZIP build pass, with zero Svelte errors or
warnings. The final manifest registers one content script, and the real
provider test passes with one initial EIP-6963 announcement. The production
ZIP SHA-256 is
`5063189fe454b04824d7ff837ba7403dc05da545e9345f650050d61618fe67d1`.
Firefox builds, but Firefox cryptographic runtime and physical hardware-card
signing remain unverified. Remote CI status must be checked against the
current PR head separately from these local results.
