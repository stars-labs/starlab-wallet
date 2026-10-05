<script lang="ts">
    import { createEventDispatcher, onMount } from "svelte";
    import FeatureHeader from "./FeatureHeader.svelte";
    import Icon from "./Icon.svelte";

    export let title: string = "";
    export let subtitle: string = "";
    export let icon = "shield";
    /** Show the ✕ close affordance + allow backdrop click to close. */
    export let dismissable: boolean = true;

    let panel: HTMLDivElement;
    const controls = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')).filter(node => node.tabIndex >= 0);
    onMount(() => {
        const previous = document.activeElement;
        (controls()[0] ?? panel).focus();
        return () => {
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        };
    });
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === "Escape" && dismissable) {
            event.preventDefault();
            close();
        } else if (event.key === "Tab") {
            const targets = controls();
            const first = targets[0];
            const last = targets[targets.length - 1];
            if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        }
    }
    const dispatch = createEventDispatcher();
    function close() {
        if (dismissable) dispatch("close");
    }
</script>

<div
    class="modal-backdrop"
    role="presentation"
    on:click|self={close}
>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1" bind:this={panel} on:keydown={handleKeydown}>
        {#if title || dismissable}
            <div class="mb-3 flex items-start justify-between gap-3">
                <FeatureHeader {title} {subtitle} {icon} />
                {#if dismissable}
                    <button
                        class="icon-btn -mr-1 -mt-1 shrink-0"
                        style="width:1.9rem;height:1.9rem"
                        on:click={close}
                        aria-label="Close"
                    >
                        <Icon name="x" size={16} />
                    </button>
                {/if}
            </div>
        {/if}
        <slot />
    </div>
</div>
