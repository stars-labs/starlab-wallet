# Unified wallet alignment

## Goal
The extension creates the same complete multi-algorithm wallet as the native
engine: ed25519 FROST, secp256k1 Taproot FROST, then threshold ECDSA. A ceremony
is complete only once all three shares exist. Chain/network selection changes
the selected account and RPC, never the wallet's key inventory.

## Scope and assumptions
- Use the existing core-wasm UnifiedDkg and native UNIFIED_DKG wire protocol.
- Remove single-curve creation and manual signature-curve settings. Keep
  concrete-curve selection internal to signing and share refresh.
- Persist, restore and back up all three curve shares under one wallet identity;
  account derivation and signing select the correct stored curve.
- No compatibility layer, silent single-curve fallback, key regeneration or
  destructive automatic reset. Incomplete test wallets must be recreated.
- YubiKey/password local encryption continue to protect the complete wallet.
- Each unified round-two peer receives only its own private packages; sender
  identifiers must match the authenticated data channel peer.

## Acceptance
- Extension-created and native-created unified DKG sessions interoperate using
  actual WASM/native clients, with matching keys/addresses for all algorithms.
- Reload locked storage, unlock, and sign with the correct per-chain keys;
  switching the visible chain does not start DKG or change root keys.
- Encrypted export/import preserves all three curve shares. Incomplete result,
  wrong sender and missing share cases reject completion/signing.
- Type check and full extension suite pass; production build has no test-prime
  hooks and no CSP violations. Browser screenshots show no creation curve
  selection and clear account/network selection.
- Native recipient-isolation regression and relevant engine checks pass.

## Risk
The current extension models a wallet around one FROST share. The critical
change is selecting the right per-curve material throughout save, restore,
backup, signing and refresh, rather than merely adding another DKG class.

## Implementation notes

- A wallet stores the canonical secp256k1 FROST entry plus encrypted ed25519
  and ECDSA entries. Each FROST entry retains its own identifiers and current
  cohort; ECDSA retains the immutable cohort extracted from its actual share.
  A FROST refresh never changes the Ethereum cohort or signing threshold.
- Wallet publication requires all three encrypted entries. Duplicate saves
  cannot replace ciphertext, and locking invalidates asynchronous encryption,
  decryption and cache writes. Missing shares fail closed.
- Backups use exactly three native-compatible files and validate each file’s
  own cryptographic parameters. Refreshed FROST identifiers with gaps remain
  intact; the ECDSA and FROST cohorts need not remain identical after refresh.
- Public account-zero addresses are recorded per chain, independently of the
  currently viewed chain. Solana address identity remains case-sensitive.
- Removed the obsolete single-curve creator, manual session creator, per-account
  DKG generator, old migration and single-share wallet-backup APIs. No old
  implementation or install-package backup is retained on update.
- Native early unified round packets must be buffered for the active session
  and replayed after local initialization; network de-duplication cannot recover
  a frame that was accepted by transport and then discarded by the driver.

## Acceptance evidence

PASS on the final candidate (2026-11-04):

- Bun 1.4.4 / Node 26.13.0: 1,008 tests across 118 files, zero failures,
  3,351 assertions in 284.77 seconds. Svelte check: zero errors/warnings.
  Ordinary production build, ZIP, native ESM import and diff checks passed.
- Real Chromium/native interop: 3/3 cases passed in 4.3 minutes. Extension and
  native creators produce matching ed25519, Taproot FROST and ECDSA roots and
  matching account 0/1 addresses for all four chains. Restarted clients sign
  account 1 on Solana, Sui, Bitcoin and Ethereum. Solana, Bitcoin and Ethereum
  additionally use independent verifiers; Sui checks the native aggregate.
  Three-file export/import into a fresh browser profile also signs Ethereum
  with the restored identity and independently recovers the expected address.
- Interop uses exact engine `cea7b03ab42483dbd5f5c3a1d6a695a7bfeb5489`.
  CLI SHA-256: `7269122108d2ed916ade5affb51406d55204a8c3be84a477d4f95b3f83dd1c50`.
  WASM SHA-256: `96b470dd7da31da20c74899932267a503af3b49c16e3b84519d2767f23725673`.
  Fixture primes are confined to the isolated interop build. The separately
  built user package contains no insecure-prime hook. Native CI also passes
  the production-prime cold DKG case.
- Native exact-source tests: 314 client tests passed; core crypto tests and
  dedicated recipient isolation, early-frame/cancellation and explicit
  storage-path/password regressions passed. All 13 PR #141 checks passed.
  Native normal clippy retains baseline warnings; this change does not claim
  those unrelated warnings were removed.
- Production browser PRF creation/lock/unlock/cancellation/retry and CSP checks
  pass with a virtual authenticator. Compiled UI contracts cover creation
  without algorithm selection, all-key account derivation, chain-only settings,
  strict three-file restoration and external account boundaries. Physical
  YubiKey behavior is not established by virtual-authenticator tests.

Local machine-readable evidence and screenshots are referenced in the PR;
private fixture shares are not committed. Remote extension and desktop checks
are reported in their PRs after completion.


## Restore identity and transport

A new empty profile adopts the original participant identity only after all
three backup files and actual ECDSA cohort are authenticated. A profile with
other wallets or an active/pending ceremony rejects another device’s identity.
The persisted identity, offscreen peer and signal registration are rebound
before publishing the restored wallet. Active-wallet selection is saved in
the canonical index; no second unread selection key is written.

A manual signal reconnect detaches the previous client before closing it.
Late or synchronous close callbacks from that client cannot schedule a retry
that repeatedly tears down the healthy replacement; unexpected active-client
closures retain exponential backoff.
