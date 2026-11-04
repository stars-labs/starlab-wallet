// ===================================================================
// KEYSTORE MANAGER - PRODUCTION-READY KEYSTORE MANAGEMENT
// ===================================================================
//
// This service provides a production-ready interface for managing
// keystores with proper password handling, session management,
// and secure storage integration.
// ===================================================================

import { KeystoreService } from './keystoreService';
import { getHardwareVault, sealHardwareVault, openHardwareVault, encodeBytes, HARDWARE_VAULT_KEY, type HardwareAssertion, type HardwareVaultRecord } from './hardwareVault';

export interface KeystoreAuthStatus { mode: 'unconfigured' | 'password' | 'hardware'; credential?: HardwareVaultRecord; }
import type { KeyShareData, ExtensionWalletMetadata, EncryptedKeyShare } from "@stars-labs/types/keystore";

interface KeystoreSession {
    unlocked: boolean;
    unlockedAt?: number;
    deviceId: string;
    sessionTimeout: number; // in milliseconds
}

export class KeystoreManager {
    private static instance: KeystoreManager;
    private keystoreService: KeystoreService;
    private session: KeystoreSession | null = null;
    private hardwareVerifiedAt: number | null = null;
    private authenticationBusy = false;
    private lockEpoch = 0;
    private lockTimer: ReturnType<typeof setTimeout> | null = null;
    
    // Default session timeout: 15 minutes
    private readonly DEFAULT_SESSION_TIMEOUT = 15 * 60 * 1000;
    
    private constructor() {
        this.keystoreService = KeystoreService.getInstance();
        this.initializeFromStorage();
    }
    
    public static getInstance(): KeystoreManager {
        if (!KeystoreManager.instance) {
            KeystoreManager.instance = new KeystoreManager();
        }
        return KeystoreManager.instance;
    }
    
    /**
     * Initialize from stored session if available
     */
    private async initializeFromStorage(): Promise<void> {
        try {
            const stored = await chrome.storage.session.get(['keystoreSession']);
            if (stored.keystoreSession) {
                this.session = stored.keystoreSession as KeystoreSession;
                
                // Check if session is still valid
                if (this.session && this.session.unlocked && this.session.unlockedAt) {
                    const elapsed = Date.now() - this.session.unlockedAt;
                    if (elapsed < this.session.sessionTimeout) {
                        // Session still valid, set up auto-lock timer
                        this.setupAutoLockTimer(this.session.sessionTimeout - elapsed);
                    } else {
                        // Session expired
                        await this.lock();
                    }
                }
            }
        } catch (error) {
            console.error('[KeystoreManager] Failed to initialize from storage:', error);
        }
    }
    
    /**
     * Initialize keystore with device ID
     */
    public async initialize(deviceId: string): Promise<void> {
        await this.keystoreService.initialize(deviceId);
        
        if (!this.session) {
            this.session = {
                unlocked: false,
                deviceId,
                sessionTimeout: this.DEFAULT_SESSION_TIMEOUT
            };
            await this.saveSession();
        }
    }
    
    /**
     * Check if keystore is initialized
     */
    public async isInitialized(): Promise<boolean> {
        await this.keystoreService.ready();
        // A password exists once a wallet is saved under it, or once it was
        // set this session. The locked session initialize() writes on every
        // startup does not count — it would skip first-run password setup.
        const wallets = this.keystoreService.getWallets();
        return (await getHardwareVault()) !== null || wallets.length > 0 || this.session?.unlocked === true;
    }
    
    public async getAuthStatus(): Promise<KeystoreAuthStatus> {
        await this.keystoreService.ready();
        const credential = await getHardwareVault();
        if (credential) return { mode: 'hardware', credential };
        return { mode: await this.isInitialized() ? 'password' : 'unconfigured' };
    }

    /** Enroll only an empty vault; never replace existing wallet encryption. */
    public async createHardwareKeystore(assertion: HardwareAssertion, deviceId?: string): Promise<void> {
        return this.authenticate(async epoch => {
            await this.keystoreService.ready();
            if (await this.isInitialized()) throw new Error('A vault already exists on this device');
            const secret = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
            const record = await sealHardwareVault(assertion, secret);
            const resolvedDeviceId = deviceId || this.session?.deviceId || 'default';
            await this.keystoreService.initialize(resolvedDeviceId);
            this.requireCurrentAuthentication(epoch);
            // Persist the authenticated empty-vault marker before reporting setup complete.
            await chrome.storage.local.set({ [HARDWARE_VAULT_KEY]: record });
            this.requireCurrentAuthentication(epoch);
            await this.unlockVaultSecret(secret, resolvedDeviceId, epoch);
        });
    }

