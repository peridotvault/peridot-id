// Token preview validation (no-network paths; live RPC/CoinGecko verified manually).
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TokenPreviewService } from "./token-preview.service";

function setup(chain: unknown = null) {
  const chains = { chainByReference: jest.fn(async () => chain) };
  return { service: new TokenPreviewService(chains as never), chains };
}

describe("TokenPreviewService", () => {
  it("rejects bad namespaces and malformed mints", async () => {
    const { service } = setup();
    await expect(service.preview("bitcoin", "mainnet", "x")).rejects.toThrow(BadRequestException);
    await expect(service.preview("solana", "devnet", "not-a-mint!!")).rejects.toThrow(BadRequestException);
    await expect(service.preview("eip155", "97", "0x123")).rejects.toThrow(BadRequestException);
  });

  it("404s chains missing from the registry", async () => {
    const { service } = setup(null);
    await expect(
      service.preview("solana", "devnet", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ).rejects.toThrow(NotFoundException);
  });

  it("404s reference rows of another namespace", async () => {
    const { service } = setup({ namespace: "eip155", reference: "97", rpcUrls: [] });
    await expect(
      service.preview("solana", "97", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ).rejects.toThrow(NotFoundException);
  });

  it("requires an RPC URL on the chain row", async () => {
    const { service } = setup({ namespace: "solana", reference: "devnet", rpcUrls: [] });
    await expect(
      service.preview("solana", "devnet", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ).rejects.toThrow(BadRequestException);
  });
});
