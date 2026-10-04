<script lang="ts">
    import ChainIcon from "../../../lib/ui/ChainIcon.svelte";
    // Account model (BIP-44 mental model): Wallet → Account 0..N → per-chain
    // addresses from PINNED standard paths. Listing is passwordless — public
    // derivation runs in the engine wasm (byte-identical to the CLI).
    //
    // BIP-44 all the way (product decision): there is NO root entry — the
    // group key exists only as the derivation parent. Account 0 is the
    // default identity.
    import { createEventDispatcher, onMount } from "svelte";
    import { addressForChain } from "../../../utils/walletAccount";
    import {
        isSupportedChain,
        normalizeDerivedAddressChain,
        type SupportedChain,
    } from "@stars-labs/types/appstate";

    export let groupPublicKey: string;
    /** secp256k1 wallets: root key of the threshold-ECDSA (Ethereum) key. */
    export let ecdsaGroupPublicKey: string = "";
    export let curve: string; // "secp256k1" | "ed25519" | "unified"
    export let chain: SupportedChain = "ethereum";
    /** Currently selected account index (account 0 = default identity). */
    export let selected: number = 0;

    const dispatch = createEventDispatcher();

    type ChainAddr = { chain: string; path: string; address: string };
    type Account = { account: number; addresses: ChainAddr[] };

    let accounts: Account[] = [];
    let open = false;
    let loading = false;
    let error = "";
    let count = 3;
    let loadEpoch = 0;

    function normalizeAddresses(addresses: ChainAddr[]): ChainAddr[] {
        return addresses
            .map((addr) => {
                const normalized = normalizeDerivedAddressChain(addr.chain);
                return normalized ? { ...addr, chain: normalized } : addr;
            })
            .filter((addr) => !addr.chain || isSupportedChain(addr.chain));
    }

    function addressHint(addresses: ChainAddr[]): string {
        const addr = addressForChain(addresses, chain);
        return addr ? `${addr.slice(0, 10)}…` : "";
    }

    async function load() {
        if (!groupPublicKey) return;
        const epoch = ++loadEpoch;
        const frostKey = groupPublicKey;
        const ecdsaKey = ecdsaGroupPublicKey;
        loading = true;
        error = "";
        try {
            // Unified wallets hold two curves; the secp side carries the
            // group key the popup tracks — derive per the tracked curve.
            const curveKey = curve === "ed25519" ? "ed25519" : "secp256k1";
            const res = await chrome.runtime.sendMessage({
                type: "deriveAccounts",
                curve: curveKey,
                groupPublicKey: frostKey,
                count,
            });
            // A secp256k1 wallet's Ethereum accounts come from its
            // threshold-ECDSA key (the FROST key covers Bitcoin).
            const ecdsa =
                curveKey === "secp256k1" && ecdsaKey
                    ? await chrome.runtime.sendMessage({
                          type: "deriveAccounts",
                          curve: "secp256k1-ecdsa",
                          groupPublicKey: ecdsaKey,
                          count,
                      })
                    : null;
            if (epoch !== loadEpoch) return;
            if (res?.success) {
                accounts = res.accounts.map((account: Account) => ({
                    ...account,
                    addresses: normalizeAddresses([
                        ...(ecdsa?.success
                            ? (ecdsa.accounts.find((a: Account) => a.account === account.account)?.addresses ?? [])
                            : []),
                        ...(account.addresses ?? []),
                    ]),
                }));
                // First load: push account 0's addresses up so the hero shows
                // the BIP-44 identity immediately (root is never displayed).
                const current = accounts.find((a) => a.account === selected);
                if (current) {
                    dispatch("select", { account: selected, addresses: current.addresses });
                }
            } else error = res?.error ?? "derivation failed";
        } catch (e) {
            if (epoch === loadEpoch) error = (e as Error).message;
        } finally {
            if (epoch === loadEpoch) loading = false;
        }
    }

    function pick(idx: number) {
        const acct = accounts.find((a) => a.account === idx);
        dispatch("select", { account: idx, addresses: acct?.addresses ?? [] });
        open = false;
    }

    async function addAccount() {
        count += 1;
        await load();
    }

    onMount(load);
    $: if (groupPublicKey || ecdsaGroupPublicKey) load();
</script>

<div class="acct-picker">
    <button class="acct-btn" on:click={() => (open = !open)} title="Switch account">
        Account {selected} ▾
    </button>

    {#if open}
        <div class="acct-menu">
            {#if loading}
                <div class="acct-hint" style="padding:6px 10px">Loading accounts…</div>
            {:else if error}
                <div class="acct-err">{error}</div>
            {:else}
                {#each accounts as a (a.account)}
                    <button
                        class="acct-item"
                        class:active={selected === a.account}
                        on:click={() => pick(a.account)}
                    >
                        <ChainIcon chain={String(chain)} size={24} />Account {a.account}
                        <span class="acct-hint">{addressHint(a.addresses)}</span>
                    </button>
                {/each}
                <button class="acct-item acct-add" on:click={addAccount}>+ Add account</button>
            {/if}
        </div>
    {/if}
</div>

<style>
    .acct-picker { position: relative; display: inline-block; }
    .acct-btn { background: rgba(255,255,255,0.2); border: none; border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 600; color: inherit; cursor: pointer; backdrop-filter: blur(4px); }
    .acct-menu { position: absolute; top: 110%; left: 0; z-index: 30; min-width: 220px; background: var(--glass-raised); color: var(--c-text); border: 1px solid rgba(127,127,127,0.3); border-radius: 10px; padding: 4px; box-shadow: var(--shadow-pop); backdrop-filter: blur(20px); }
    .acct-item { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; background: none; border: none; border-radius: 6px; padding: 7px 10px; font-size: 12px; cursor: pointer; }
    .acct-item:hover { background: rgba(127,127,127,0.12); }
    .acct-item.active { font-weight: 700; }
    .acct-add { color: #6366f1; font-weight: 600; }
    .acct-hint { opacity: 0.55; font-size: 11px; font-family: monospace; }
    .acct-err { color: #c0392b; font-size: 11px; padding: 6px 10px; }
</style>
