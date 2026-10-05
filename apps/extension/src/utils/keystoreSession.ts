/** Keep an open popup in sync with background auto-lock and unlock events. */
export function observeKeystoreSession(refresh: () => void): () => void {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "session" && "keystoreSession" in changes) refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
}
