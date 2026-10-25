// Chain preview validation (no-network paths; live RPC/chainlist verified manually).
import { BadRequestException } from "@nestjs/common";
import { ChainPreviewService } from "./chain-preview.service";

describe("ChainPreviewService", () => {
  it("rejects bad namespaces, empty refs, and non-http RPCs", async () => {
    const service = new ChainPreviewService();
    await expect(service.preview("bitcoin", "1", "https://x")).rejects.toThrow(BadRequestException);
    await expect(service.preview("eip155", "", "https://x")).rejects.toThrow(BadRequestException);
    await expect(service.preview("eip155", "97", "ftp://x")).rejects.toThrow(BadRequestException);
  });

  it("reports unreachable RPCs instead of throwing", async () => {
    const service = new ChainPreviewService();
    const p = await service.preview("eip155", "97", "http://127.0.0.1:9");
    expect(p.rpc.ok).toBe(false);
    expect(typeof p.rpc.error).toBe("string");
  });
});
