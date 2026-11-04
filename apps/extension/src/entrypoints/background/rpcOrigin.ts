/** Chrome supplies sender metadata; extension pages can also live in tabs. */
export function isInternalSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
    if (sender.id !== extensionId || !sender.url) return false;
    try {
        const url = new URL(sender.url);
        return url.protocol === "chrome-extension:" && url.hostname === extensionId;
    } catch {
        return false;
    }
}

/** Web pages can request approved dApp RPC only, never vault or UI commands. */
export function canSendBackgroundMessage(message: { type: string }, sender: chrome.runtime.MessageSender, extensionId: string): boolean {
    return isInternalSender(sender, extensionId) || message.type === 'dappRpc';
}
