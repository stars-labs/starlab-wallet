/**
 * activityReconciler tests (#11) — the alarm-driven receipt-polling loop that
 * flips `pending` activity to confirmed/failed. The tick gets a fake RPC
 * client injected; alarm registration is checked against a stubbed
 * chrome.alarms (MV3: alarms, not setInterval — SW timers die with the
 * worker).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  runReconcileTick,
  setupActivityReconciler,
  RECONCILE_ALARM,
  RECONCILE_PERIOD_MINUTES,
  type ReconcileTickDeps,
} from "../../../src/entrypoints/background/activityReconciler";
import { ActivityService } from "../../../src/services/activityService";

const ACC = "0x1111111111111111111111111111111111111111";
const HASH = "0x" + "ab".repeat(32);

function freshService(): ActivityService {
  const svc = ActivityService.getInstance();
  (svc as any).byAccount = {};
  (svc as any).loaded = false;
  return svc;
}

function pendingTx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hash: HASH,
    chainId: 1,
    from: ACC,
    to: "0x2222222222222222222222222222222222222222",
    value: "1000000000000000000",
    kind: "send" as const,
    ...overrides,
  };
}

function receiptClient(status: "success" | "reverted" | "missing") {
  return {
    getTransactionReceipt: async () => {
      if (status === "missing") throw new Error("receipt not found");
      return { status } as any;
    },
  };
}

describe("runReconcileTick", () => {
  it("flips a pending tx to confirmed when the receipt is success", async () => {
    const svc = freshService();
    await svc.record(ACC, pendingTx());

    const notify = jest.fn();
    const changed = await runReconcileTick({
      activity: svc,
      clientFor: () => receiptClient("success"),
      notify,
    });

    expect(changed).toBe(1);
    expect(notify).toHaveBeenCalledWith(1);
    const [entry] = await svc.list(ACC);
    expect(entry.status).toBe("confirmed");
  });

  it("flips a pending tx to failed when the receipt is reverted", async () => {
    const svc = freshService();
    await svc.record(ACC, pendingTx());

    const changed = await runReconcileTick({
      activity: svc,
      clientFor: () => receiptClient("reverted"),
    });

    expect(changed).toBe(1);
    const [entry] = await svc.list(ACC);
    expect(entry.status).toBe("failed");
  });

  it("keeps a tx pending (and does not notify) while no receipt exists", async () => {
    const svc = freshService();
    await svc.record(ACC, pendingTx());

    const notify = jest.fn();
    const changed = await runReconcileTick({
      activity: svc,
      clientFor: () => receiptClient("missing"),
      notify,
    });

    expect(changed).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    const [entry] = await svc.list(ACC);
    expect(entry.status).toBe("pending");
  });

  it("skips chains without a configured client", async () => {
    const svc = freshService();
    await svc.record(ACC, pendingTx({ chainId: 4242 }));

    const changed = await runReconcileTick({
      activity: svc,
      clientFor: () => undefined,
    });

    expect(changed).toBe(0);
    const [entry] = await svc.list(ACC);
    expect(entry.status).toBe("pending");
  });
});

describe("setupActivityReconciler", () => {
  const realChrome = (global as any).chrome;
  let alarmListeners: Array<(alarm: { name: string }) => void>;
  let create: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    alarmListeners = [];
    create = jest.fn();
    (global as any).chrome = {
      ...realChrome,
      alarms: {
        create,
        onAlarm: {
          addListener: (fn: (alarm: { name: string }) => void) =>
            alarmListeners.push(fn),
        },
      },
    };
  });
  afterEach(() => {
    (global as any).chrome = realChrome;
  });

  it("registers a 30s repeating alarm", () => {
    setupActivityReconciler(jest.fn(async () => 0));
    expect(create).toHaveBeenCalledWith(RECONCILE_ALARM, {
      periodInMinutes: RECONCILE_PERIOD_MINUTES,
    });
    expect(RECONCILE_PERIOD_MINUTES).toBe(0.5);
    expect(alarmListeners.length).toBe(1);
  });

  it("runs the tick only for its own alarm", async () => {
    const tick = jest.fn(async (_?: ReconcileTickDeps) => 0);
    setupActivityReconciler(tick);

    alarmListeners[0]({ name: "some-other-alarm" });
    expect(tick).not.toHaveBeenCalled();

    alarmListeners[0]({ name: RECONCILE_ALARM });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("does nothing (no throw) when chrome.alarms is unavailable", () => {
    (global as any).chrome = { ...realChrome, alarms: undefined };
    expect(() => setupActivityReconciler(jest.fn(async () => 0))).not.toThrow();
  });
});
