import { ForbiddenException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RegisterSessionDto } from "./dto/session-key.dto";
import { expectedAccountIdHex, SessionKeysController } from "./session-keys.controller";

jest.mock("@peridotvault/pid-solana", () => ({
  PublicKey: class {
    constructor(public readonly value: string) {}
    equals(other: { value: string }): boolean {
      return other instanceof Object && (other as { value: string }).value === this.value;
    }
    toBase58(): string {
      return this.value;
    }
    toBytes(): Uint8Array {
      return new Uint8Array(32);
    }
  },
  buildRegisterSessionPayload: jest.fn(async () => new Uint8Array(32).fill(0xab)),
  deriveSessionAddress: jest.fn(() => ({ address: { toBase58: () => "SessionPDA" } })),
}));

function dtoFor(accountId: string): RegisterSessionDto {
  const d = new RegisterSessionDto();
  d.vault = "VaultPDA1111111111111111111111111111111111";
  d.accountId = accountId;
  d.sessionPubkey = "SessionKey11111111111111111111111111111111";
  d.allowedProgram = "GameProgram1111111111111111111111111111111";
  d.expiresAt = Math.floor(Date.now() / 1000) + 3600;
  d.recordedHasAuthority = false;
  d.recordedSlot = "0";
  d.deadline = Math.floor(Date.now() / 1000) + 300;
  d.nonce = "0";
  return d;
}

describe("SessionKeysController caller-pid binding (ANT-285(d), BOLA)", () => {
  const pid = "Ifal@pid";
  const ownAccountId = `0x${createHash("sha256").update("ifal@pid", "utf8").digest("hex")}`;

  it("derives the expected accountId independent of handle case", () => {
    expect(expectedAccountIdHex(pid)).toBe(ownAccountId);
    expect(expectedAccountIdHex("  IFAL@PID ")).toBe(ownAccountId);
  });

  it("validates a grant for the caller's own accountId", async () => {
    const service = { validateGrant: jest.fn(async () => ({ sessionAddress: "x", registerPayload: "0x" })) };
    const c = new SessionKeysController(service as never);
    await c.validateGrant({ pid } as never, dtoFor(ownAccountId));
    expect(service.validateGrant).toHaveBeenCalled();
  });

  it("rejects a grant for another identity's accountId without reaching the service", async () => {
    const service = { validateGrant: jest.fn(async () => ({ sessionAddress: "x", registerPayload: "0x" })) };
    const c = new SessionKeysController(service as never);
    const other = `0x${createHash("sha256").update("victim@pid", "utf8").digest("hex")}`;
    expect(() => c.validateGrant({ pid } as never, dtoFor(other))).toThrow(ForbiddenException);
    expect(service.validateGrant).not.toHaveBeenCalled();
  });
});
