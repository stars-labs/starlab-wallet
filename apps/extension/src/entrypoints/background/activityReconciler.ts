/**
 * Receipt-polling reconciler (#11): flips `pending` activity entries to
 * `confirmed` / `failed` once their tx receipt lands.
 *
 * MV3 note: this is driven by chrome.alarms, NOT setInterval — the service
 * worker is torn down after ~30s idle, which silently kills timers. Alarms
 * survive SW death and re-wake it for the next tick, so a send made just
 * before the popup closed still gets reconciled.
 *
 * The tick itself is dependency-injected (activity store + chainId→client
 * mapping) so the receipt-driven status transition is unit-testable with a
 * fake RPC; the zero-arg default binds the real singletons.
 */
import type { PublicClient } from "viem";

export const RECONCILE_ALARM = "activity-reconcile";
/** 0.5 min = 30s — the chrome.alarms minimum period. */
export const RECONCILE_PERIOD_MINUTES = 0.5;

type ReceiptClient = Pick<PublicClient, "getTransactionReceipt">;

export interface ReconcileTickDeps {
    activity: {
        reconcileAllPending: (
            clientFor: (chainId: number) => ReceiptClient | undefined,
        ) => Promise<number>;
    };
    clientFor: (chainId: number) => ReceiptClient | undefined;
    /** Called with the number of entries that changed status (if > 0). */
    notify?: (changed: number) => void;
}

/** Bind the real ActivityService + NetworkService singletons. */
async function defaultDeps(): Promise<ReconcileTickDeps> {
    const { ActivityService } = await import("../../services/activityService");
    const NetworkService = (await import("../../services/networkService")).default;
    const net = NetworkService.getInstance();
    return {
        activity: ActivityService.getInstance(),
        clientFor: (chainId) => {
            const network = net.getNetworkByChainId(chainId);
            return network ? (net.getPublicClient(network) as ReceiptClient) : undefined;
        },
        notify: (changed) => {
            console.log(`[Background] activity reconciler: ${changed} tx finalized`);
            // Nudge an open popup so the feed flips without a manual refresh.
            // Best-effort: with no popup open sendMessage rejects — ignore.
            try {
                chrome.runtime
                    .sendMessage({ type: "activityChanged", changed })
                    .catch(() => {});
            } catch {
                /* no runtime (tests) or popup closed */
            }
        },
    };
}

/**
 * One reconciliation pass over every pending tx. Returns how many entries
 * changed status. Chains without a configured network are skipped; a failed
 * receipt poll just waits for the next tick.
 */
export async function runReconcileTick(deps?: ReconcileTickDeps): Promise<number> {
    const d = deps ?? (await defaultDeps());
    const changed = await d.activity.reconcileAllPending(d.clientFor);
    if (changed > 0) d.notify?.(changed);
    return changed;
}

/**
 * Register the recurring alarm + listener. Idempotent: chrome.alarms.create
 * with the same name replaces the existing alarm, and this runs once per SW
 * start so the listener isn't stacked.
 */
export function setupActivityReconciler(
    tick: (deps?: ReconcileTickDeps) => Promise<number> = runReconcileTick,
): void {
    if (typeof chrome === "undefined" || !chrome.alarms) {
        console.warn("[Background] chrome.alarms unavailable — activity reconciler disabled");
        return;
    }
    chrome.alarms.create(RECONCILE_ALARM, {
        periodInMinutes: RECONCILE_PERIOD_MINUTES,
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== RECONCILE_ALARM) return;
        void tick().catch((e) => {
            console.warn("[Background] activity reconciler tick failed:", e);
        });
    });
}
