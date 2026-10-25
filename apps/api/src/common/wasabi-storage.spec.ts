// Wasabi key/URL builders (pure — no credentials needed).
import { chainLogoKey, logoPublicUrl, normalizeMint, proxyLogoUrl, tokenLogoKey } from "./wasabi-storage";

describe("token logo keys", () => {
  it("uses one file per symbol", () => {
    expect(tokenLogoKey("usdc", "png")).toBe("public/tokens/USDC.png");
    expect(tokenLogoKey("wSOL", "jpg")).toBe("public/tokens/WSOL.jpg");
  });

  it("uses one file per chain", () => {
    expect(chainLogoKey("eip155", "97", "png")).toBe("public/chains/eip155-97.png");
    expect(chainLogoKey("solana", "a/b:c", "webp")).toBe("public/chains/solana-a_b_c.webp");
  });

  it("builds proxy logo URLs (null without an API base)", () => {
    expect(proxyLogoUrl("https://api.example/", "public/tokens/USDC.png")).toBe(
      "https://api.example/v1/tokens/logo?key=public%2Ftokens%2FUSDC.png",
    );
    expect(proxyLogoUrl("", "public/tokens/USDC.png")).toBeNull();
  });

  it("lowercases EVM mints but keeps Solana base58 intact", () => {
    expect(normalizeMint("eip155", "0xABCDEF")).toBe("0xabcdef");
    expect(normalizeMint("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("builds path-style public URLs", () => {
    expect(logoPublicUrl("https://s3.ap-southeast-1.wasabisys.com/", "pid", "public/tokens/solana/x/M.png")).toBe(
      "https://s3.ap-southeast-1.wasabisys.com/pid/public/tokens/solana/x/M.png",
    );
  });

  it("refuses non-registry keys and non-image exts without touching the network", async () => {
    const { WasabiStorageService } = await import("./wasabi-storage");
    const svc = new WasabiStorageService({ get: () => "" } as never);
    await expect(svc.getLogo("private/evil.png")).rejects.toThrow("Unknown logo");
    await expect(svc.getLogo("public/tokens/USDC.svg")).rejects.toThrow("Unknown logo");
    await expect(svc.getLogo("")).rejects.toThrow("Unknown logo");
    await expect(svc.getLogo("public/chains/eip155-97.png")).rejects.toThrow("Wasabi storage is not configured");
  });
});