    public async unlockHardwareKeystore(assertion: HardwareAssertion): Promise<void> {
        return this.authenticate(async epoch => {
            const record = await getHardwareVault();
            if (!record) throw new Error('No hardware vault is configured');
            const secret = await openHardwareVault(record, assertion);
            this.requireCurrentAuthentication(epoch);
            await this.unlockVaultSecret(secret, this.session?.deviceId || 'default', epoch);
        }, true);
    }

    private async unlockVaultSecret(secret: string, deviceId: string, epoch: number): Promise<void> {
        if (!await this.keystoreService.unlock(secret)) throw new Error('Hardware vault could not decrypt the wallet');
        this.requireCurrentAuthentication(epoch);
        this.session = { unlocked: true, unlockedAt: Date.now(), deviceId, sessionTimeout: this.DEFAULT_SESSION_TIMEOUT };
        await this.saveSession();
        this.requireCurrentAuthentication(epoch);
        this.setupAutoLockTimer(this.DEFAULT_SESSION_TIMEOUT);
        this.hardwareVerifiedAt = Date.now();
    }

    private requireCurrentAuthentication(epoch: number): void {
        if (epoch !== this.lockEpoch) throw new Error('Wallet was locked during authentication. Try again.');
    }

    /** Serialize changes to the one in-memory vault secret; a later lock wins. */
    private async authenticate<T>(operation: (epoch: number) => Promise<T>, lockFirst = false): Promise<T> {
        if (this.authenticationBusy) throw new Error('Another authentication operation is finishing. Try again.');
        this.authenticationBusy = true;
        if (lockFirst) this.lock();
        const epoch = this.lockEpoch;
        try {
            const result = await operation(epoch);
            this.requireCurrentAuthentication(epoch);
            return result;
        } catch (error) {
            this.lock();
            throw error;
        } finally { this.authenticationBusy = false; }
    }

    /** Fresh hardware touch authorizes a portable backup, without exposing the vault secret. */
    public hasRecentHardwareVerification(): boolean {
        return !this.isLocked() && this.hardwareVerifiedAt !== null
            && Date.now() >= this.hardwareVerifiedAt && Date.now() - this.hardwareVerifiedAt < 60_000;
    }

    public assertHardwareExportAuthorized(): void {
        if (!this.hasRecentHardwareVerification()) throw new Error('Verify your hardware key again before exporting a backup');
    }

    /**
     * Check if keystore is locked
     */
    public isLocked(): boolean {
        return !this.session?.unlocked || this.keystoreService.isLocked();
    }
    
    /**
     * Create a new keystore with password. Optional deviceId lets
     * callers bootstrap a new device's keystore before a session
     * exists (e.g. the first-wallet-on-this-device flow); if
     * omitted we reuse any session-known deviceId or fall back to
     * 'default'.
     */
    public async createKeystore(password: string, deviceId?: string): Promise<boolean> {
        try {
            return await this.authenticate(async epoch => {
                if (await getHardwareVault()) throw new Error('Use your hardware key to unlock this vault');
                const resolvedDeviceId =
                    deviceId || this.session?.deviceId || 'default';
                // Initialize keystore service
                await this.keystoreService.initialize(resolvedDeviceId);

                // Set the password and unlock
                const success = await this.keystoreService.unlock(password);
                this.requireCurrentAuthentication(epoch);

                if (success) {
                    this.session = {
                        unlocked: true,
                        unlockedAt: Date.now(),
                        deviceId: resolvedDeviceId,
                        sessionTimeout: this.DEFAULT_SESSION_TIMEOUT
                    };

                    await this.saveSession();
                    this.requireCurrentAuthentication(epoch);
                    this.setupAutoLockTimer(this.session.sessionTimeout);

                    return true;
                }
                
                return false;
            });
        } catch (error) {
            console.error('[KeystoreManager] Create keystore failed:', error);
            return false;
        }
    }
    
    /**
     * Unlock keystore with password
     */
    public async unlock(password: string, rememberDuration?: number): Promise<boolean> {
        try {
            return await this.authenticate(async epoch => {
                if (await getHardwareVault()) { this.lock(); return false; }
                const success = await this.keystoreService.unlock(password);
                this.requireCurrentAuthentication(epoch);
                
                if (success) {
                    if (!this.session) {
                        this.session = {
                            unlocked: true,
                            unlockedAt: Date.now(),
                            deviceId: 'default',
                            sessionTimeout: rememberDuration || this.DEFAULT_SESSION_TIMEOUT
                        };
                    } else {
                        this.session.unlocked = true;
                        this.session.unlockedAt = Date.now();
                        if (rememberDuration) {
                            this.session.sessionTimeout = rememberDuration;
                        }
                    }

                    await this.saveSession();
                    this.requireCurrentAuthentication(epoch);
                    this.setupAutoLockTimer(this.session.sessionTimeout);

                    return true;
                }
                
                return false;
            });
        } catch (error) {
            console.error('[KeystoreManager] Unlock failed:', error);
            this.lock();
            return false;
        }
    }
    
