import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { TRANSFER_TOPIC } from "../../src/services/tokenService";
import { TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC } from "../../src/services/nftService";

const account = "0x1111111111111111111111111111111111111111";
const recipient = `0x${account.slice(2).padStart(64, "0")}`;

describe("discovery filters through the actual viem transport", () => {
    for (const [name, topics] of [
        ["ERC-20", [TRANSFER_TOPIC, null, recipient]],
        ["ERC-721", [TRANSFER_TOPIC, null, recipient]],
        ["ERC-1155", [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, null, recipient]],
    ] as const) {
        it(`${name} sends the indexed recipient and block range to eth_getLogs`, async () => {
            // Several service tests mock the entire viem module globally. A fresh
            // process keeps this regression on the installed client's real transport.
            const probe = Bun.spawn([
                process.execPath, "run",
                fileURLToPath(new URL("../helpers/discoveryRpcFilterProbe.ts", import.meta.url)),
                name,
            ], { stdout: "pipe", stderr: "pipe" });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(probe.stdout).text(),
                new Response(probe.stderr).text(),
                probe.exited,
            ]);
            expect(exitCode, stderr).toBe(0);
            const requests = JSON.parse(stdout);
            expect(requests).toEqual([{ method: "eth_getLogs", params: [{
                fromBlock: "0x64", toBlock: "0xc8", topics,
            }] }]);
        });
    }
});
