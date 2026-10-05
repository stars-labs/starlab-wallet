<script lang="ts">
    import TokenIcon from "../../../lib/ui/TokenIcon.svelte";
    import ChainIcon from "../../../lib/ui/ChainIcon.svelte";
    import Icon from "../../../lib/ui/Icon.svelte";
    // Token + native balances with fiat, fetched from the background
    // (getPortfolio → buildPortfolio). Self-contained; parent just mounts it.
    import { onMount } from "svelte";
    import type { SupportedChain } from "@stars-labs/types/appstate";

    export let address: string | undefined = undefined;
    export let networkId: number | undefined = undefined;
    export let chain: SupportedChain = "ethereum";

    let loading = true;
    let error = "";
    let portfolio: {
        native: { symbol: string; balance: string; fiat?: number };
        tokens: { symbol: string; name?: string; balance: string; fiat?: number; address?: string }[];
        totalFiat: number;
    } | null = null;

    async function load() {
        loading = true;
        error = "";
        try {
            const res = await chrome.runtime.sendMessage({ type: "getPortfolio", address, chain });
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
            : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, ...(Math.abs(n) >= 1_000_000 ? { notation: "compact" as const } : {}) })}`;
    }
    function fullFiat(n?: number): string {
        return n === undefined ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    }

    function amt(s: string): string {
        const n = Number(s);
        return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1_000_000 ? 2 : 6, ...(Math.abs(n) >= 1_000_000 ? { notation: "compact" as const } : {}) }) : s;
    }

    onMount(load);
</script>

<div class="token-list">
    <div class="tl-head">
        <span>Assets</span>
        <button class="tl-refresh" on:click={load} title="Refresh balances" aria-label="Refresh balances"><Icon name="refresh" size={18} /></button>
    </div>

    {#if loading}
        <div class="state-panel" aria-busy="true"><div class="skeleton-row"></div><div class="skeleton-row"></div><span>Loading balances…</span></div>
    {:else if error}
        <div class="state-panel state-error"><Icon name="alert" /><span>{error}</span><button class="btn btn-secondary btn-sm" on:click={load}>Try again</button></div>
    {:else if portfolio}

        <ul class="tl-rows">
            <li class="tl-row">
                <div class="asset-identity"><TokenIcon {networkId} symbol={portfolio.native.symbol} chain={String(chain)} /><div><span class="tl-sym">{portfolio.native.symbol}</span><span class="asset-network">Native asset</span></div></div>
                <span class="tl-bal" title={portfolio.native.balance} aria-label={portfolio.native.balance}>{amt(portfolio.native.balance)}</span>
                <span class="tl-fiat" title={fullFiat(portfolio.native.fiat)} aria-label={fullFiat(portfolio.native.fiat)}>{fiat(portfolio.native.fiat)}</span>
            </li>
            {#each portfolio.tokens as t (t.address)}
                <li class="tl-row">
                    <div class="asset-identity"><TokenIcon {networkId} symbol={t.symbol} chain={String(chain)} address={t.address} /><div><span class="tl-sym" title={t.name ?? t.symbol}>{t.name ?? t.symbol}</span><span class="asset-network">{t.symbol}</span></div></div>
                    <span class="tl-bal" title={t.balance} aria-label={t.balance}>{amt(t.balance)}</span>
                    <span class="tl-fiat" title={fullFiat(t.fiat)} aria-label={fullFiat(t.fiat)}>{fiat(t.fiat)}</span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .token-list { display: flex; flex-direction: column; gap: 8px; }
    .tl-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    .tl-refresh { background: none; border: none; cursor: pointer; font-size: 16px; opacity: 0.7; }
    .tl-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .tl-row { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(127,127,127,0.15); }
    .tl-sym { display:block; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .tl-bal { max-width:90px; text-align:right; white-space:nowrap; opacity:0.85; }
    .tl-fiat { min-width:70px; max-width:100px; text-align:right; white-space:nowrap; opacity:0.7; }
</style>
