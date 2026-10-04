// Load the production extension into an ordinary local dApp document.
// Only read-only discovery/account calls: no wallet, connect approval or signing.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

test("production content script injects one provider per document", async ({ page }, testInfo) => {
  const manifest = JSON.parse(await readFile(new URL("../../.output/chrome-mv3/manifest.json", import.meta.url), "utf8"));
  const scripts = manifest.content_scripts.filter((entry: { js?: string[] }) => entry.js?.includes("content-scripts/content.js"));
  expect(scripts).toHaveLength(1);
  expect(scripts[0].matches).toEqual(["<all_urls>"]);
  expect(scripts[0].run_at).toBe("document_start");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Starlab provider regression</title><h1>Local dApp</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local dApp server unavailable");
  const initializations: string[] = [];
  page.on("console", message => {
    if (message.text().includes("Initializing Starlab Wallet provider")) initializations.push(message.text());
  });
  await page.addInitScript(() => {
    (window as any).__providers = [];
    window.addEventListener("eip6963:announceProvider", (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.info.rdns === "org.starlab.wallet") (window as any).__providers.push(detail);
    });
  });
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => (window as any).starlabEthereum?.isStarLabWallet);
    await page.waitForTimeout(300);
    expect(initializations).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).__providers.length)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("eip6963:requestProvider")));
    const discovery = await page.evaluate(() => {
      const providers = (window as any).__providers;
      return { count: providers.length, sameUUID: providers[0].info.uuid === providers[1]?.info.uuid, sameProvider: providers[0].provider === providers[1]?.provider };
    });
    expect(discovery).toEqual({ count: 2, sameUUID: true, sameProvider: true });
    expect(await page.evaluate(() => (window as any).starlabEthereum.request({ method: "eth_accounts" }))).toEqual([]);
    expect(initializations).toHaveLength(1);
    await testInfo.attach("provider-evidence", { body: Buffer.from(JSON.stringify({ manifestEntries: scripts.length, initializations: initializations.length, discovery, accounts: [] }, null, 2)), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("provider.png") });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
