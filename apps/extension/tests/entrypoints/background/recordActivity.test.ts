/**
 * Record-on-send wiring tests (#11) — the popup SendForm path lands in
 * handleRecordActivity, which must produce a `pending` ActivityService entry
 * with the exact broadcast fields, reject garbage hashes (they could never
 * reconcile), and dedupe against the dApp-path record (same chainId+hash).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { handleRecordActivity } from "../../../src/entrypoints/background/assetHandlers";
import { ActivityService } from "../../../src/services/activityService";

const ACC = "0x1111111111111111111111111111111111111111";
const HASH = "0x" + "cd".repeat(32);

const sendTx = {
  hash: HASH,
  chainId: 11155111,
  from: ACC,
  to: "0x2222222222222222222222222222222222222222",
  value: "250000000000000000",
  kind: "send" as const,
};

beforeEach(() => {
  const svc = ActivityService.getInstance();
  (svc as any).byAccount = {};
  (svc as any).loaded = false;
});

describe("handleRecordActivity (popup send path)", () => {
  it("records a pending entry with the broadcast fields", async () => {
    const entry = await handleRecordActivity(ACC, sendTx);
    expect(entry.status).toBe("pending");

    const list = await ActivityService.getInstance().list(ACC);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      hash: HASH,
      chainId: 11155111,
      from: ACC,
      to: sendTx.to,
      value: "250000000000000000",
      kind: "send",
      status: "pending",
    });
  });

  it("records a token transfer with its contract address", async () => {
    const token = "0x3333333333333333333333333333333333333333";
    await handleRecordActivity(ACC, {
      ...sendTx,
      to: token,
      value: "0",
      kind: "token-transfer",
      tokenAddress: token,
    });
    const [entry] = await ActivityService.getInstance().list(ACC);
    expect(entry.kind).toBe("token-transfer");
    expect(entry.tokenAddress).toBe(token);
  });

  it("rejects a malformed tx hash (would never reconcile)", async () => {
    await expect(
      handleRecordActivity(ACC, { ...sendTx, hash: "0x1234" }),
    ).rejects.toThrow(/Invalid transaction hash/);
    await expect(
      handleRecordActivity(ACC, { ...sendTx, hash: "not-a-hash" }),
    ).rejects.toThrow(/Invalid transaction hash/);
    expect((await ActivityService.getInstance().list(ACC)).length).toBe(0);
  });

  it("rejects an invalid chainId", async () => {
    await expect(
      handleRecordActivity(ACC, { ...sendTx, chainId: 0 }),
    ).rejects.toThrow(/Invalid chainId/);
  });

  it("dedupes against the dApp-path record by (chainId, hash)", async () => {
    // RpcHandler.broadcastAndRecord wrote first (dApp/hardware path)…
    await ActivityService.getInstance().record(ACC, sendTx);
    // …then the popup records the same broadcast.
    await handleRecordActivity(ACC, sendTx);

    const list = await ActivityService.getInstance().list(ACC);
    expect(list.length).toBe(1);
  });

  it("the recorded entry is visible to pending() for the reconciler", async () => {
    await handleRecordActivity(ACC, sendTx);
    const pending = await ActivityService.getInstance().pending(ACC);
    expect(pending.map((p) => p.hash)).toEqual([HASH]);
  });
});
