# YubiKey passwordless device unlock

## Goal and scope

A new browser-extension vault can be created and subsequently unlocked with a
PRF-capable FIDO2 security key, without creating an application password. The
creation dialog recommends YubiKey and retains an explicit Password choice.
A browser-controlled security-key PIN and touch may still be required.

This feature protects the extension's local MPC shares. Existing YubiKey
PIV/OpenPGP on-card signing accounts are a separate feature. Existing password
vaults retain their encryption and unlock method; there is no automatic
conversion or overwrite of an existing vault.

## Behavior and security contract

- WebAuthn runs from a dedicated, full extension tab. Chromium's default
  extension relying-party identity is used: `rp.id` and `rpId` are omitted.
  No remote website, authentication server or native messaging host is needed.
- Enrollment requests a cross-platform authenticator and required user
  verification, then evaluates PRF through an assertion. Only a matching
  credential and an actual 32-byte PRF result can protect/unlock the vault.
  The UI accepts compatible FIDO2 security keys; it does not claim verified
  Yubico brand attestation.
- A random 256-bit vault secret encrypts existing FROST/ECDSA share formats.
  PRF output passes through domain-separated HKDF-SHA-256 into an AES-256-GCM
  wrapping key. Local storage contains credential metadata and an authenticated
  encrypted envelope, never the unwrapped vault secret or PRF output.
- Authentication requests contain only short-lived public metadata in session
  storage. Completion is bound to the exact extension page, Chrome-assigned
  tab, request nonce and five-minute expiry, and is consumed once. Cancellation,
  expiry, closed/navigated tabs, wrong keys and unsupported PRF do not silently
  switch unlock methods. Web pages can relay dApp RPC, not vault commands.
- Authentication changes are serialized. A user lock invalidates an in-flight
  request and its crypto completion; a late result cannot unlock the vault.
  If request-metadata cleanup fails, authentication stays blocked and the
  extension closes only its own dedicated authentication pages.
  The shared session notification key is consistent, and the unused unsalted
  password-hash cache/expiry field are removed.
- Locking clears decrypted shares and the in-memory vault secret. A remembered
  session flag is not sufficient to unlock actual cryptographic storage after
  worker recreation. A hardware vault remains recognizable while empty.
- Saving a completed DKG under an unlocked hardware vault needs no application
  password and persists both FROST and ECDSA material. A locked vault rejects
  saving without discarding the pending ceremony.
- Portable backup files use a separate password chosen for the backup, retain
  existing engine-compatible formats and include each curve. Hardware-mode
  export requires a successful key verification within the preceding minute.
  Backup import authenticates the source password and re-encrypts under the
  unlocked target vault; the source password never replaces the target key.

## Compatibility and recovery

Use a current Chromium browser and a FIDO2 key that supports WebAuthn PRF.
Unsupported keys/browsers fail closed with an actionable message; choosing
Password is an explicit alternative for a new vault, not an automatic fallback.
A virtual authenticator proves browser/protocol integration, not physical-key
or operating-system compatibility. Physical YubiKey behavior is reported
separately from automated evidence.

The credential is bound to the extension identity. For unpacked installations,
update the same extension directory in place; moving/reinstalling into another
identity cannot be treated as recovery. Keep an encrypted portable share backup
and its separate password: losing the configured key without an independent
backup can lose access to this device's share. No key is reset or reprovisioned
by this feature.

## Acceptance

1. Create/unlock/password-alternative dialogs and full-tab ready, waiting,
   cancelled, unsupported, error and success states are inspected in light/dark
   popup and wide layouts. Keyboard focus stays inside dialogs and returns to
   its opener. Hardware DKG save has no application-password fields.
2. Actual WebCrypto tests exercise PRF envelope authentication, wrong-key and
   tamper rejection, all-curve share/prime-cache encryption, new-manager lock,
   unlock failure cleanup and portable-backup re-encryption.
3. Actual Chromium extension-origin WebAuthn tests use an isolated CDP virtual
   CTAP2 authenticator with PRF support. They exercise create/get, stable PRF,
   authenticated wrapping, wrong key, cancellation, reload and unsupported PRF.
4. Router/controller tests reject content/foreign-tab/stale/replayed requests,
   including cancellation/completion races and closed/navigated authentication
   tabs. Real backup and DKG-save handler regressions cover hardware mode.
5. Run the pinned Bun/Nix type check, complete unit suite, ordinary production
   build and ZIP. Verify one content script, no insecure-prime hook, no popup
   import in the offscreen document, and record exact source/artifact hashes.

Local release acceptance (2026-11-04): pinned Bun 1.4.4 / Node 26.13.0,
985 tests across 114 files passed (2,804 assertions; 254.18 seconds), with
zero failures. Svelte check reported zero errors and warnings; ordinary
production build and ZIP succeeded. The final production bundle also passed
the isolated Chromium 156 UI ceremony: create, encrypted empty-vault storage,
lock/unlock, dedicated-tab reuse with a fresh nonce, replay rejection,
cancellation remaining locked, and retry. This browser run uses a CDP virtual
USB PRF authenticator, not a physical YubiKey. Screenshots and machine-readable
results are recorded in the associated PR and local acceptance evidence.

## Primary references

- [Chromium extension WebAuthn origins](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/webauth/origins.md)
- [Yubico PRF key derivation guide](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html)
- [WebAuthn PRF explainer](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md)
