// SVM session-grant backend spec: hygiene rules mirrored from `register_session`.
import { RegisterSessionDto } from "./dto/session-key.dto";
import { SessionKeysService } from "./session-keys.service";

const seen: { method: string; args: unknown[] }[] = [];

class MockPublicKey {
  constructor(public readonly value: string) {}
  equals(other: MockPublicKey): boolean {
    return other instanceof MockPublicKey && other.value === this.value;
  }
  toBase58(): string {
    return this.value;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(Buffer.from(this.value.slice(0, 32).padEnd(32, "0")));
  }
}

jest.mock("@peridotvault/pid-solana", () => ({
  PublicKey: MockPublicKey,
  deriveSessionAddress: jest.fn((accountId32: Uint8Array, sessionKey: unknown) => {
    seen.push({ method: "deriveSessionAddress", args: [accountId32.length, sessionKey] });
    return { address: new MockPublicKey("SessionPDA111111111111111111111111111111"), bump: 255 };
  }),
  buildRegisterSessionPayload: jest.fn(async (args: Record<string, unknown>) => {
    seen.push({ method: "buildRegisterSessionPayload", args: [args] });
    return new Uint8Array(32).fill(0xab);
  }),
}));

const NOW = 1_700_000_000;
const SESSION = "SessionKey11111111111111111111111111111111";
const GAME = "GameProgram1111111111111111111111111111111";
const AUTH = "UpgradeAuth1111111111111111111111111111111";

function baseDto(): RegisterSessionDto {
  const d = new RegisterSessionDto();
  d.vault = "VaultPDA1111111111111111111111111111111111";
  d.accountId = "0x" + "22".repeat(32);
  d.sessionPubkey = SESSION;
  d.allowedProgram = GAME;
  d.expiresAt = NOW + 3600;
  d.recordedHasAuthority = true;
  d.recordedAuthority = AUTH;
  d.recordedSlot = "12345";
  d.deadline = NOW + 300;
  d.nonce = "0";
  return d;
}

describe("SessionKeysService", () => {
  const svc = new SessionKeysService();

  it("validates a grant and returns the session address + challenge", async () => {
    const v = await svc.validateGrant(baseDto(), NOW);
    expect(v.sessionAddress).toBe("SessionPDA111111111111111111111111111111");
    expect(v.registerPayload).toBe("0x" + "ab".repeat(32));
    const built = seen.find((s) => s.method === "buildRegisterSessionPayload");
    const args = (built?.args[0] ?? {}) as Record<string, unknown>;
    expect(args["expiresAt"]).toBe(NOW + 3600);
    expect(args["recordedSlot"]).toBe(12345n);
  });

  it("rejects past expiry and >24h lifetimes", async () => {
    const d = baseDto();
    d.expiresAt = NOW - 1;
    await expect(svc.validateGrant(d, NOW)).rejects.toThrow(/future/);
    const d2 = baseDto();
    d2.expiresAt = NOW + 86_401;
    await expect(svc.validateGrant(d2, NOW)).rejects.toThrow(/24 hours/);
  });

  it("rejects 600s+ deadlines and missing upgrade authority", async () => {
    const d = baseDto();
    d.deadline = NOW + 601;
    await expect(svc.validateGrant(d, NOW)).rejects.toThrow(/600s/);
    const d2 = baseDto();
    d2.recordedAuthority = undefined;
    await expect(svc.validateGrant(d2, NOW)).rejects.toThrow(/recordedAuthority/);
  });

  it("rejects identical session key and game program", async () => {
    const d = baseDto();
    d.allowedProgram = SESSION;
    await expect(svc.validateGrant(d, NOW)).rejects.toThrow(/must differ/);
  });

  it("exposes the on-chain session bounds", () => {
    expect(svc.constants()).toEqual({ maxTtlSecs: 86_400, inactivitySecs: 1_800, stateLen: 205 });
  });
});
