/**
 * activityService tests — the record/dedupe/status-transition logic and
 * receipt reconciliation, which is what a trustworthy activity feed hinges on.
 * chrome.storage comes from setup-bun; Date.now is stubbed for deterministic
 * ordering.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ActivityService } from "../../src/services/activityService";

const ACC = "0x1111111111111111111111111111111111111111";
const realNow = globalThis.Date.now;
let clock = 1_000;

function freshService(): ActivityService {
  const svc = ActivityService.getInstance();
  (svc as any).byAccount = {};
  (svc as any).loaded = false;
  return svc;
}

beforeEach(() => {
  clock = 1_000;
  (globalThis as any).Date.now = () => ++clock;
});
afterEach(() => {
  (globalThis as any).Date.now = realNow;
});

const baseTx = {
  hash: "0xaaa",
  chainId: 1,
  from: ACC,
  to: "0xbbb",
  value: "1000000000000000000",
  kind: "send" as const,
};

describe("ActivityService.record / list", () => {
  it("records a pending entry and lists it", async () => {
    const svc = freshService();
    const entry = await svc.record(ACC, baseTx);
    expect(entry.status).toBe("pending");
    const list = await svc.list(ACC);
    expect(list.length).toBe(1);
    expect(list[0].hash).toBe("0xaaa");
  });

  it("is idempotent by (chainId, hash) — re-record updates, no dupe", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    await svc.record(ACC, { ...baseTx, to: "0xCCC" }); // same hash+chain
    const list = await svc.list(ACC);
    expect(list.length).toBe(1);
    expect(list[0].to).toBe("0xCCC");
  });

  it("treats same hash on a different chain as distinct", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    await svc.record(ACC, { ...baseTx, chainId: 137 });
    expect((await svc.list(ACC)).length).toBe(2);
    expect((await svc.list(ACC, 137)).length).toBe(1);
  });

  it("lists newest-first", async () => {
    const svc = freshService();
    await svc.record(ACC, { ...baseTx, hash: "0x1" });
    await svc.record(ACC, { ...baseTx, hash: "0x2" });
    await svc.record(ACC, { ...baseTx, hash: "0x3" });
    const list = await svc.list(ACC);
    expect(list.map((a) => a.hash)).toEqual(["0x3", "0x2", "0x1"]);
  });
});

describe("ActivityService.setStatus / pending", () => {
  it("transitions pending → confirmed", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    expect((await svc.pending(ACC)).length).toBe(1);
    await svc.setStatus(ACC, "0xaaa", "confirmed");
    expect((await svc.pending(ACC)).length).toBe(0);
    expect((await svc.list(ACC))[0].status).toBe("confirmed");
  });

  it("setStatus on an unknown hash is a no-op", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    await svc.setStatus(ACC, "0xZZZ", "failed");
    expect((await svc.list(ACC))[0].status).toBe("pending");
  });
});

describe("ActivityService.reconcile", () => {
  it("confirms on a success receipt", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    const client = { getTransactionReceipt: async () => ({ status: "success" }) } as any;
    expect(await svc.reconcile(ACC, client, "0xaaa")).toBe("confirmed");
    expect((await svc.list(ACC))[0].status).toBe("confirmed");
  });

  it("fails on a reverted receipt", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    const client = { getTransactionReceipt: async () => ({ status: "reverted" }) } as any;
    expect(await svc.reconcile(ACC, client, "0xaaa")).toBe("failed");
  });

  it("stays pending when the receipt isn't available yet", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    const client = {
      getTransactionReceipt: async () => {
        throw new Error("not found");
      },
    } as any;
    expect(await svc.reconcile(ACC, client, "0xaaa")).toBe("pending");
    expect((await svc.list(ACC))[0].status).toBe("pending");
  });
});

describe("ActivityService persistence", () => {
  it("reloads activity from chrome.storage", async () => {
    const svc = freshService();
    await svc.record(ACC, baseTx);
    // drop the in-memory cache; next read must come from storage
    (svc as any).loaded = false;
    (svc as any).byAccount = {};
    const list = await svc.list(ACC);
    expect(list.length).toBe(1);
    expect(list[0].hash).toBe("0xaaa");
  });
});
