/**
 * Key-share backup file — exactly the engine's v2 `WalletFile` (TUI /
 * desktop `Keystore::export_share` / `import_share`, starlab-mpc
 * apps/tui/src/keystore/{models,storage,encryption}.rs), so a share moves
 * between the extension and the engine clients in both directions:
 *
 *   { version: "2.0", encrypted: true, algorithm: "AES-256-GCM-PBKDF2",
 *     data: base64(salt[16] | nonce[12] | AES-256-GCM(ciphertext+tag)),
 *     metadata: WalletMetadata }
 *
 * Key derivation: PBKDF2-HMAC-SHA256, 100 000 iterations, 32-byte key.
 * The plaintext is the engine's binary share blob (see frostShareBlob.ts).
 * The engine also accepts Argon2id files; WebCrypto has no Argon2, so
 * those are refused with a clear error.
 */
import type { KeyShareData } from "@stars-labs/types/keystore";
import { dkgParticipantIdentifiers, keyShareCoreFromEngine, toEngineKeystoreJson, type KeyShareCore } from "./engineKeystore";
import { engineBlobFromKeystore, keystoreFromEngineBlob } from "./frostShareBlob";

export const SHARE_BACKUP_ALGORITHM = "AES-256-GCM-PBKDF2";
const PBKDF2_ITERATIONS = 100_000;

/** The engine's `WalletMetadata` as it serializes (field order included). */
export interface ShareBackupMetadata {
    /** The wallet id (engine: `session_id`, serde alias `wallet_id`). */
    session_id: string;
    device_id: string;
    curve_type: "secp256k1" | "ed25519";
    threshold: number;
    total_participants: number;
    participant_index: number;
    group_public_key: string;
    /** Every shareholder's device id, sorted — FROST ids are the 1-based positions. */
    participants: string[];
    created_at: string;
    last_modified: string;
    label?: string;
}

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

/** Encrypt this device's key share into an engine-format share file (JSON string). */
export async function encryptShareBackup(
    keyShare: KeyShareData,
    wallet: { id: string; name?: string },
    password: string,
): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, "encrypt");
    const plaintext = engineBlobFromKeystore(toEngineKeystoreJson(keyShare));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    const data = new Uint8Array(salt.length + iv.length + ciphertext.length);
    data.set(salt, 0);
    data.set(iv, salt.length);
    data.set(ciphertext, salt.length + iv.length);

    const now = new Date().toISOString();
    const metadata: ShareBackupMetadata = {
        session_id: wallet.id,
        device_id: keyShare.device_id,
        curve_type: keyShare.curve,
        threshold: keyShare.threshold,
        total_participants: keyShare.total_participants,
        participant_index: keyShare.participant_index,
        group_public_key: keyShare.group_public_key,
        participants: [...keyShare.participants].sort(),
        created_at: new Date(keyShare.created_at || Date.now()).toISOString(),
        last_modified: now,
        ...(wallet.name ? { label: wallet.name } : {}),
    };
    return JSON.stringify(
        { version: "2.0", encrypted: true, algorithm: SHARE_BACKUP_ALGORITHM, data: toBase64(data), metadata },
        null,
        2,
    );
}

/**
 * Open an engine-format share file (the engine's or ours). Checks what the
 * engine's `validate_share` checks — the payload is a FROST share for the
 * metadata's curve with the metadata's group key — and rebuilds the stored
 * key-share fields. FROST ids come from the sorted participant list.
 */
export async function openShareBackup(
    fileJson: string,
    password: string,
): Promise<{ metadata: ShareBackupMetadata; keyShare: KeyShareCore & Pick<KeyShareData, "session_id" | "device_id"> }> {
    let file: any;
    try {
        file = JSON.parse(fileJson);
    } catch {
        throw new Error("Not a Starlab key share file (not JSON)");
    }
    const metadata: ShareBackupMetadata | undefined = file?.metadata;
    if (file?.version !== "2.0" || file?.encrypted !== true || !metadata || typeof file.data !== "string") {
        throw new Error("Not a Starlab key share file; expected an encrypted v2.0 share file");
    }
    if (file.algorithm !== SHARE_BACKUP_ALGORITHM) {
        throw new Error(`Unsupported key share encryption ${String(file.algorithm)}; re-export it as ${SHARE_BACKUP_ALGORITHM}`);
    }
    const walletId = metadata.session_id ?? (metadata as any).wallet_id;
    if (typeof walletId !== "string" || !walletId) throw new Error("Key share file has no wallet id");
    if (!Array.isArray(metadata.participants) || metadata.participants.length === 0) {
        throw new Error("Key share file has no participant list — co-signers can't be identified");
    }

    const raw = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const key = await deriveKey(password, raw.slice(0, 16), "decrypt");
    let blob: Uint8Array;
    try {
        blob = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(16, 28) }, key, raw.slice(28)));
    } catch {
        throw new Error("Wrong password for this key share file");
    }

    const { keystoreJson, groupPublicKey } = keystoreFromEngineBlob(blob, metadata.total_participants);
    if (groupPublicKey.toLowerCase() !== String(metadata.group_public_key).toLowerCase()) {
        throw new Error("Key share does not match the wallet's group public key");
    }
    const core = keyShareCoreFromEngine(keystoreJson, groupPublicKey, dkgParticipantIdentifiers(metadata.participants));
    if (core.curve !== metadata.curve_type) {
        throw new Error(`Key share is ${core.curve}, metadata says ${metadata.curve_type}`);
    }
    return {
        metadata: { ...metadata, session_id: walletId },
        keyShare: { ...core, session_id: walletId, device_id: metadata.device_id },
    };
}
