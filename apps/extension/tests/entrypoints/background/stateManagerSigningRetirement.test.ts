import { describe, it, expect, jest } from "bun:test";
import { StateManager } from "../../../src/entrypoints/background/stateManager";
import { WebSocketManager } from "../../../src/entrypoints/background/webSocketManager";
import { WebSocketClient } from "../../../src/entrypoints/background/websocket";
const session = (id: string) => ({session_id: id, session_type: "signing", proposer_id: "creator", participants: ["creator", "signer", "observer"], threshold: 2, total: 3}) as any;
function complete(mgr: StateManager, id: string) {
    mgr.handleOffscreenStateUpdate({type: "signingComplete", sessionId: id, signingId: id, signature: "abcd", messageHex: "42", blockchain: "ethereum"} as any);
}
describe("completed signing invite retirement", () => {
    it("withdraws the proposer invite, resolves the signature and allows another ceremony", () => {
        const mgr = new StateManager({deviceId: "creator"});
        const withdraw = jest.fn(), resolve = jest.fn();
        mgr.setSigningInviteWithdrawal(withdraw);
        mgr.setRpcHandler({handleSignatureComplete: resolve});
        for (const id of ["first", "second"]) {
            mgr.updateState({sessionInfo: session(id), invites: [session(id)]});
            complete(mgr, id);
            expect(withdraw).toHaveBeenLastCalledWith(id);
            expect(resolve).toHaveBeenLastCalledWith(id, "abcd");
            expect(mgr.getState().sessionInfo).toBeNull();
            expect(mgr.getState().invites).toHaveLength(0);
        }
        expect(withdraw).toHaveBeenCalledTimes(2);
    });
    it("wires completion to the existing leave_session frame without closing transport", () => {
        const mgr = new StateManager({deviceId: "creator"});
        const socket = {readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn()};
        const client = new WebSocketClient("ws://localhost");
        (client as any).ws = socket;
        const transport = new WebSocketManager(mgr.getState(), {} as any, () => {}, async () => ({success: true}), mgr);
        (transport as any).wsClient = client;
        mgr.updateState({sessionInfo: session("first")});
        complete(mgr, "first");
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({type: "leave_session", session_id: "first"}));
        expect(socket.close).not.toHaveBeenCalled();
    });
    it("retries a withdrawal lost while disconnected before requesting session replay", () => {
        const mgr = new StateManager({deviceId: "creator"});
        const socket = {readyState: WebSocket.CLOSED as number, send: jest.fn(), close: jest.fn()};
        const client = new WebSocketClient("ws://localhost");
        (client as any).ws = socket;
        const transport = new WebSocketManager(mgr.getState(), {updateWebSocketClient() {}} as any, () => {}, async () => ({success: true}), mgr);
        (transport as any).wsClient = client;
        (transport as any).setupEventHandlers();
        mgr.updateState({sessionInfo: session("first")});
        complete(mgr, "first");
        expect(socket.send).not.toHaveBeenCalled();
        socket.readyState = WebSocket.OPEN;
        for (const open of (client as any).onOpenCallbacks) open();
        expect(socket.send.mock.calls[0][0]).toBe(JSON.stringify({type: "register", device_id: "creator"}));
        expect(socket.send.mock.calls[1][0]).toBe(JSON.stringify({type: "leave_session", session_id: "first"}));
    });
    it("co-signers and outsiders never send leave_session", () => {
        for (const deviceId of ["signer", "observer"]) {
            const mgr = new StateManager({deviceId});
            const withdraw = jest.fn();
            mgr.setSigningInviteWithdrawal(withdraw);
            mgr.updateState({sessionInfo: session("first")});
            complete(mgr, "first");
            expect(withdraw).not.toHaveBeenCalled();
            expect((mgr.getState() as any).lastSignature.signature).toBe("abcd");
        }
    });
    it("an old completion cannot withdraw a newer session", () => {
        const mgr = new StateManager({deviceId: "creator"});
        const withdraw = jest.fn();
        mgr.setSigningInviteWithdrawal(withdraw);
        mgr.updateState({sessionInfo: session("next")});
        complete(mgr, "previous");
        expect(withdraw).not.toHaveBeenCalled();
        expect(mgr.getState().sessionInfo?.session_id).toBe("next");
    });
});
