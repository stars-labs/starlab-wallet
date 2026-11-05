// Real MV3 lifecycle regression in a fresh profile; never uses a user's Chrome.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extension = path.join(root, '.output/chrome-mv3');
const output = process.env.POPUP_CONNECTION_OUTPUT || '/tmp/starlab-popup-connection-browser';
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'starlab-popup-connection-'));
const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--no-first-run'],
});
const errors = [];
let initialStates = 0;
try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage();
    page.on('console', message => {
        if (message.text().includes('Processing initialState')) initialStates++;
        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
    await expect.poll(() => initialStates).toBeGreaterThan(0);
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    for (let restart = 0; restart < 2; restart++) {
        const before = initialStates;
        await cdp.send('ServiceWorker.stopAllWorkers');
        await expect.poll(() => initialStates, { timeout: 15000 }).toBeGreaterThan(before);
        assert.equal(await page.evaluate(async () => Boolean(await chrome.runtime.sendMessage({ type: 'getState' }))), true);
    }
    // Closing and reopening the UI must leave no stale-port failure.
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/popup.html`);
    await expect(reopened.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
    await reopened.screenshot({ path: path.join(output, 'reconnected.png') });
    assert.deepEqual(errors, [], 'No console or page errors during worker restart and popup close');
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ realWorkerRestarts: 2, initialStates, errors, closeAndReopen: true }, null, 2));
    console.log('POPUP_CONNECTION_BROWSER_PASS', { initialStates, errors });
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
}
