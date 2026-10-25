// F3: operator-only breaker endpoints (admin JWT, never app tokens).
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { validate } from "class-validator";
import { AdminGuard } from "../common/admin.guard";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { mockBreaker } from "../../test/factories";
import { CloseBreakerDto } from "./admin.dto";
import { AdminController } from "./admin.controller";

// @aws-sdk/client-s3 is not installed in this runner (pre-existing env gap).
// Stub the wasabi module (only logo helpers live there; nothing this spec
// touches) so the admin import graph loads. CI installs full deps.
jest.mock("../common/wasabi-storage", () => ({
  WasabiStorageService: jest.fn(),
  proxyLogoUrl: jest.fn(),
  tokenLogoKey: jest.fn(),
}));

function setup() {
  const breaker = mockBreaker();
  const controller = new AdminController({} as never, {} as never, {} as never, breaker as never);
  return { controller, breaker };
}

describe("Relayer breaker admin endpoints (F3)", () => {
  it("gates close + snapshot behind JwtAuthGuard + AdminGuard", () => {
    for (const key of ["breakerSnapshot", "closeBreaker"] as const) {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, AdminController.prototype[key]) ?? [];
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(AdminGuard);
    }
  });

  it("closes the breaker with recorded evidence", async () => {
    const { controller, breaker } = setup();
    breaker.closeBreaker.mockResolvedValue({ chain: "solana", open: false, absorbedWindow: "0", cap: "0" });
    await expect(
      controller.closeBreaker({ pid: "pid_01HASH" } as never, {
        chain: "solana",
        evidence: "incident #1 reviewed",
      } as never),
    ).resolves.toEqual({ chain: "solana", open: false, absorbedWindow: "0", cap: "0" });
    expect(breaker.closeBreaker).toHaveBeenCalledWith("pid_01HASH", "solana", "incident #1 reviewed");
  });

  it("reads the breaker snapshot", () => {
    const { controller, breaker } = setup();
    controller.breakerSnapshot("solana");
    expect(breaker.snapshot).toHaveBeenCalledWith("solana");
  });

  it("requires non-trivial evidence (DTO floor)", async () => {
    const dto = new CloseBreakerDto();
    dto.chain = "solana";
    dto.evidence = "short";
    expect((await validate(dto)).length).toBeGreaterThan(0);
    dto.evidence = "incident #1 reviewed, logs attached";
    expect(await validate(dto)).toEqual([]);
  });
});
