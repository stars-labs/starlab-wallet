/**
 * Signal-server resilience: a dropped socket (weak network, server restart)
 * must come back on its own — before this the extension stayed offline until
 * the service worker restarted or the user re-saved the room.
 */
import { describe, it, expect, jest } from "bun:test";
import { WebSocketManager, reconnectDelayMs } from "../../../src/entrypoints/background/webSocketManager";
import { DkgState } from "@stars-labs/types/dkg";
import { MeshStatusType } from "@stars-labs/types/mesh";

describe("reconnectDelayMs", () => {
    it("starts around a second", () => {
        expect(reconnectDelayMs(0, () => 0)).toBe(500);
        expect(reconnectDelayMs(0, () => 1)).toBe(1000);
    });

    it("backs off exponentially and caps at 30s", () => {
        expect(reconnectDelayMs(3, () => 1)).toBe(8000);
        expect(reconnectDelayMs(20, () => 1)).toBe(30000);
        expect(reconnectDelayMs(20, () => 0)).toBe(15000);
    });
});

function fakeClient() {
    const handlers: Record<string, (arg?: any) => void> = {};
    return {
        handlers,
        onOpen: (cb: any) => (handlers.open = cb),
        onClose: (cb: any) => (handlers.close = cb),
        onError: (cb: any) => (handlers.error = cb),
        onMessage: (cb: any) => (handlers.message = cb),
        register: jest.fn(),
        listdevices: jest.fn(),
        requestActiveSessions: jest.fn(),
        sendSessionStatusUpdate: jest.fn(),
        getReadyState: () => 1,
        disconnect: jest.fn(),
    };
}

function managerWith(client: ReturnType<typeof fakeClient>, sessionInfo: any = null) {
    const appState: any = {
        deviceId: "ext-bob",
        connecteddevices: [],
        wsConnected: false,
        sessionInfo,
        invites: [],
        meshStatus: { type: MeshStatusType.Incomplete },
        dkgState: DkgState.Idle,
        webrtcConnections: {},
    };
    const stateManager = {
        getState: () => appState,
        updateWebSocketStatus: jest.fn(),
        updateConnectedDevices: jest.fn(),
        updateInvites: jest.fn(),
    };
    const mgr = new WebSocketManager(appState, { updateWebSocketClient: jest.fn() } as any, jest.fn() as any, jest.fn(async () => ({ success: true })) as any, stateManager as any);
    (mgr as any).wsClient = client;
    (mgr as any).setupEventHandlers();
    return mgr;
}

describe("WebSocketManager auto-reconnect", () => {
    it("schedules a reconnect when the active socket closes", () => {
        const client = fakeClient();
        const mgr = managerWith(client);
        const schedule = jest.fn();
        (mgr as any).scheduleReconnect = schedule;
        client.handlers.close({ code: 1006, reason: "" });
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it("re-announces our membership of the active session after reconnecting", () => {
        const client = fakeClient();
        managerWith(client, { session_id: "sign_1", proposer_id: "cli-alice", participants: ["cli-alice", "ext-bob"] });
        client.handlers.open();
        expect(client.sendSessionStatusUpdate).toHaveBeenCalledWith("sign_1", "ext-bob");
    });

    it("does not re-announce a session we proposed", () => {
        const client = fakeClient();
        managerWith(client, { session_id: "sign_2", proposer_id: "ext-bob", participants: ["ext-bob"] });
        client.handlers.open();
        expect(client.sendSessionStatusUpdate).not.toHaveBeenCalled();
    });
});
