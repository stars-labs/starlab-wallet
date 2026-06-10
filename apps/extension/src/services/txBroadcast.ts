/**
 * Assemble a FROST-signed EVM transaction into its broadcast-ready raw form,
 * and broadcast it. This is the missing link between "the threshold ceremony
 * produced (r,s,recovery)" and "the tx is on-chain": the wallet was signing but
 * never serializing+broadcasting (eth_sendTransaction returned the signature).
 *
 * The assembly is pure and unit-tested against viem's own signer so a wrong
 * yParity / encoding can't ship — that's the part that, done wrong, broadcasts
 * an invalid or wrong-sender transaction.
 */
import {
  serializeTransaction,
  type TransactionSerializable,
} from "viem";
import type { Secp256k1Signature } from "../signers/signer";

function pad32(hex: string): `0x${string}` {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${h.padStart(64, "0")}` as `0x${string}`;
}

/**
 * Serialize a transaction together with a FROST/hardware secp256k1 signature
 * into the raw signed tx hex ready for `eth_sendRawTransaction`. `recovery`
 * (0/1) becomes `yParity` for typed txs / the parity viem needs for legacy.
 */
export function assembleSignedEvmTx(
  tx: TransactionSerializable,
  sig: Secp256k1Signature,
): `0x${string}` {
  const r = pad32(sig.r);
  const s = pad32(sig.s);
  const isLegacy = !tx.type || tx.type === "legacy";
  if (isLegacy) {
    // Legacy wants `v` (bigint). EIP-155: v = chainId*2 + 35 + recovery;
    // pre-155: v = 27 + recovery. (Typed txs use yParity below.)
    const chainId = (tx as { chainId?: number }).chainId;
    const v = chainId
      ? BigInt(chainId) * 2n + 35n + BigInt(sig.recovery)
      : BigInt(27 + sig.recovery);
    return serializeTransaction(tx, { r, s, v });
  }
  return serializeTransaction(tx, { r, s, yParity: sig.recovery });
}

/**
 * Broadcast a raw signed tx via JSON-RPC. Returns the tx hash. Throws the
 * node's error (e.g. nonce too low, insufficient funds) so the caller can show it.
 */
export async function broadcastRawTx(
  rpcUrl: string,
  signedTxHex: `0x${string}`,
): Promise<`0x${string}`> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [signedTxHex],
    }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message ?? "eth_sendRawTransaction failed");
  }
  return json.result as `0x${string}`;
}
