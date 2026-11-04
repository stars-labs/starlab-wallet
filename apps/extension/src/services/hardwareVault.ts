/** Local-only WebAuthn PRF envelope. The PRF output and vault secret never enter storage. */
export interface HardwareAssertion {
    credentialId: string;
    prfSalt: string;
    prfOutput: string;
}
export interface HardwareVaultRecord {
    version: 1;
    credentialId: string;
    prfSalt: string;
    hkdfSalt: string;
    iv: string;
    ciphertext: string;
}
export const HARDWARE_VAULT_KEY = 'mpc_hardware_vault';
export function encodeBytes(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid hardware key data');
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (encodeBytes(bytes) !== value) throw new Error('Invalid hardware key data');
    return bytes;
}
function bytes32(value: string): Uint8Array<ArrayBuffer> {
    const bytes = decodeBytes(value);
    if (bytes.length !== 32) throw new Error('Invalid hardware key secret');
    return bytes;
}
function aad(record: Pick<HardwareVaultRecord, 'credentialId' | 'prfSalt'>): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify(['starlab-hardware-vault-v1', record.credentialId, record.prfSalt]));
}
async function wrappingKey(output: string, salt: string): Promise<CryptoKey> {
    const secret = bytes32(output);
    try {
        const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
        return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes32(salt), info: new TextEncoder().encode('starlab/hardware-vault/wrap/v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally { secret.fill(0); }
}
export async function sealHardwareVault(assertion: HardwareAssertion, vaultSecret: string): Promise<HardwareVaultRecord> {
    decodeBytes(assertion.credentialId);
    bytes32(assertion.prfSalt);
    const record: HardwareVaultRecord = { version: 1, credentialId: assertion.credentialId, prfSalt: assertion.prfSalt, hkdfSalt: encodeBytes(crypto.getRandomValues(new Uint8Array(32))), iv: encodeBytes(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '' };
    const secret = bytes32(vaultSecret);
    try {
        const key = await wrappingKey(assertion.prfOutput, record.hkdfSalt);
        record.ciphertext = encodeBytes(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: decodeBytes(record.iv), additionalData: aad(record) }, key, secret)));
        return record;
    } finally { secret.fill(0); }
}
export async function openHardwareVault(record: HardwareVaultRecord, assertion: HardwareAssertion): Promise<string> {
    if (record.version !== 1 || assertion.credentialId !== record.credentialId || assertion.prfSalt !== record.prfSalt) throw new Error('This hardware key does not match the vault');
    const iv = decodeBytes(record.iv);
    if (iv.length !== 12) throw new Error('Invalid hardware vault');
    const key = await wrappingKey(assertion.prfOutput, record.hkdfSalt);
    const secret = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(record) }, key, decodeBytes(record.ciphertext)));
    try {
        if (secret.length !== 32) throw new Error('Invalid hardware vault');
        return encodeBytes(secret);
    } finally { secret.fill(0); }
}
export async function getHardwareVault(): Promise<HardwareVaultRecord | null> {
    const stored = (await chrome.storage.local.get(HARDWARE_VAULT_KEY))[HARDWARE_VAULT_KEY] as Partial<HardwareVaultRecord> | undefined;
    if (stored === undefined) return null;
    if (!stored || stored.version !== 1 || typeof stored.credentialId !== 'string' || typeof stored.prfSalt !== 'string' || typeof stored.hkdfSalt !== 'string' || typeof stored.iv !== 'string' || typeof stored.ciphertext !== 'string') throw new Error('Hardware vault data is invalid');
    return stored as HardwareVaultRecord;
}
