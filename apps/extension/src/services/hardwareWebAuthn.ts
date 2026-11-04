import { decodeBytes, encodeBytes, type HardwareAssertion, type HardwareVaultRecord } from './hardwareVault';

// Run only from a full extension tab: a popup can be destroyed when the
// authenticator prompt takes focus. Chromium uses the extension's own origin;
// intentionally omit rp.id and rpId (no external website dependency).
function credentials(): CredentialsContainer {
    if (!globalThis.isSecureContext || !navigator.credentials) throw new Error('Hardware key authentication is unavailable in this browser');
    return navigator.credentials;
}
export async function getHardwareAssertion(record: Pick<HardwareVaultRecord, 'credentialId' | 'prfSalt'>, signal?: AbortSignal): Promise<HardwareAssertion> {
    const result = await credentials().get({ signal, publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: decodeBytes(record.credentialId), transports: ['usb', 'nfc'] }],
        userVerification: 'required', timeout: 120_000,
        extensions: { prf: { eval: { first: decodeBytes(record.prfSalt) } } } as AuthenticationExtensionsClientInputs,
    } }) as PublicKeyCredential | null;
    if (!result || encodeBytes(new Uint8Array(result.rawId)) !== record.credentialId) throw new Error('The hardware key did not match');
    const output = (result.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & { prf?: { results?: { first: ArrayBuffer } } }).prf?.results?.first;
    if (!output || output.byteLength !== 32) throw new Error('This hardware key or browser does not support WebAuthn PRF');
    return { credentialId: record.credentialId, prfSalt: record.prfSalt, prfOutput: encodeBytes(new Uint8Array(output)) };
}
export async function createHardwareCredential(signal?: AbortSignal): Promise<HardwareAssertion> {
    const result = await credentials().create({ signal, publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Starlab Wallet' },
        user: { id: crypto.getRandomValues(new Uint8Array(32)), name: 'Starlab Wallet', displayName: 'Starlab Wallet' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'cross-platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none', timeout: 120_000,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    } }) as PublicKeyCredential | null;
    if (!result) throw new Error('Hardware key setup was cancelled');
    // A second ceremony also supports authenticators without PRF evaluation at registration.
    return getHardwareAssertion({ credentialId: encodeBytes(new Uint8Array(result.rawId)), prfSalt: encodeBytes(crypto.getRandomValues(new Uint8Array(32))) }, signal);
}
