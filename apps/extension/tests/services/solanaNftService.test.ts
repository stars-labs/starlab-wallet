/**
 * solanaNftService tests — NFT-mint heuristic (amount==1 && decimals==0),
 * metadata PDA derivation (snapshot for the wSOL mint), borsh metadata
 * decoding (null-padded strings), and the full fetch pipeline over a mocked
 * JSON-RPC with ipfs normalization + per-mint failure tolerance.
 */
import { describe, it, expect, jest } from "bun:test";
import {
  discoverSolanaNftMints,
  metadataPda,
  decodeMetaplexMetadata,
  fetchSolanaNft,
  loadSolanaNfts,
  makeSolanaRpc,
  SPL_TOKEN_PROGRAM,
} from "../../src/services/solanaNftService";

const OWNER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const MINT = "So11111111111111111111111111111111111111112"; // wSOL
const MINT2 = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const tokenAccount = (mint: string, amount: string, decimals: number) => ({
  account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
});

describe("discoverSolanaNftMints", () => {
  it("keeps amount==1 && decimals==0 mints only, deduped", async () => {
    const rpc = jest.fn(async (method: string) => {
      expect(method).toBe("getTokenAccountsByOwner");
      return {
        value: [
          tokenAccount(MINT, "1", 0), // NFT
          tokenAccount(MINT, "1", 0), // duplicate account, same mint
          tokenAccount(MINT2, "1000000", 6), // fungible
          tokenAccount("FungibleZeroDecimalsButMany11111111111111111", "5", 0), // SFT stack
          tokenAccount("EmptyAccount1111111111111111111111111111111", "0", 0), // emptied
        ],
      };
    });
    expect(await discoverSolanaNftMints(rpc as any, OWNER)).toEqual([MINT]);
    expect((rpc as any).mock.calls[0][1][1]).toEqual({ programId: SPL_TOKEN_PROGRAM });
  });
});

describe("metadataPda", () => {
  it('derives ["metadata", program, mint] under the Token Metadata program', () => {
    // Snapshot: the canonical metadata PDA for the wSOL mint.
    expect(metadataPda(MINT)).toBe("6dM4TqWyWJsbx7obrdLcviBkTafD5E8av61zfU6jq57X");
  });

  it("different mints derive different PDAs", () => {
    expect(metadataPda(MINT2)).not.toBe(metadataPda(MINT));
  });
});

/** Borsh-style fixture: key + update_authority + mint + 3 padded strings. */
function metadataFixture(name: string, symbol: string, uri: string): Uint8Array {
  const str = (s: string, pad: number) => {
    const out = new Uint8Array(4 + pad);
    new DataView(out.buffer).setUint32(0, pad, true); // on-chain prefix = PADDED length
    out.set(new TextEncoder().encode(s), 4);
    return out;
  };
  const parts = [new Uint8Array(1 + 32 + 32), str(name, 32), str(symbol, 10), str(uri, 200)];
  parts[0][0] = 4; // key = MetadataV1
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return buf;
}

describe("decodeMetaplexMetadata", () => {
  it("reads name/symbol/uri and strips null padding", () => {
    const data = metadataFixture("Mad Lad #1", "MAD", "ipfs://QmMeta/1.json");
    expect(decodeMetaplexMetadata(data)).toEqual({
      name: "Mad Lad #1",
      symbol: "MAD",
      uri: "ipfs://QmMeta/1.json",
    });
  });

  it("throws on truncated accounts instead of reading garbage", () => {
    expect(() => decodeMetaplexMetadata(new Uint8Array(40))).toThrow("truncated");
  });
});

describe("fetchSolanaNft", () => {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it("PDA account → borsh → uri JSON, ipfs-normalized", async () => {
    const rpc = jest.fn(async (method: string, params: any[]) => {
      expect(method).toBe("getAccountInfo");
      expect(params[0]).toBe(metadataPda(MINT));
      return { value: { data: [b64(metadataFixture("Lad", "MAD", "ipfs://QmMeta/1.json")), "base64"] } };
    });
    const fetched: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, json: async () => ({ name: "Mad Lad #1", image: "ipfs://QmImg/1.png" }) };
    }) as any;

    const item = await fetchSolanaNft(rpc as any, MINT, fetchFn);
    expect(fetched[0]).toBe("https://ipfs.io/ipfs/QmMeta/1.json");
    expect(item).toEqual({
      contract: MINT,
      tokenId: 0n,
      standard: "metaplex",
      name: "Mad Lad #1",
      collection: "MAD",
      image: "https://ipfs.io/ipfs/QmImg/1.png",
    });
  });

  it("missing metadata account degrades to a mint-only card", async () => {
    const rpc = jest.fn(async () => ({ value: null }));
    const item = await fetchSolanaNft(rpc as any, MINT, jest.fn() as any);
    expect(item).toEqual({ contract: MINT, tokenId: 0n, standard: "metaplex" });
  });

  it("RPC failure degrades to a mint-only card, never throws", async () => {
    const rpc = jest.fn(async () => {
      throw new Error("rpc down");
    });
    const item = await fetchSolanaNft(rpc as any, MINT, jest.fn() as any);
    expect(item.contract).toBe(MINT);
    expect(item.name).toBeUndefined();
  });
});

describe("loadSolanaNfts", () => {
  it("end-to-end over a mocked rpc: discovery then metadata per mint", async () => {
    const rpc = jest.fn(async (method: string) => {
      if (method === "getTokenAccountsByOwner") return { value: [tokenAccount(MINT, "1", 0)] };
      return { value: null }; // no metadata account
    });
    const items = await loadSolanaNfts(rpc as any, OWNER, jest.fn() as any);
    expect(items).toEqual([{ contract: MINT, tokenId: 0n, standard: "metaplex" }]);
  });
});

describe("makeSolanaRpc", () => {
  it("POSTs JSON-RPC and unwraps result / surfaces errors", async () => {
    const calls: any[] = [];
    const fetchFn = jest.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ result: { ok: 1 } }) };
    }) as any;
    const rpc = makeSolanaRpc("https://rpc.test", fetchFn);
    expect(await rpc("getHealth", [])).toEqual({ ok: 1 });
    expect(calls[0].body).toMatchObject({ jsonrpc: "2.0", method: "getHealth", params: [] });

    const errFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ error: { message: "boom" } }),
    })) as any;
    await expect(makeSolanaRpc("https://rpc.test", errFetch)("getHealth", [])).rejects.toThrow(
      "boom",
    );
  });
});
