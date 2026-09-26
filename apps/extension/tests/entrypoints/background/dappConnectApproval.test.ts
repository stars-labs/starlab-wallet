/**
 * dApp connect approval: eth_requestAccounts / solana_connect from an origin
 * with no stored permission must park until the user decides in the popup.
 * Nothing about the user's accounts is revealed before approval; reject is
 * EIP-1193 4001; approve stores exactly the selected accounts.
 */
import { describe, it, expect, beforeEach, jest, mock } from "bun:test";

import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);

const EVM_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const EVM_B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const EVM_C = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const SOL_1 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL_2 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// The Solana path looks wallets up via a dynamic keystoreManager import.
mock.module("../../../src/services/keystoreManager", () => ({
    KeystoreManager: {
        getInstance: () => ({
            getWallets: () => [
                { id: "evm1", name: "Main", address: EVM_A, blockchain: "ethereum" },
                { id: "sol1", name: "Sol main", address: SOL_1, blockchain: "solana" },
                { id: "sol2", name: "Sol spare", address: SOL_2, blockchain: "solana" },
            ],
            getKeyShareData: () => undefined,
        }),
    },
}));

import { RpcHandler } from "../../../src/entrypoints/background/rpcHandler";
import { PermissionService } from "../../../src/services/permissionService";
import { setBlocklist } from "../../../src/services/phishingService";

const ORIGIN = "https://app.example.org";

async function makeRpc() {
    const chromeGlobal = (global as any).chrome ?? {};
    chromeGlobal.notifications = { create: jest.fn(), clear: jest.fn() };
    const sent: any[] = [];
    chromeGlobal.runtime = {
        ...(chromeGlobal.runtime ?? {}),
        sendMessage: jest.fn((m: any) => {
            sent.push(m);
        }),
    };
    chromeGlobal.action = { openPopup: jest.fn(async () => {}) };
    (global as any).chrome = chromeGlobal;

    (PermissionService as any).instance = null;
    const permissions = PermissionService.getInstance();
    await permissions.ensureInitialized();
    (permissions as any).permissions = new Map();

    const rpc = new RpcHandler();
    (rpc as any).permissionService = permissions;
    (rpc as any).accountService = {
        ensureInitialized: async () => {},
        getAccountsByBlockchain: () => [
            { id: "a", name: "Account 1", address: EVM_A },
            { id: "b", name: "Account 2", address: EVM_B },
            { id: "c", name: "Account 3", address: EVM_C },
        ],
        getCurrentAccount: () => ({ id: "b", name: "Account 2", address: EVM_B }),
        ensureDefaultAccount: async () => null,
    };
    (rpc as any).networkService = { getCurrentNetwork: () => ({ id: 1 }) };
    rpc.setOrigin(ORIGIN);
    return { rpc, permissions, sent };
}

/** Let the handler's awaits settle so the request is parked. */
const settle = () => new Promise((r) => setTimeout(r, 10));

async function requestAccounts(rpc: RpcHandler) {
    const pending = rpc.handleRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_requestAccounts",
        params: [],
    } as any) as Promise<string[]>;
    pending.catch(() => {});
    await settle();
    return { pending };
}

