<script lang="ts">
    // Transaction activity feed, fetched from the background (getActivity →
    // ActivityService). Newest first; status badge per tx.
    //
    // Status flips live (#11) two ways: the background reconciler broadcasts
    // `activityChanged` when a receipt lands (instant when the popup is open),
    // and a light poll re-fetches while any row is still pending (covers a
    // broadcast lost to popup-open races).
    import { onMount, onDestroy } from "svelte";

    export let address: string | undefined = undefined;

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
            const res = await chrome.runtime.sendMessage({ type: "getActivity", address });
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
        <button class="af-refresh" on:click={load} title="Refresh">⟳</button>
    </div>

    {#if loading}
        <div class="af-muted">Loading…</div>
    {:else if error}
        <div class="af-error">{error}</div>
    {:else if items.length === 0}
        <div class="af-muted">No transactions yet.</div>
    {:else}
        <ul class="af-rows">
            {#each items as a (a.hash)}
                <li class="af-row">
                    <span class="af-kind">{a.kind}</span>
                    <span class="af-to">→ {short(a.to)}</span>
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
    .af-kind { grid-area: kind; font-weight: 600; text-transform: capitalize; }
    .af-to { grid-area: to; opacity: 0.8; font-family: monospace; }
    .af-status { grid-area: status; font-size: 11px; text-transform: uppercase; }
    .af-time { grid-area: time; opacity: 0.5; font-size: 11px; }
    .af-pending { color: #e0a800; }
    .af-confirmed { color: #27ae60; }
    .af-failed { color: #c0392b; }
    .af-muted { opacity: 0.6; }
    .af-error { color: #c0392b; font-size: 13px; }
</style>
