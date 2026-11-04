/** Production extension, real WebAuthn PRF via an isolated virtual USB key.
 * No mocked runtime messages, vault crypto or credentials APIs. A virtual key
 * does not establish physical YubiKey compatibility. Never uses a user profile.
 * Run after the ordinary production build, with a dedicated DISPLAY.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extension = path.join(root, '.output/chrome-mv3');
const output = process.env.PASSWORDLESS_TEST_OUTPUT || '/tmp/starlab-passwordless-ui-browser';
await fs.mkdir(output, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'starlab-passwordless-profile-'));
const evidence = { scope: 'Production extension with CDP virtual USB PRF authenticator; no physical key or user profile', checks: {} };
let context;
let popup;
let keyPage;
try {
    context = await chromium.launchPersistentContext(scratch, {
        headless: false,
        executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-sandbox'],
    });
    evidence.browser = await context.browser().version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    // Observe browser CSP diagnostics before any extension document executes.
    const cspErrors = [];
    context.on('console', message => {
        if (/content security policy|violates.*script-src/i.test(message.text())) cspErrors.push(message.text());
    });
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    assert.deepEqual(cspErrors, [], 'Extension startup must not violate CSP');
    evidence.checks.noStartupCspViolations = true;
    for (const [mode, os, dark] of [['dark', 'light', true], ['light', 'dark', false], ['system', 'dark', true], ['system', 'light', false]]) {
        await popup.emulateMedia({ colorScheme: os });
        await popup.evaluate(mode => localStorage.setItem('starlab_theme', mode), mode);
        await popup.reload();
        await expect(popup.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
        assert.equal(await popup.evaluate(() => document.documentElement.classList.contains('dark')), dark);
    }
    evidence.checks.savedAndSystemTheme = true;
    const status = () => popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'getKeystoreStatus' }))?.status);
    await expect(popup.getByRole('button', { name: 'Get started', exact: true })).toBeVisible({ timeout: 20_000 });
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.getByRole('button', { name: 'Get started', exact: true }).click();
    await expect(popup.getByRole('button', { name: 'Continue with YubiKey', exact: true })).toBeVisible();
    await expect(popup.locator('input[type="password"]')).toHaveCount(0);
    for (const height of [400, 600]) {
        await popup.setViewportSize({ width: 380, height });
        for (const method of ['Password', 'YubiKey']) {
            await popup.getByRole('button', { name: method === 'Password' ? /^Password$/ : /^YubiKey/ }).click();
            assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow');
            const actions = popup.locator('.auth-actions');
            const box = await actions.boundingBox();
            assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${method} actions must fit ${height}px viewport`);
            await expect(actions.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
            await popup.screenshot({ animations: 'disabled', path: path.join(output, `create-${method}-${height}.png`) });
        }
    }
    evidence.checks.createActionsVisibleAt400And600px = true;
    await popup.screenshot({ animations: 'disabled', path: path.join(output, '01-create-method.png') });
    const opened = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Continue with YubiKey', exact: true }).click();
    keyPage = await opened;
    await keyPage.waitForURL(/\/security-key\.html\?request=/);
    await expect(keyPage.getByRole('button', { name: 'Set up YubiKey', exact: true })).toBeVisible();
    const initialRequest = new URL(keyPage.url()).searchParams.get('request');
    const cdp = await context.newCDPSession(keyPage);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    } });
    await keyPage.getByRole('button', { name: 'Set up YubiKey', exact: true }).click();
    await expect(keyPage.getByRole('heading', { name: 'Your YubiKey is ready', exact: true })).toBeVisible({ timeout: 20_000 });
    let current = await status();
    assert.equal(current.authMode, 'hardware');
    assert.equal(current.initialized, true);
    assert.equal(current.locked, false);
    assert.equal(current.wallets.length, 0);
    evidence.checks.realUiCreation = true;
    console.log('PASS production UI: real WebAuthn PRF creation');
    const ownedAuthPages = await popup.evaluate(async () => (await chrome.tabs.query({ url: chrome.runtime.getURL('security-key.html*') })).length);
    assert.equal(ownedAuthPages, 1);
    evidence.checks.authPageCleanupQueryIsScopedAndSupported = true;
    const storage = await keyPage.evaluate(async () => {
        const local = await chrome.storage.local.get(null);
        const session = await chrome.storage.session.get(null);
        const record = local.mpc_hardware_vault;
        return { envelopeKeys: Object.keys(record).sort(), hasPasswordHash: Object.hasOwn(local, 'keystorePasswordHash'),
            hasPersistedPrf: JSON.stringify({ local, session }).includes('prfOutput'), activeRequest: !!session.starlab_security_key_request };
    });
    assert.deepEqual(storage.envelopeKeys, ['ciphertext', 'credentialId', 'hkdfSalt', 'iv', 'prfSalt', 'version']);
    assert.equal(storage.hasPasswordHash, false);
    assert.equal(storage.hasPersistedPrf, false);
    assert.equal(storage.activeRequest, false);
    evidence.checks.encryptedEmptyVaultPersists = storage;
    await keyPage.screenshot({ animations: 'disabled', path: path.join(output, '02-created.png') });

    // An already-open app observes the canonical background session event.
    await expect(popup.getByRole('button', { name: 'Lock wallet', exact: true })).toBeVisible();
    await popup.getByRole('button', { name: 'Lock wallet', exact: true }).click();
    await expect.poll(async () => (await status()).locked).toBe(true);
    await popup.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await expect(popup.locator('input[type="password"]')).toHaveCount(0);
    await popup.getByRole('button', { name: 'Continue with YubiKey', exact: true }).click();
    await keyPage.waitForURL(url => url.pathname === '/security-key.html' && url.searchParams.get('request') !== initialRequest);
    await keyPage.bringToFront();
    await expect(keyPage.getByRole('button', { name: 'Unlock wallet', exact: true })).toBeVisible();
    await keyPage.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await expect(keyPage.getByRole('heading', { name: 'Wallet unlocked', exact: true })).toBeVisible({ timeout: 20_000 });
    assert.equal((await status()).locked, false);
    evidence.checks.realUiLockAndUnlockSameVirtualKey = true;
    console.log('PASS production UI: lock and real PRF unlock');
    evidence.checks.dedicatedTabReusedWithFreshRequest = true;
    const replay = await keyPage.evaluate(async requestId => chrome.runtime.sendMessage({ type: 'getSecurityKeyRequest', requestId }), initialRequest);
    assert.equal(replay.success, false);
    evidence.checks.oldRequestRejected = true;
    await keyPage.screenshot({ animations: 'disabled', path: path.join(output, '03-unlocked.png') });

    await expect(popup.getByRole('button', { name: 'Lock wallet', exact: true })).toBeVisible();
    await popup.getByRole('button', { name: 'Lock wallet', exact: true }).click();
    await expect.poll(async () => (await status()).locked).toBe(true);
    const lastUrl = keyPage.url();
    await popup.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await popup.getByRole('button', { name: 'Continue with YubiKey', exact: true }).click();
    await keyPage.waitForURL(url => url.href !== lastUrl);
    await keyPage.bringToFront();
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    await keyPage.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await expect(keyPage.getByRole('status')).toContainText('Waiting for your YubiKey');
    await keyPage.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(keyPage.getByRole('status')).toContainText('Request cancelled');
    assert.equal((await status()).locked, true);
    evidence.checks.realUiCancellationRemainsLocked = true;
    await keyPage.screenshot({ animations: 'disabled', path: path.join(output, '04-cancelled.png') });
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    const cancelledUrl = keyPage.url();
    await keyPage.getByRole('button', { name: 'Try again', exact: true }).click();
    await keyPage.waitForURL(url => url.href !== cancelledUrl);
    await expect(keyPage.getByRole('button', { name: 'Unlock wallet', exact: true })).toBeVisible();
    await keyPage.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await expect(keyPage.getByRole('heading', { name: 'Wallet unlocked', exact: true })).toBeVisible({ timeout: 20_000 });
    evidence.checks.retryDoesNotCloseReusedTab = true;
    evidence.checks.realUiRetryUnlock = true;
    assert.deepEqual(cspErrors, [], 'Extension pages must not violate CSP');
    evidence.checks.noCspViolations = true;
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
    await keyPage?.screenshot({ animations: 'disabled', path: path.join(output, 'failure-key-page.png') }).catch(() => {});
    await popup?.screenshot({ animations: 'disabled', path: path.join(output, 'failure-popup.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.txt'), String(error));
    throw error;
} finally {
    await context?.close();
    await fs.rm(scratch, { recursive: true, force: true });
}
