<script lang="ts">
    import FeatureHeader from "../lib/ui/FeatureHeader.svelte";
    /**
     * M3 reshare: "Devices / Reshare" card for Settings.
     *
     * Shows the active wallet's current cohort (threshold / total /
     * device ids from the decrypted key share) and offers two flows:
     *
     *   - Rotate shares: same cohort, same threshold — every device
     *     gets a brand-new share, the group key (and all addresses)
     *     stay identical. Use after a device might have leaked its
     *     share.
     *   - Replace device: remove a lost/retired device from the
     *     cohort (optionally adjusting the threshold). The remaining
     *     devices reshare among themselves; the removed device's
     *     share becomes useless.
     *
     * Both flows announce a `reshare` session over the signal
     * server; the OTHER devices must be online and join (their popup
     * shows the invitation). The ceremony auto-starts when the full
     * new cohort has joined. Progress is polled from the
     * background's appState.reshareStatus.
     */
    import { onMount, onDestroy } from "svelte";
    import Button from "../lib/ui/Button.svelte";
    import Icon from "../lib/ui/Icon.svelte";

    type WalletMeta = { id: string; name: string; blockchain: string; address: string };
    type Cohort = {
        walletId: string;
        deviceId: string;
        threshold: number;
        total: number;
        participants: string[];
        curve: string;
        groupPublicKey: string;
    };
    type ReshareStatus = {
        sessionId: string;
        walletId: string;
        state: string;
        round1Received: string[];
        round2Received: string[];
        participants: string[];
        error?: string;
        saved?: boolean;
        updatedAt: number;
    };

    let wallets: WalletMeta[] = [];
    let selectedWalletId = "";
    let cohort: Cohort | null = null;
    let cohortError = "";

    // Replace-device form state
    let showReplaceForm = false;
    let removeDeviceId = "";
    let newThresholdInput = "";

    let startError = "";
    let activeSessionId = "";
    let joinedCount = 0;
    let joinedTotal = 0;
    let reshare: ReshareStatus | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    $: busy =
        !!activeSessionId &&
        reshare?.state !== "Complete" &&
        reshare?.state !== "Failed";

    async function send(message: Record<string, unknown>): Promise<any> {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (e) {
            return { success: false, error: (e as Error).message };
        }
    }

    async function loadWallets() {
        const resp = await send({ type: "getKeystoreStatus" });
        if (resp?.success && resp.status) {
            wallets = resp.status.wallets ?? [];
            const active = resp.status.activeWallet;
            if (!selectedWalletId) {
                selectedWalletId = active?.id ?? wallets[0]?.id ?? "";
            }
            if (selectedWalletId) await loadCohort();
        }
    }

    async function loadCohort() {
        cohort = null;
        cohortError = "";
        if (!selectedWalletId) return;
        const resp = await send({
            type: "getWalletCohort",
            walletId: selectedWalletId,
        });
        if (resp?.success && resp.cohort) {
            cohort = resp.cohort;
        } else {
            cohortError = resp?.error ?? "Could not load cohort";
        }
    }

    async function startReshare(removeIds: string[], threshold?: number) {
        startError = "";
        reshare = null;
        const resp = await send({
            type: "createReshareSession",
            walletId: selectedWalletId,
            ...(threshold ? { newThreshold: threshold } : {}),
            removeDeviceIds: removeIds,
        });
        if (!resp?.success) {
            startError = resp?.error ?? "Failed to start reshare";
            return;
        }
        activeSessionId = resp.sessionId;
        joinedCount = 1;
        joinedTotal = (cohort?.participants.length ?? 0) - removeIds.length;
        showReplaceForm = false;
        startPolling();
    }

    function rotateShares() {
        void startReshare([]);
    }

    function replaceDevice() {
        if (!removeDeviceId) {
            startError = "Pick the device to remove";
            return;
        }
        const remaining = (cohort?.participants.length ?? 0) - 1;
        let threshold: number | undefined;
        if (newThresholdInput.trim()) {
            threshold = Number(newThresholdInput.trim());
            if (!Number.isInteger(threshold) || threshold < 1 || threshold > remaining) {
                startError = `Threshold must be 1..${remaining}`;
                return;
            }
        } else if ((cohort?.threshold ?? 0) > remaining) {
            startError = `Current threshold ${cohort?.threshold} exceeds the ${remaining} remaining devices — set a new threshold`;
            return;
        }
        void startReshare([removeDeviceId], threshold);
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(poll, 1500);
        void poll();
    }
    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function poll() {
        const state = await send({ type: "getState" });
        if (!state) return;
        if (
            state.sessionInfo?.session_id === activeSessionId &&
            Array.isArray(state.sessionInfo?.participants)
        ) {
            joinedCount = state.sessionInfo.participants.length;
            joinedTotal = state.sessionInfo.total ?? joinedTotal;
        }
        const rs: ReshareStatus | undefined = state.reshareStatus;
        if (rs && rs.sessionId === activeSessionId) {
            reshare = rs;
            if (rs.state === "Complete" || rs.state === "Failed") {
                stopPolling();
                if (rs.state === "Complete") {
                    // Refresh the cohort display with the new params.
                    await loadCohort();
                }
            }
        }
    }

    function resetCeremony() {
        activeSessionId = "";
        reshare = null;
        startError = "";
        stopPolling();
    }

    function shortId(d: string): string {
        return d.length > 24 ? `${d.slice(0, 14)}…${d.slice(-6)}` : d;
    }

    function progressLabel(rs: ReshareStatus | null): string {
        if (!rs) {
            return `Waiting for devices to join (${joinedCount}/${joinedTotal || "?"})…`;
        }
        switch (rs.state) {
            case "WaitingForMesh":
                return "All devices joined — connecting the mesh…";
            case "Round1InProgress":
                return `Round 1 of 2 — packages ${rs.round1Received.length}/${rs.participants.length}`;
            case "Round2InProgress":
                return `Round 2 of 2 — packages ${rs.round2Received.length}/${rs.participants.length}`;
            case "Complete":
                return rs.saved
                    ? "Done — new Bitcoin, Solana or Sui shares saved. Their addresses are unchanged."
                    : "Ceremony finished, but saving the new share failed.";
            case "Failed":
                return `Reshare failed: ${rs.error ?? "unknown error"}`;
            default:
                return rs.state;
        }
    }

    onMount(loadWallets);
    onDestroy(stopPolling);
