/**
 * Page-context registration of the Starlab Solana wallet per the wallet-standard
 * discovery protocol, plus the postMessage bridge to the extension background
 * (same channel the EVM PageProvider uses). Build-only verified — exercising
 * this needs a real page + a Solana dApp.
 */
import { MESSAGE_PREFIX, MessageType } from "../../../constants";
import { createStarlabSolanaWallet, type SolanaBridge } from "./wallet";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function unhex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** postMessage JSON-RPC bridge → content script → background. */
function makeBridge(): SolanaBridge {
  const pending = new Map<string, (r: any) => void>();
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d?.type === `${MESSAGE_PREFIX}${MessageType.RESPONSE}` && d.payload?.id != null) {
      const cb = pending.get(d.payload.id);
      if (cb) {
        pending.delete(d.payload.id);
        cb(d.payload);
      }
    }
  });

  let n = 0;
  function request(method: string, params: unknown[]): Promise<any> {
    const id = `sol_${++n}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      pending.set(id, (resp) =>
        resp.error
          ? reject(new Error(resp.error?.message ?? String(resp.error)))
          : resolve(resp.result),
      );
      window.postMessage(
        { type: `${MESSAGE_PREFIX}${MessageType.REQUEST}`, payload: { id, jsonrpc: "2.0", method, params } },
        "*",
      );
    });
  }

  return {
    connect: () => request("solana_connect", []),
    signMessage: async (address, bytes) =>
      unhex(await request("solana_signBytes", [address, hex(bytes)])),
    signTransaction: async (address, tx) =>
      unhex(await request("solana_signTransaction", [address, hex(tx)])),
    signAndSendTransaction: (address, tx) =>
      request("solana_signAndSendTransaction", [address, hex(tx)]),
  };
}

/** Register the wallet via the wallet-standard handshake (both directions). */
export function registerStarlabSolanaWallet(): void {
  const wallet = createStarlabSolanaWallet(makeBridge());
  // The register-wallet event carries a callback the app invokes with its api;
  // the app-ready event carries the api directly when the app loaded first.
  const callback = (api: { register: (w: unknown) => void }) => {
    try {
      api.register(wallet);
    } catch {
      /* app may register defensively; ignore double-register */
    }
  };
  try {
    const ev = new Event("wallet-standard:register-wallet") as Event & {
      detail: unknown;
    };
    Object.defineProperty(ev, "detail", { value: callback });
    window.dispatchEvent(ev);
  } catch {
    /* no window (non-page context) */
  }
  try {
    window.addEventListener("wallet-standard:app-ready", (e: Event) => {
      callback((e as CustomEvent).detail);
    });
  } catch {
    /* ignore */
  }
}
