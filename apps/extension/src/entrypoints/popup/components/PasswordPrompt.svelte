<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import FeatureHeader from "../../../lib/ui/FeatureHeader.svelte";
    import Icon from "../../../lib/ui/Icon.svelte";
    import Button from "../../../lib/ui/Button.svelte";

    export let title: string = "Unlock your wallet";
    export let message: string = "Use your password to unlock this device";
    export let confirmMode: boolean = false;
    export let minLength: number = 8;
    export let authMode: "password" | "security-key" = "password";
    let method: "password" | "security-key" = confirmMode ? "security-key" : authMode;
    
    const dispatch = createEventDispatcher();
    
    let password: string = '';
    let confirmPassword: string = '';
    let showPassword: boolean = false;
    let showConfirmPassword: boolean = false;
    export let error: string = '';
    $: if (error) loading = false;
    let loading: boolean = false;
    
    function validatePassword(): boolean {
        error = '';
        
        if (password.length < minLength) {
            error = `Password must be at least ${minLength} characters`;
            return false;
        }
        
        if (confirmMode && password !== confirmPassword) {
            error = "Passwords do not match";
            return false;
        }
        
        return true;
    }
    
    async function handleSubmit() {
        if (!validatePassword()) {
            return;
        }
        
        loading = true;
        dispatch('submit', { password });
    }
    
    function handleCancel() {
        dispatch('cancel');
    }
    
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Tab') {
            const controls = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), [tabindex="0"]')).filter(node => node.tabIndex >= 0);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        } else if (event.key === 'Enter' && !confirmMode && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            handleSubmit();
        } else if (event.key === 'Escape') {
            handleCancel();
        }
    }

    // Svelte action — deliberate autofocus for a modal primary input.
    // Using the HTML `autofocus` attribute triggers a svelte-check a11y
    // warning (correct in the general case), but on a modal that has
    // just appeared the focus landing on the password field is the
    // expected UX, not a surprise.
    function autofocus(node: HTMLElement) {
        const previous = document.activeElement;
        node.focus();
        return { destroy() {
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        } };
    }
</script>

<div
    class="modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="password-prompt-title"
    tabindex="-1"
    on:keydown={handleKeydown}
>
    <div class="modal-panel">
        <div id="password-prompt-title"><FeatureHeader {title} icon="lock" /></div>
        <p class="mt-1 text-xs text-muted">{message}</p>

        {#if confirmMode}
            <div class="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Unlock method">
                <button class="method-choice" class:selected={method === "security-key"} aria-pressed={method === "security-key"}
                    on:click={() => { method = "security-key"; error = ""; }} disabled={loading}>
                    YubiKey <span class="text-[10px] text-primary">Recommended</span>
                </button>
                <button class="method-choice" class:selected={method === "password"} aria-pressed={method === "password"}
                    on:click={() => { method = "password"; error = ""; }} disabled={loading}>Password</button>
            </div>
        {/if}

        {#if method === "security-key"}
            <div class="key-intro mt-3" tabindex="-1" use:autofocus>
                <span class="key-symbol" aria-hidden="true"><Icon name="shield" size={23} /></span>
                <div><p class="text-sm font-semibold">{confirmMode ? "Unlock with your YubiKey" : "Your YubiKey is required"}</p>
                <p class="mt-1 text-xs text-muted">{confirmMode ? "No wallet password to create or remember." : "No wallet password needed."} Your browser may ask for your security key PIN and a touch.</p></div>
            </div>
            <p class="mt-3 text-xs text-muted">Continue in a secure Starlab tab so the browser prompt can stay open. Use a FIDO2 key that supports encryption.</p>
        {:else}
        <div class="mt-4">
            <label class="label" for="password">Password</label>
            <div class="relative">
                <input
                    id="password"
                    class="input pr-16"
                    type={showPassword ? "text" : "password"}
                    bind:value={password}
                    placeholder="Enter password"
                    autocomplete={confirmMode
                        ? "new-password"
                        : "current-password"}
                    use:autofocus
                    disabled={loading}
                />
                <button
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted hover:text-content"
                    on:click={() => (showPassword = !showPassword)}
                >
                    {showPassword ? "Hide" : "Show"}
                </button>
            </div>
        </div>

        {#if confirmMode}
            <div class="mt-3">
                <label class="label" for="confirmPassword">Confirm password</label
                >
                <div class="relative">
                    <input
                        id="confirmPassword"
                        class="input pr-16"
                        type={showConfirmPassword ? "text" : "password"}
                        bind:value={confirmPassword}
                        placeholder="Confirm password"
                        autocomplete="new-password"
                        disabled={loading}
                    />
                    <button
                        type="button"
                        class="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted hover:text-content"
                        on:click={() =>
                            (showConfirmPassword = !showConfirmPassword)}
                        >
                        {showConfirmPassword ? "Hide" : "Show"}
                    </button>
                </div>
            </div>
        {/if}

        {/if}

        {#if error}
            <div class="mt-3 alert alert-danger text-xs">{error}</div>
        {/if}

        <div class="mt-5 flex gap-2">
            <Button
                block
                on:click={() => {
                    if (method === "security-key") { loading = true; dispatch("securitykey"); }
                    else void handleSubmit();
                }}
                disabled={loading || (method === "password" &&
                    (!password || (confirmMode && !confirmPassword)))}
            >
                {loading ? (method === "security-key" ? "Opening…" : "Working…") : method === "security-key" ? "Continue with YubiKey" : "Continue"}
            </Button>
            <Button variant="secondary" on:click={handleCancel} disabled={loading}>
                Cancel
            </Button>
        </div>
    </div>
</div>
<style>
    .method-choice { display:flex; flex-direction:column; justify-content:center; gap:2px; min-height:48px; padding:8px; border:1px solid var(--c-line); border-radius:12px; background:var(--c-surface-2); font-size:13px; font-weight:600; }
    .method-choice.selected { border-color:var(--c-primary); box-shadow:0 0 0 1px var(--c-primary); }
    .key-intro { display:flex; gap:12px; padding:12px; border:1px solid var(--c-line); border-radius:12px; background:var(--c-surface-2); }
    .key-symbol { display:grid; place-items:center; flex-shrink:0; width:36px; height:36px; border-radius:10px; color:var(--c-primary); background:var(--c-primary-soft); font-size:30px; }
</style>
