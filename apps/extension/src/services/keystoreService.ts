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
    WalletMetadata,
    ExtensionWalletMetadata, 
    KeystoreIndex, 
    EncryptedKeyShare,
    KeystoreBackup,
    CLIKeystoreBackup,
    WalletFile,
    BlockchainInfo,
    NewAccountSession
} from "@stars-labs/types/keystore";

/** Curves a wallet can hold besides its FROST share (`setCurveShare`). */
export const EXTRA_CURVES = ["secp256k1-ecdsa"] as const;

export class KeystoreService {
    private static instance: KeystoreService;
    private static testMode: boolean = false;
    private keystoreIndex: KeystoreIndex | null = null;
    private keyShares: Map<string, KeyShareData> = new Map();
    /** Decrypted per-curve shares (`setCurveShare`), keyed by storage key. */
    private curveShares: Map<string, string> = new Map();
    private password: string | null = null;
    private isUnlocked: boolean = false;
    
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
        this.password = null;
        this.isUnlocked = false;
        this.keyShares.clear();
        this.curveShares.clear();
    }
    
    /**
     * Add a new wallet after DKG completion
     */
    public async addWallet(
        walletId: string,
        keyShareData: KeyShareData,
        metadata: ExtensionWalletMetadata
    ): Promise<void> {
        if (!this.isUnlocked || !this.password) {
            throw new Error("Keystore is locked");
        }
        
        // Encrypt and save key share
        const encrypted = await this.encryptKeyShare(walletId, keyShareData);
        await this.saveEncryptedShare(walletId, encrypted);
        
        // Update index
        if (!this.keystoreIndex) {
            throw new Error("Keystore not initialized");
        }
        
        this.keystoreIndex.wallets.push(metadata);
        this.keystoreIndex.lastModified = Date.now();
        await this.saveKeystoreIndex();
        
        // Cache decrypted share
        this.keyShares.set(walletId, keyShareData);
        
        console.log("[KeystoreService] Added wallet:", walletId);
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

        // Encrypt and overwrite the stored share.
        const encrypted = await this.encryptKeyShare(walletId, keyShareData);
        await this.saveEncryptedShare(walletId, encrypted);

        this.keystoreIndex.lastModified = Date.now();
        await this.saveKeystoreIndex();

        // Refresh decrypted cache.
        this.keyShares.set(walletId, keyShareData);

        console.log("[KeystoreService] Replaced key share for wallet:", walletId);
    }
    
    /**
     * Import wallet from CLI-compatible format
     */
    public async importCLIWallet(walletFile: WalletFile, password: string): Promise<void> {
        if (!this.isUnlocked) {
            throw new Error("Keystore is locked");
        }
        
        const cliMetadata = walletFile.metadata;
        const walletId = cliMetadata.wallet_id;
        
        // Check if wallet already exists
        if (this.getWallet(walletId)) {
            console.warn("[KeystoreService] Wallet already exists:", walletId);
            return;
        }
        
        // Decrypt the CLI wallet data using CLI password
        const decryptedData = await this.decryptCLIData(walletFile.data, password);
        const cliKeyData = JSON.parse(decryptedData);
        
        // Convert CLI data to extension format
        const keyShareData: KeyShareData = {
            key_package: cliKeyData.key_package || '',
            public_key_package: cliKeyData.public_key_package || '',
            group_public_key: cliMetadata.group_public_key,
            session_id: cliMetadata.wallet_id,
            device_id: cliMetadata.device_id,
            participant_index: cliMetadata.participant_index,
            threshold: cliMetadata.threshold,
            total_participants: cliMetadata.total_participants,
            participants: [cliMetadata.device_id], // Only this device known from CLI
            participant_identifiers: { [cliMetadata.device_id]: cliMetadata.participant_index },
            curve: cliMetadata.curve_type as 'secp256k1' | 'ed25519',
            blockchains: cliMetadata.blockchains,
            ethereum_address: cliMetadata.blockchains.find(b => b.blockchain === 'ethereum')?.address,
            solana_address: cliMetadata.blockchains.find(b => b.blockchain === 'solana')?.address,
            created_at: new Date(cliMetadata.created_at).getTime()
        };
        
        // Convert to extension metadata
        const primaryBlockchain = cliMetadata.blockchains.find(b => b.enabled) || cliMetadata.blockchains[0];
        const extensionMetadata: ExtensionWalletMetadata = {
            id: walletId,
            name: walletId,
            blockchain: primaryBlockchain?.blockchain || 'ethereum',
            address: primaryBlockchain?.address || '',
            session_id: cliMetadata.wallet_id,
            isActive: true,
            hasBackup: true
        };
        
        // Re-encrypt with extension password
        const encrypted = await this.encryptKeyShare(walletId, keyShareData);
        await this.saveEncryptedShare(walletId, encrypted);
        
        // Update index
        if (!this.keystoreIndex) {
            throw new Error("Keystore not initialized");
        }
        
        this.keystoreIndex.wallets.push(extensionMetadata);
        this.keystoreIndex.lastModified = Date.now();
        await this.saveKeystoreIndex();
        
        // Cache decrypted share
        this.keyShares.set(walletId, keyShareData);
        
        console.log("[KeystoreService] Imported CLI wallet:", walletId);
    }
    
    /**
     * Export wallet in CLI-compatible format
     */
    public async exportCLIWallet(walletId: string, exportPassword?: string): Promise<WalletFile> {
        if (!this.isUnlocked || !this.keystoreIndex) {
            throw new Error("Keystore is locked");
        }
        
        const metadata = this.getWallet(walletId);
        if (!metadata) {
            throw new Error("Wallet not found");
        }
        
        const keyShareData = await this.getKeyShare(walletId);
        if (!keyShareData) {
            throw new Error("Key share not found");
        }
        
        // Create CLI-compatible metadata
        const cliMetadata: WalletMetadata = {
            wallet_id: walletId,
            device_id: keyShareData.device_id,
            device_name: keyShareData.device_id,
            curve_type: keyShareData.curve,
            blockchains: keyShareData.blockchains || [],
            threshold: keyShareData.threshold,
            total_participants: keyShareData.total_participants,
            participant_index: keyShareData.participant_index,
            group_public_key: keyShareData.group_public_key,
            created_at: new Date(keyShareData.created_at).toISOString(),
            last_modified: new Date().toISOString(),
            tags: [],
            description: `Exported from Chrome extension on ${new Date().toISOString()}`
        };
        
        // Prepare CLI key data
        const cliKeyData = {
            key_package: keyShareData.key_package,
            group_public_key: keyShareData.group_public_key,
            session_id: keyShareData.session_id,
            device_id: keyShareData.device_id,
        };
        
        // Encrypt with current extension password (CLI will need to re-encrypt with their password)
        const encryptedData = await this.encryptCLIData(JSON.stringify(cliKeyData), exportPassword);
        
        return {
            version: "2.0",
            encrypted: true,
            algorithm: "AES-256-GCM",
            data: encryptedData,
            metadata: cliMetadata
        };
    }
    
    /**
     * Get key share for a wallet
     */
    public async getKeyShare(walletId: string): Promise<KeyShareData | null> {
        if (!this.isUnlocked) {
            throw new Error("Keystore is locked");
        }
        
        // Check cache first
        if (this.keyShares.has(walletId)) {
            return this.keyShares.get(walletId)!;
        }
        
        // Load and decrypt
        try {
            const keyShare = await this.loadKeyShare(walletId);
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
     * Export wallet for backup
     */
    public async exportWallet(walletId: string): Promise<KeystoreBackup> {
        if (!this.isUnlocked || !this.keystoreIndex) {
            throw new Error("Keystore is locked");
        }
        
        const metadata = this.getWallet(walletId);
        if (!metadata) {
            throw new Error("Wallet not found");
        }
        
        const encryptedShare = await this.loadEncryptedShare(walletId);
        if (!encryptedShare) {
            throw new Error("Encrypted share not found");
        }
        
        return {
            version: this.keystoreIndex.version,
            device_id: this.keystoreIndex.device_id,
            exportedAt: Date.now(),
            wallets: [{
                metadata,
                encryptedShare
            }]
        };
    }
    
    /**
     * Import wallet from backup
     */
    public async importWallet(backup: KeystoreBackup, password: string): Promise<void> {
        if (!this.isUnlocked) {
            throw new Error("Keystore is locked");
        }
        
        for (const wallet of backup.wallets) {
            // Check if wallet already exists
            if (this.getWallet(wallet.metadata.id)) {
                console.warn("[KeystoreService] Wallet already exists:", wallet.metadata.id);
                continue;
            }
            
            const encrypted = wallet.encryptedShare;
            const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0));
            const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
            const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
            const key = await this.deriveKey(password, salt);
            let share: KeyShareData;
            try {
                share = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)));
            } catch { throw new Error('Invalid password for backup'); }
            await this.addWallet(wallet.metadata.id, share, wallet.metadata);
        }
    }
    
    // === Private Helper Methods ===
    
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
        const key = this.curveShareKey(walletId, curve);
        await storage.setItem(`local:${key}`, await this.encryptSecret(walletId, shareJson));
        this.curveShares.set(key, shareJson);
    }

    /** The share JSON stored by `setCurveShare`, or null if the wallet has none. */
    public async getCurveShare(walletId: string, curve: string): Promise<string | null> {
        if (!this.isUnlocked) {
            throw new Error("Keystore is locked");
        }
        const key = this.curveShareKey(walletId, curve);
        const cached = this.curveShares.get(key);
        if (cached !== undefined) return cached;
        const encrypted = await storage.getItem<EncryptedKeyShare>(`local:${key}`);
        if (!encrypted) return null;
        const json = await this.decryptSecret(encrypted);
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
        const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0));
        const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
        const key = await this.deriveKey(this.password, salt);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
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

    /**
     * Decrypt CLI data using base64 format
     */
    public async decryptCLIData(base64Data: string, password: string): Promise<string> {
        // CLI uses base64 encoding for the entire encrypted blob
        const encryptedData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        
        // CLI format: salt (16) + nonce (12) + ciphertext
        if (encryptedData.length < 28) {
            throw new Error("Invalid CLI encrypted data");
        }
        
        const salt = encryptedData.slice(0, 16);
        const nonce = encryptedData.slice(16, 28);
        const ciphertext = encryptedData.slice(28);
        
        // Note: CLI uses Argon2id, but for now we'll use PBKDF2
        // This is a limitation that would need proper Argon2id implementation
        const key = await this.deriveCLIKey(password, salt);
        
        // Decrypt using AES-GCM
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce },
            key,
            ciphertext
        );
        
        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
    }

    /**
     * Encrypt data in CLI format
     */
    private async encryptCLIData(data: string, exportPassword?: string): Promise<string> {
        if (!this.password) {
            throw new Error("No password set");
        }

        // Generate salt and nonce like CLI
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        
        // Derive key (should be Argon2id for full CLI compatibility)
        const key = await this.deriveCLIKey(exportPassword ?? this.password, salt);
        
        // Encrypt data
        const encoder = new TextEncoder();
        const dataBytes = encoder.encode(data);
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce },
            key,
            dataBytes
        );
        
        // Combine salt + nonce + ciphertext like CLI
        const combined = new Uint8Array(salt.length + nonce.length + ciphertext.byteLength);
        combined.set(salt, 0);
        combined.set(nonce, salt.length);
        combined.set(new Uint8Array(ciphertext), salt.length + nonce.length);
        
        // Encode as base64
        return btoa(String.fromCharCode(...combined));
    }

    /**
     * Derive key compatible with CLI (should use Argon2id for full compatibility)
     */
    private async deriveCLIKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
        // NOTE: CLI uses Argon2id, but WebCrypto doesn't support it natively
        // For now, using PBKDF2 with higher iterations as a fallback
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
                iterations: 600000, // Higher iterations to compensate for not using Argon2id
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
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