describe("eth_requestAccounts connect approval", () => {
    let env: Awaited<ReturnType<typeof makeRpc>>;

    beforeEach(async () => {
        setBlocklist([]);
        env = await makeRpc();
    });

    it("unconnected origin: parks a connect request instead of connecting", async () => {
        await requestAccounts(env.rpc);

        const [request] = env.rpc.getPendingConnectRequests();
        expect(request.origin).toBe(ORIGIN);
        expect(request.blockchain).toBe("ethereum");
        expect(request.accounts.map((a) => a.address)).toEqual([EVM_A, EVM_B, EVM_C]);
        expect(env.permissions.getConnectedAccounts(ORIGIN)).toEqual([]);
    });

    it("unconnected origin: preselects the current account", async () => {
        await requestAccounts(env.rpc);
        expect(env.rpc.getPendingConnectRequests()[0].selected).toEqual([EVM_B]);
    });

    it("unconnected origin: notifies the popup with the request", async () => {
        await requestAccounts(env.rpc);
        const msg = env.sent.find((m) => m.type === "connectRequest");
        expect(msg.request.requestId).toBe(env.rpc.getPendingConnectRequests()[0].requestId);
    });

    it("reject: fails the dApp request with EIP-1193 code 4001", async () => {
        const { pending } = await requestAccounts(env.rpc);
        const { requestId } = env.rpc.getPendingConnectRequests()[0];

        await env.rpc.resolveConnectRequest(requestId, false);

        await expect(pending).rejects.toMatchObject({ code: 4001 });
    });

    it("reject: stores no permission and clears the queue", async () => {
        const { pending } = await requestAccounts(env.rpc);
        const { requestId } = env.rpc.getPendingConnectRequests()[0];

        await env.rpc.resolveConnectRequest(requestId, false);
        await pending.catch(() => {});

        expect(env.permissions.getConnectedAccounts(ORIGIN)).toEqual([]);
        expect(env.rpc.getPendingConnectRequests()).toEqual([]);
    });

    it("approve with a subset: returns only the selected accounts", async () => {
        const { pending } = await requestAccounts(env.rpc);
        const { requestId } = env.rpc.getPendingConnectRequests()[0];

        await env.rpc.resolveConnectRequest(requestId, true, [EVM_A, EVM_C]);

        expect(await pending).toEqual([EVM_A, EVM_C]);
    });

    it("approve with a subset: connects only the selected accounts", async () => {
        const { pending } = await requestAccounts(env.rpc);
        const { requestId } = env.rpc.getPendingConnectRequests()[0];

        await env.rpc.resolveConnectRequest(requestId, true, [EVM_C]);
        await pending;

        expect(env.permissions.getConnectedAccounts(ORIGIN)).toEqual([EVM_C.toLowerCase()]);
    });

    it("approve with an account that was not offered: refused, request stays pending", async () => {
        await requestAccounts(env.rpc);
        const { requestId } = env.rpc.getPendingConnectRequests()[0];

        const result = await env.rpc.resolveConnectRequest(requestId, true, [
            "0x0000000000000000000000000000000000000001",
        ]);

        expect(result.success).toBe(false);
        expect(env.rpc.getPendingConnectRequests()).toHaveLength(1);
    });

    it("approve with nothing selected: refused", async () => {
        await requestAccounts(env.rpc);
        const { requestId } = env.rpc.getPendingConnectRequests()[0];

        const result = await env.rpc.resolveConnectRequest(requestId, true, []);

        expect(result.success).toBe(false);
    });

    it("connected origin: returns existing accounts without a prompt", async () => {
        await env.permissions.connectAccounts(ORIGIN, [EVM_B], "0x1");

        const accounts = await env.rpc.handleRpcRequest({
            jsonrpc: "2.0",
            id: 2,
            method: "eth_requestAccounts",
            params: [],
        } as any);

        expect(accounts).toEqual([EVM_B.toLowerCase()]);
        expect(env.rpc.getPendingConnectRequests()).toEqual([]);
    });

    it("second request while one is pending: -32002", async () => {
        await requestAccounts(env.rpc);
        const { pending: second } = await requestAccounts(env.rpc);
        await expect(second).rejects.toMatchObject({ code: -32002 });
    });

    it("eth_accounts on an unconnected origin: empty, no prompt", async () => {
        const accounts = await env.rpc.handleRpcRequest({
            jsonrpc: "2.0",
            id: 3,
            method: "eth_accounts",
            params: [],
        } as any);

        expect(accounts).toEqual([]);
        expect(env.rpc.getPendingConnectRequests()).toEqual([]);
    });

    it("known phishing origin: refused with 4100, no prompt", async () => {
        setBlocklist(["app.example.org"]);
        const { pending } = await requestAccounts(env.rpc);
        await expect(pending).rejects.toMatchObject({ code: 4100 });
        expect(env.rpc.getPendingConnectRequests()).toEqual([]);
    });

    it("lookalike origin: prompt carries a phishing warning", async () => {
        env.rpc.setOrigin("https://uniswapp.org");
        await requestAccounts(env.rpc);
        expect(env.rpc.getPendingConnectRequests()[0].warning).toBeTruthy();
    });
});

describe("solana_connect connect approval", () => {
    let env: Awaited<ReturnType<typeof makeRpc>>;

    beforeEach(async () => {
        setBlocklist([]);
        env = await makeRpc();
    });

    async function solanaConnect() {
        const pending = env.rpc.handleRpcRequest({
            jsonrpc: "2.0",
            id: 10,
            method: "solana_connect",
            params: [],
        } as any) as Promise<string>;
        pending.catch(() => {});
        await settle();
        return { pending };
    }

    it("unconnected origin: parks a Solana connect request", async () => {
        await solanaConnect();
        const [request] = env.rpc.getPendingConnectRequests();
        expect(request.blockchain).toBe("solana");
        expect(request.accounts.map((a) => a.address)).toEqual([SOL_1, SOL_2]);
    });

    it("reject: fails with 4001", async () => {
        const { pending } = await solanaConnect();
        await env.rpc.resolveConnectRequest(env.rpc.getPendingConnectRequests()[0].requestId, false);
        await expect(pending).rejects.toMatchObject({ code: 4001 });
    });

    it("approve: returns the selected address with its original casing", async () => {
        const { pending } = await solanaConnect();
        await env.rpc.resolveConnectRequest(env.rpc.getPendingConnectRequests()[0].requestId, true, [SOL_2]);
        expect(await pending).toBe(SOL_2);
    });

    it("approve: keeps the origin's existing EVM connection", async () => {
        await env.permissions.connectAccounts(ORIGIN, [EVM_A], "0x1");
        const { pending } = await solanaConnect();
        await env.rpc.resolveConnectRequest(env.rpc.getPendingConnectRequests()[0].requestId, true, [SOL_1]);
        await pending;

        expect(env.permissions.getConnectedAccounts(ORIGIN).sort()).toEqual(
            [EVM_A.toLowerCase(), SOL_1.toLowerCase()].sort(),
        );
    });

    it("connected origin: returns the connected address without a prompt", async () => {
        await env.permissions.connectAccounts(ORIGIN, [SOL_2], "0x1");
        const address = await env.rpc.handleRpcRequest({
            jsonrpc: "2.0",
            id: 11,
            method: "solana_connect",
            params: [],
        } as any);
        expect(address).toBe(SOL_2);
        expect(env.rpc.getPendingConnectRequests()).toEqual([]);
    });

    it("Solana-only connection is not reported as EVM accounts", async () => {
        await env.permissions.connectAccounts(ORIGIN, [SOL_1], "0x1");
        const accounts = await env.rpc.handleRpcRequest({
            jsonrpc: "2.0",
            id: 12,
            method: "eth_accounts",
            params: [],
        } as any);
        expect(accounts).toEqual([]);
    });
});
