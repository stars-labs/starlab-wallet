/**
 * phishingService tests — the false-positive boundary matters as much as the
 * detections: real brand domains and unrelated sites must stay 'ok', or users
 * learn to ignore the warnings.
 */
import { describe, it, expect } from "bun:test";
import { checkOrigin, setBlocklist } from "../../src/services/phishingService";

describe("checkOrigin — clean origins", () => {
  it("real brand domains and their subdomains are ok", () => {
    expect(checkOrigin("https://app.uniswap.org").verdict).toBe("ok");
    expect(checkOrigin("https://opensea.io").verdict).toBe("ok");
    expect(checkOrigin("https://pro.opensea.io/collection/x").verdict).toBe("ok");
  });

  it("unrelated sites are ok", () => {
    expect(checkOrigin("https://example.com").verdict).toBe("ok");
    expect(checkOrigin("https://github.com").verdict).toBe("ok");
  });

  it("localhost is ok (dev)", () => {
    expect(checkOrigin("http://localhost:5173").verdict).toBe("ok");
    expect(checkOrigin("http://127.0.0.1:8545").verdict).toBe("ok");
  });
});

describe("checkOrigin — blocklist", () => {
  it("seeded phishing hosts block, including subdomains", () => {
    expect(checkOrigin("https://uniswap-airdrop.org").verdict).toBe("block");
    expect(checkOrigin("https://www.uniswap-airdrop.org").verdict).toBe("block");
  });

  it("setBlocklist extends (and keeps the seed)", () => {
    setBlocklist(["evil-dapp.xyz"]);
    expect(checkOrigin("https://evil-dapp.xyz").verdict).toBe("block");
    expect(checkOrigin("https://uniswap-airdrop.org").verdict).toBe("block"); // seed kept
  });
});

describe("checkOrigin — lookalikes", () => {
  it("brand with affix warns and names the brand", () => {
    const r = checkOrigin("https://uniswap-claim.net");
    expect(r.verdict).toBe("warn");
    expect(r.imitates).toBe("uniswap.org");
  });

  it("digit-for-letter confusables warn (un1swap)", () => {
    const r = checkOrigin("https://un1swap.org");
    expect(r.verdict).toBe("warn");
    expect(r.imitates).toBe("uniswap.org");
  });

  it("one-edit near-miss warns (uniswaps.org)", () => {
    const r = checkOrigin("https://uniswaps.org");
    expect(r.verdict).toBe("warn");
    expect(r.imitates).toBe("uniswap.org");
  });

  it("punycode warns", () => {
    expect(checkOrigin("https://xn--niswap-2ya.org").verdict).toBe("warn");
  });

  it("unparseable origin warns, never blocks (fail-open)", () => {
    expect(checkOrigin("::::").verdict).toBe("warn");
  });
});
