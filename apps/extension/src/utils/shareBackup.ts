/**
 * Encrypted key-share backup file — the CLI keystore format that
 * "Import keystore" (offscreen importKeystore) and the CLI read:
 *
 *   { version, encrypted: true, algorithm: "AES-256-GCM-PBKDF2",
 *     data: base64(salt[16] | iv[12] | AES-GCM ciphertext+tag),
 *     metadata: { wallet_id, session_id, device_id, curve_type, threshold,
 *                 total_participants, participant_index, group_public_key,
 *                 blockchains: [{ blockchain, address }] } }
 *
 * `data` decrypts to the engine keystore JSON (see engineKeystore.ts).
 * Key derivation: PBKDF2-SHA256, 100 000 iterations (CLI parity).
 */
import type { ExtensionWalletMetadata, KeyShareData } from "@stars-labs/types/keystore";
import { toEngineKeystoreJson } from "./engineKeystore";

export const SHARE_BACKUP_ALGORITHM = "AES-256-GCM-PBKDF2";
const PBKDF2_ITERATIONS = 100_000;

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
    const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        [usage],
    );
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/** Encrypt this device's key share into a backup file (JSON string). */
export async function encryptShareBackup(
    keyShare: KeyShareData,
    wallet: Pick<ExtensionWalletMetadata, "id" | "blockchain" | "address">,
    password: string,
): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, "encrypt");
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            new TextEncoder().encode(toEngineKeystoreJson(keyShare)),
        ),
    );
    const blob = new Uint8Array(salt.length + iv.length + ciphertext.length);
    blob.set(salt, 0);
    blob.set(iv, salt.length);
    blob.set(ciphertext, salt.length + iv.length);

    return JSON.stringify(
        {
            version: "2.0",
            encrypted: true,
            algorithm: SHARE_BACKUP_ALGORITHM,
            data: toBase64(blob),
            metadata: {
                wallet_id: wallet.id,
                session_id: keyShare.session_id,
                device_id: keyShare.device_id,
                curve_type: keyShare.curve,
                threshold: keyShare.threshold,
                total_participants: keyShare.total_participants,
                participant_index: keyShare.participant_index,
                group_public_key: keyShare.group_public_key,
                blockchains: wallet.address
                    ? [{ blockchain: wallet.blockchain, address: wallet.address }]
                    : [],
                created_at: new Date(keyShare.created_at || Date.now()).toISOString(),
            },
        },
        null,
        2,
    );
}

/** Decrypt a backup's (or CLI keystore's) `data` field to its plaintext JSON. */
export async function decryptShareBackupData(base64Data: string, password: string): Promise<string> {
    const blob = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    const salt = blob.slice(0, 16);
    const iv = blob.slice(16, 28);
    const key = await deriveKey(password, salt, "decrypt");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, blob.slice(28));
    return new TextDecoder().decode(plaintext);
}