    /**
     * Lock keystore
     */
    public lock(): void {
        this.lockEpoch++;
        this.hardwareVerifiedAt = null;
        this.keystoreService.lock();
        
        if (this.session) {
            this.session.unlocked = false;
            this.session.unlockedAt = undefined;
            // Save session asynchronously without blocking
            this.saveSession().catch(error => {
                console.error('[KeystoreManager] Failed to save session after lock:', error);
            });
        }
        
        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
        }
        
        // Clear stored password hash asynchronously
        chrome.storage.local.remove(['keystorePasswordHash']).catch(error => {
            console.error('[KeystoreManager] Failed to clear password hash:', error);
        });
    }
    
    
    /**
     * Change keystore password
     */
    public async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
        if (!await this.unlock(oldPassword)) {
            return false;
        }
        
        // Re-encrypt all wallets with new password
        const wallets = this.keystoreService.getWallets();
        
        // Temporarily store all key shares
        const keyShares: Map<string, KeyShareData> = new Map();
        for (const wallet of wallets) {
            const keyShare = await this.keystoreService.getKeyShare(wallet.id);
            if (keyShare) {
                keyShares.set(wallet.id, keyShare);
            }
        }
        
        // Lock and unlock with new password
        await this.lock();
        
        // This is a simplified version - in production, you'd need to
        // re-encrypt all stored data with the new password
        // For now, we'll just update the session
        return await this.unlock(newPassword);
    }
    
    /**
     * Add wallet with auto-unlock check
     */
    public async addWallet(
        walletId: string,
        keyShareData: KeyShareData,
        metadata: ExtensionWalletMetadata
    ): Promise<boolean> {
        if (this.isLocked()) {
            console.error('[KeystoreManager] Cannot add wallet - keystore is locked');
            return false;
        }
        
        try {
            await this.keystoreService.addWallet(walletId, keyShareData, metadata);
            return true;
        } catch (error) {
            console.error('[KeystoreManager] Failed to add wallet:', error);
            return false;
        }
    }
    
    /**
     * M3 reshare: replace an existing wallet's key share in place
     * (same wallet id / group key / addresses, fresh share material).
     */
    public async updateWalletKeyShare(
        walletId: string,
        keyShareData: KeyShareData
    ): Promise<boolean> {
        if (this.isLocked()) {
            console.error('[KeystoreManager] Cannot update key share - keystore is locked');
            return false;
        }

        try {
            await this.keystoreService.updateWalletKeyShare(walletId, keyShareData);
            return true;
        } catch (error) {
            console.error('[KeystoreManager] Failed to update key share:', error);
            return false;
        }
    }

    /**
     * Get all wallets
     */
    public getWallets(): ExtensionWalletMetadata[] {
        return this.keystoreService.getWallets();
    }
    
    /**
     * Get active wallet
     */
    public getActiveWallet(): ExtensionWalletMetadata | null {
        const wallets = this.getWallets();
        return wallets.find(w => w.isActive) || wallets[0] || null;
    }
    
    /**
     * Set active wallet
     */
    public async setActiveWallet(walletId: string): Promise<boolean> {
        const wallets = this.getWallets();
        
        // Update all wallets' active status
        for (const wallet of wallets) {
            wallet.isActive = wallet.id === walletId;
        }
        
        // Save updated index
        await chrome.storage.local.set({
            'mpc_active_wallet_id': walletId
        });
        
        return true;
    }
    
    /**
     * Switch to a different wallet (alias for setActiveWallet)
     */
    public async switchWallet(walletId: string): Promise<boolean> {
        return this.setActiveWallet(walletId);
    }
    
    /**
     * Export wallet for backup
     */
    public async exportWallet(walletId: string, password: string): Promise<any> {
        if (!await this.unlock(password)) {
            throw new Error('Invalid password');
        }
        
        return await this.keystoreService.exportWallet(walletId);
    }
    
    /**
     * Import wallet from backup
     */
    public async importWallet(backup: any, password: string): Promise<boolean> {
        if (!await this.unlock(password)) {
            throw new Error('Invalid password');
        }
        
        try {
            await this.keystoreService.importWallet(backup, password);
            return true;
        } catch (error) {
            console.error('[KeystoreManager] Import failed:', error);
            return false;
        }
    }
    
    /**
     * Get key share for signing
     */
    public async getKeyShare(walletId: string): Promise<KeyShareData | null> {
        if (this.isLocked()) {
            console.error('[KeystoreManager] Cannot get key share - keystore is locked');
            return null;
        }
        
        return await this.keystoreService.getKeyShare(walletId);
    }

    public async updateWalletAddress(walletId: string, address: string, blockchain?: string): Promise<void> {
        if (this.isLocked()) throw new Error("Keystore is locked");
        await this.keystoreService.updateWalletAddress(walletId, address, blockchain);
    }

    /** Store another curve's share of a wallet (the threshold-ECDSA share). */
    public async setCurveShare(walletId: string, curve: string, shareJson: string): Promise<void> {
        if (this.isLocked()) throw new Error("Keystore is locked");
        await this.keystoreService.setCurveShare(walletId, curve, shareJson);
    }

    /** A wallet's share for `curve` (null when it has none). */
    public async getCurveShare(walletId: string, curve: string): Promise<string | null> {
        if (this.isLocked()) throw new Error("Keystore is locked");
        return await this.keystoreService.getCurveShare(walletId, curve);
    }

    /** Encrypt / decrypt a secret with the keystore password (the ECDSA prime cache). */
    public async encryptSecret(id: string, plaintext: string): Promise<EncryptedKeyShare> {
        if (this.isLocked()) throw new Error("Keystore is locked");
        return await this.keystoreService.encryptSecret(id, plaintext);
    }

    public async decryptSecret(encrypted: EncryptedKeyShare): Promise<string> {
        if (this.isLocked()) throw new Error("Keystore is locked");
        return await this.keystoreService.decryptSecret(encrypted);
    }

    // === Private Helper Methods ===
    
    private async saveSession(): Promise<void> {
        if (this.session) {
            await chrome.storage.session.set({
                keystoreSession: this.session
            });
        }
    }
    
    private setupAutoLockTimer(timeout: number): void {
        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
        }
        
        this.lockTimer = setTimeout(() => {
            console.log('[KeystoreManager] Auto-locking due to timeout');
            this.lock();
        }, timeout);
    }
    
    /**
     * Migrate imported keystores from chrome.storage.local
     */
    public async migrateFromChromeStorage(password: string): Promise<number> {
        if (!await this.unlock(password)) {
            throw new Error('Invalid password');
        }
        
        let migratedCount = 0;
        
        try {
            // Get all stored keystores
            const storage = await chrome.storage.local.get(null);
            const keystoreKeys = Object.keys(storage).filter(key => 
                key.startsWith('mpc_imported_keystore_')
            );
            
            for (const key of keystoreKeys) {
                const importedData = storage[key] as any;
                if (importedData && importedData.keystoreData) {
                    try {
                        // Parse the keystore data
                        const keystoreData = JSON.parse(importedData.keystoreData);
                        
                        // Create key share data
                        const keyShareData: KeyShareData = {
                            key_package: keystoreData.key_package || '',
                            public_key_package: keystoreData.public_key_package || '',
                            group_public_key: importedData.sessionInfo.group_public_key || '',
                            session_id: importedData.sessionInfo.session_id,
                            device_id: importedData.sessionInfo.device_id,
                            participant_index: importedData.sessionInfo.participant_index,
                            threshold: importedData.sessionInfo.threshold,
                            total_participants: importedData.sessionInfo.total_participants,
                            participants: [importedData.sessionInfo.device_id],
                            participant_identifiers: {
                                [importedData.sessionInfo.device_id]: importedData.sessionInfo.participant_index,
                            },
                            curve: importedData.sessionInfo.curve_type as 'secp256k1' | 'ed25519',
                            blockchains: importedData.sessionInfo.blockchains || [],
                            ethereum_address: importedData.addresses?.ethereum,
                            solana_address: importedData.addresses?.solana,
                            created_at: importedData.importedAt || Date.now()
                        };
                        
                        // Create wallet metadata
                        const metadata: ExtensionWalletMetadata = {
                            id: importedData.sessionInfo.session_id,
                            name: `Imported Wallet ${migratedCount + 1}`,
                            blockchain: importedData.chain || 'ethereum',
                            address: importedData.addresses?.[importedData.chain] || '',
                            session_id: importedData.sessionInfo.session_id,
                            isActive: migratedCount === 0, // First wallet is active
                            hasBackup: true
                        };
                        
                        // Add to keystore
                        await this.keystoreService.addWallet(
                            importedData.sessionInfo.session_id,
                            keyShareData,
                            metadata
                        );
                        
                        migratedCount++;
                        
                        // Remove from chrome.storage
                        await chrome.storage.local.remove([key]);
                    } catch (error) {
                        console.error(`[KeystoreManager] Failed to migrate ${key}:`, error);
                    }
                }
            }
            
            // Clean up other migration-related keys
            await chrome.storage.local.remove(['mpc_active_keystore_id']);
            
            console.log(`[KeystoreManager] Migrated ${migratedCount} keystores`);
        } catch (error) {
            console.error('[KeystoreManager] Migration failed:', error);
            throw error;
        }
        
        return migratedCount;
    }
}
