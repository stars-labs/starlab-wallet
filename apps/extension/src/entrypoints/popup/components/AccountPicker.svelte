<script lang="ts">
    // Account model (BIP-44 mental model): Wallet → Account 0..N → per-chain
    // addresses from PINNED standard paths. Listing is passwordless — public
    // derivation runs in the engine wasm (byte-identical to the CLI).
    //
    // BIP-44 all the way (product decision): there is NO root entry — the
    // group key exists only as the derivation parent. Account 0 is the
    // default identity.
    import { createEventDispatcher, onMount } from "svelte";

    export let groupPublicKey: string;
    export let curve: string; // "secp256k1" | "ed25519" | "unified"
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

    async function load() {
        if (!groupPublicKey) return;
        loading = true;
        error = "";
        try {
            // Unified wallets hold two curves; the secp side carries the
            // group key the popup tracks — derive per the tracked curve.
            const curveKey = curve === "ed25519" ? "ed25519" : "secp256k1";
            const res = await chrome.runtime.sendMessage({
                type: "deriveAccounts",
                curve: curveKey,
                groupPublicKey,
                count,
            });
            if (res?.success) {
                accounts = res.accounts;
                // First load: push account 0's addresses up so the hero shows
                // the BIP-44 identity immediately (root is never displayed).
                const current = accounts.find((a) => a.account === selected);
                if (current) {
                    dispatch("select", { account: selected, addresses: current.addresses });
                }
            } else error = res?.error ?? "derivation failed";
        } catch (e) {
            error = (e as Error).message;
        } finally {
            loading = false;
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
    $: if (groupPublicKey) load();
</script>

<div class="acct-picker">
    <button class="acct-btn" on:click={() => (open = !open)} title="Switch account">
        Account {selected} ▾
    </button>

    {#if open}
        <div class="acct-menu">
            {#if loading}
                <div class="acct-hint" style="padding:6px 10px">deriving…</div>
            {:else if error}
                <div class="acct-err">{error}</div>
            {:else}
                {#each accounts as a (a.account)}
                    <button
                        class="acct-item"
                        class:active={selected === a.account}
                        on:click={() => pick(a.account)}
                    >
                        Account {a.account}
                        <span class="acct-hint">{a.addresses[0]?.address.slice(0, 10)}…</span>
                    </button>
                {/each}
                <button class="acct-item acct-add" on:click={addAccount}>＋ Add account</button>
            {/if}
        </div>
    {/if}
</div>

<style>
    .acct-picker { position: relative; display: inline-block; }
    .acct-btn { background: rgba(255,255,255,0.2); border: none; border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 600; color: inherit; cursor: pointer; backdrop-filter: blur(4px); }
    .acct-menu { position: absolute; top: 110%; left: 0; z-index: 30; min-width: 220px; background: var(--surface, #fff); color: var(--text, #111); border: 1px solid rgba(127,127,127,0.3); border-radius: 10px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
    .acct-item { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; background: none; border: none; border-radius: 6px; padding: 7px 10px; font-size: 12px; cursor: pointer; }
    .acct-item:hover { background: rgba(127,127,127,0.12); }
    .acct-item.active { font-weight: 700; }
    .acct-add { color: #6366f1; font-weight: 600; }
    .acct-hint { opacity: 0.55; font-size: 11px; font-family: monospace; }
    .acct-err { color: #c0392b; font-size: 11px; padding: 6px 10px; }
</style>
