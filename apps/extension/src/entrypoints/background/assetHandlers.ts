/**
 * Asset/portfolio aggregation for the popup: native + ERC-20 balances joined
 * with fiat prices, plus the activity feed. The aggregation core
 * ({@link buildPortfolio}) takes its dependencies as plain objects so it's
 * unit-testable with fakes; the message-handler wrappers below bind the real
 * singletons (NetworkService public client, TokenRegistry, PriceService,
 * ActivityService).
 */
import { formatUnits } from "viem";
import {
  fetchTokenBalance,
  TokenRegistry,
  type TokenInfo,
} from "../../services/tokenService";
import {
  PriceService,
  CHAIN_NATIVE_COINGECKO_ID,
  fiatValue,
} from "../../services/priceService";
import { ActivityService } from "../../services/activityService";

export interface AssetView {
  symbol: string;
  /** Contract address for tokens; omitted for the native coin. */
  address?: string;
  decimals: number;
  /** Human-readable balance (already divided by decimals). */
  balance: string;
  /** Fiat (USD) value of the balance, if a price was available. */
  fiat?: number;
}

export interface Portfolio {
  native: AssetView;
  tokens: AssetView[];
  /** Sum of all available fiat values. */
  totalFiat: number;
}

interface PortfolioDeps {
  /** viem-ish client exposing getBalance + readContract (balanceOf). */
  client: {
    getBalance: (a: { address: `0x${string}` }) => Promise<bigint>;
    readContract: (a: any) => Promise<unknown>;
  };
  chainId: number;
  account: string;
  nativeSymbol: string;
  nativeDecimals?: number;
  tokens: TokenInfo[];
  prices: {
    getPricesByIds: (ids: string[]) => Promise<Record<string, number>>;
    getTokenPrices: (
      chainId: number,
      addrs: string[],
    ) => Promise<Record<string, number>>;
  };
}

/**
 * Read native + token balances and join with fiat. A token whose balanceOf or
 * price fails is skipped/priced-as-undefined rather than failing the whole
 * portfolio — one bad token contract shouldn't blank the popup.
 */
export async function buildPortfolio(deps: PortfolioDeps): Promise<Portfolio> {
  const nativeDecimals = deps.nativeDecimals ?? 18;

  // Native balance + price (in parallel with token reads below).
  const nativeBalP = deps.client
    .getBalance({ address: deps.account as `0x${string}` })
    .catch(() => 0n);

  const tokenBalsP = Promise.all(
    deps.tokens.map((t) =>
      fetchTokenBalance(deps.client as any, t.address, deps.account)
        .then((raw) => ({ t, raw }))
        .catch(() => ({ t, raw: 0n })),
    ),
  );

  const nativeId = CHAIN_NATIVE_COINGECKO_ID[deps.chainId];
  const pricesP = Promise.all([
    nativeId ? deps.prices.getPricesByIds([nativeId]).catch(() => ({})) : Promise.resolve({}),
    deps.tokens.length
      ? deps.prices
          .getTokenPrices(
            deps.chainId,
            deps.tokens.map((t) => t.address),
          )
          .catch(() => ({}))
      : Promise.resolve({}),
  ]);

  const [nativeRaw, tokenBals, [nativePrices, tokenPrices]] = await Promise.all([
    nativeBalP,
    tokenBalsP,
    pricesP,
  ]);

  let totalFiat = 0;

  const nativeBalance = formatUnits(nativeRaw, nativeDecimals);
  const nativeUnit = nativeId ? (nativePrices as any)[nativeId] : undefined;
  const nativeFiat =
    typeof nativeUnit === "number"
      ? fiatValue(Number(nativeBalance), nativeUnit)
      : undefined;
  if (nativeFiat !== undefined) totalFiat += nativeFiat;

  const tokens: AssetView[] = tokenBals.map(({ t, raw }) => {
    const balance = formatUnits(raw, t.decimals);
    const unit = (tokenPrices as any)[t.address.toLowerCase()];
    const fiat =
      typeof unit === "number" ? fiatValue(Number(balance), unit) : undefined;
    if (fiat !== undefined) totalFiat += fiat;
    return { symbol: t.symbol, address: t.address, decimals: t.decimals, balance, fiat };
  });

  return {
    native: {
      symbol: deps.nativeSymbol,
      decimals: nativeDecimals,
      balance: nativeBalance,
      fiat: nativeFiat,
    },
    tokens,
    totalFiat,
  };
}

// ── message-handler wrappers (bind the real singletons) ─────────────────────

/** Build the portfolio for the current EVM account/network. */
export async function handleGetPortfolio(
  account: string,
  chainId: number,
  publicClient: any,
  nativeSymbol = "ETH",
): Promise<Portfolio> {
  const tokens = await TokenRegistry.getInstance().list(chainId);
  return buildPortfolio({
    client: publicClient,
    chainId,
    account,
    nativeSymbol,
    tokens,
    prices: PriceService.getInstance(),
  });
}

/** Activity feed for an account (optionally chain-filtered). */
export async function handleGetActivity(account: string, chainId?: number) {
  return ActivityService.getInstance().list(account, chainId);
}
