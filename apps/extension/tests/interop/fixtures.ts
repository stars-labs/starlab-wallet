// Playwright fixtures for loading the built MV3 extension (L3c, #33).
//
// MV3 extensions can only be loaded into a *persistent* Chromium context with
// `--load-extension`, and only in headed mode (Chromium refuses to load
// unpacked extensions headless). We resolve the extension id from its
// background service worker.
import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = process.env.STARLAB_EXTENSION_DIR ?? path.resolve(HERE, "../../.output/chrome-mv3");

export type ExtFixtures = {
  context: BrowserContext;
  extensionId: string;
};

export const test = base.extend<ExtFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(EXT_PATH, "manifest.json"))) {
      throw new Error(
        `Built extension not found at ${EXT_PATH}. Run \`bun run build\` first.`,
      );
    }
    // Use a system Chrome when PLAYWRIGHT_CHROME_PATH is set (e.g. Nix/CI where
    // Playwright's bundled chromium can't resolve system libs); else bundled.
    const executablePath = process.env.PLAYWRIGHT_CHROME_PATH || undefined;
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      executablePath,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        "--no-first-run",
        "--no-sandbox",
        // Chromium hides host ICE candidates behind mDNS `.local` names, which
        // the Rust CLI peers can't resolve — all peers here share one host, so
        // there is no srflx fallback. Real users connect across networks.
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        ...(process.env.INTEROP_BROWSER_LOG ? ["--enable-logging=stderr", "--v=0"] : []),
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // The service worker URL is chrome-extension://<id>/background.js
    let sw: Worker | undefined = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
    const id = new URL(sw.url()).host;
    await use(id);
  },
});

export const expect = test.expect;

/** URL of the extension popup page. */
export function popupUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/popup.html`;
}

/**
 * Debug aid (INTEROP_BROWSER_LOG=1): mirror the extension's offscreen
 * document (WebRTC mesh + FROST rounds) and background service worker
 * (signal-server traffic, session state) consoles to the test output. Neither
 * is a Playwright page, so attach over CDP (non-flattened: Playwright's
 * CDPSession only surfaces its own session's events).
 */
export async function mirrorOffscreenConsole(context: BrowserContext): Promise<void> {
  const cdp = await context.browser()!.newBrowserCDPSession();
  const labels = new Map<string, string>();
  cdp.on("Target.receivedMessageFromTarget", ({ sessionId, message }: { sessionId: string; message: string }) => {
    const label = labels.get(sessionId) ?? "extension";
    const msg = JSON.parse(message);
    if (msg.method === "Runtime.consoleAPICalled") {
      const args = msg.params.args as Array<{ value?: unknown; description?: string }>;
      console.log(`[${label}] ${args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      console.log(`[${label}:exception] ${d.exception?.description ?? d.text} @ ${d.url}:${d.lineNumber}:${d.columnNumber}`);
    }
  });
  const attach = async (targetId: string, label: string) => {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false });
    labels.set(sessionId, label);
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id: 1, method: "Runtime.enable" }),
    });
  };
  // The background creates the offscreen document during its async startup.
  let offscreen: { targetId: string } | undefined;
  let background: { targetId: string } | undefined;
  for (let i = 0; i < 50 && !offscreen; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    offscreen = targetInfos.find((t) => t.url.endsWith("/offscreen.html"));
    background = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
    if (!offscreen) await new Promise((r) => setTimeout(r, 200));
  }
  if (!offscreen) throw new Error("offscreen document not found after 10s");
  await attach(offscreen.targetId, "offscreen");
  if (background) await attach(background.targetId, "background");
}
