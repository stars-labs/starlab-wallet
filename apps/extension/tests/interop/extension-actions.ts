// Extension UI actions for the L3c harness (#33).
//
// All popup interactions live here so selectors are in ONE place.
import { expect, type Page, type Worker } from "@playwright/test";
import { popupUrl } from "./fixtures";

export async function openPopup(page: Page, extensionId: string): Promise<void> {
  await page.goto(popupUrl(extensionId));
  await page.waitForLoadState("domcontentloaded");
}

// --- Settings → room ---------------------------------------------------------

/** Open Settings. The gear/settings control toggles `showSettings`. */
export async function openSettings(page: Page): Promise<void> {
  // Settings is reachable via a control with an accessible "Settings" name.
  // Fall back to clicking any element that reveals the room input.
  const gear = page.getByRole("button", { name: /settings/i });
  if (await gear.count()) {
    await gear.first().click();
  }
  await page.getByTestId("room-input").waitFor({ state: "visible", timeout: 10_000 });
}

/** Set + save the shared signal-server room (the multi-tenant key). */
export async function setRoom(page: Page, room: string): Promise<void> {
  await openSettings(page);
  const input = page.getByTestId("room-input");
  await input.fill(room);
  await page.getByRole("button", { name: /^save$/i }).click();
  // Assert the saved confirmation rather than guessing timing.
  await page.getByTestId("room-status").filter({ hasText: /saved/i }).waitFor({ timeout: 10_000 });
}

// --- first run -------------------------------------------------------------

/** First-run onboarding: set the keystore password ("Get started"). */
export async function onboard(page: Page, password: string): Promise<void> {
  await page.getByRole("button", { name: "Get started" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Wallet" });
  await dialog.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await dialog.getByRole("textbox", { name: "Confirm password" }).fill(password);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

/**
 * Point the extension at `url` (e.g. a local signal server). There is no popup
 * control for this — it's the chrome.storage override `getSignalServerUrl()`
 * reads — so write it from the service worker. Takes effect on the reconnect
 * that `setRoom` triggers.
 */
export async function useSignalServer(sw: Worker, url: string): Promise<void> {
  await sw.evaluate((u) => chrome.storage.local.set({ signalServerUrl: u }), url);
}

// --- create wallet (DKG initiator) ------------------------------------------

/** Leave the Settings view (its "Done" button) so the wallet view is showing. */
export async function closeSettings(page: Page): Promise<void> {
  const done = page.getByRole("button", { name: /^done$/i });
  if (await done.count()) {
    await done.first().click();
  }
}

/**
 * Create a threshold wallet — the extension becomes the DKG initiator.
 *
 * The "Create wallet — New shared wallet" shortcut is disabled until the
 * background reports the signal server connected, so waiting for it to enable
 * turns a connection failure into a clear error. The form (CreateWalletForm)
 * has stable ids; curve is chosen via the primary chain.
 */
export async function createWallet(
  page: Page,
  opts: { threshold: number; total: number; curve: string },
): Promise<void> {
  await closeSettings(page);

  const trigger = page.getByRole("button", { name: /Create wallet New shared wallet/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();

  await page.locator("#cw-total").fill(String(opts.total));
  await page.locator("#cw-threshold").fill(String(opts.threshold));
  await page.locator("#cw-chain").selectOption(opts.curve === "ed25519" ? "solana" : "ethereum");
  await page.getByRole("button", { name: "Create wallet", exact: true }).click();
}

/** The extension's DKG result, read from the background state. */
export async function dkgResult(page: Page): Promise<{ groupPublicKey: string; address: string | null }> {
  await expect
    .poll(() => page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }).then((s) => !!s?.dkgLastResult)), {
      timeout: 60_000,
    })
    .toBe(true);
  return page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }).then((s) => s.dkgLastResult));
}

/** The aggregate signature the extension ended up with (hex, no 0x). */
export async function extSignature(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }).then((s) => !!s?.lastSignature)), {
      timeout: 60_000,
    })
    .toBe(true);
  const sig: string = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "getState" }).then((s) => s.lastSignature.signature),
  );
  return sig.replace(/^0x/, "").toLowerCase();
}

/** Save the freshly generated wallet (the post-DKG "Save this wallet" form). */
export async function saveWallet(page: Page, password: string): Promise<void> {
  await page.getByPlaceholder("Password (at least 8 characters)").fill(password);
  await page.getByPlaceholder("Confirm password").fill(password);
  await page.getByRole("button", { name: "Encrypt & save" }).click();
  await page.getByPlaceholder("Password (at least 8 characters)").waitFor({ state: "hidden", timeout: 15_000 });
}

/**
 * Start a threshold signing of `message` with the saved wallet (extension as
 * initiator): Sign message → Review → Confirm & broadcast.
 */
export async function signMessage(page: Page, message: string): Promise<void> {
  const trigger = page.getByRole("button", { name: /Sign message Request signatures/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await page.locator("#sign-msg").fill(message);
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: /Confirm & broadcast/ }).click();
  // Surface a rejected request right away instead of as a peer timeout.
  await expect(page.getByRole("button", { name: /Confirm & broadcast/ })).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".text-danger-fg")).toHaveCount(0);
}
