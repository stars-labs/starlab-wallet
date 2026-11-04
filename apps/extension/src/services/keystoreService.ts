// ===================================================================
// KEYSTORE SERVICE - FROST KEY SHARE MANAGEMENT
// ===================================================================
//
// This service manages the secure storage of FROST key shares for
// multiple accounts. Each account represents a separate DKG session
// with its own key material. The service handles encryption, 
// persistence, and recovery of key shares.
// ===================================================================

import { storage } from "#imports";
import type { 
    KeyShareData, 
    ExtensionWalletMetadata, 
    KeystoreIndex, 
    EncryptedKeyShare,
    KeystoreBackup,
    CLIKeystoreBackup,
    BlockchainInfo
} from "@stars-labs/types/keystore";

/** Curves a wallet can hold besides its FROST share (`setCurveShare`). */
export const EXTRA_CURVES = ["ed25519", "secp256k1-ecdsa"] as const;

export class KeystoreService {
    private static instance: KeystoreService;
    private static testMode: boolean = false;
    private keystoreIndex: KeystoreIndex | null = null;
    private keyShares: Map<string, KeyShareData> = new Map();
    /** Decrypted per-curve shares (`setCurveShare`), keyed by storage key. */
    private curveShares: Map<string, string> = new Map();
    private password: string | null = null;
    private isUnlocked: boolean = false;
    private lockEpoch = 0;
    private readonly walletWrites = new Set<string>();
    
    private readonly STORAGE_PREFIX = "mpc_keystore";
    private readonly INDEX_KEY = `${this.STORAGE_PREFIX}_index`;
    private readonly SHARES_KEY_PREFIX = `${this.STORAGE_PREFIX}_share_`;
    /** The stored index, read once. Everything that decides whether an
     *  index exists awaits it — deciding before it resolves is how an
     *  empty index once overwrote a saved wallet on SW start. */
    private readonly loaded: Promise<void>;
    
    private constructor() {
        this.loaded = this.loadKeystoreIndex();
        // Surface a failed load even if nobody awaits it yet.
        this.loaded.catch((error) => console.error("[KeystoreService] Failed to load index:", error));
    }

    /** Resolves once the stored index is loaded; rejects if it can't be read. */
    public ready(): Promise<void> {
        return this.loaded;
    }
    
    public static getInstance(): KeystoreService {
        if (!KeystoreService.instance) {
            KeystoreService.instance = new KeystoreService();
        }
        return KeystoreService.instance;
    }
    
    /**
     * Reset the singleton instance (for testing only)
     */
    public static resetInstance(): void {
        if (KeystoreService.instance) {
            KeystoreService.instance.lock();
            KeystoreService.instance.keyShares.clear();
            KeystoreService.instance.keystoreIndex = null;
        }
        KeystoreService.instance = null as any;
        KeystoreService.testMode = true;
    }
    
    /**
     * Initialize or create keystore
     */
    public async initialize(deviceId: string): Promise<void> {
        // Throws (and writes nothing) if the stored index can't be read.
        await this.loaded;
        if (!this.keystoreIndex) {
            this.keystoreIndex = {
                version: "1.0.0",
                wallets: [],
                device_id: deviceId,
                isEncrypted: true,
                encryptionMethod: 'password',
                lastModified: Date.now()
            };
            await this.saveKeystoreIndex();
        } else if (this.keystoreIndex.wallets.length === 0 && this.keystoreIndex.device_id !== deviceId) {
            this.keystoreIndex.device_id = deviceId;
            await this.saveKeystoreIndex();
        }
    }
    
    /**
     * Check if keystore is locked
     */
    public isLocked(): boolean {
        return !this.isUnlocked;
    }
    
    /**
     * Unlock keystore with password
     */
    public async unlock(password: string): Promise<boolean> {
        // The password is checked against a stored share — so the index
        // must be loaded first (else any password "unlocks").
        await this.loaded;
        try {
            this.lock();
            this.password = password;
            
            // Try to decrypt one key share to verify password
            if (this.keystoreIndex && this.keystoreIndex.wallets.length > 0) {
                const firstWallet = this.keystoreIndex.wallets[0];
                if (!await this.loadKeyShare(firstWallet.id)) throw new Error("Encrypted wallet share is missing");
            }
            
            this.isUnlocked = true;
            return true;
        } catch (error) {
            console.error("[KeystoreService] Failed to unlock:", error);
            this.lock();
            return false;
        }
    }
    
