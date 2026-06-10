<script lang="ts">
    // Send form: pick asset (native or ERC-20), recipient, amount → build the
    // eth_sendTransaction params with the pure sendService and emit `submit`.
    // The parent routes the tx through the existing MPC sign+broadcast flow, so
    // this component stays self-contained and unaware of the signing plumbing.
    import { onMount, createEventDispatcher } from "svelte";
    import { buildSendTransaction } from "../../../services/sendService";

    export let from: string;

    const dispatch = createEventDispatcher();

    type Asset = { symbol: string; address?: string; decimals: number; balance: string };
    let assets: Asset[] = [];
    let selected = 0; // index into assets; 0 = native
    let recipient = "";
    let amount = "";
    let error = "";
    let loadingAssets = true;

    async function loadAssets() {
        loadingAssets = true;
        try {
            const res = await chrome.runtime.sendMessage({ type: "getPortfolio", address: from });
            if (res?.success && res.portfolio) {
                assets = [
                    { symbol: res.portfolio.native.symbol, decimals: 18, balance: res.portfolio.native.balance },
                    ...res.portfolio.tokens,
                ];
            } else {
                assets = [{ symbol: "ETH", decimals: 18, balance: "0" }];
            }
        } catch {
            assets = [{ symbol: "ETH", decimals: 18, balance: "0" }];
        } finally {
            loadingAssets = false;
        }
    }

    function validate(): boolean {
        error = "";
        if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
            error = "Enter a valid 0x recipient address";
            return false;
        }
        if (!(Number(amount) > 0)) {
            error = "Enter an amount greater than 0";
            return false;
        }
        return true;
    }

    function submit() {
        if (!validate()) return;
        const asset = assets[selected];
        try {
            const tx = buildSendTransaction({
                from,
                to: recipient,
                amount,
                token: asset.address ? { address: asset.address, decimals: asset.decimals } : undefined,
            });
            dispatch("submit", { tx, asset: asset.symbol, amount, to: recipient });
        } catch (e) {
            error = (e as Error).message;
        }
    }

    onMount(loadAssets);
</script>

<div class="send-form">
    <div class="sf-head">Send</div>

    <label class="sf-field">
        <span>Asset</span>
        {#if loadingAssets}
            <span class="sf-muted">loading…</span>
        {:else}
            <select bind:value={selected}>
                {#each assets as a, i}
                    <option value={i}>{a.symbol} — {Number(a.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })}</option>
                {/each}
            </select>
        {/if}
    </label>

    <label class="sf-field">
        <span>To</span>
        <input placeholder="0x…" bind:value={recipient} spellcheck="false" />
    </label>

    <label class="sf-field">
        <span>Amount</span>
        <input placeholder="0.0" inputmode="decimal" bind:value={amount} />
    </label>

    {#if error}<div class="sf-error">{error}</div>{/if}

    <div class="sf-actions">
        <button class="sf-cancel" on:click={() => dispatch("cancel")}>Cancel</button>
        <button class="sf-submit" on:click={submit} disabled={loadingAssets}>Review &amp; sign</button>
    </div>
    <p class="sf-note">Signing runs the FROST threshold ceremony across your devices.</p>
</div>

<style>
    .send-form { display: flex; flex-direction: column; gap: 12px; }
    .sf-head { font-weight: 600; font-size: 16px; }
    .sf-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .sf-field input, .sf-field select { padding: 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.3); background: transparent; }
    .sf-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .sf-actions button { padding: 8px 16px; border-radius: 8px; cursor: pointer; border: 1px solid rgba(127,127,127,0.3); background: transparent; }
    .sf-submit { background: #6366f1; color: #fff; border-color: #6366f1; }
    .sf-submit:disabled { opacity: 0.5; cursor: default; }
    .sf-error { color: #c0392b; font-size: 13px; }
    .sf-muted { opacity: 0.6; }
    .sf-note { font-size: 11px; opacity: 0.55; margin: 0; }
</style>
