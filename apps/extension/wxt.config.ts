import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';

/**
 * Rolldown otherwise parks its runtime helpers (e.g. the `import * as`
 * namespace builder) in the first entry chunk of the HTML-pages build — the
 * popup's. The offscreen document then imports the popup chunk, runs its
 * top-level `mount(App, #app)`, throws (there is no #app) and never
 * initialises WebRTC/FROST. Give the runtime its own chunk. Only the
 * code-split ES build needs it; WXT's single-entry IIFE builds (background,
 * content scripts) reject `codeSplitting` options.
 */
function isolateRolldownRuntime() {
  return {
    name: 'isolate-rolldown-runtime',
    outputOptions(options: { format?: string }) {
      if (options.format === 'iife' || options.format === 'umd') return;
      return {
        ...options,
        codeSplitting: { groups: [{ name: 'rolldown-runtime', test: /rolldown\/runtime/ }] },
      };
    },
  };
}

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  dev: {
    server: {
      port: 3002,
      strictPort: true,
    },
  },
  vite: () => ({
    plugins: [
      wasm(),
      tailwindcss(),
      isolateRolldownRuntime(),
    ],
    resolve: {
      alias: {
        buffer: 'buffer/',
      },
    },
    // Vite 8 + rolldown supports top-level await natively for ESM output
    // (which the MV3 module background/offscreen entrypoints use), so the
    // old vite-plugin-top-level-await is gone — under rolldown its
    // generateBundle hook crashes ("path argument must be of type string").
    // Pin the build target to esnext so esbuild/rolldown emit native TLA and
    // destructuring instead of trying (and failing) to down-level them for
    // WXT's default chrome87/es2020 target. The extension only ever runs in
    // a modern MV3 runtime, so the lower targets bought us nothing.
    build: {
      target: 'esnext',
      // ANALYZE=1 bun run build → emit sourcemaps so bundle attribution
      // tools (source-map-explorer etc.) can break chunks down per module.
      // Off by default: maps roughly double output size and slow the build.
      sourcemap: !!process.env.ANALYZE,
    },
  }),
  manifest: {
    name: 'Starlab Wallet',
    description: 'A shared wallet for Ethereum, Bitcoin, Solana and Sui.',
    version: '1.0.0',
    // `notifications` added for Ext-3a: chrome.notifications push
    // when someone else announces a signing session we're a
    // participant in. Without it, co-signers on MainMenu would miss
    // the invite entirely (service worker logs it but nothing
    // surfaces in the browser chrome).
    // `nativeMessaging` lets the background service worker open the
    // YubiWallet native host (`chrome.runtime.connectNative(
    // "com.yubiwallet.host")`) to discover on-card accounts and
    // delegate ECDSA/EdDSA signing to the YubiKey. The host must be
    // installed separately — see integration/native-messaging/README.md.
    // `alarms` drives the receipt-polling activity reconciler (#11) —
    // MV3 SW timers die with the worker; alarms survive and re-wake it.
    permissions: ['storage', 'tabs', 'activeTab', 'offscreen', 'notifications', 'nativeMessaging', 'alarms'],
    host_permissions: [
      'https://*/*',
      // The signal server (matches TUI's `model.rs` websocket_url).
      'wss://panda.qzz.io/*'
    ],
    icons: {
      "16": "assets/icon-16.png",
      "32": "assets/icon-32.png",
      "48": "assets/icon-48.png",
      "128": "assets/icon-128.png"
    },
    action: {
      default_popup: "popup.html",
      default_icon: {
        "16": "assets/icon-16.png",
        "32": "assets/icon-32.png"
      }
    },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content-scripts/content.js'],
        run_at: 'document_start'
      }
    ],
    background: {
      service_worker: "entrypoints/background/index.ts",
      type: "module"
    },
    content_security_policy: {
      "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
    },
    web_accessible_resources: [
      {
        resources: ['injected.js'],
        matches: ['<all_urls>']
      }
    ],
  },
});
