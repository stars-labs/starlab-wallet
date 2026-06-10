/**
 * Builds the `eth_sendTransaction` parameter object for a user-initiated send,
 * for both native coin and ERC-20 transfers. Pure (no I/O) so it's unit-tested
 * exactly; the popup hands the result straight to the existing
 * eth_sendTransaction → FROST sign → broadcast path.
 *
 * A native send is `{ to, value }`; an ERC-20 send is a call to the token
 * contract — `{ to: token, value: 0, data: transfer(recipient, amount) }`.
 */
import { numberToHex } from "viem";
import {
  encodeErc20Transfer,
  parseTokenAmount,
  type TokenInfo,
} from "./tokenService";

export interface EthSendParams {
  from?: string;
  to: string;
  /** hex wei */
  value: string;
  /** hex calldata */
  data: string;
}

const ZERO = "0x0";

/** Native coin send. `amount` is a human string (e.g. "0.25"); 18 decimals. */
export function buildNativeSend(
  from: string,
  to: string,
  amount: string,
): EthSendParams {
  const wei = parseTokenAmount(amount, 18);
  return { from, to, value: numberToHex(wei), data: "0x" };
}

/** ERC-20 transfer. `amount` is a human string in the token's own decimals. */
export function buildTokenSend(
  from: string,
  recipient: string,
  amount: string,
  token: Pick<TokenInfo, "address" | "decimals">,
): EthSendParams {
  const raw = parseTokenAmount(amount, token.decimals);
  return {
    from,
    to: token.address,
    value: ZERO,
    data: encodeErc20Transfer(recipient, raw),
  };
}

/**
 * Unified entry: build a send for either asset kind. `token` undefined ⇒ native.
 * `to` is always the human recipient (for tokens it's encoded into calldata and
 * the tx `to` becomes the contract).
 */
export function buildSendTransaction(opts: {
  from: string;
  to: string;
  amount: string;
  token?: Pick<TokenInfo, "address" | "decimals">;
}): EthSendParams {
  return opts.token
    ? buildTokenSend(opts.from, opts.to, opts.amount, opts.token)
    : buildNativeSend(opts.from, opts.to, opts.amount);
}