    /**
     * Lock keystore
     */
    public lock(): void {
        this.lockEpoch += 1;
        this.password = null;
        this.isUnlocked = false;
        this.keyShares.clear();
        this.curveShares.clear();
    }
    
    /**
     * Add a new wallet after DKG completion
     */
    public async addWallet(walletId: string, keyShareData: KeyShareData, metadata: ExtensionWalletMetadata): Promise<void> {
        if (!this.isUnlocked || !this.password) throw new Error("Keystore is locked");
        if (!this.keystoreIndex) throw new Error("Keystore not initialized");
        if (this.walletWrites.has(walletId) || this.keystoreIndex.wallets.some(wallet => wallet.id === walletId)) throw new Error(`Wallet ${walletId} already exists or is being saved`);
        this.walletWrites.add(walletId);
        const epoch = this.lockEpoch;
        try {
            const roots = keyShareData.frost_group_public_keys;
            const edJson = await this.getCurveShare(walletId, "ed25519");
            const ecdsa = await this.getCurveShare(walletId, "secp256k1-ecdsa");
            if (keyShareData.curve !== "secp256k1" || !roots?.ed25519 || !roots.secp256k1 || !keyShareData.ecdsa_group_public_key || !edJson || !ecdsa) throw new Error("A wallet requires all three algorithm shares");
            const ed = JSON.parse(edJson) as KeyShareData;
            if (ed.curve !== "ed25519" || !ed.key_package || !ed.public_key_package || ed.group_public_key !== roots.ed25519 || keyShareData.group_public_key !== roots.secp256k1) throw new Error("Unified wallet public keys do not match its shares");
            const encrypted = await this.encryptKeyShare(walletId, keyShareData);
            if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while saving wallet");
            await this.saveEncryptedShare(walletId, encrypted);
            if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while saving wallet");
            if (metadata.isActive) this.keystoreIndex.wallets = this.keystoreIndex.wallets.map(wallet => ({...wallet,isActive:false}));
            this.keystoreIndex.wallets.push(metadata);
            this.keystoreIndex.lastModified = Date.now();
            await this.saveKeystoreIndex();
            if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while saving wallet");
            this.keyShares.set(walletId, keyShareData);
        } finally { this.walletWrites.delete(walletId); }
    }

    /**
     * M3 reshare: REPLACE an existing wallet's encrypted key share
     * in place. Same wallet id, same group public key, same
     * addresses — only the FROST share material (and possibly the
     * cohort parameters) change. Mirrors addWallet's
     * encrypt-and-save path but updates the index entry instead of
     * appending a duplicate.
     */
    public async updateWalletKeyShare(
        walletId: string,
        keyShareData: KeyShareData
    ): Promise<void> {
        if (!this.isUnlocked || !this.password) {
            throw new Error("Keystore is locked");
        }
        if (!this.keystoreIndex) {
            throw new Error("Keystore not initialized");
        }
        const existing = this.keystoreIndex.wallets.find(w => w.id === walletId);
        if (!existing) {
            throw new Error(`Wallet ${walletId} not found — refusing to create via update`);
        }

        const epoch = this.lockEpoch;
        const root = await this.getKeyShare(walletId);
        if (root && keyShareData.curve !== root.curve) {
            await this.setCurveShare(walletId, keyShareData.curve, JSON.stringify(keyShareData));
            return;
        }
        // Encrypt and overwrite the stored share.
        const encrypted = await this.encryptKeyShare(walletId, keyShareData);
        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while updating wallet");
        await this.saveEncryptedShare(walletId, encrypted);
        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while updating wallet");

        this.keystoreIndex.lastModified = Date.now();
        await this.saveKeystoreIndex();

        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while updating wallet");
        // Refresh decrypted cache.
        this.keyShares.set(walletId, keyShareData);

        console.log("[KeystoreService] Replaced key share for wallet:", walletId);
    }
    
