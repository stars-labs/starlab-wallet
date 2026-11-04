<script lang="ts">
    import ChainIcon from "../lib/ui/ChainIcon.svelte";
    import { onMount } from 'svelte';
    import type { Account } from "@stars-labs/types/account";
    import { isEvmChain, type SupportedChain } from "@stars-labs/types/appstate";
    import AccountService from '../services/accountService';
    
    export let blockchain: SupportedChain = 'ethereum';
    
    let currentAccount: Account | null = null;
    let accounts: Account[] = [];
    let showAccountSelector = false;
    let accountService: AccountService;
    
    onMount(async () => {
        accountService = AccountService.getInstance();
        await loadAccounts();
        
        // Listen for account changes
        accountService.onAccountChange((account) => {
            void loadAccounts();
        });
    });
    
    async function loadAccounts() {
        await accountService.ensureInitialized();
        accounts = accountService.getAccounts().filter(
            (account) =>
                (account.type === 'hardware' || account.type === 'watch-only') && (
                    account.blockchain === blockchain ||
                    (isEvmChain(account.blockchain) && isEvmChain(blockchain))
                ),
        );
        currentAccount = accounts.find(account => account.id === accountService.getCurrentAccount()?.id) ?? null;
        console.log('[AccountManager] Loaded accounts:', accounts);
    }
    
    $: if (accountService && blockchain) void loadAccounts();

    function toggleAccountSelector() {
        showAccountSelector = !showAccountSelector;
    }
    
    async function selectAccount(accountId: string) {
        try {
            await accountService.setCurrentAccount(accountId);
            showAccountSelector = false;
        } catch (error) {
            console.error('[AccountManager] Error selecting account:', error);
        }
    }
    
    function formatAddress(address: string): string {
        if (address.length <= 10) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    
    function copyAddress(address: string) {
        navigator.clipboard.writeText(address);
        // Could add a toast notification here
    }

    function accountBadge(account: Account): string {
        const tags = account.metadata?.tags ?? [];
        if (account.type === 'watch-only') return 'Simulation';
        if (tags.includes('ledger') || account.id.startsWith('ledger:')) return 'Ledger';
        if (tags.includes('yubikey') || account.id.startsWith('yubikey:')) return 'YubiKey';
        if (account.type === 'hardware') return 'Hardware';
        return '';
    }

    function nativeSymbol(chain: string): string {
        if (chain === 'solana') return 'SOL';
        if (chain === 'bitcoin') return 'BTC';
        if (chain === 'sui') return 'SUI';
        if (chain === 'polygon') return 'POL';
        return 'ETH';
    }
</script>

<div class="account-manager">
    <div
        class="current-account"
        role="button"
        tabindex="0"
        on:click={toggleAccountSelector}
        on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleAccountSelector()}
    >
        {#if currentAccount}
            <ChainIcon chain={String(blockchain)} size={32} /><div class="account-info">
                <div class="account-name">
                    {currentAccount.name}
                    {#if accountBadge(currentAccount)}
                        <span class="account-badge" class:watch-badge={currentAccount.type === 'watch-only'} title={currentAccount.type === 'watch-only' ? 'Watch-only simulation account' : 'Signed on a hardware device'}>{accountBadge(currentAccount)}</span>
                    {/if}
                </div>
                <div class="account-address">{formatAddress(currentAccount.address)}</div>
            </div>
            <div class="account-balance">
                {currentAccount.balance || '0'} {nativeSymbol(blockchain)}
            </div>
        {:else}
            <div class="no-account">No account selected</div>
        {/if}
        <svg class="chevron {showAccountSelector ? 'rotate' : ''}" width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
    </div>
    
    {#if showAccountSelector}
        <div class="account-dropdown">
            <div class="dropdown-header">
                <h3>External accounts</h3>
            </div>

            <div class="accounts-list">
                {#each accounts as account}
                    <div
                        class="account-item {account.id === currentAccount?.id ? 'selected' : ''}"
                        role="button"
                        tabindex="0"
                        on:click={() => selectAccount(account.id)}
                        on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectAccount(account.id)}
                    >
                        <div class="account-item-info">
                            <div class="account-item-name">
                                {account.name}
                                {#if accountBadge(account)}
                                    <span class="account-badge" class:watch-badge={account.type === 'watch-only'} title={account.type === 'watch-only' ? 'Watch-only simulation account' : 'Signed on a hardware device'}>{accountBadge(account)}</span>
                                {/if}
                            </div>
                            <div class="account-item-address">
                                {formatAddress(account.address)}
                                <button
                                    class="copy-button"
                                    aria-label="Copy address"
                                    on:click|stopPropagation={() => copyAddress(account.address)}
                                >
                                    <svg width="12" height="12" viewBox="0 0 12 12">
                                        <path d="M3 2h5v5M3 3v6h6V4" stroke="currentColor" fill="none"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="account-item-balance">
                            {account.balance || '0'} {nativeSymbol(blockchain)}
                        </div>
                    </div>
                {/each}
                
                {#if accounts.length === 0}
                    <div class="no-accounts">
                        No accounts yet. Create one above.
                    </div>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .account-manager {
        position: relative;
        width: 100%;
    }

    .current-account {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: var(--c-surface);
        border: 1px solid var(--c-line);
        border-radius: 14px;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .current-account:hover {
        background: var(--c-surface-2);
    }

    .account-info {
        flex: 1;
        min-width: 0;
    }

    .account-name {
        font-weight: 600;
        font-size: 14px;
        color: var(--c-text);
    }

    .account-badge {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.4;
        vertical-align: middle;
        color: var(--c-primary-fg);
        background: var(--c-primary);
        border-radius: 6px;
    }

    .watch-badge {
        color: var(--c-info-fg);
        background: var(--c-info-soft);
    }

    .account-address {
        font-size: 12px;
        color: var(--c-muted);
        font-family: var(--font-mono, monospace);
    }

    .account-balance {
        font-weight: 600;
        font-size: 14px;
        color: var(--c-text);
        margin-right: 8px;
    }

    .no-account {
        color: var(--c-muted);
        font-style: italic;
    }

    .chevron {
        transition: transform 0.2s;
        color: var(--c-muted);
    }

    .chevron.rotate {
        transform: rotate(180deg);
    }

    .account-dropdown {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        background: var(--c-surface);
        border: 1px solid var(--c-line);
        border-radius: 14px;
        box-shadow: var(--shadow-pop);
        z-index: 100;
        max-height: 400px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .dropdown-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid var(--c-line);
    }

    .dropdown-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
        color: var(--c-text);
    }

    .accounts-list {
        overflow-y: auto;
        max-height: 300px;
    }

    .account-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .account-item:hover {
        background: var(--c-surface-2);
    }

    .account-item.selected {
        background: var(--c-primary-soft);
    }

    .account-item-info {
        flex: 1;
        min-width: 0;
    }

    .account-item-name {
        font-weight: 600;
        font-size: 14px;
        color: var(--c-text);
    }

    .account-item-address {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        color: var(--c-muted);
        font-family: var(--font-mono, monospace);
    }

    .copy-button {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px;
        color: var(--c-muted);
        opacity: 0.7;
        transition: opacity 0.2s;
    }

    .copy-button:hover {
        opacity: 1;
        color: var(--c-text);
    }

    .account-item-balance {
        font-size: 14px;
        color: var(--c-text);
    }

    .no-accounts {
        padding: 24px;
        text-align: center;
        color: var(--c-muted);
        font-size: 14px;
    }
</style>
