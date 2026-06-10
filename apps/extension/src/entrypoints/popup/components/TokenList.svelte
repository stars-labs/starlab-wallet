<script lang="ts">
    // Token + native balances with fiat, fetched from the background
    // (getPortfolio → buildPortfolio). Self-contained; parent just mounts it.
    import { onMount } from "svelte";

    export let address: string | undefined = undefined;

    let loading = true;
    let error = "";
    let portfolio: {
        native: { symbol: string; balance: string; fiat?: number };
        tokens: { symbol: string; balance: string; fiat?: number; address?: string }[];
        totalFiat: number;
    } | null = null;

    async function load() {
        loading = true;
        error = "";
        try {
            const res = await chrome.runtime.sendMessage({ type: "getPortfolio", address });
            if (res?.success) portfolio = res.portfolio;
            else error = res?.error ?? "Failed to load balances";
        } catch (e) {
            error = (e as Error).message;
        } finally {
            loading = false;
        }
    }

    function fiat(n?: number): string {
        return n === undefined
            ? "—"
            : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
    function amt(s: string): string {
        const n = Number(s);
        return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : s;
    }

    onMount(load);
</script>

<div class="token-list">
    <div class="tl-head">
        <span>Assets</span>
        <button class="tl-refresh" on:click={load} title="Refresh">⟳</button>
    </div>

    {#if loading}
        <div class="tl-muted">Loading balances…</div>
    {:else if error}
        <div class="tl-error">{error}</div>
    {:else if portfolio}
        <div class="tl-total">{fiat(portfolio.totalFiat)}</div>
        <ul class="tl-rows">
            <li class="tl-row">
                <span class="tl-sym">{portfolio.native.symbol}</span>
                <span class="tl-bal">{amt(portfolio.native.balance)}</span>
                <span class="tl-fiat">{fiat(portfolio.native.fiat)}</span>
            </li>
            {#each portfolio.tokens as t (t.address)}
                <li class="tl-row">
                    <span class="tl-sym">{t.symbol}</span>
                    <span class="tl-bal">{amt(t.balance)}</span>
                    <span class="tl-fiat">{fiat(t.fiat)}</span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .token-list { display: flex; flex-direction: column; gap: 8px; }
    .tl-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    .tl-refresh { background: none; border: none; cursor: pointer; font-size: 16px; opacity: 0.7; }
    .tl-total { font-size: 22px; font-weight: 700; }
    .tl-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .tl-row { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(127,127,127,0.15); }
    .tl-sym { font-weight: 600; }
    .tl-bal { opacity: 0.85; }
    .tl-fiat { min-width: 70px; text-align: right; opacity: 0.7; }
    .tl-muted { opacity: 0.6; }
    .tl-error { color: #c0392b; font-size: 13px; }
</style>
