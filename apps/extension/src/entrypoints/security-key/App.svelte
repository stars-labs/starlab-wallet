<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import Button from '../../lib/ui/Button.svelte';
    import Icon from '../../lib/ui/Icon.svelte';
    import { initTheme } from '../../lib/theme';
    import { createHardwareCredential, getHardwareAssertion } from '../../services/hardwareWebAuthn';
    import { SECURITY_KEY_MESSAGES, type SecurityKeyMessage } from '../../services/securityKeyProtocol';
    import type { HardwareVaultRecord } from '../../services/hardwareVault';

    const requestId = new URLSearchParams(location.search).get('request') || '';
    let creating = false;
    let phase: 'loading' | 'ready' | 'waiting' | 'finishing' | 'success' | 'error' | 'cancelled' | 'unsupported' = 'loading';
    let error = '';
    let credential: Pick<HardwareVaultRecord, 'credentialId' | 'prfSalt'> | undefined;
    let controller: AbortController | undefined;
    let attempt = 0;
    let requestSpent = false;
    let cancellation: Promise<unknown> = Promise.resolve();
    let requestLoaded = false;
    let disposeTheme: (() => void) | undefined;

    onMount(() => {
        disposeTheme = initTheme();
        void loadStatus();
    });
    onDestroy(() => { controller?.abort(); disposeTheme?.(); });

    async function loadStatus() {
        if (!isSecureContext || !('PublicKeyCredential' in window) || !navigator.credentials) {
            phase = 'unsupported';
            return;
        }
        try {
            const response = await chrome.runtime.sendMessage({ type: SECURITY_KEY_MESSAGES.GET_REQUEST, requestId } satisfies SecurityKeyMessage);
            if (!response?.success) throw new Error(response?.error || 'Could not read this device’s unlock method.');
            if (response.action !== 'create' && response.action !== 'unlock') throw new Error('This request is no longer available. Return to your wallet.');
            creating = response.action === 'create';
            credential = response.credential;
            if (!creating && !credential) throw new Error('No YubiKey unlock is configured on this device. Return to your wallet.');
            requestLoaded = true;
            phase = 'ready';
        } catch (e) { error = friendlyError(e); phase = 'error'; }
    }

    function friendlyError(e: unknown): string {
        if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
            return 'The request was cancelled or timed out. Connect your YubiKey and try again.';
        }
        if (e instanceof DOMException && e.name === 'NotSupportedError') return 'This browser or security key does not support the encryption feature required for YubiKey unlock.';
        if (e instanceof Error && /PRF|hmac.secret/i.test(e.message)) return 'This key or browser cannot provide encrypted device unlock. Try a compatible FIDO2 key.';
        return e instanceof Error ? e.message : 'Could not use your YubiKey. Try again.';
    }

    async function authenticate() {
        const current = ++attempt;
        controller = new AbortController();
        phase = 'waiting';
        error = '';
        try {
            const assertion = creating
                ? await createHardwareCredential(controller.signal)
                : await getHardwareAssertion(credential!, controller.signal);
            if (current !== attempt) return;
            phase = 'finishing';
            requestSpent = true;
            const response = await chrome.runtime.sendMessage({
                type: SECURITY_KEY_MESSAGES.COMPLETE, requestId, assertion,
            } satisfies SecurityKeyMessage);
            if (current !== attempt) return;
            if (!response?.success) throw new Error(response?.error || 'Your YubiKey could not unlock this device.');
            phase = 'success';
        } catch (e) {
            if (current !== attempt) return;
            error = friendlyError(e);
            phase = 'error';
            requestSpent = true;
            await chrome.runtime.sendMessage({ type: SECURITY_KEY_MESSAGES.CANCEL, requestId } satisfies SecurityKeyMessage).catch(() => console.warn('Could not cancel the security key request.'));
        } finally { if (current === attempt) controller = undefined; }
    }

    function cancel() {
        attempt++;
        controller?.abort();
        controller = undefined;
        phase = 'cancelled';
        cancellation = chrome.runtime.sendMessage({ type: SECURITY_KEY_MESSAGES.CANCEL, requestId } satisfies SecurityKeyMessage).catch(() => console.warn('Could not cancel the security key request.'));
    }

    async function retry() {
        await cancellation;
        if (phase !== 'cancelled' && !requestSpent) {
            if (credential || creating) await authenticate();
            else await loadStatus();
            return;
        }
        try {
            const response = await chrome.runtime.sendMessage({ type: SECURITY_KEY_MESSAGES.OPEN, action: creating ? 'create' : 'unlock' } satisfies SecurityKeyMessage);
            if (!response?.success) throw new Error(response?.error || 'Could not start a new request. Return to your wallet and try again.');
            const current = await chrome.tabs.getCurrent();
            if (current?.id !== undefined && current.id !== response.tabId) {
                await chrome.tabs.remove(current.id);
            }
        } catch (e) { error = friendlyError(e); phase = 'error'; }
    }

    async function closeTab() {
        cancel();
        const tab = await chrome.tabs.getCurrent();
        if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
        else window.close();
    }
