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
