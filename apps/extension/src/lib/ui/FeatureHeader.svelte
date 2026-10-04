<script lang="ts">
    import Icon from "./Icon.svelte";
    export let title: string;
    export let subtitle = "";
    export let icon = "wallet";
</script>
<div class="feature-title"><span class="feature-title-icon"><Icon name={icon} size={24} /></span><div><h2>{title}</h2>{#if subtitle}<p>{subtitle}</p>{/if}</div></div>
<style>
.feature-title { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
.feature-title-icon { display:flex; align-items:center; justify-content:center; flex:none; width:44px; height:44px; border-radius:14px; background:var(--c-primary-soft); color:var(--c-primary); }
h2 { margin:0; font-size:16px; font-weight:700; letter-spacing:-.02em; }
p { margin:3px 0 0; font-size:12px; line-height:1.5; color:var(--c-muted); }
</style>
