// A saved wallet must survive a browser restart (P0, round 3b: the keystore
// index came back `wallets: []` on every service-worker start while the
// share was still in storage — fixed by awaiting the index load; the live
// report that followed turned out to be a cached old service worker). Real
// Chromium, persistent profile: import a wallet, close the browser, relaunch
// the same profile, and check storage and the background's view of the
// keystore; a wrong password must not unlock it. No CLI / signal server.
import { test as base, expect, chromium, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "../../.output/chrome-mv3");
const FIXTURES = path.resolve(HERE, "../fixtures/engine-share");
const FILE = fs.readFileSync(path.join(FIXTURES, "engine-share-secp256k1.json"), "utf8");
const PASSWORD: string = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "engine-share-secp256k1.expected.json"), "utf8"),
).password;

async function launch(userDataDir: string): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--no-first-run", "--no-sandbox"],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  return { context, extensionId: new URL(sw.url()).host };
}

async function extensionPage(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

const storedIndex = (page: any) =>
  page.evaluate(() => chrome.storage.local.get("mpc_keystore_index").then((r: any) => r.mpc_keystore_index ?? null));

const test = base;
test.describe.configure({ timeout: 120_000 });
// Curve-independent: run it once (in the secp256k1 job).
test.skip((process.env.INTEROP_CURVE ?? "secp256k1") !== "secp256k1", "curve-independent");

test("an imported wallet survives a browser restart", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ext-profile-"));
  try {
    let { context, extensionId } = await launch(profile);
    let page = await extensionPage(context, extensionId);
    const imported = await page.evaluate(
      ([keystoreData, password]) =>
        chrome.runtime.sendMessage({ type: "importKeystore", keystoreData, password, chain: "ethereum" }),
      [FILE, PASSWORD],
    );
    expect(imported, JSON.stringify(imported)).toMatchObject({ success: true, walletId: "w-transfer" });
    const before = await storedIndex(page);
    expect(before.wallets.map((w: any) => w.id)).toEqual(["w-transfer"]);
    await context.close();

    for (let restart = 1; restart <= 2; restart++) {
      ({ context, extensionId } = await launch(profile));
      page = await extensionPage(context, extensionId);
      // Let the background finish its startup restore.
      await page.waitForTimeout(3_000);
      const after = await storedIndex(page);
      expect(after?.wallets?.map((w: any) => w.id), `restart ${restart}: stored index`).toEqual(["w-transfer"]);
      expect(after.lastModified, `restart ${restart}: the index must not be rewritten`).toBe(before.lastModified);
      const status = (await page.evaluate(() => chrome.runtime.sendMessage({ type: "getKeystoreStatus" })))?.status;
      expect(status?.wallets?.map((w: any) => w.id), `restart ${restart}: ${JSON.stringify(status)}`).toEqual(["w-transfer"]);
      await context.close();
    }

    // A wrong password must not unlock a keystore that has wallets.
    ({ context, extensionId } = await launch(profile));
    page = await extensionPage(context, extensionId);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lockKeystore" }));
    const wrong = await page.evaluate(() => chrome.runtime.sendMessage({ type: "unlockKeystore", password: "definitely-wrong" }));
    expect(wrong?.success, JSON.stringify(wrong)).toBe(false);
    const right = await page.evaluate((pw) => chrome.runtime.sendMessage({ type: "unlockKeystore", password: pw }), PASSWORD);
    expect(right?.success, JSON.stringify(right)).toBe(true);
    await context.close();
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
