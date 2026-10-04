/**
 * nftService tests — the 3-vs-4-topic split (ERC-20 logs must NOT appear as
 * NFTs), ownerOf verification (sold/burned drop out), dedupe, and metadata
 * resolution with ipfs:// normalization + per-token failure tolerance.
 */
import { describe, it, expect, jest } from "bun:test";
import {
  discoverNfts,
  discoverErc1155,
  fetchNftMetadata,
  fetchErc1155Metadata,
  normalizeUri,
  substituteErc1155Id,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_BATCH_TOPIC,
} from "../../src/services/nftService";
import { TRANSFER_TOPIC } from "../../src/services/tokenService";

const ACCT = "0x1111111111111111111111111111111111111111";
const PADDED = `0x${ACCT.slice(2).padStart(64, "0")}`;
const NFT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOLD = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("discoverNfts", () => {
  it("keeps 4-topic logs only, dedupes, and ownerOf-verifies", async () => {
    const client = {
      request: async () => [
        // ERC-20 transfer (3 topics) — must be ignored
        { address: "0xerc20", topics: [TRANSFER_TOPIC, id(0), PADDED] },
        // owned NFT, duplicated log
        { address: NFT, topics: [TRANSFER_TOPIC, id(0), PADDED, id(7)] },
        { address: NFT, topics: [TRANSFER_TOPIC, id(0), PADDED, id(7)] },
        // received then sold — ownerOf says someone else now
        { address: SOLD, topics: [TRANSFER_TOPIC, id(0), PADDED, id(9)] },
      ],
      readContract: async (a: any) => {
        if (a.functionName !== "ownerOf") throw new Error("unexpected");
        return a.address === NFT ? ACCT : "0x2222222222222222222222222222222222222222";
      },
    } as any;

    const refs = await discoverNfts(client, ACCT, { fromBlock: 1n });
    expect(refs).toEqual([{ contract: NFT, tokenId: 7n }]);
  });

  it("ownerOf revert (burned) drops the token, not the scan", async () => {
    const client = {
      request: async () => [
        { address: NFT, topics: [TRANSFER_TOPIC, id(0), PADDED, id(1)] },
      ],
      readContract: async () => {
        throw new Error("ERC721: invalid token ID");
      },
    } as any;
    expect(await discoverNfts(client, ACCT, { fromBlock: 1n })).toEqual([]);
  });
});

describe("fetchNftMetadata", () => {
  const ref = { contract: NFT, tokenId: 7n };

  it("resolves collection + tokenURI JSON with ipfs normalization", async () => {
    const client = {
      readContract: async (a: any) => {
        if (a.functionName === "name") return "Cool Cats";
        if (a.functionName === "tokenURI") return "ipfs://QmHash/7.json";
        throw new Error("unexpected");
      },
    } as any;
    const fetched: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      fetched.push(url);
      return {
        ok: true,
        json: async () => ({ name: "Cat #7", image: "ipfs://QmImg/7.png" }),
      };
    }) as any;

    const item = await fetchNftMetadata(client, ref, fetchFn);
    expect(item.collection).toBe("Cool Cats");
    expect(item.name).toBe("Cat #7");
    expect(item.image).toBe("https://ipfs.io/ipfs/QmImg/7.png");
    expect(fetched[0]).toBe("https://ipfs.io/ipfs/QmHash/7.json");
  });

  it("metadata failure degrades to id-only, never throws", async () => {
    const client = {
      readContract: async (a: any) => {
        if (a.functionName === "name") return "Cool Cats";
        throw new Error("no tokenURI");
      },
    } as any;
    const item = await fetchNftMetadata(client, ref, jest.fn() as any);
    expect(item.collection).toBe("Cool Cats");
    expect(item.name).toBeUndefined();
    expect(item.tokenId).toBe(7n);
  });
});

