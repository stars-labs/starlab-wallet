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
    export let walletName = "";
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
    <div class="setup-heading">
        <FeatureHeader title="Configure wallet" subtitle="Choose the devices that approve transactions" icon="users" />
        <span class="setup-step">Setup 1 of 3</span>
    </div>
    <p class="mt-2 text-xs text-muted">All four chains included automatically</p>
    <div class="included-chains" aria-label="Chains included automatically">
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

    <p class="mt-2 text-xs text-muted" aria-live="polite">
        <strong>{threshold} of {total} devices</strong> must approve each transaction.
    </p>

    {#if room}
        <details class="room-details mt-3">
            <summary>Share room with devices</summary>
            <div class="room-value">
                <code class="mono text-xs">{room}</code>
                <CopyButton value={room} label="Copy room" title="Copy room" />
            </div>
            <p class="text-xs text-muted">Use this same room on the other devices to find your invitation.</p>
        </details>
    {:else}
        <div class="mt-3 alert alert-warning text-xs">
            Set up a shared room before inviting devices.
        </div>
    {/if}

    {#if errorMessage}
        <div class="mt-3 alert alert-danger text-xs">{errorMessage}</div>
    {/if}

    <p class="mt-3 text-xs text-muted">
        Invite your other devices next. Wallet setup starts when everyone joins.
    </p>
    <div class="mt-3 flex gap-2">
        <Button
            variant="secondary"
            on:click={() => dispatch("cancel")}
            disabled={submitting}
        >
            Cancel
        </Button>
        <Button
            block
            on:click={handleSubmit}
            disabled={submitting || !wsConnected}
        >
            {submitting ? "Inviting devices…" : "Invite devices"}
        </Button>
    </div>
</div>

<style>
    .setup-heading { display: flex; align-items: flex-start; gap: 12px; justify-content: space-between; }
    .setup-step { flex: none; padding-top: 3px; font-size: 11px; color: var(--c-muted); }
    .included-chains { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .chain-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border-radius: 8px; background: var(--c-surface-2); font-size: 11px; font-weight: 600; }
    .room-details { border-top: 1px solid var(--c-line); padding-top: 10px; }
    .room-details summary { cursor: pointer; font-size: 12px; color: var(--c-muted); }
    .room-value { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .room-value code { flex: 1; min-width: 0; overflow-wrap: anywhere; }
</style>
