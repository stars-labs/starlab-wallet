import { KeystoreManager } from '../../services/keystoreManager';
import { isInternalSender } from './rpcOrigin';
import type { HardwareAssertion } from '../../services/hardwareVault';
import { SECURITY_KEY_MESSAGES, type SecurityKeyAction, type SecurityKeyMessage } from '../../services/securityKeyProtocol';

const REQUEST_KEY = 'starlab_security_key_request';
const AUTH_TAB_KEY = 'starlab_security_key_tab';
const REQUEST_LIFETIME = 5 * 60_000;
interface PendingRequest {
    id: string;
    action: SecurityKeyAction;
    tabId: number;
    expiresAt: number;
}
type AuthKeystore = Pick<KeystoreManager, 'getAuthStatus' | 'createHardwareKeystore' | 'unlockHardwareKeystore'>;

/** Only non-secret, short-lived request metadata survives worker suspension. */
export class SecurityKeyAuthController {
    private opening = false;
    private completing = false;
    private readonly consumed = new Set<string>();
    private cancelEpoch = 0;
    private requestsBlocked = false;

    constructor(
        private readonly deviceId: () => string,
        private readonly onUnlocked: () => Promise<void>,
        private readonly keystore: () => AuthKeystore = () => KeystoreManager.getInstance(),
    ) {}

