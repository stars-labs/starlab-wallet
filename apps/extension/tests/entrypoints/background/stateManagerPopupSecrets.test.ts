/**
 * The DKG keystore JSON (secret share included) sits in appState between
 * DKG completion and the wallet save. The popup never needs it, so nothing
 * sent over a popup port may carry it.
 */
import { describe, it, expect, jest } from "bun:test";
import { DkgState } from "@stars-labs/types/dkg";
import { StateManager } from "../../../src/entrypoints/background/stateManager";

const SECRET = '{"key_package":"SECRET_SHARE"}';

function fakePort() {
    return {
        postMessage: jest.fn(),
        onDisconnect: { addListener: jest.fn() },
    } as unknown as chrome.runtime.Port & { postMessage: ReturnType<typeof jest.fn> };
}

function sentPayloads(port: { postMessage: ReturnType<typeof jest.fn> }): string {
    return JSON.stringify(port.postMessage.mock.calls.map((c) => c[0]));
}

async function loadedStateManager() {
    const mgr = new StateManager({ deviceId: "d", dkgState: DkgState.Idle });
    // The constructor loads persisted state asynchronously; ports added
    // before that are queued, not sent to.
    await new Promise((r) => setTimeout(r, 0));
    return mgr;
}

describe("StateManager popup broadcasts", () => {
    it("never send the pending keystore JSON", async () => {
        const mgr = await loadedStateManager();
        (mgr as any).appState.pendingKeystoreJson = SECRET;
        const port = fakePort();
        mgr.addPopupPort(port);
        mgr.broadcastCurrentState();
        expect(port.postMessage).toHaveBeenCalledTimes(2);
        expect(sentPayloads(port)).not.toContain("SECRET_SHARE");
    });

    it("strip keystoreJson from forwarded messages", async () => {
        const mgr = await loadedStateManager();
        const port = fakePort();
        mgr.addPopupPort(port);
        mgr.broadcastToPopupPorts({ type: "dkgCompleted", keystoreJson: SECRET, address: "0xabc" } as any);
        const calls = port.postMessage.mock.calls;
        const last = calls[calls.length - 1][0];
        expect(last).toEqual({ type: "dkgCompleted", address: "0xabc" });
    });
});
