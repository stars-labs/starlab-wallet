import { Account } from "@stars-labs/types/account";
import type { SupportedChain } from "@stars-labs/types/appstate";

type AccountChangeCallback = (account: Account | null) => void;

class AccountService {
    private static instance: AccountService;
    private accounts: Account[] = [];
    private readonly STORAGE_KEY = 'wallet_accounts';
    private readonly CURRENT_ACCOUNT_KEY = 'wallet_current_account';
    private currentAccountId: string | undefined;
    private changeCallbacks: AccountChangeCallback[] = [];
    private initialized: boolean = false;

    private constructor() {
        // Don't call async methods in constructor
        this.initializeAsync();
    }

    public static getInstance(): AccountService {
        if (!AccountService.instance) {
            AccountService.instance = new AccountService();
        }
        return AccountService.instance;
    }

    private async initializeAsync(): Promise<void> {
        if (!this.initialized) {
            await this.loadAccounts();
            this.initialized = true;
        }
    }

    public async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.initializeAsync();
        }
    }

    // Testing utility method to reset singleton instance
    public static resetInstance(): void {
        AccountService.instance = undefined as any;
    }

    private async loadAccounts(): Promise<void> {
        try {
            // In test environment, chrome.storage might not be available
            if (typeof chrome !== 'undefined' && chrome.storage) {
                const result = await chrome.storage.local.get([this.STORAGE_KEY, this.CURRENT_ACCOUNT_KEY]);
                // Defensive: corrupted storage (non-array) must reset to [].
                const raw = result[this.STORAGE_KEY];
                this.accounts = Array.isArray(raw) ? raw : [];
                const current = result[this.CURRENT_ACCOUNT_KEY];
                this.currentAccountId = typeof current === 'string' ? current : undefined;
            } else {
                // Fallback for test environment
                this.accounts = [];
                this.currentAccountId = undefined;
            }
        } catch (error) {
            console.error('Failed to load accounts:', error);
            this.accounts = [];
        }
    }

    private async saveAccounts(): Promise<void> {
        // Propagate storage failures — callers (addAccount, removeAccount)
        // need to know if persistence failed, otherwise we corrupt the
        // in-memory cache without anything on disk to back it up.
        if (typeof chrome !== 'undefined' && chrome.storage) {
            await chrome.storage.local.set({ [this.STORAGE_KEY]: this.accounts });
        }
    }

    private async saveCurrentAccount(): Promise<void> {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            await chrome.storage.local.set({ [this.CURRENT_ACCOUNT_KEY]: this.currentAccountId });
        }
    }

    public async addAccount(account: Account): Promise<Account> {
        // Validate account structure
        if (!account || typeof account !== 'object') {
            throw new Error('Invalid account: must be an object');
        }
        
        if (!account.id || typeof account.id !== 'string') {
            throw new Error('Invalid account: id is required and must be a string');
        }
        
        if (!account.name || typeof account.name !== 'string') {
            throw new Error('Invalid account: name is required and must be a string');
        }
        
        if (!account.address || typeof account.address !== 'string') {
            throw new Error('Invalid account: address is required and must be a string');
        }
        
        if (!account.blockchain || typeof account.blockchain !== 'string') {
            throw new Error('Invalid account: blockchain is required and must be a string');
        }

        // Check for duplicate ID
        if (this.accounts.some(acc => acc.id === account.id)) {
            throw new Error('Account with this ID already exists');
        }

        // Check for duplicate address on same blockchain
        if (this.accounts.some(acc => acc.address === account.address && acc.blockchain === account.blockchain)) {
            throw new Error('Account with this address already exists for this blockchain');
        }

        this.accounts.push(account);
        await this.saveAccounts();
        return account;
    }

    public async updateAccount(account: Account): Promise<Account> {
        // Validate account
        if (!account.id || typeof account.id !== 'string') {
            throw new Error('Invalid account: id is required and must be a string');
        }

        const existingIndex = this.accounts.findIndex(acc => acc.id === account.id);
        if (existingIndex === -1) {
            throw new Error('Account not found');
        }

        // Update the account
        this.accounts[existingIndex] = {
            ...this.accounts[existingIndex],
            ...account,
            // Preserve original creation time
            created: this.accounts[existingIndex].created
        };
        
        await this.saveAccounts();
        return this.accounts[existingIndex];
    }

    public async addOrUpdateAccount(account: Account): Promise<Account> {
        const existingAccount = this.accounts.find(acc => acc.id === account.id);
        if (existingAccount) {
            console.log(`[AccountService] Account ${account.id} already exists, updating instead`);
            return await this.updateAccount(account);
        } else {
            console.log(`[AccountService] Creating new account ${account.id}`);
            return await this.addAccount(account);
        }
    }

    public async removeAccount(accountId: string): Promise<void> {
        const accountIndex = this.accounts.findIndex(acc => acc.id === accountId);
        if (accountIndex === -1) {
            throw new Error('Account not found');
        }

        const removedAccount = this.accounts[accountIndex];
        this.accounts.splice(accountIndex, 1);

        // If this was the current account, clear current account
        if (this.currentAccountId === removedAccount.id) {
            this.currentAccountId = undefined;
        }

        await this.saveAccounts();
        await this.saveCurrentAccount();
        this.notifyAccountChange(this.getCurrentAccount());
    }

    public getAccounts(): Account[] {
        return this.accounts;
    }

    public getAccount(address: string): Account | undefined {
        return this.accounts.find(acc => acc.address === address);
    }

    /**
     * Address-keyed lookup. Complementary to `getAccountById`; matches
     * the pair naming convention the test suite expects. Returns null
     * (not undefined) for consistency with `getAccountById`.
     */
    public getAccountByAddress(address: string): Account | null {
        return this.accounts.find(acc => acc.address === address) || null;
    }

    public getAccountById(id: string): Account | null {
        return this.accounts.find(acc => acc.id === id) || null;
    }

    public getAccountsByBlockchain(blockchain: SupportedChain): Account[] {
        return this.accounts.filter(acc => acc.blockchain === blockchain);
    }

    public getCurrentAccount(): Account | null {
        // Pure read: returns null when no account has been explicitly
        // selected. Callers that want "pick one if unset" must use
        // ensureDefaultAccount(), which is the opt-in helper.
        if (!this.currentAccountId) return null;
        return this.accounts.find(acc => acc.id === this.currentAccountId) || null;
    }

    public async ensureDefaultAccount(): Promise<Account | null> {
        const current = this.getCurrentAccount();
        if (current && (current.type === 'hardware' || current.type === 'watch-only')) return current;
        const external = this.accounts.find(account => account.type === 'hardware' || account.type === 'watch-only');
        if (external) {
            await this.setCurrentAccount(external.id);
            return external;
        }
        if (current) await this.setCurrentAccount(null);
        return null;
    }

    /**
     * Set the active account by id, or pass `null` to clear the
     * active selection (useful for sign-out / account-reset flows
     * without wiping the full account list).
     */
    public async setCurrentAccount(accountId: string | null): Promise<void> {
        if (accountId === null) {
            this.currentAccountId = undefined;
            await this.saveCurrentAccount();
            this.notifyAccountChange(null);
            return;
        }
        const account = this.accounts.find(acc => acc.id === accountId);
        if (!account) {
            throw new Error('Account not found');
        }
        this.currentAccountId = account.id;
        await this.saveCurrentAccount();
        this.notifyAccountChange(account);
    }

    public async clearAccounts(): Promise<void> {
        this.accounts = [];
        this.currentAccountId = undefined;
        await this.saveAccounts();
        await this.saveCurrentAccount();
        this.notifyAccountChange(null);
    }

    public onAccountChange(callback: AccountChangeCallback): void {
        this.changeCallbacks.push(callback);
    }

    public removeAccountChangeListener(callback: AccountChangeCallback): void {
        this.changeCallbacks = this.changeCallbacks.filter(cb => cb !== callback);
    }

    /**
     * Symmetric with `onAccountChange` — the on/off naming pair
     * is what most listener APIs expose (EventTarget, Node EE).
     * Delegates to removeAccountChangeListener for the same effect.
     */
    public offAccountChange(callback: AccountChangeCallback): void {
        this.removeAccountChangeListener(callback);
    }

    private notifyAccountChange(account: Account | null): void {
        this.changeCallbacks.forEach(callback => callback(account));
    }
}

export default AccountService; 
