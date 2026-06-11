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
 * ERC-1155 rides the same log-scan idea with its own topics: TransferSingle /
 * TransferBatch carry the recipient in topic[3] and the ids in DATA (not
 * topics), so decoding is manual but trivial 32-byte words. Current holdings
 * are confirmed via balanceOf(account, id) > 0 — the 1155 analogue of
 * ownerOf. Metadata comes from uri(id) with the EIP-1155 `{id}` substitution
 * (64-char lowercase hex, NO 0x prefix).
 *
 * Solana/Metaplex lives in solanaNftService.ts (different RPC universe).
 */
import type { PublicClient } from "viem";
import { TRANSFER_TOPIC } from "./tokenService";

export type NftStandard = "erc721" | "erc1155" | "metaplex";

export interface NftRef {
  contract: string;
  tokenId: bigint;
}

export interface NftItem extends NftRef {
  name?: string;
  image?: string;
  collection?: string;
  standard?: NftStandard;
  /** ERC-1155 only: how many copies the account holds. */
  balance?: bigint;
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
  const item: NftItem = { ...ref, standard: "erc721" };
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

// ───────────────────────────── ERC-1155 ─────────────────────────────

/** keccak256("TransferSingle(address,address,address,uint256,uint256)") */
export const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
/** keccak256("TransferBatch(address,address,address,uint256[],uint256[])") */
export const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const ERC1155_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "uri",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/**
 * EIP-1155 metadata URI `{id}` substitution: tokenId as 64 hex chars,
 * lowercase, zero-padded, WITHOUT 0x — exactly as the spec demands.
 * URIs without `{id}` pass through untouched.
 */
export function substituteErc1155Id(uri: string, tokenId: bigint): string {
  return uri.replace(/\{id\}/g, tokenId.toString(16).toLowerCase().padStart(64, "0"));
}

/** Split log DATA into 32-byte words as bigints. */
function dataWords(data: string): bigint[] {
  const hex = (data ?? "0x").replace(/^0x/, "");
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    words.push(BigInt(`0x${hex.slice(i, i + 64)}`));
  }
  return words;
}

/**
 * Find ERC-1155s currently held by `account`: TransferSingle/TransferBatch
 * logs with to=account (topic[3]), token ids decoded from DATA, deduped,
 * then balanceOf-verified (received-then-sent drops out).
 */
export async function discoverErc1155(
  client: Pick<PublicClient, "getLogs" | "readContract">,
  account: string,
  opts: { fromBlock: bigint; toBlock?: bigint | "latest" },
): Promise<NftItem[]> {
  const padded = `0x${account.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
  const logs = (await client.getLogs({
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock ?? "latest",
    // topic0 ∈ {TransferSingle, TransferBatch}, topic3 = recipient.
    topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, null, padded],
  } as any)) as { address: string; topics: string[]; data?: string }[];

  const seen = new Set<string>();
  const refs: NftRef[] = [];
  const note = (contract: string, tokenId: bigint) => {
    const key = `${contract.toLowerCase()}:${tokenId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ contract: contract.toLowerCase(), tokenId });
  };

  for (const log of logs) {
    const words = dataWords(log.data ?? "0x");
    if (log.topics?.[0] === TRANSFER_SINGLE_TOPIC) {
      // DATA = [id, value]
      if (words.length >= 1) note(log.address, words[0]);
    } else if (log.topics?.[0] === TRANSFER_BATCH_TOPIC) {
      // DATA = ABI(uint256[] ids, uint256[] values): two head offsets, then
      // each array as [length, items…]. Offsets are bytes → /32 for words.
      if (words.length < 2) continue;
      const idsAt = Number(words[0] / 32n);
      if (idsAt >= words.length) continue;
      const len = Number(words[idsAt]);
      for (let i = 0; i < len && idsAt + 1 + i < words.length; i++) {
        note(log.address, words[idsAt + 1 + i]);
      }
    }
  }

  // Keep only ids the account STILL holds (balance semantics, not ownerOf).
  const held: NftItem[] = [];
  for (const ref of refs) {
    try {
      const balance = (await client.readContract({
        address: ref.contract as `0x${string}`,
        abi: ERC1155_ABI,
        functionName: "balanceOf",
        args: [account as `0x${string}`, ref.tokenId],
      })) as bigint;
      if (balance > 0n) held.push({ ...ref, balance, standard: "erc1155" });
    } catch {
      // not actually 1155 / hostile contract — skip the token, not the scan
    }
  }
  return held;
}

/**
 * Resolve ERC-1155 display metadata: uri(id) → {id}-substituted URL →
 * JSON name/image (ipfs-normalized). Failures degrade to id-only.
 */
export async function fetchErc1155Metadata(
  client: Pick<PublicClient, "readContract">,
  item: NftItem,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<NftItem> {
  const out: NftItem = { ...item, standard: "erc1155" };
  try {
    const template = (await client.readContract({
      address: item.contract as `0x${string}`,
      abi: ERC1155_ABI,
      functionName: "uri",
      args: [item.tokenId],
    })) as string;
    const res = await fetchFn(normalizeUri(substituteErc1155Id(template, item.tokenId)));
    if (res.ok) {
      const meta = (await res.json()) as { name?: string; image?: string };
      out.name = meta.name;
      if (meta.image) out.image = normalizeUri(meta.image);
    }
  } catch {
    /* metadata unreachable — render id-only */
  }
  return out;
}
