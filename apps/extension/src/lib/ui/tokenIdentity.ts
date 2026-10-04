import eth from "../../assets/tokens/eth.svg";
import btc from "../../assets/tokens/btc.svg";
import sol from "../../assets/tokens/sol.svg";
import sui from "../../assets/tokens/sui.png";
import usdc from "../../assets/tokens/usdc.svg";
import usdt from "../../assets/tokens/usdt.svg";
import dai from "../../assets/tokens/dai.svg";
import bnb from "../../assets/tokens/bnb.svg";
import pol from "../../assets/tokens/pol.svg";
import avax from "../../assets/tokens/avax.svg";
import { DEFAULT_TOKENS } from "../../services/tokenService";

const images: Record<string, string> = { ETH: eth, BTC: btc, SOL: sol, SUI: sui, USDC: usdc, USDT: usdt, DAI: dai, BNB: bnb, POL: pol, AVAX: avax };
const chainIds: Record<string, number> = { ethereum: 1, polygon: 137, base: 8453, arbitrum: 42161, optimism: 10, bsc: 56, avalanche: 43114 };
export function nativeSymbol(chain: string): string {
    return ({ bitcoin: "BTC", solana: "SOL", sui: "SUI", polygon: "POL", "137": "POL", bsc: "BNB", "56": "BNB", avalanche: "AVAX", "43114": "AVAX" } as Record<string, string>)[chain] ?? "ETH";
}
export function tokenImage(symbol: string, chain: string, address?: string): string | undefined {
    if (address) {
        const chainId = chainIds[chain] ?? Number(chain);
        const known = DEFAULT_TOKENS[chainId]?.find((token) => token.address.toLowerCase() === address.toLowerCase());
        return known ? images[known.symbol] : undefined;
    }
    // A native asset's identity is the chain, never an arbitrary token ticker.
    return images[nativeSymbol(chain)];
}
