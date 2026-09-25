/**
 * This extension's device id — its peer identity on the signal server and in
 * DKG / signing sessions. Generated once per install and persisted, so every
 * extension in a room has a distinct id and keeps it across restarts.
 */

/** chrome.storage.local key holding the persisted device id. */
export const DEVICE_ID_STORAGE_KEY = "deviceId";

function newDeviceId(): string {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    return `ext-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Read the persisted device id, generating and storing one on first use. */
export async function getDeviceId(): Promise<string> {
    const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
    const existing = stored[DEVICE_ID_STORAGE_KEY];
    if (typeof existing === "string" && existing.length > 0) return existing;
    const id = newDeviceId();
    await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: id });
    return id;
}
