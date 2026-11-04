<script lang="ts">
    import ChainIcon from "../../../lib/ui/ChainIcon.svelte";
    // Account model (BIP-44 mental model): Wallet → Account 0..N → per-chain
    // addresses from PINNED standard paths. Listing is passwordless — public
    // derivation runs in the engine wasm (byte-identical to the CLI).
    //
    // BIP-44 all the way (product decision): there is NO root entry — the
    // group key exists only as the derivation parent. Account 0 is the
    // default identity.
    import { createEventDispatcher } from "svelte";
    import { addressForChain } from "../../../utils/walletAccount";
    import {
        isSupportedChain,
        type SupportedChain,
    } from "@stars-labs/types/appstate";

    export let frostGroupPublicKeys: { ed25519: string; secp256k1: string };
    export let ecdsaGroupPublicKey: string;
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

    function addressHint(addresses: ChainAddr[]): string {
        const addr = addressForChain(addresses, chain);
        return addr ? `${addr.slice(0, 10)}…` : "";
    }

    async function load(ed25519Key: string, secp256k1Key: string, ecdsaKey: string) {
        const epoch = ++loadEpoch;
        accounts = [];
        dispatch("select", { account: selected, addresses: [] });
        if (!ed25519Key || !secp256k1Key || !ecdsaKey) {
            loading = false;
            error = "Wallet keys are not ready.";
            return;
        }
        const requestedCount = count;
        loading = true;
        error = "";
        try {
            const requests = [
                { curve: "ed25519", groupPublicKey: ed25519Key },
                { curve: "secp256k1", groupPublicKey: secp256k1Key },
                { curve: "secp256k1-ecdsa", groupPublicKey: ecdsaKey },
            ];
            const results = await Promise.all(requests.map(request => chrome.runtime.sendMessage({
                type: "deriveAccounts", ...request, count: requestedCount,
            })));
            if (epoch !== loadEpoch) return;
            if (results.some(result => !result?.success || !Array.isArray(result.accounts))) {
                throw new Error("Could not load wallet accounts. Try again.");
            }
            accounts = Array.from({ length: requestedCount }, (_, account) => ({
                account,
                addresses: results.flatMap((result, index) => {
                    const derived: Account | undefined = result.accounts.find((item: Account) => item.account === account);
                    if (!derived || !Array.isArray(derived.addresses)) throw new Error("Could not load every chain for this account.");
                    // Each algorithm is authoritative only for its own chains.
                    // In particular, a FROST secp256k1 key must never supply an EVM address.
                    return derived.addresses.filter(address => isSupportedChain(address.chain) && (
                        index === 0 ? address.chain === "solana" || address.chain === "sui" :
                        index === 1 ? address.chain === "bitcoin" : address.chain === "ethereum"
                    ));
                }),
            }));
            const current = accounts.find(account => account.account === selected);
            if (current) dispatch("select", { account: selected, addresses: current.addresses });
        } catch (e) {
            if (epoch === loadEpoch) {
                accounts = [];
                error = (e as Error).message;
            }
        } finally {
            if (epoch === loadEpoch) loading = false;
        }
    }

    function pick(idx: number) {
        const acct = accounts.find((a) => a.account === idx);
        if (!acct) return;
        dispatch("select", { account: idx, addresses: acct.addresses });
        open = false;
    }

    async function addAccount() {
        count += 1;
        await load(frostGroupPublicKeys.ed25519, frostGroupPublicKeys.secp256k1, ecdsaGroupPublicKey);
    }

    $: ed25519Key = frostGroupPublicKeys.ed25519;
    $: secp256k1Key = frostGroupPublicKeys.secp256k1;
    $: void load(ed25519Key, secp256k1Key, ecdsaGroupPublicKey);
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
