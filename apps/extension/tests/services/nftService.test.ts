/**
 * nftService tests — the 3-vs-4-topic split (ERC-20 logs must NOT appear as
 * NFTs), ownerOf verification (sold/burned drop out), dedupe, and metadata
 * resolution with ipfs:// normalization + per-token failure tolerance.
 */
import { describe, it, expect, jest } from "bun:test";
import {
  discoverNfts,
  fetchNftMetadata,
  normalizeUri,
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
      getLogs: async () => [
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
      getLogs: async () => [
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

describe("normalizeUri", () => {
  it("rewrites ipfs:// and passes https through", () => {
    expect(normalizeUri("ipfs://abc/1.png")).toBe("https://ipfs.io/ipfs/abc/1.png");
    expect(normalizeUri("https://x.io/1.png")).toBe("https://x.io/1.png");
  });
});
