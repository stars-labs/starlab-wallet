<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import type { SessionInfo } from "@stars-labs/types/session";
    import { DkgState } from "@stars-labs/types/dkg";
    import FeatureHeader from "../../../lib/ui/FeatureHeader.svelte";
    import CopyButton from "../../../lib/ui/CopyButton.svelte";
    import Button from "../../../lib/ui/Button.svelte";

    export let session: SessionInfo;
    export let state: DkgState;
    export let deviceId: string;
    export let room: string;
    export let invite: string;
    export let connections: Record<string, boolean> = {};
    export let ethereumStatus: string | null = null;
    export let preparationLabel = "Preparing the Ethereum key";
    export let error = "";
    const dispatch = createEventDispatcher<{ review: void; connection: void }>();
    $: refreshing = session.session_type === "reshare";
    $: failed = state === DkgState.Failed;
    $: waiting = state === DkgState.Idle || state === DkgState.Initializing;
    $: joined = session.participants.length;
    $: progress = ethereumStatus === "waiting-primes"
        ? `${preparationLabel}. This can take a few minutes.`
        : ethereumStatus === "aux-info" || ethereumStatus === "keygen"
          ? "Creating the Ethereum key. This can take a few minutes."
          : "Your devices are generating all wallet keys together.";
</script>

<section class="card card-pad space-y-3" data-testid="wallet-setup-status" aria-live="polite">
    <div class="flex items-start justify-between gap-2">
        <FeatureHeader
            title={failed ? (refreshing ? "Device refresh failed" : "Wallet setup failed") : waiting ? (refreshing ? "Connect your wallet devices" : "Invite your devices") : refreshing ? "Refreshing wallet devices" : "Creating your wallet"}
            subtitle={refreshing ? "Your wallet addresses stay the same" : failed ? "Your wallet has not been created" : waiting ? "Share the invitation with your other devices" : "Keep your devices connected"}
            icon={failed ? "shield" : "users"}
        />
        <span class="badge badge-muted whitespace-nowrap">{failed ? "Needs attention" : refreshing ? "Device refresh" : `Setup ${waiting ? 2 : 3} of 3`}</span>
    </div>

    {#if failed}
        <p class="text-sm text-muted">Check that your other devices are online and using the same room, then review your setup.</p>
        <Button block on:click={() => refreshing ? dispatch("connection") : dispatch("review")}>{refreshing ? "Check connection" : "Review setup"}</Button>
    {:else if waiting}
        <div class="flex items-center justify-between gap-2 rounded-xl bg-surface-2 p-3">
            <div>
                <p class="text-sm font-semibold">{joined} of {session.total} devices joined</p>
                <p class="text-xs text-muted">All {session.total} devices join {refreshing ? "the refresh" : "setup"}; any {session.threshold} can sign later.</p>
            </div>
            <CopyButton value={invite} label="Copy invite" title="Copy wallet setup invitation" />
        </div>
        <ul class="space-y-1">
            {#each session.participants as participant, index}
                <li class="flex items-center justify-between gap-2 py-1 text-xs">
                    <span>{participant === deviceId ? "This device" : `Device ${index + 1}`}</span>
                    <span class="text-muted">{participant === deviceId || connections[participant] ? "Connected" : "Joining…"}</span>
                </li>
            {/each}
        </ul>
        <p class="text-xs text-muted">Setup starts automatically when every device has joined and connected.</p>
    {:else}
        <div class="alert alert-info text-sm" data-testid="dkg-progress">{refreshing ? "Your devices are refreshing their wallet keys. Keep them connected until this finishes." : progress}</div>
        {#if !refreshing}<p class="text-xs text-muted">Your wallet will be available after all keys are ready and saved on this device.</p>{/if}
    {/if}

    <details class="border-t border-line pt-2 text-xs text-muted">
        <summary class="cursor-pointer">Connection details</summary>
        <dl class="mt-2 space-y-2">
            <div><dt>Room</dt><dd class="mono break-all">{room || "No room set"}</dd></div>
            <div><dt>Session</dt><dd class="mono break-all">{session.session_id}</dd></div>
            {#if error}<div><dt>Last issue</dt><dd class="break-words">{error}</dd></div>{/if}
        </dl>
    </details>
</section>
