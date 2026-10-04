import { it, expect, jest } from "bun:test";
import { observeKeystoreSession } from "../../src/utils/keystoreSession";
it("refreshes the open popup on background auto-lock and unlock, and cleans up", () => {
    const original = chrome.storage.onChanged;
    let listener: any;
    const remove = jest.fn();
    (chrome.storage as any).onChanged = {addListener: (f: any) => listener = f, removeListener: remove};
    try {
        const refresh = jest.fn();
        const stop = observeKeystoreSession(refresh);
        listener({keystoreSession: {newValue: {unlocked: false}}}, "session");
        listener({keystoreSession: {newValue: {unlocked: true}}}, "session");
        listener({other: {}}, "session");
        listener({keystoreSession: {}}, "local");
        expect(refresh).toHaveBeenCalledTimes(2);
        stop();
        expect(remove).toHaveBeenCalledWith(listener);
    } finally { (chrome.storage as any).onChanged = original; }
});
