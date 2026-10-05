<script lang="ts">
    import type { ProtocolBlockchain } from "@stars-labs/types/appstate";
    import Button from "../lib/ui/Button.svelte";
    import Icon from "../lib/ui/Icon.svelte";
    export let chain: ProtocolBlockchain = "ethereum";
    let files: File[] = [];
    let fileInput: HTMLInputElement;
    let password = "";
    let busy = false;
    let error = "";
    let complete = false;
    async function restore() {
        busy = true;
        error = "";
        complete = false;
        try {
            const keystoreFiles = await Promise.all(files.map((file) => file.text()));
            const keystoreData = keystoreFiles[0];
            if (!keystoreData) throw new Error("Choose your backup files first.");
            for (const text of keystoreFiles) JSON.parse(text);
            if (JSON.parse(keystoreData).encrypted === true && !password) throw new Error("Enter the password for this encrypted backup.");
            const result = await chrome.runtime.sendMessage({ type: "importKeystore", keystoreData, keystoreFiles, password: password || undefined, chain });
            if (!result?.success) throw new Error(result?.error ?? "Could not restore this backup.");
            complete = true;
            password = "";
            files = [];
            if (fileInput) fileInput.value = "";
        } catch (cause) {
            error = cause instanceof SyntaxError ? "This file is not a valid wallet backup." : (cause as Error).message;
        } finally { busy = false; }
    }
</script>
<details class="restore-panel">
    <summary><Icon name="upload" size={18} /> Restore from backup</summary>
    <div class="mt-3 space-y-3">
        <p class="text-xs text-muted">Choose this device's encrypted backup files. If your Ethereum wallet has separate key files, select them together.</p>
        <label class="label" for="restore-files">Backup files</label>
        <input id="restore-files" bind:this={fileInput} class="input text-xs" type="file" accept=".json" multiple disabled={busy} on:change={(event) => { files = Array.from((event.currentTarget as HTMLInputElement).files ?? []); error = ""; complete = false; }} />
        {#if files.length}<p class="text-xs text-muted">{files.map((file) => file.name).join(", ")}</p>{/if}
        <label class="label" for="restore-password">Backup password</label>
        <input id="restore-password" class="input" type="password" placeholder="Password used to encrypt this backup" autocomplete="current-password" bind:value={password} disabled={busy} />
        {#if error}<p class="alert alert-danger" role="alert">{error}</p>{/if}
        {#if complete}<p class="alert alert-success" role="status">Wallet restored on this device.</p>{/if}
        <Button block on:click={restore} disabled={busy || files.length === 0}>{busy ? "Restoring…" : "Restore wallet"}</Button>
    </div>
</details>
<style>
.restore-panel { border-top:1px solid var(--c-line); margin-top:12px; padding-top:12px; }
summary { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; cursor:pointer; color:var(--c-primary); }
input[type=file] { width:100%; min-height:42px; }
</style>