    /**
     * Get key share for a wallet
     */
    public async getKeyShare(walletId: string): Promise<KeyShareData | null> {
        if (!this.isUnlocked) {
            throw new Error("Keystore is locked");
        }
        
        const epoch = this.lockEpoch;
        // Check cache first
        if (this.keyShares.has(walletId)) {
            return this.keyShares.get(walletId)!;
        }
        
        // Load and decrypt
        try {
            const keyShare = await this.loadKeyShare(walletId);
            if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while reading wallet");
            if (keyShare) {
                this.keyShares.set(walletId, keyShare);
            }
            return keyShare;
        } catch (error) {
            console.error("[KeystoreService] Failed to load key share:", error);
            return null;
        }
    }
    
    /**
     * Get all wallet metadata
     */
    public async setActiveWallet(walletId: string): Promise<void> {
        await this.loaded;
        if (!this.keystoreIndex || !this.keystoreIndex.wallets.some(wallet => wallet.id === walletId)) throw new Error(`Wallet ${walletId} not found`);
        const next = {...this.keystoreIndex,lastModified:Date.now(),wallets:this.keystoreIndex.wallets.map(wallet => ({...wallet,isActive:wallet.id === walletId}))};
        await storage.setItem(`local:${this.INDEX_KEY}`,next);
        this.keystoreIndex = next;
    }

    public getWallets(): ExtensionWalletMetadata[] {
        return this.keystoreIndex?.wallets || [];
    }
    
    /**
     * Get wallet metadata by ID
     */
    public getWallet(walletId: string): ExtensionWalletMetadata | null {
        return this.keystoreIndex?.wallets.find(w => w.id === walletId) || null;
    }
    
    /**
     * Remove a wallet
     */
    public async removeWallet(walletId: string): Promise<void> {
        if (!this.keystoreIndex) return;
        
        // Remove from index
        this.keystoreIndex.wallets = this.keystoreIndex.wallets.filter(
            w => w.id !== walletId
        );
        this.keystoreIndex.lastModified = Date.now();
        await this.saveKeystoreIndex();
        
        // Remove encrypted share
        await storage.removeItem(`local:${this.SHARES_KEY_PREFIX}${walletId}`);
        for (const curve of EXTRA_CURVES) {
            const key = this.curveShareKey(walletId, curve);
            await storage.removeItem(`local:${key}`);
            this.curveShares.delete(key);
        }

        // Remove from cache
        this.keyShares.delete(walletId);
    }
    
    /**
     * Read the stored index. Never writes: an index that can't be read or
     * parsed is an error (the caller must not start over with an empty one
     * and save it over the user's wallets).
     */
    private async loadKeystoreIndex(): Promise<void> {
        // Skip loading in test mode to ensure clean state
        if (KeystoreService.testMode) {
            return;
        }
        const stored = await storage.getItem<KeystoreIndex>(`local:${this.INDEX_KEY}`);
        if (stored == null) return; // nothing saved yet
        if (typeof stored !== "object" || !Array.isArray((stored as any).wallets)) {
            throw new Error(
                `Unreadable ${this.INDEX_KEY} in storage (left untouched): ${JSON.stringify(stored).slice(0, 200)}`,
            );
        }
        this.keystoreIndex = stored;
        console.log("[KeystoreService] Loaded keystore index with", stored.wallets.length, "wallets");
    }
    
    private async saveKeystoreIndex(): Promise<void> {
        // Never write before the stored index was read (and never if it
        // couldn't be): that is how a saved wallet got overwritten.
        await this.loaded;
        if (!this.keystoreIndex) return;
        
        // A failed write must reach the caller (it just told the user the
        // wallet is saved) — no swallowing.
        await storage.setItem(`local:${this.INDEX_KEY}`, this.keystoreIndex);
    }
    
    /** Change a wallet's primary address in the index (e.g. once its
     *  Ethereum (ECDSA) share is attached). */
    public async updateWalletAddress(walletId: string, address: string, blockchain?: string): Promise<void> {
        const wallet = this.keystoreIndex?.wallets.find((w) => w.id === walletId);
        if (!wallet) throw new Error(`Wallet ${walletId} not found`);
        wallet.address = address;
        if (blockchain) wallet.blockchain = blockchain;
        this.keystoreIndex!.lastModified = Date.now();
        await this.saveKeystoreIndex();
    }