describe("substituteErc1155Id", () => {
  it("substitutes {id} as 64-char lowercase hex without 0x", () => {
    expect(substituteErc1155Id("https://x.io/{id}.json", 0xabcn)).toBe(
      `https://x.io/${"abc".padStart(64, "0")}.json`,
    );
  });

  it("substitutes every occurrence and passes plain URIs through", () => {
    expect(substituteErc1155Id("https://x.io/{id}/{id}", 1n)).toBe(
      `https://x.io/${"1".padStart(64, "0")}/${"1".padStart(64, "0")}`,
    );
    expect(substituteErc1155Id("https://x.io/7.json", 7n)).toBe("https://x.io/7.json");
  });
});

describe("discoverErc1155", () => {
  const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
  const C = "0xcccccccccccccccccccccccccccccccccccccccc";

  it("decodes TransferSingle + TransferBatch data, dedupes, verifies balance", async () => {
    const balances: Record<string, bigint> = { "5": 2n, "8": 1n, "9": 0n };
    const client = {
      request: async () => [
        // single: id=5 value=2 (and a duplicate)
        { address: C, topics: [TRANSFER_SINGLE_TOPIC, id(0), id(0), PADDED], data: `0x${word(5)}${word(2)}` },
        { address: C, topics: [TRANSFER_SINGLE_TOPIC, id(0), id(0), PADDED], data: `0x${word(5)}${word(2)}` },
        // batch: ids=[8,9] values=[1,1] — 9 was later sent away (balance 0)
        {
          address: C,
          topics: [TRANSFER_BATCH_TOPIC, id(0), id(0), PADDED],
          data: `0x${word(64)}${word(160)}${word(2)}${word(8)}${word(9)}${word(2)}${word(1)}${word(1)}`,
        },
      ],
      readContract: async (a: any) => {
        if (a.functionName !== "balanceOf") throw new Error("unexpected");
        return balances[String(a.args[1])] ?? 0n;
      },
    } as any;

    const held = await discoverErc1155(client, ACCT, { fromBlock: 1n });
    expect(held).toEqual([
      { contract: C, tokenId: 5n, balance: 2n, standard: "erc1155" },
      { contract: C, tokenId: 8n, balance: 1n, standard: "erc1155" },
    ]);
  });

  it("balanceOf revert drops the token, not the scan", async () => {
    const client = {
      request: async () => [
        { address: C, topics: [TRANSFER_SINGLE_TOPIC, id(0), id(0), PADDED], data: `0x${word(1)}${word(1)}` },
      ],
      readContract: async () => {
        throw new Error("not 1155");
      },
    } as any;
    expect(await discoverErc1155(client, ACCT, { fromBlock: 1n })).toEqual([]);
  });
});

describe("fetchErc1155Metadata", () => {
  const item = { contract: "0xcc", tokenId: 0xabn, balance: 2n };

  it("resolves uri(id) with {id} substitution + ipfs normalization", async () => {
    const client = {
      readContract: async (a: any) => {
        if (a.functionName === "uri") return "ipfs://QmHash/{id}.json";
        throw new Error("unexpected");
      },
    } as any;
    const fetched: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, json: async () => ({ name: "Sword", image: "ipfs://QmImg/s.png" }) };
    }) as any;

    const out = await fetchErc1155Metadata(client, item as any, fetchFn);
    expect(fetched[0]).toBe(`https://ipfs.io/ipfs/QmHash/${"ab".padStart(64, "0")}.json`);
    expect(out.name).toBe("Sword");
    expect(out.image).toBe("https://ipfs.io/ipfs/QmImg/s.png");
    expect(out.standard).toBe("erc1155");
    expect(out.balance).toBe(2n);
  });

  it("uri failure degrades to id-only, never throws", async () => {
    const client = {
      readContract: async () => {
        throw new Error("no uri");
      },
    } as any;
    const out = await fetchErc1155Metadata(client, item as any, jest.fn() as any);
    expect(out.name).toBeUndefined();
    expect(out.tokenId).toBe(0xabn);
  });
});

describe("normalizeUri", () => {
  it("rewrites ipfs:// and passes https through", () => {
    expect(normalizeUri("ipfs://abc/1.png")).toBe("https://ipfs.io/ipfs/abc/1.png");
    expect(normalizeUri("https://x.io/1.png")).toBe("https://x.io/1.png");
  });
});
