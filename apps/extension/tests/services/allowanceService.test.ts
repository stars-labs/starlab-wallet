/**
 * allowanceService tests — record/list/remove round-trip, the live-refresh
 * behaviour (on-chain truth wins: zeroed allowances are pruned, unreadable
 * tokens surface as unknown instead of lying "0"), and the revoke tx shape.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  AllowanceService,
  buildRevokeTx,
} from "../../src/services/allowanceService";
import { ERC20_ABI } from "../../src/services/tokenService";

const OWNER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SPENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function fresh(): AllowanceService {
  const svc = AllowanceService.getInstance();
  (svc as any).records = {};
  (svc as any).loaded = false;
  return svc;
}

const REC = {
  chainId: 1,
  token: TOKEN,
  spender: SPENDER,
  owner: OWNER,
  lastApproved: "1000000",
};

describe("AllowanceService record/list/remove", () => {
  beforeEach(() => {
    fresh();
  });

  it("records, lists per owner+chain, and upserts by (chain,token,spender,owner)", async () => {
    const svc = AllowanceService.getInstance();
    await svc.record(REC);
    await svc.record({ ...REC, lastApproved: "2000000" }); // upsert, not dupe
    const list = await svc.list(OWNER, 1);
    expect(list.length).toBe(1);
    expect(list[0].lastApproved).toBe("2000000");
    expect(await svc.list(OWNER, 137)).toEqual([]);
    expect(await svc.list("0xother")).toEqual([]);
  });

  it("remove drops the record", async () => {
    const svc = AllowanceService.getInstance();
    await svc.record(REC);
    await svc.remove(REC);
    expect(await svc.list(OWNER, 1)).toEqual([]);
  });
});

describe("AllowanceService.listLive", () => {
  it("joins current on-chain allowance; prunes zeroed entries; unknown on read failure", async () => {
    const svc = fresh();
    const TOKEN2 = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    const TOKEN3 = "0x2222222222222222222222222222222222222222";
    await svc.record(REC); // reads 500000
    await svc.record({ ...REC, token: TOKEN2 }); // reads 0 → pruned
    await svc.record({ ...REC, token: TOKEN3 }); // read throws → unknown(-1)

    const client = {
      readContract: async (a: any) => {
        if (a.address === TOKEN) return 500_000n;
        if (a.address === TOKEN2) return 0n;
        throw new Error("revert");
      },
    } as any;

    const live = await svc.listLive(OWNER, 1, client);
    expect(live.length).toBe(2);
    expect(live.find((r) => r.token === TOKEN)!.current).toBe(500_000n);
    expect(live.find((r) => r.token === TOKEN3)!.current).toBe(-1n);
    // zeroed entry pruned from storage too
    expect((await svc.list(OWNER, 1)).some((r) => r.token === TOKEN2)).toBe(false);
  });
});

describe("buildRevokeTx", () => {
  it("targets the token with approve(spender, 0)", () => {
    const tx = buildRevokeTx(OWNER, TOKEN, SPENDER);
    expect(tx.to).toBe(TOKEN);
    expect(tx.from).toBe(OWNER);
    expect(tx.value).toBe("0x0");
    const dec = decodeFunctionData({ abi: ERC20_ABI, data: tx.data as `0x${string}` });
    expect(dec.functionName).toBe("approve");
    expect((dec.args[0] as string).toLowerCase()).toBe(SPENDER.toLowerCase());
    expect(dec.args[1]).toBe(0n);
  });
});