    /**
     * Another curve's share of a wallet (the threshold-ECDSA
     * `secp256k1-ecdsa` share next to the FROST one): the engine's
     * per-curve keystore entry. Plaintext is the curve's own share JSON,
     * encrypted exactly like the FROST share (same password, PBKDF2 +
     * AES-GCM, fresh salt).
     */
    public async setCurveShare(walletId: string, curve: string, shareJson: string): Promise<void> {
        if (!this.isUnlocked || !this.password) {
            throw new Error("Keystore is locked");
        }
        const epoch = this.lockEpoch;
        const key = this.curveShareKey(walletId, curve);
        const encrypted = await this.encryptSecret(walletId, shareJson);
        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while saving algorithm share");
        await storage.setItem(`local:${key}`, encrypted);
        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while saving algorithm share");
        this.curveShares.set(key, shareJson);
    }

    /** The share JSON stored by `setCurveShare`, or null if the wallet has none. */
    public async getCurveShare(walletId: string, curve: string): Promise<string | null> {
        if (!this.isUnlocked) {
            throw new Error("Keystore is locked");
        }
        const key = this.curveShareKey(walletId, curve);
        const epoch = this.lockEpoch;
        const cached = this.curveShares.get(key);
        if (cached !== undefined) return cached;
        const encrypted = await storage.getItem<EncryptedKeyShare>(`local:${key}`);
        if (!encrypted) return null;
        const json = await this.decryptSecret(encrypted);
        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while reading algorithm share");
        this.curveShares.set(key, json);
        return json;
    }

    private curveShareKey(walletId: string, curve: string): string {
        return `${this.SHARES_KEY_PREFIX}${walletId}__${curve}`;
    }

    /** Encrypt any secret string with the keystore password (same scheme as shares). */
    public async encryptSecret(id: string, plaintext: string): Promise<EncryptedKeyShare> {
        if (!this.password) {
            throw new Error("No password set");
        }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this.deriveKey(this.password, salt);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
        return {
            walletId: id,
            algorithm: 'AES-GCM',
            salt: bytesToBase64(salt),
            iv: bytesToBase64(iv),
            ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        };
    }

    /** Inverse of `encryptSecret`. */
    public async decryptSecret(encrypted: EncryptedKeyShare): Promise<string> {
        if (!this.password) {
            throw new Error("No password set");
        }
        const epoch = this.lockEpoch;
        const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0));
        const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
        const key = await this.deriveKey(this.password, salt);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        if (!this.isUnlocked || this.lockEpoch !== epoch) throw new Error("Vault locked while decrypting algorithm share");
        return new TextDecoder().decode(decrypted);
    }

    private async encryptKeyShare(walletId: string, keyShare: KeyShareData): Promise<EncryptedKeyShare> {
        if (!this.password) {
            throw new Error("No password set");
        }
        
        // Generate salt and IV
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        
        // Derive key from password
        const key = await this.deriveKey(this.password, salt);
        
        // Encrypt data
        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(keyShare));
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );
        
        return {
            walletId,
            algorithm: 'AES-GCM',
            salt: btoa(String.fromCharCode(...salt)),
            iv: btoa(String.fromCharCode(...iv)),
            ciphertext: bytesToBase64(new Uint8Array(ciphertext))
        };
    }
    
    private async decryptKeyShare(encrypted: EncryptedKeyShare): Promise<KeyShareData> {
        if (!this.password) {
            throw new Error("No password set");
        }

        // Decode base64
        const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0));
        const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));

        // Derive key
        const key = await this.deriveKey(this.password, salt);

        // Decrypt
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );

        const decoder = new TextDecoder();
        const json = decoder.decode(decrypted);
        return JSON.parse(json);
    }
    
    private async deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        
        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt,
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }
    
    private async saveEncryptedShare(walletId: string, encrypted: EncryptedKeyShare): Promise<void> {
        await storage.setItem(`local:${this.SHARES_KEY_PREFIX}${walletId}`, encrypted);
    }
    
    private async loadEncryptedShare(walletId: string): Promise<EncryptedKeyShare | null> {
        return await storage.getItem<EncryptedKeyShare>(`local:${this.SHARES_KEY_PREFIX}${walletId}`);
    }
    
    private async loadKeyShare(walletId: string): Promise<KeyShareData | null> {
        const encrypted = await this.loadEncryptedShare(walletId);
        if (!encrypted) return null;
        
        return await this.decryptKeyShare(encrypted);
    }


}

/** base64 of arbitrary-size bytes (spreading a large array into
 *  String.fromCharCode overflows the call stack). */
function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}
