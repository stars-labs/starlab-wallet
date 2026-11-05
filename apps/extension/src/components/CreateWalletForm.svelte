<script lang="ts">
    /**
     * Ext-1b: minimal "Create Wallet" form. Fires
     * CREATE_DKG_WALLET over chrome.runtime. Background announces via
     * `announce_session` — any TUI or extension peer on the same
     * signal server can discover and join.
     *
     * This is the DKG *initiator* flow only. Joiner side is Ext-1e.
     */
    import { createEventDispatcher } from "svelte";
    import { MESSAGE_TYPES } from "@stars-labs/types/messages";
    import Button from "../lib/ui/Button.svelte";
    import CopyButton from "../lib/ui/CopyButton.svelte";
    import FeatureHeader from "../lib/ui/FeatureHeader.svelte";
    import ChainIcon from "../lib/ui/ChainIcon.svelte";
    import Icon from "../lib/ui/Icon.svelte";
    import { guideError } from "../utils/error-guidance";
    export let wsConnected: boolean = false;
    export let room: string = "";

    const dispatch = createEventDispatcher<{
        created: { sessionId: string };
        cancel: void;
    }>();

    // Defaults match TUI's ThresholdConfig screen starting values.
    let total = 3;
    let threshold = 2;
    let walletName = "";
    let submitting = false;
    let errorMessage = "";

    // Keep threshold clamped to [2, total] — threshold < 2 defeats the
    // purpose of multisig, and > total is nonsense. Mirror TUI.
    $: if (threshold > total) threshold = total;
    $: if (threshold < 2) threshold = 2;
    $: if (total < 2) total = 2;
    $: if (total > 10) total = 10;

    async function handleSubmit() {
        errorMessage = "";
        if (!wsConnected) {
            errorMessage =
                "Signal server not connected. Check Settings → Signal Server.";
            return;
        }
        submitting = true;
        try {
            const response = await chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.CREATE_DKG_WALLET,
                name: walletName.trim() || undefined,
                total,
                threshold,
            });
            if (response?.success && response.sessionId) {
                dispatch("created", { sessionId: response.sessionId });
            } else {
                errorMessage = guideError(
                    response?.error ?? "Failed to create wallet (no error returned)",
                    "dkg",
                );
            }
        } catch (e) {
            errorMessage = guideError((e as Error).message ?? String(e), "dkg");
        } finally {
            submitting = false;
        }
    }
</script>

<div class="card card-pad">
    <FeatureHeader title="Create a shared wallet" subtitle="All supported chains, created together" icon="users" />
    <div class="threshold-preview"><Icon name="shield" size={28} /><div><strong>{threshold} of {total} devices</strong><span>required to approve a signature</span></div><span class="badge badge-primary">Multi-chain</span></div>
    <p class="mt-1 text-xs text-muted">
        All four chains included automatically. Your devices create all wallet
        keys together.
    </p>
    <div class="mt-3 flex flex-wrap gap-2" aria-label="Chains included automatically">
        {#each ["ethereum", "bitcoin", "solana", "sui"] as chain}
            <span class="chain-chip"><ChainIcon {chain} size={16} />{chain === "ethereum" ? "Ethereum" : chain === "bitcoin" ? "Bitcoin" : chain === "solana" ? "Solana" : "Sui"}</span>
        {/each}
    </div>

    <div class="mt-4">
        <label class="label" for="cw-name">Wallet name (optional)</label>
        <input
            id="cw-name"
            type="text"
            bind:value={walletName}
            placeholder="e.g. Treasury"
            class="input"
            disabled={submitting}
        />
    </div>

    <div class="mt-3 grid grid-cols-2 gap-3">
        <div>
            <label class="label" for="cw-total">Total devices</label>
            <input
                id="cw-total"
                type="number"
                min="2"
                max="10"
                bind:value={total}
                class="input"
                disabled={submitting}
            />
        </div>
        <div>
            <label class="label" for="cw-threshold">Needed to sign</label>
            <input
                id="cw-threshold"
                type="number"
                min="2"
                max={total}
                bind:value={threshold}
                class="input"
                disabled={submitting}
            />
        </div>
    </div>

    {#if room}
        <div class="mt-3 alert alert-info">
            <div class="mb-1.5 flex items-center justify-between gap-2">
                <span class="text-xs font-semibold">Room for co-signers</span>
                <CopyButton value={room} label="Copy room" title="Copy room" />
            </div>
            <p class="text-xs">
                Other devices must use this room before they can see the wallet
                session.
            </p>
            <code class="mono mt-2 block truncate text-xs">{room}</code>
        </div>
    {:else}
        <div class="mt-3 alert alert-warning text-xs">
            Generate and save a room before creating an MPC wallet.
        </div>
    {/if}

    <div class="mt-3 alert alert-info text-xs">
        Any <b>{threshold}</b> of <b>{total}</b> devices will be able to approve
        a transaction together.
    </div>

    {#if errorMessage}
        <div class="mt-3 alert alert-danger text-xs">{errorMessage}</div>
    {/if}

    <div class="mt-4 flex gap-2">
        <Button
            block
            on:click={handleSubmit}
            disabled={submitting || !wsConnected}
        >
            {submitting ? "Creating…" : "Create wallet"}
        </Button>
        <Button
            variant="secondary"
            on:click={() => dispatch("cancel")}
            disabled={submitting}
        >
            Cancel
        </Button>
    </div>
</div>

<style>
.chain-chip { display:inline-flex; align-items:center; gap:5px; padding:4px 7px; border-radius:8px; background:var(--c-surface-2); font-size:11px; font-weight:600; }
.threshold-preview { display:flex; gap:10px; align-items:center; padding:14px; border-radius:12px; background:var(--c-surface-2); margin:16px 0; }
.threshold-preview strong { display:block; font-size:14px; }
.threshold-preview span:not(.badge) { display:block; color:var(--c-muted); font-size:11px; }
</style>
