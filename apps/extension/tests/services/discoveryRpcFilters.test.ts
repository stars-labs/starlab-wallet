import { describe, expect, it } from "bun:test";
import { createPublicClient, custom } from "viem";
import { discoverTokens, TRANSFER_TOPIC } from "../../src/services/tokenService";
import { discoverNfts, discoverErc1155, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC } from "../../src/services/nftService";

const account = "0x1111111111111111111111111111111111111111";
const recipient = `0x${account.slice(2).padStart(64, "0")}`;

describe("discovery filters through the actual viem transport", () => {
    for (const [name, discover, topics] of [
        ["ERC-20", discoverTokens, [TRANSFER_TOPIC, null, recipient]],
        ["ERC-721", discoverNfts, [TRANSFER_TOPIC, null, recipient]],
        ["ERC-1155", discoverErc1155, [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, null, recipient]],
    ] as const) {
        it(`${name} sends the indexed recipient and block range to eth_getLogs`, async () => {
            const requests: any[] = [];
            const client = createPublicClient({ transport: custom({
                request: async (request) => { requests.push(request); return []; },
            }) });
            await discover(client, account, { fromBlock: 100n, toBlock: 200n });
            expect(requests).toEqual([{ method: "eth_getLogs", params: [{
                fromBlock: "0x64", toBlock: "0xc8", topics,
            }] }]);
        });
    }
});
