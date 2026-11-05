/**
 * SETUP_WORKFLOW_MODE=real (default): actual production MV3 popup, password
 * vault and a private local signal server. No peers, keys, prime fixtures or
 * secret engine state are injected. This tests waiting/reopen, not DKG crypto.
 * SETUP_WORKFLOW_MODE=ui-contract: the same built App with PUBLIC mock runtime
 * snapshots for presentation states. These are explicitly not crypto tests.
 * Run with Bun from apps/extension; PLAYWRIGHT_CHROME_PATH selects Chromium.
 */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DkgState } from '@stars-labs/types/dkg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extension = path.resolve(process.env.SETUP_WORKFLOW_EXTENSION_DIR || path.join(root, '.output/chrome-mv3'));
const mode = process.env.SETUP_WORKFLOW_MODE || 'real';
assert(['real', 'ui-contract'].includes(mode), 'Select real or ui-contract explicitly');
const output = path.resolve(process.env.SETUP_WORKFLOW_OUTPUT || `/tmp/starlab-setup-workflow-${mode}`);
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(extension, 'manifest.json'));
const evidence = { mode, scope: mode === 'real' ? 'Actual production MV3 UI, password vault and private signal server; no DKG/signing proof' : 'Compiled production App with public mock runtime snapshots; UI contract only, no crypto proof', extension, checks: [], screenshots: [], errors: [] };
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const screenshot = async (page, name) => {
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    evidence.screenshots.push(file);
};
const watchErrors = page => page.on('pageerror', error => evidence.errors.push(error.message));
async function assertFocusedSetup(page) {
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await expect(page.getByText('Wallet tools', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Overview', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'EVM network' })).toHaveCount(0);
    await expect(page.getByText('Advanced', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add hardware|Ledger|YubiKey|Create shared wallet/i })).toHaveCount(0);
    await expect(page.locator('#cw-total')).toHaveCount(0);
}
async function assertWaiting(page) {
    const setup = page.getByTestId('wallet-setup-status');
    await expect(setup).toBeVisible();
    await expect(setup.getByRole('heading', { name: 'Invite your devices', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy invite', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Copy / })).toHaveCount(1);
    await assertFocusedSetup(page);
    const details = setup.locator('details');
    if (await details.count()) await expect(details).not.toHaveAttribute('open', '');
}
async function startSignal() {
    if (process.env.SETUP_WORKFLOW_SILENT_SIGNAL === '1') {
        const received = [];
        const server = Bun.serve({
            hostname: '127.0.0.1', port: 0,
            fetch(request, server) { return server.upgrade(request) ? undefined : new Response('WebSocket required', { status: 400 }); },
            websocket: { message(_socket, message) { received.push(JSON.parse(String(message))); } },
        });
        const record = { url: `ws://127.0.0.1:${server.port}`, scope: 'Real WebSocket transport that receives announcements but never sends messages', serverMessages: 0 };
        (evidence.signals ??= []).push(record);
        evidence.signal = record;
        return { url: record.url, announcements: () => received.filter(message => message.type === 'announce_session').length, async stop() { record.receivedTypes = received.map(message => message.type); server.stop(true); } };
    }
    const binary = process.env.SETUP_WORKFLOW_SIGNAL_BIN || '/tmp/starlab-unified-artifacts/712f0364/starlab-signal-server';
    await fs.access(binary);
    const port = await new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
    });
    const child = spawn(binary, [], { env: { ...process.env, MPC_SIGNAL_BIND: `127.0.0.1:${port}` }, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Private signal server did not become ready')), 10000);
        child.stderr.on('data', bytes => { if (String(bytes).includes('listening')) { clearTimeout(timeout); resolve(); } });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Private signal server exited ${code}`)); });
    });
    evidence.signal = { url: `ws://127.0.0.1:${port}`, binary, sha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex') };
    return { url: evidence.signal.url, async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGINT');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    } };
}
async function protectDevice(page) {
    await page.getByRole('button', { name: 'Get started', exact: true }).click({ timeout: 15000 });
    const dialog = page.getByRole('dialog', { name: 'Protect this device', exact: true });
    await dialog.getByRole('button', { name: 'Password', exact: true }).click();
    const password = `workflow-${randomBytes(16).toString('hex')}`;
    await dialog.getByLabel('Password', { exact: true }).fill(password);
    await dialog.getByLabel('Confirm password', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 15000 });
}
async function realWorkflow() {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'starlab-setup-workflow-'));
    let signal, context, page;
    try {
        signal = await startSignal();
        context = await chromium.launchPersistentContext(profile, { headless: false, executablePath, viewport: { width: 380, height: 640 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--no-first-run'] });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        // Public network configuration only; the actual background owns all state.
        await worker.evaluate(url => chrome.storage.local.set({ signalServerUrl: url }), signal.url);
        const id = new URL(worker.url()).hostname;
        const url = `chrome-extension://${id}/popup.html`;
        page = await context.newPage(); watchErrors(page);
        await page.addInitScript(() => {
            globalThis.__workflowCreateCalls = 0;
            const forward = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = (message, ...args) => {
                if (message?.type === 'createDkgWallet') globalThis.__workflowCreateCalls++;
                return forward(message, ...args);
            };
        });
        await page.goto(url);
        await protectDevice(page);
        const onboarding = page.getByTestId('onboarding');
        await onboarding.getByRole('button', { name: /^Create shared wallet/ }).click();
        await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
        const room = `workflow-room-${randomBytes(12).toString('hex')}`;
        await onboarding.getByPlaceholder(/room/i).fill(room);
        await onboarding.getByRole('button', { name: 'Save room & continue', exact: true }).click();
        // Room confirmation must lead directly to the one configuration form.
        await expect(page.getByRole('heading', { name: 'Configure wallet', exact: true })).toBeVisible();
        await expect(onboarding).toHaveCount(0);
        await expect(page.getByText(/Step 3 of 3/)).toHaveCount(0);
        await page.locator('#cw-total').fill('3');
        await page.locator('#cw-threshold').fill('2');
        const invite = page.getByRole('button', { name: 'Invite devices', exact: true });
        await expect(invite).toBeEnabled({ timeout: 15000 });
        await screenshot(page, 'real-configure-once');
        await invite.click();
        await assertWaiting(page);
        if (signal.announcements) await expect.poll(signal.announcements).toBe(1);
        assert.equal(await page.evaluate(() => globalThis.__workflowCreateCalls), 1, 'Only Invite devices may create the ceremony, once');
        await screenshot(page, 'real-waiting');
        const before = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
        assert.equal(before.sessionInfo.session_type, 'dkg');
        assert.equal(before.sessionInfo.curve_type, 'unified');
        await page.close();
        page = await context.newPage(); watchErrors(page);
        await page.goto(url);
        await assertWaiting(page);
        const after = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
        assert.equal(after.sessionInfo.session_id, before.sessionInfo.session_id, 'Reopen resumes the same real ceremony');
        await screenshot(page, 'real-reopened-waiting');
        evidence.checks.push('real password-vault onboarding', 'room leads directly to one configuration form', 'one create request', 'only waiting workflow visible', 'one Copy invite', 'close/reopen preserves same waiting session');
        evidence.realSession = { sessionId: before.sessionInfo.session_id, threshold: before.sessionInfo.threshold, total: before.sessionInfo.total, curve: before.sessionInfo.curve_type };
    } catch (error) { if (page && !page.isClosed()) await screenshot(page, 'real-failure').catch(() => {}); throw error; }
    finally { await context?.close(); await signal?.stop(); await fs.rm(profile, { recursive: true, force: true }); }
}
async function realJoinWorkflow() {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'starlab-setup-workflow-join-'));
    let signal, context, page;
    try {
        signal = await startSignal();
        context = await chromium.launchPersistentContext(profile, { headless: false, executablePath, viewport: { width: 380, height: 640 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--no-first-run'] });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        await worker.evaluate(url => chrome.storage.local.set({ signalServerUrl: url }), signal.url);
        page = await context.newPage(); watchErrors(page);
        await page.addInitScript(() => {
            globalThis.__workflowCreateCalls = 0;
            const forward = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = (message, ...args) => {
                if (message?.type === 'createDkgWallet') globalThis.__workflowCreateCalls++;
                return forward(message, ...args);
            };
        });
        await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
        await protectDevice(page);
        const onboarding = page.getByTestId('onboarding');
        await onboarding.getByRole('button', { name: /^Join a shared wallet/ }).click();
        await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
        await onboarding.getByPlaceholder(/room/i).fill(`workflow-join-${randomBytes(12).toString('hex')}`);
        await onboarding.getByRole('button', { name: 'Save room & continue', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Waiting for an invitation', exact: true })).toBeVisible();
        await assertFocusedSetup(page);
        await expect(page.getByRole('button', { name: 'Invite devices', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Got it', exact: true })).toHaveCount(0);
        assert.equal(await page.evaluate(() => globalThis.__workflowCreateCalls), 0, 'Joining must never create a new wallet ceremony');
        await expect.poll(() => page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }).then(state => state.wsConnected))).toBe(true);
        assert.equal(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }).then(state => Boolean(state.sessionInfo))), false);
        await screenshot(page, 'real-join-waiting');
        evidence.checks.push('real Join leads directly from room to invitation waiting', 'Join never creates a ceremony', 'Join hides configuration and unrelated tools');
    } catch (error) { if (page && !page.isClosed()) await screenshot(page, 'real-join-failure').catch(() => {}); throw error; }
    finally { await context?.close(); await signal?.stop(); await fs.rm(profile, { recursive: true, force: true }); }
}
async function publicSnapshot(page, stateName) {
    const states = { idle: DkgState.Idle, waiting: DkgState.Idle, generating: DkgState.Finalizing, failed: DkgState.Failed, unsaved: DkgState.Complete, ready: DkgState.Complete, 'refresh-invite': DkgState.Complete, refreshing: DkgState.Round2InProgress };
    await page.addInitScript(({ stateName, dkgState }) => {
        const address = '0x1111111111111111111111111111111111111111';
        const session = { session_id: 'public-ui-only-session', session_type: 'dkg', curve_type: 'unified', proposer_id: 'public-browser', participants: stateName === 'waiting' ? ['public-browser'] : ['public-browser', 'public-desktop', 'public-phone'], threshold: 2, total: 3 };
        const keys = { ed25519: 'a1'.repeat(32), secp256k1: '03' + '11'.repeat(32) };
        const saved = stateName === 'ready' || stateName === 'refresh-invite';
        const complete = stateName === 'unsaved' || saved;
        const refresh = { session_id: 'public-refresh', session_type: 'reshare', curve_type: 'secp256k1', proposer_id: 'public-desktop', participants: ['public-desktop'], threshold: 2, total: 3, wallet_name: 'public-ui-only-wallet' };
        const state = { deviceId: 'public-browser', wsConnected: true, connecteddevices: [], sessionInfo: stateName === 'refreshing' ? { ...session, session_type: 'reshare', curve_type: 'secp256k1' } : session, invites: stateName === 'refresh-invite' ? [refresh] : [], dkgState, dkgError: stateName === 'failed' ? 'Connection was lost. Reconnect your devices and try again.' : '', ecdsaDkgStatus: stateName === 'generating' ? 'aux-info' : null, pendingKeystoreReady: stateName === 'unsaved', webrtcConnections: {}, meshStatus: { type: 0 }, chain: 'ethereum', blockchain: 'ethereum', uiPreferences: { language: 'en' }, ...(complete ? { frostGroupPublicKeys: keys, ecdsaGroupPublicKey: '02' + '22'.repeat(32), dkgGroupPublicKey: keys.secp256k1, dkgAddress: address, ethereumAddress: address } : {}) };
        const wallet = { id: 'public-ui-only-wallet', name: 'Everyday wallet', blockchain: 'ethereum', address, chainAddresses: { ethereum: address }, session_id: session.session_id, isActive: true };
        const data = { signalRoom: 'public-ui-only-room-code', wallet_accounts: [], wallet_current_account: null };
        const event = { addListener() {}, removeListener() {} };
        const respond = message => {
            switch (message.type) {
                case 'getState': return state;
                case 'getKeystoreStatus': return { success: true, status: { initialized: true, authMode: 'password', locked: false, wallets: saved ? [wallet] : [], activeWallet: saved ? wallet : null } };
                case 'getPortfolio': return { success: true, portfolio: { native: { symbol: 'ETH', balance: '0', fiat: 0 }, tokens: [], totalFiat: 0 } };
                case 'getActivity': return { success: true, activity: [] };
                case 'getPendingConnectRequests': case 'getPendingSignatureRequests': return { success: true, requests: [] };
                case 'deriveAccounts': return { success: true, accounts: Array.from({ length: message.count || 1 }, (_, account) => ({ account, addresses: [{ chain: message.curve === 'ed25519' ? 'solana' : message.curve === 'secp256k1' ? 'bitcoin' : 'ethereum', address, path: 'public-ui-only-path' }] })) };
                default: return { success: true };
            }
        };
        window.chrome = { runtime: { id: 'public-ui-contract', getURL: file => new URL(file, location.href).href, lastError: null, onMessage: event, connect() { return { onMessage: { addListener(callback) { setTimeout(() => callback({ type: 'initialState', ...state }), 0); }, removeListener() {} }, onDisconnect: event, postMessage() {}, disconnect() {} }; }, sendMessage(message, callback) { const response = respond(message); if (callback) queueMicrotask(() => callback(response)); return Promise.resolve(response); } }, storage: { local: { async get() { return data; }, async set(values) { Object.assign(data, values); }, async remove(key) { delete data[key]; } }, session: { async get() { return {}; }, async set() {}, async remove() {} }, onChanged: event }, tabs: { async query() { return []; }, async create() {} }, alarms: { onAlarm: event, create() {} }, notifications: { create() {} }, extension: { getViews: () => [] } };
    }, { stateName, dkgState: states[stateName] });
}
async function uiContract() {
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
    const server = createServer(async (request, response) => {
        try {
            const file = path.resolve(extension, '.' + new URL(request.url, 'http://localhost').pathname);
            if (!file.startsWith(extension + path.sep)) throw new Error('outside fixture build');
            response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.end(await fs.readFile(file));
        } catch { response.statusCode = 404; response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    try {
        for (const state of ['waiting', 'generating', 'failed', 'unsaved', 'ready', 'refresh-invite', 'refreshing']) for (const width of [380, 900]) {
            const page = await browser.newPage({ viewport: { width, height: 760 } }); watchErrors(page);
            await publicSnapshot(page, state);
            await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ json: {} }));
            await page.goto(origin + '/popup.html');
            if (state !== 'ready') await assertFocusedSetup(page);
            if (state === 'waiting') await assertWaiting(page);
            if (state === 'generating' || state === 'failed') await expect(page.getByTestId('wallet-setup-status').getByRole('heading', { name: state === 'generating' ? 'Creating your wallet' : 'Wallet setup failed', exact: true })).toBeVisible();
            if (state === 'unsaved') await expect(page.getByRole('button', { name: 'Encrypt & save', exact: true })).toBeVisible();
            if (state === 'ready') { await expect(page.getByTestId('onboarding')).toHaveCount(0); await expect(page.getByText('Wallet tools', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: /Sign message/ })).toBeVisible(); }
            if (state === 'refreshing') await expect(page.getByRole('heading', { name: 'Refreshing wallet devices', exact: true })).toBeVisible();
            if (state === 'refresh-invite') await expect(page.getByRole('button', { name: 'Accept & join', exact: true })).toHaveCount(1);
            await screenshot(page, `ui-contract-${state}-${width}`);
            evidence.checks.push(`PUBLIC UI MOCK ${state} ${width}px`);
            await page.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
try {
    if (mode === 'real') { await realWorkflow(); await realJoinWorkflow(); } else await uiContract();
    assert.deepEqual(evidence.errors, [], 'No uncaught App errors');
    evidence.passed = true;
    console.log('SETUP_WORKFLOW_BROWSER_PASS', { mode, checks: evidence.checks.length, output });
} catch (error) { evidence.passed = false; evidence.failure = error.stack || String(error); throw error; }
finally { await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); }
