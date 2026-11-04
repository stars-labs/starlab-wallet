<script lang="ts">
    import Button from "../lib/ui/Button.svelte";
    import Icon from "../lib/ui/Icon.svelte";
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
            if (files.length !== 3) throw new Error("Choose all three backup files for this wallet and device.");
            const keystoreFiles = await Promise.all(files.map((file) => file.text()));
            const backups = keystoreFiles.map((text) => JSON.parse(text));
            if (backups.some((backup) => backup.encrypted === true) && !password) throw new Error("Enter the password used to encrypt these backups.");
            const result = await chrome.runtime.sendMessage({ type: "importKeystore", keystoreFiles, password: password || undefined });
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
        <p class="text-xs text-muted">Choose all three encrypted backup files belonging to this device and wallet. Keep the complete set together; a single file cannot restore the wallet.</p>
        <label class="label" for="restore-files">Three backup files</label>
        <input id="restore-files" bind:this={fileInput} class="input text-xs" type="file" accept=".json" multiple disabled={busy} on:change={(event) => { files = Array.from((event.currentTarget as HTMLInputElement).files ?? []); error = ""; complete = false; }} />
        {#if files.length}<p class="text-xs text-muted">{files.map((file) => file.name).join(", ")}</p>{/if}
        <label class="label" for="restore-password">Backup password</label>
        <input id="restore-password" class="input" type="password" placeholder="Password used to encrypt these backups" autocomplete="current-password" bind:value={password} disabled={busy} />
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