    async cancelPending(): Promise<void> {
        this.cancelEpoch++;
        this.requestsBlocked = true;
        try { await chrome.storage.session.remove(REQUEST_KEY); }
        catch (error) {
            // A failed metadata delete must not leave a live prompt capable of
            // submitting its old response, including after worker recreation.
            try {
                const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('security-key.html*') });
                for (const tab of tabs) {
                    const url = new URL(tab.pendingUrl ?? tab.url ?? '');
                    if (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id
                        && url.pathname === '/security-key.html' && tab.id !== undefined) {
                        await chrome.tabs.remove(tab.id);
                    }
                }
            } catch { /* Keep the in-memory block if the browser cannot close its auth pages. */ }
            throw error;
        }
    }

    async handle(message: SecurityKeyMessage, sender: chrome.runtime.MessageSender): Promise<object> {
        const epoch = this.cancelEpoch;
        if (!isInternalSender(sender, chrome.runtime.id) || (sender.frameId !== undefined && sender.frameId !== 0)) {
            throw new Error('Security key authentication is only available inside Starlab Wallet');
        }
        if (message.type === SECURITY_KEY_MESSAGES.OPEN) return this.open(message.action);
        if (this.requestsBlocked) throw new Error('Security key request was cancelled by locking the wallet');
        const pending = await this.pending();
        if (epoch !== this.cancelEpoch) throw new Error('Security key request was cancelled by locking the wallet');
        this.requireOwner(pending, message.requestId, sender);
        if (this.consumed.has(message.requestId)) throw new Error('This security key request has already finished');
        if (this.completing) throw new Error('Security key authentication is already finishing');
        if (message.type === SECURITY_KEY_MESSAGES.CANCEL) {
            this.consumed.add(message.requestId);
            await chrome.storage.session.remove(REQUEST_KEY);
            return { success: true };
        }
        if (message.type === SECURITY_KEY_MESSAGES.GET_REQUEST) {
            const status = await this.keystore().getAuthStatus();
            if (pending!.action === 'create' && status.mode !== 'unconfigured') throw new Error('A vault already exists on this device');
            if (pending!.action === 'unlock' && (!status.credential || status.mode !== 'hardware')) throw new Error('No security key is configured for this vault');
            return {
                success: true,
                action: pending!.action,
                ...(status.credential ? { credential: { credentialId: status.credential.credentialId, prfSalt: status.credential.prfSalt } } : {}),
            };
        }
        if (message.type !== SECURITY_KEY_MESSAGES.COMPLETE) throw new Error('Unknown security key request');
        const assertion = this.assertion(message.assertion);
        this.completing = true;
        this.consumed.add(message.requestId);
        try {
            // Consume before asynchronous crypto/storage work: a completion cannot be replayed.
            await chrome.storage.session.remove(REQUEST_KEY);
            if (epoch !== this.cancelEpoch) throw new Error('Security key request was cancelled by locking the wallet');
            if (pending!.action === 'create') await this.keystore().createHardwareKeystore(assertion, this.deviceId());
            else await this.keystore().unlockHardwareKeystore(assertion);
            await this.onUnlocked();
            return { success: true };
        } finally {
            assertion.prfOutput = '';
            this.completing = false;
        }
    }

    private async open(action: SecurityKeyAction): Promise<object> {
        if (action !== 'create' && action !== 'unlock') throw new Error('Invalid security key action');
        if (this.opening || this.completing) throw new Error('Finish or cancel the current security key request first');
        this.opening = true;
        const epoch = this.cancelEpoch;
        let tabId: number | undefined;
        let createdTab = false;
        let ownsRequest = false;
        try {
            if (this.requestsBlocked) await chrome.storage.session.remove(REQUEST_KEY);
            if (await this.pending()) throw new Error('Finish or cancel the current security key request first');
            const status = await this.keystore().getAuthStatus();
            if (action === 'create' && status.mode !== 'unconfigured') throw new Error('A vault already exists on this device');
            if (action === 'unlock' && status.mode !== 'hardware') throw new Error('This vault uses a password');
            const id = crypto.randomUUID();
            // Reuse only our dedicated authentication page, never a tab the
            // user has navigated elsewhere. Each visit still gets a new nonce.
            const savedId = (await chrome.storage.session.get(AUTH_TAB_KEY))[AUTH_TAB_KEY];
            if (typeof savedId === 'number') {
                try {
                    const tab = await chrome.tabs.get(savedId);
                    const url = new URL(tab.pendingUrl ?? tab.url ?? '');
                    if (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname === '/security-key.html') tabId = savedId;
                } catch { /* The previous authentication page was closed. */ }
            }
            // Bind the Chrome-assigned tab before navigating to the credential page.
            if (tabId === undefined) {
                const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
                tabId = tab.id;
                createdTab = true;
            }
            if (tabId === undefined) throw new Error('Could not open security key authentication');
            const pending: PendingRequest = { id, action, tabId, expiresAt: Date.now() + REQUEST_LIFETIME };
            if (epoch !== this.cancelEpoch) throw new Error('Security key request was cancelled by locking the wallet');
            await chrome.storage.session.set({ [REQUEST_KEY]: pending, [AUTH_TAB_KEY]: tabId });
            ownsRequest = true;
            if (epoch !== this.cancelEpoch) throw new Error('Security key request was cancelled by locking the wallet');
            this.requestsBlocked = false;
            const url = chrome.runtime.getURL(`security-key.html?request=${encodeURIComponent(id)}`);
            await chrome.tabs.update(tabId, { url, active: true });
            if (epoch !== this.cancelEpoch) throw new Error('Security key request was cancelled by locking the wallet');
            return { success: true, requestId: id, url, tabId };
        } catch (error) {
            if (ownsRequest) await chrome.storage.session.remove(REQUEST_KEY);
            if (createdTab && tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
            throw error;
        } finally { this.opening = false; }
    }

    private async pending(): Promise<PendingRequest | null> {
        const value = (await chrome.storage.session.get(REQUEST_KEY))[REQUEST_KEY] as Partial<PendingRequest> | undefined;
        if (!value) return null;
        if (typeof value.id !== 'string' || typeof value.action !== 'string' || !['create', 'unlock'].includes(value.action) || !Number.isInteger(value.tabId)
            || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
            await chrome.storage.session.remove(REQUEST_KEY);
            return null;
        }
        try {
            const tab = await chrome.tabs.get(value.tabId!);
            const url = new URL(tab.pendingUrl ?? tab.url ?? '');
            if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id
                || url.pathname !== '/security-key.html' || url.searchParams.get('request') !== value.id) {
                throw new Error('Security key page was closed');
            }
        }
        catch {
            await chrome.storage.session.remove(REQUEST_KEY);
            return null;
        }
        return value as PendingRequest;
    }

    private requireOwner(pending: PendingRequest | null, id: string, sender: chrome.runtime.MessageSender): void {
        const url = new URL(sender.url!);
        if (!pending || pending.id !== id || sender.tab?.id !== pending.tabId || url.pathname !== '/security-key.html'
            || url.searchParams.get('request') !== pending.id) throw new Error('This security key request expired or belongs to another tab');
    }

    private assertion(value: HardwareAssertion): HardwareAssertion {
        if (!value || typeof value.credentialId !== 'string' || value.credentialId.length > 2048
            || typeof value.prfSalt !== 'string' || value.prfSalt.length !== 43
            || typeof value.prfOutput !== 'string' || value.prfOutput.length !== 43) throw new Error('Invalid security key response');
        return { credentialId: value.credentialId, prfSalt: value.prfSalt, prfOutput: value.prfOutput };
    }
}
