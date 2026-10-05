/** Real viem transport probe, isolated from Bun's process-global module mocks. */
import { createPublicClient, custom } from "viem";
import { discoverTokens } from "../../src/services/tokenService";
import { discoverNfts, discoverErc1155 } from "../../src/services/nftService";

const discovery = {
    "ERC-20": discoverTokens,
    "ERC-721": discoverNfts,
    "ERC-1155": discoverErc1155,
};
const standard = process.argv[2] as keyof typeof discovery;
if (!Object.prototype.hasOwnProperty.call(discovery, standard)) throw new Error("Unknown discovery standard");

const requests: unknown[] = [];
const client = createPublicClient({ transport: custom({
    request: async (request) => { requests.push(request); return []; },
}) });
await discovery[standard](client, "0x1111111111111111111111111111111111111111", {
    fromBlock: 100n, toBlock: 200n,
});
process.stdout.write(JSON.stringify(requests));
