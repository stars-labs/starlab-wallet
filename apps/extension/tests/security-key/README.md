# Security-key verification

`prf-extension-browser.mjs` creates a minimal MV3 test extension that bundles
`hardwareWebAuthn.ts` and `hardwareVault.ts` from production. It launches a new
throwaway persistent Chromium profile and a CDP virtual USB authenticator;
it never attaches to an existing browser or opens `chrome://extensions`.

```sh
# From the repository root; use an installed Chromium supporting CDP hasPrf.
xvfb-run -a env PLAYWRIGHT_CHROME_PATH=/path/to/chromium \
  bun apps/extension/tests/security-key/prf-extension-browser.mjs
```

Playwright normally resolves from the workspace. An existing test installation
can be selected with `PLAYWRIGHT_MODULE=/absolute/path/to/@playwright/test/index.mjs`.
`PRF_TEST_OUTPUT` selects the output directory; the default is
`/tmp/starlab-prf-extension-browser`. The isolated browser profile and fixture
extension are removed even when browser assertions fail.

This is actual browser WebAuthn and actual WebCrypto, without replacing
`navigator.credentials` or `crypto.subtle`. The CDP authenticator simulates the
hardware. Checks cover:

- A secure `chrome-extension://…` document, with no `rp.id` / `rpId` supplied.
  Its browser-reported origin matches the authenticator's default RP ID.
- Registration and authentication yielding a stable 32-byte PRF result.
- Production HKDF/AES-GCM wrapping, authenticated decryption, and rejection
  of a wrong credential ID or modified ciphertext.
- Cancellation with `AbortController`, leaving the record unchanged.
- Document reload removing JS memory, followed by fresh PRF authentication
  and successful decryption of an encrypted public test challenge.
- Replacing the enrolled virtual authenticator with a different one that
  lacks the credential: it returns no credential before the test aborts the
  request after 200ms, and the stored record remains unchanged.
- A non-PRF authenticator failing closed.

The output contains booleans, public origin/RP identifiers and record field
names. It does not print PRF results, the random vault secret, credential
private keys, or decrypted key-share data. The fixture stores only the
production encrypted record and an encrypted public restart challenge.

This probe is not the complete wallet UI or background routing test. It tests
a document restart inside the same virtual-authenticator lifetime, not
physical hardware persistence across full browser shutdown. Physical YubiKey
PRF support, PIN prompts, device removal, and browser restart with an actual
key remain unverified by this harness.

An additional isolated Chromium 156 diagnostic confirmed that CDP virtual
authenticators are target-scoped: exporting a credential and importing its
private key into another tab did not restore PRF support. The CDP credential
format does not expose the PRF/hmac secret. That diagnostic is a simulator
limitation, not evidence that physical keys fail across tabs; it must not be
reported as a successful cross-tab or full-browser hardware restore.

Additional unit tests use actual WebCrypto with fixture PRF input:

```sh
cd apps/extension
bun test tests/services/hardwareKeystoreLifecycle.test.ts \
  tests/entrypoints/background/securityKeyAuthIsolation.test.ts
```

The manager tests discard singleton instances and reload encrypted storage to
model worker restart, checking FROST/ECDSA/prime-cache restoration, locked
sessions, missing/tampered data, no password fallback, and export freshness.
The controller tests inject a counting vault only to check sender, page, tab,
nonce, expiry, replay and concurrent cancellation/completion boundaries.
Neither unit-test PRF input nor a virtual authenticator is evidence of
physical YubiKey compatibility.

Primary references:

- [Chromium supported WebAuthn origins](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/webauth/origins.md)
- [Official CDP WebAuthn schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/WebAuthn.pdl)
