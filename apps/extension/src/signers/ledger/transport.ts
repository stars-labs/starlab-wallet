import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";

/**
 * WebHID transport for a Ledger device.
 *
 * IMPORTANT — context: WebHID (`navigator.hid`) is **not** available in the
 * MV3 background service worker, and the permission prompt
 * (`TransportWebHID.request`) needs a real user gesture. So every function
 * here must run in a DOM context that the user is interacting with — the popup
 * or a dedicated extension page — never the service worker. The background SW
 * routes a sign request to that context via messaging; it cannot hold a live
 * Ledger transport itself.
 */

/** Whether this context can talk to WebHID at all (false in the SW). */
export function isWebHidAvailable(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

/**
 * Prompt the user to pick a Ledger and open it. Must be called from a user
 * gesture (e.g. a "Connect Ledger" button handler in the popup).
 */
export async function requestLedgerTransport(): Promise<Transport> {
  if (!isWebHidAvailable()) {
    throw new Error(
      "WebHID unavailable in this context — connect a Ledger from the popup, not the background worker",
    );
  }
  return TransportWebHID.request();
}

/**
 * Open an already-granted, currently-connected Ledger without a prompt.
 * Returns null if none is connected/granted yet.
 */
export async function openLedgerTransport(): Promise<Transport | null> {
  if (!isWebHidAvailable()) return null;
  try {
    return await TransportWebHID.openConnected();
  } catch {
    return null;
  }
}
