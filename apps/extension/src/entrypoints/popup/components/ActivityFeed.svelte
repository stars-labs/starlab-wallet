<script lang="ts">
    import TokenIcon from "../../../lib/ui/TokenIcon.svelte";
    import ChainIcon from "../../../lib/ui/ChainIcon.svelte";
    import Icon from "../../../lib/ui/Icon.svelte";
    // Transaction activity feed, fetched from the background (getActivity →
    // ActivityService). Newest first; status badge per tx.
    //
    // Status flips live (#11) two ways: the background reconciler broadcasts
    // `activityChanged` when a receipt lands (instant when the popup is open),
    // and a light poll re-fetches while any row is still pending (covers a
    // broadcast lost to popup-open races).
    import { onMount, onDestroy } from "svelte";
    import { formatUnits } from "viem";
    import { nativeSymbol } from "../../../lib/ui/tokenIdentity";
    import type { SupportedChain } from "@stars-labs/types/appstate";

    export let address: string | undefined = undefined;
    export let chain: SupportedChain = "ethereum";

    let loading = true;
    let error = "";
    let items: {
        hash: string;
        to: string;
        value: string;
        kind: string;
        status: "pending" | "confirmed" | "failed";
        timestamp: number;
    }[] = [];

    async function load() {
        // Only show the loading state when there's nothing on screen yet —
        // background refreshes (poll / activityChanged) swap data in place.
        loading = items.length === 0;
        error = "";
        try {
            const res = await chrome.runtime.sendMessage({ type: "getActivity", address, chain });
            if (res?.success) items = res.activity ?? [];
            else error = res?.error ?? "Failed to load activity";
        } catch (e) {
            error = (e as Error).message;
        } finally {
            loading = false;
        }
    }

    function short(s: string): string {
        return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
    }
    function when(ts: number): string {
        try {
            return new Date(ts).toLocaleString();
        } catch {
            return "";
        }
    }

    function nativeValue(value: string): string {
        try { return Number(formatUnits(BigInt(value), chain === "solana" ? 9 : 18)).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
        catch { return "—"; }
    }

    const PENDING_POLL_MS = 15_000;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    function onRuntimeMessage(message: any) {
        if (message?.type === "activityChanged") load();
    }

    onMount(() => {
        load();
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
        pollTimer = setInterval(() => {
            if (items.some((a) => a.status === "pending")) load();
        }, PENDING_POLL_MS);
    });
    onDestroy(() => {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        if (pollTimer) clearInterval(pollTimer);
    });
</script>

<div class="activity">
    <div class="af-head">
        <span>Activity</span>
        <button class="af-refresh" on:click={load} title="Refresh activity" aria-label="Refresh activity"><Icon name="refresh" size={18} /></button>
    </div>

    {#if loading}
        <div class="state-panel" aria-busy="true"><div class="skeleton-row"></div><span>Loading activity…</span></div>
    {:else if error}
        <div class="state-panel state-error"><Icon name="alert" /><span>{error}</span><button class="btn btn-secondary btn-sm" on:click={load}>Try again</button></div>
    {:else if items.length === 0}
        <div class="state-panel"><Icon name="clock" size={32} /><strong>Your activity appears here</strong><span>Send or receive crypto to see transaction updates.</span></div>
    {:else}
        <ul class="af-rows">
            {#each items as a (a.hash)}
                <li class="af-row">
                    <span class="af-kind"><ChainIcon chain={String(chain)} size={28} /> {a.kind}</span>
                    <span class="af-to" title={a.to}>{short(a.to)}{#if a.kind !== "token-transfer"}<span class="af-value">{nativeValue(a.value)} {nativeSymbol(String(chain))}</span>{/if}</span>
                    <span class="af-status af-{a.status}">{a.status}</span>
                    <span class="af-time">{when(a.timestamp)}</span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .activity { display: flex; flex-direction: column; gap: 8px; }
    .af-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    .af-refresh { background: none; border: none; cursor: pointer; font-size: 16px; opacity: 0.7; }
    .af-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .af-row { display: grid; grid-template-columns: auto 1fr auto; grid-template-areas: "kind to status" "time time time"; gap: 4px 10px; padding: 8px 0; border-bottom: 1px solid rgba(127,127,127,0.15); font-size: 13px; }
    .af-kind { display:flex; align-items:center; gap:8px; grid-area: kind; font-weight: 600; text-transform: capitalize; }
    .af-to { grid-area: to; opacity: 0.8; font-family: monospace; }
    .af-status { grid-area: status; font-size: 11px; text-transform: uppercase; }
    .af-value { display:block; font-family:var(--font-sans); color:var(--c-text); font-size:12px; }
    .af-time { grid-area: time; opacity: 0.5; font-size: 11px; }
    .af-pending { color: var(--c-warning-fg); }
    .af-confirmed { color: var(--c-success-fg); }
    .af-failed { color: var(--c-danger-fg); }
    .af-muted { opacity: 0.6; }
    .af-error { color: var(--c-danger-fg); font-size: 13px; }
</style>