</script>

<div class="card card-pad space-y-2" data-testid="reshare-card">
    <FeatureHeader title="Manage wallet devices" subtitle="Refresh Bitcoin, Solana or Sui shares" icon="users" />
    <p class="text-xs text-muted">
        Refresh this wallet's Bitcoin, Solana or Sui shares while keeping
        their addresses. Ethereum shares and device access stay unchanged.
        To retire a device for Ethereum, create a new wallet with the devices
        you trust and transfer the funds to its new address.
        <strong>All remaining devices must be online and join.</strong>
    </p>

    {#if wallets.length > 1}
        <select
            class="select text-xs"
            bind:value={selectedWalletId}
            on:change={() => {
                resetCeremony();
                void loadCohort();
            }}
        >
            {#each wallets as w (w.id)}
                <option value={w.id}>{w.name}</option>
            {/each}
        </select>
    {/if}

    {#if cohortError}
        <p class="text-xs text-muted">{cohortError}</p>
    {:else if cohort}
        <div class="rounded-lg bg-surface-2 p-2.5 text-xs">
            <p class="mb-1">
                <span class="font-semibold">{cohort.threshold}-of-{cohort.total}</span>
                <span class="text-muted"> · {cohort.curve}</span>
            </p>
            <ul class="space-y-1">
                {#each cohort.participants as p (p)}
                    <li class="flex items-center justify-between gap-2">
                        <span class="mono truncate" class:font-semibold={p === cohort.deviceId}>
                            {shortId(p)}
                            {#if p === cohort.deviceId}<span class="text-primary">(this device)</span>{/if}
                        </span>
                    </li>
                {/each}
            </ul>
        </div>

        {#if !busy && reshare?.state !== "Complete"}
            <div class="flex items-center gap-2">
                <Button size="sm" on:click={rotateShares}>
                    Rotate shares
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    on:click={() => {
                        showReplaceForm = !showReplaceForm;
                        startError = "";
                    }}
                    disabled={cohort.participants.length <= 2}
                    title={cohort.participants.length <= 2
                        ? "A 2-device wallet can't lose a device"
                        : "Remove a lost device from the cohort"}
                >
                    Replace device
                </Button>
            </div>
        {/if}

        {#if showReplaceForm && !busy}
            <div class="space-y-2 rounded-lg bg-surface-2 p-2.5">
                <label class="text-xs">
                    Device to remove
                    <select class="select mt-1 text-xs" bind:value={removeDeviceId}>
                        <option value="">— pick a device —</option>
                        {#each cohort.participants.filter((p) => p !== cohort?.deviceId) as p (p)}
                            <option value={p}>{shortId(p)}</option>
                        {/each}
                    </select>
                </label>
                <label class="text-xs">
                    New threshold (of {cohort.participants.length - 1} remaining; blank = keep {Math.min(
                        cohort.threshold,
                        cohort.participants.length - 1,
                    )})
                    <input
                        type="text"
                        class="input mt-1 text-xs"
                        placeholder="e.g. 2"
                        bind:value={newThresholdInput}
                    />
                </label>
                <p class="text-[10px] text-muted">
                    The removed device's Bitcoin, Solana or Sui share cannot
                    join new signing sessions after the refresh. Its Ethereum
                    share stays unchanged. The removed device does NOT need to be online —
                    everyone else does. Adding a brand-new device is not
                    supported yet (every reshare participant must already hold
                    a share).
                </p>
                <Button size="sm" variant="danger" on:click={replaceDevice}>
                    Remove &amp; reshare
                </Button>
            </div>
        {/if}
    {:else}
        <p class="text-xs text-muted">
            Unlock the keystore and select a wallet to manage its devices.
        </p>
    {/if}

    {#if startError}
        <p class="text-xs text-muted" data-testid="reshare-error">{startError}</p>
    {/if}

    {#if activeSessionId}
        <div class="rounded-lg bg-surface-2 p-2.5 text-xs" data-testid="reshare-progress">
            <p class="mb-1 flex items-center gap-1.5 font-semibold">
                {#if reshare?.state === "Complete" && reshare?.saved}
                    <Icon name="check" size={14} /> Reshare complete
                {:else if reshare?.state === "Failed" || (reshare?.state === "Complete" && !reshare?.saved)}
                    Reshare problem
                {:else}
                    Reshare in progress
                {/if}
            </p>
            <p class="text-muted">{progressLabel(reshare)}</p>
            <p class="mono mt-1 break-all text-[10px] text-muted">
                session {activeSessionId}
            </p>
            {#if !reshare}
                <p class="mt-1 text-[10px] text-muted">
                    Other devices: open the wallet popup and accept the
                    reshare invitation.
                </p>
            {/if}
            {#if reshare?.state === "Complete" || reshare?.state === "Failed"}
                <div class="mt-2">
                    <Button size="sm" variant="ghost" on:click={resetCeremony}>
                        Dismiss
                    </Button>
                </div>
            {/if}
        </div>
    {/if}
</div>
