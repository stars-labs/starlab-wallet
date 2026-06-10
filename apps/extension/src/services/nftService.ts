/**
 * NFT display (#20) — ERC-721 first.
 *
 * Discovery piggybacks on the same Transfer topic as ERC-20 with one crucial
 * difference: **ERC-721's Transfer has all three params indexed**, so its logs
 * carry FOUR topics (sig, from, to, tokenId) where ERC-20 carries three. That
 * topic-count split is how the scan separates NFTs from fungibles without
 * guessing.
 *
 * Pipeline: scan Transfer(to=account, 4 topics) → (contract, tokenId) pairs →
 * confirm CURRENT ownership via ownerOf (received-then-sold drops out) →
 * resolve tokenURI → fetch JSON metadata (ipfs:// rewritten to a gateway).
 * Every per-token failure skips that token, never the gallery.
 *
 * ERC-1155 (TransferSingle/Batch, balance semantics) and Solana/Metaplex are
 * tracked as follow-ups on #20.
 */
import type { PublicClient } from "viem";
import { TRANSFER_TOPIC } from "./tokenService";

export interface NftRef {
  contract: string;
  tokenId: bigint;
}

export interface NftItem extends NftRef {
  name?: string;
  image?: string;
  collection?: string;
}

const ERC721_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/** ipfs://… → a public https gateway; everything else passes through. */
export function normalizeUri(uri: string): string {
  return uri.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`
    : uri;
}

/**
 * Find ERC-721s currently owned by `account`: 4-topic Transfer logs to the
 * account, deduped by (contract, tokenId), then ownerOf-verified.
 */
export async function discoverNfts(
  client: Pick<PublicClient, "getLogs" | "readContract">,
  account: string,
  opts: { fromBlock: bigint; toBlock?: bigint | "latest" },
): Promise<NftRef[]> {
  const padded = `0x${account.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
  const logs = (await client.getLogs({
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock ?? "latest",
    topics: [TRANSFER_TOPIC, null, padded],
  } as any)) as { address: string; topics: string[] }[];

  const seen = new Set<string>();
  const refs: NftRef[] = [];
  for (const log of logs) {
    // ERC-721: indexed tokenId ⇒ 4 topics. ERC-20 logs (3 topics) drop here.
    if (!log.topics || log.topics.length !== 4) continue;
    const tokenId = BigInt(log.topics[3]);
    const key = `${log.address.toLowerCase()}:${tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ contract: log.address.toLowerCase(), tokenId });
  }

  // Keep only what the account STILL owns (received-then-transferred drops).
  const owned: NftRef[] = [];
  for (const ref of refs) {
    try {
      const owner = (await client.readContract({
        address: ref.contract as `0x${string}`,
        abi: ERC721_ABI,
        functionName: "ownerOf",
        args: [ref.tokenId],
      })) as string;
      if (owner.toLowerCase() === account.toLowerCase()) owned.push(ref);
    } catch {
      // burned / non-721 contract that shares the topic shape — skip
    }
  }
  return owned;
}

/**
 * Resolve display metadata for one NFT: collection name + tokenURI JSON
 * (name/image, ipfs-normalized). `fetchFn` injected for tests.
 */
export async function fetchNftMetadata(
  client: Pick<PublicClient, "readContract">,
  ref: NftRef,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<NftItem> {
  const item: NftItem = { ...ref };
  try {
    item.collection = (await client.readContract({
      address: ref.contract as `0x${string}`,
      abi: ERC721_ABI,
      functionName: "name",
    })) as string;
  } catch {
    /* collection name optional */
  }
  try {
    const uri = (await client.readContract({
      address: ref.contract as `0x${string}`,
      abi: ERC721_ABI,
      functionName: "tokenURI",
      args: [ref.tokenId],
    })) as string;
    const res = await fetchFn(normalizeUri(uri));
    if (res.ok) {
      const meta = (await res.json()) as { name?: string; image?: string };
      item.name = meta.name;
      if (meta.image) item.image = normalizeUri(meta.image);
    }
  } catch {
    /* metadata unreachable — render id-only */
  }
  return item;
}
