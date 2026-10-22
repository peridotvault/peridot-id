import { UnauthorizedException } from "@nestjs/common";
import { PidAppsService } from "../auth/apps.service";
import { AppCredentialGuard } from "./app-credential.guard";

/**
 * ANT-89 M3 (ANT-441) — AppCredentialGuard matrix (Tobias C2 + F5 + F9).
 *
 * Fail-closed uniform 401 "Invalid client" for every failure mode (no
 * oracle about which half was wrong, no secret material in the message);
 * missing secret fails closed (differs from clientSecretValid's
 * public-client pass — intake REQUIRES a confidential client); cookies
 * alone authenticate nothing (C2: never cookie sessions on intake).
 */
const SECRET = "pidsk_test_secret_value_0123456789abcdef";

function setup(appRow: Record<string, unknown> | null) {
  const prisma = {
    pidApp: { findUnique: jest.fn(async () => appRow) },
  } as never;
  const apps = new PidAppsService(prisma, undefined);
  const guard = new AppCredentialGuard(prisma, apps);
  return { guard, prisma };
}

function liveApp(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    clientId: "pidapp_test123",
    ownerPid: "owner@pid",
    isActive: true,
    isVerified: true,
    xpEnabled: true,
    approvedEventTypes: ["onboarding_completed"],
    clientSecretHash: PidAppsService.hashSecret(SECRET),
    clientSecretExpiresAt: new Date(Date.now() + 3600_000),
    prevClientSecretHash: null,
    prevClientSecretExpiresAt: null,
    ...overrides,
  };
}

const ctxFor = (body: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ body, headers: {}, cookies: { pid_access: "valid-looking-cookie" } }) }),
  }) as never;

describe("AppCredentialGuard (C2 server-to-server credentials)", () => {
  it("authenticates a valid client_id + client_secret pair", async () => {
    const { guard } = setup(liveApp());
    const req = { body: { client_id: "pidapp_test123", client_secret: SECRET }, headers: {}, xpApp: undefined as never };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.xpApp).toMatchObject({ id: "app-1", clientId: "pidapp_test123", ownerPid: "owner@pid", xpEnabled: true });
  });

  it.each([
    ["missing body", {}],
    ["missing secret", { client_id: "pidapp_test123" }],
    ["missing id", { client_secret: SECRET }],
    ["empty strings", { client_id: "", client_secret: "" }],
  ] as Array<[string, Record<string, unknown> | undefined]>)("rejects %s with uniform 401", async (_name, body) => {
    const { guard } = setup(liveApp());
    await expect(guard.canActivate(ctxFor(body))).rejects.toThrow(UnauthorizedException);
  });

  it("rejects unknown apps with the SAME uniform error (no oracle)", async () => {
    const { guard } = setup(null);
    const err = await guard.canActivate(ctxFor({ client_id: "pidapp_nope", client_secret: SECRET })).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(String(err.message)).toBe("Invalid client");
  });

  it("rejects inactive apps (C2: isActive=false fails closed)", async () => {
    const { guard } = setup(liveApp({ isActive: false }));
    await expect(guard.canActivate(ctxFor({ client_id: "pidapp_test123", client_secret: SECRET }))).rejects.toThrow(
      "Invalid client",
    );
  });

  it("rejects apps with no secret set (C2: missing secret fails closed)", async () => {
    const { guard } = setup(liveApp({ clientSecretHash: null, clientSecretExpiresAt: null }));
    await expect(guard.canActivate(ctxFor({ client_id: "pidapp_test123", client_secret: "anything" }))).rejects.toThrow(
      "Invalid client",
    );
  });

  it("rejects expired secrets (C2: fail closed on expired)", async () => {
    const { guard } = setup(liveApp({ clientSecretExpiresAt: new Date(Date.now() - 1000) }));
    await expect(guard.canActivate(ctxFor({ client_id: "pidapp_test123", client_secret: SECRET }))).rejects.toThrow(
      "Invalid client",
    );
  });

  it("rejects wrong secrets without leaking which half was wrong (F5)", async () => {
    const { guard } = setup(liveApp());
    const err = await guard
      .canActivate(ctxFor({ client_id: "pidapp_test123", client_secret: "wrong-secret" }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(String(err.message)).toBe("Invalid client");
    expect(String(err.message)).not.toContain("wrong-secret");
    expect(String(err.message)).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it("cookies alone authenticate nothing (C2: never cookie sessions)", async () => {
    const { guard } = setup(liveApp());
    // Valid-looking session cookie, no body credentials → still 401.
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toThrow("Invalid client");
  });

  it("accepts the previous-hash grace window (rotation overlap)", async () => {
    const newSecret = "pidsk_rotated_secret_abcdef0123456789";
    const { guard } = setup(
      liveApp({
        clientSecretHash: PidAppsService.hashSecret(newSecret),
        prevClientSecretHash: PidAppsService.hashSecret(SECRET),
        prevClientSecretExpiresAt: new Date(Date.now() + 3600_000),
      }),
    );
    const req = { body: { client_id: "pidapp_test123", client_secret: SECRET }, headers: {} };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe("secretMatches timing-safety (Tobias F9)", () => {
  it("verifies equal hashes, rejects mismatches and malformed input", () => {
    const hash = PidAppsService.hashSecret(SECRET);
    expect(PidAppsService.secretMatches(SECRET, hash)).toBe(true);
    expect(PidAppsService.secretMatches("wrong", hash)).toBe(false);
    expect(PidAppsService.secretMatches("", hash)).toBe(false);
    expect(PidAppsService.secretMatches(SECRET, "not-hex!")).toBe(false);
    expect(PidAppsService.secretMatches(SECRET, "")).toBe(false);
  });

  it("compares in constant time (equal-length buffers, no short-circuit oracle)", () => {
    // Both sides always hash to 32 bytes, so the length pre-check never
    // leaks: attacker input and stored hash are the same length in practice.
    const a = PidAppsService.hashSecret("a".repeat(48));
    const b = PidAppsService.hashSecret("b".repeat(48));
    expect(Buffer.from(a, "hex").length).toBe(Buffer.from(b, "hex").length);
    expect(PidAppsService.secretMatches("a".repeat(48), b)).toBe(false);
  });
});