</script>

<svelte:head><title>{creating ? 'Set up YubiKey' : 'Unlock with YubiKey'} · Starlab Wallet</title></svelte:head>

<div class="key-page">
    <header class="key-header"><span class="brand-mark">S</span><strong>Starlab Wallet</strong><span class="header-label">Device unlock</span></header>
    <main class="key-card" aria-busy={phase === 'waiting' || phase === 'finishing' || phase === 'loading'}>
        <div class="key-badge"><Icon name={phase === 'success' ? 'check' : 'shield'} size={28} /></div>
        <p class="eyebrow">{creating ? 'PASSWORDLESS SETUP' : 'YUBIKEY UNLOCK'}</p>
        <h1>{phase === 'error' && !requestLoaded ? 'Verification unavailable' : phase === 'success' ? (creating ? 'Your YubiKey is ready' : 'Wallet unlocked') : creating ? 'Set up YubiKey unlock' : 'Unlock with your YubiKey'}</h1>
        <p class="intro">{phase === 'error' && !requestLoaded ? 'Return to Starlab Wallet to start a new verification request.' : phase === 'success' ? 'Return to Starlab Wallet to continue. No wallet password is needed.' : creating ? 'Use your security key to protect this device. No wallet password to create or remember.' : 'Use the same security key you set up on this device. Your key stays with you.'}</p>

        {#if phase === 'success'}
            <div class="notice success" role="status"><Icon name="check" size={18} /><span>{creating ? 'YubiKey unlock has been set up for this device.' : 'This device is now unlocked.'}</span></div>
            <a class="btn btn-primary w-full justify-center" href={chrome.runtime.getURL("popup.html")}>Open wallet</a>
        {:else if phase === 'unsupported'}
            <div class="notice" role="alert"><Icon name="alert" size={18} /><span>Security key authentication is not available here. Use a current Chromium browser and a compatible FIDO2 YubiKey.</span></div>
            <p class="text-xs text-muted">No unlock method was changed. {creating ? 'You can return to the wallet and explicitly choose Password instead.' : 'Use a browser and key that support YubiKey unlock.'}</p>
            <Button block variant="secondary" on:click={closeTab}>Close this tab</Button>
        {:else}
            {#if phase !== 'error' || requestLoaded}
            <ol class="steps">
                <li><span>1</span><div><strong>Connect your YubiKey</strong><p>Plug in your key or use NFC when your browser supports it.</p></div></li>
                <li><span>2</span><div><strong>Follow the browser prompt</strong><p>Enter your security key PIN if asked, then touch the key. {creating ? 'Setup may ask you to confirm twice.' : ''}</p></div></li>
            </ol>
            {/if}
            {#if phase === 'waiting' || phase === 'finishing'}
                <div class="notice" role="status"><Icon name="clock" size={18} /><span>{phase === 'finishing' ? 'Finishing securely. Keep this tab open.' : 'Waiting for your YubiKey. Keep this tab open and follow the browser prompt.'}</span></div>
            {:else if phase === 'cancelled'}
                <div class="notice" role="status"><Icon name="lock" size={18} /><span>Request cancelled. Your wallet remains unchanged.</span></div>
            {:else if error}
                <div class="notice error" role="alert"><Icon name="alert" size={18} /><span>{error}</span></div>
            {/if}
            <div class="actions">
                {#if phase === 'error' && !requestLoaded}
                    <a class="btn btn-primary w-full justify-center" href={chrome.runtime.getURL("popup.html")}>Open wallet</a>
                {:else if phase === 'waiting' || phase === 'finishing'}
                    <Button block variant="secondary" disabled={phase === 'finishing'} on:click={cancel}>{phase === 'finishing' ? 'Finishing…' : 'Cancel request'}</Button>
                {:else}
                    <Button block disabled={phase === 'loading'} on:click={retry}>{phase === 'loading' ? 'Checking this device…' : phase === 'error' || phase === 'cancelled' ? 'Try again' : creating ? 'Set up YubiKey' : 'Unlock wallet'}</Button>
                    <Button block variant="secondary" on:click={closeTab}>Cancel</Button>
                {/if}
            </div>
            <p class="footnote">Requires a FIDO2 security key and browser that support encrypted device unlock. Keep your key safe; losing it can prevent this device from unlocking.</p>
        {/if}
    </main>
    <footer><Icon name="lock" size={13} /><span>Local device protection · Your wallet shares stay encrypted</span></footer>
</div>

<style>
    :global(body:has(.key-page)) { display:flow-root; width:100%; min-height:100vh; margin:0; border:0; border-radius:0; box-shadow:none; overflow:visible; background-color:var(--c-bg); }
    .key-page { width:min(520px,calc(100% - 32px)); margin:clamp(20px,5vh,48px) auto; }
    .key-header { display:flex; align-items:center; gap:9px; padding:0 2px 18px; font-size:14px; }
    .brand-mark { display:grid; place-items:center; width:30px; height:30px; background:var(--grad-brand); color:white; border-radius:10px; font-weight:800; }
    .header-label { margin-left:auto; font-size:11px; color:var(--c-muted); }
    .key-card { padding:24px; border:1px solid var(--glass-edge); border-radius:22px; background:var(--glass-raised); box-shadow:var(--shadow-pop); backdrop-filter:blur(16px); }
    .key-badge { display:grid; place-items:center; width:56px; height:56px; border-radius:17px; color:var(--c-primary); background:var(--c-primary-soft); border:1px solid var(--glass-outline); margin-bottom:18px; }
    .eyebrow { color:var(--c-primary); font-size:10px; font-weight:800; letter-spacing:.1em; margin:0 0 6px; }
    h1 { margin:0; font-size:26px; line-height:1.2; font-weight:750; letter-spacing:-.025em; }
    .intro { margin:10px 0 20px; color:var(--c-muted); font-size:13px; line-height:1.6; }
    .steps { list-style:none; display:grid; gap:16px; margin:0 0 20px; padding:0; }
    .steps li { display:flex; align-items:flex-start; gap:11px; }
    .steps li > span { display:grid; place-items:center; flex-shrink:0; width:24px; height:24px; border-radius:8px; background:var(--c-surface-2); color:var(--c-primary); font-weight:700; font-size:11px; }
    .steps strong { font-size:13px; }
    .steps p { font-size:12px; line-height:1.5; color:var(--c-muted); margin:3px 0 0; }
    .notice { display:flex; align-items:flex-start; gap:9px; border:1px solid var(--c-line); border-radius:12px; background:var(--c-surface-2); padding:12px; margin:0 0 16px; font-size:12px; line-height:1.6; }
    .notice :global(svg) { flex-shrink:0; margin-top:2px; }
    .notice.error { color:var(--c-danger); }
    .notice.success { color:var(--c-success-fg); background:var(--c-success-soft); }
    .actions { display:flex; gap:8px; }
    .footnote { margin:16px 0 0; font-size:11px; color:var(--c-muted); line-height:1.6; }
    footer { display:flex; justify-content:center; align-items:center; gap:6px; margin:16px 8px; color:var(--c-muted); font-size:10px; }
    @media (max-width:480px) { .key-card { padding:20px; } h1 { font-size:23px; } }
    @supports not (backdrop-filter:blur(1px)) { .key-card { background:var(--c-surface); } }
</style>
