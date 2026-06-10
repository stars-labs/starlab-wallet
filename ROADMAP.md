# Starlab Wallet — Roadmap

A multi-device **MPC (FROST) wallet**: one threshold key — split across your
devices, optionally with a hardware co-signer — controlling **Ethereum, Bitcoin,
Solana, and Sui** at once. No single device ever holds the whole key. Available
as a browser extension (this repo), a desktop app
([starlab-desktop](https://github.com/stars-labs/starlab-desktop)), and a
headless CLI ([starlab-mpc](https://github.com/stars-labs/starlab-mpc)).

> Status: **early-stage (0.1)** — works end-to-end, **not yet audited**. This
> roadmap is the path to a trustworthy daily driver. Dates are intentionally
> omitted; milestones ship when they're done. Issues are filed and labelled
> `M1`–`M4`; see the [issue list](https://github.com/stars-labs/starlab-wallet/issues).

## Shipped (0.1)

- FROST DKG + threshold signing over a WebRTC mesh; unified wallet (one DKG →
  all four chains)
- dApp connectivity: **EVM** (EIP-1193 + EIP-6963) and **Solana**
  (wallet-standard)
- **EIP-712** typed-data signing
- ERC-20 tokens, fiat pricing, transaction-activity history (service layer +
  popup UI)
- Send / Receive (native + ERC-20, QR)
- Hardware backends behind one `Signer` seam: **YubiKey**, **Ledger**
  (build-verified)
- Published: crates.io (`starlab-*`) + npm (`@stars-labs/*`)

---

## M1 — Trustworthy daily driver
*Make the core money-movement flows real, observed, and verified.*

- **Record activity on send** — write a `pending` entry when a tx broadcasts;
  reconcile to confirmed/failed via a receipt-polling loop (the store + UI
  already exist; nothing records into it yet).
- **Send UX** — gas/fee preview (editable), a confirmation screen, and a
  broadcast + status toast. Today the popup builds the tx but there's no fee
  preview or post-broadcast feedback.
- **Fiat in the balance card** — show the portfolio total + per-asset USD on the
  hero card (the pricing service exists; it isn't surfaced there yet).
- **Hardware verification** — Ledger popup WebHID wiring (Stage 4b) + YubiKey on
  real devices; both backends are build-verified only.
- **dApp connection manager** — list connected origins and **revoke**
  per-origin permissions in Settings.
- **Built-in Sandbox network** — one-click toggle to the local anvil/surfpool
  fork nodes (today: hand-entered custom RPCs; #31).
- **Account / network switcher polish** — fast, obvious switching across wallets
  and chains.

## M2 — DeFi-ready
*Everything a dApp power-user needs.*

- **ERC-20 approve / allowance** flows + allowance review & revocation.
- **EIP-712 verified end-to-end** against real dApps (ERC-2612 permit, Seaport
  orders).
- **Solana dApp interop verified** (e.g. a Jupiter swap) on the wallet-standard
  provider.
- **⭐ Transaction preflight simulation** — replay every tx on a local fork
  (anvil, sandbox-powered) *before* the FROST ceremony: balance diffs, approvals
  granted, revert prediction. Turns the sandbox into a security feature (#32).
- **Human-readable signing** — decode calldata + EIP-712 into plain language in
  the approval UI; red warnings for unlimited approvals / `setApprovalForAll`
  (#33).
- **Phishing protection** — origin reputation + lookalike-domain warnings at
  connect and at every signing request (#36).
- **NFT display** — ERC-721/1155 + Metaplex, with media.
- **Token discovery** — auto-detect held tokens; custom-token add UI on top of
  the registry.

## M3 — Recovery & trust
*Don't lose funds; earn trust.*

- **Keystore backup/export UI** (import already exists) — clear, safe export of
  encrypted shares.
- **Key resharing / device rotation UI** — the engine supports resharing; wire a
  recover-a-lost-device / rotate-cohort flow into the wallet.
- **Share-usage policy engine** — auto-lock timer, per-tx / daily value limits,
  per-origin allowlist; policy breach ⇒ explicit re-auth (#35).
- **Account-recovery story** + docs.
- **Third-party security audit** of the integration layer + UI (upstream FROST
  crates are audited; our glue is not).
- **Name resolution + address book** — ENS / SNS + saved contacts.

## M4 — Polish & scale

- **Onboarding** — first-run create/join flow that a non-expert can complete.
- **E2E tests** — Playwright for the popup + a dApp-interop CI lane (EVM +
  Solana).
- **Performance** — bundle size, cold-start, mesh-degree at larger cohorts.
- **Error handling** — typed, user-legible failures across the signing path.
- **More chains** + **i18n**.

---

## Principles

- **The key never reconstitutes.** Every feature preserves threshold security.
- **One `Signer` seam.** FROST, YubiKey, Ledger, and future backends are
  interchangeable; the provider never knows which signed.
- **Honest status.** No "production-ready" claims before an audit; build-verified
  vs. device-verified vs. tested is always called out.
