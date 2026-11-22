// Consent screens: a client_id typed into a popup URL proves nothing on its own,
// so the app's name/logo are only served for an origin the app registered.
import { PidAppsService } from "./apps.service";

function serviceWith(allowedOrigins: string[]) {
  const prisma: any = {
    pidApp: {
      findUnique: jest.fn(async () => ({
        id: "app-1",
        clientId: "pidapp_a",
        ownerPid: "owner@pid",
        name: "Game",
        logoUrl: "https://cdn.example/logo.png",
        allowedOrigins,
        isActive: true,
        isVerified: false,
        verificationExpiresAt: null,
        providerSettings: [],
      })),
      update: jest.fn(async ({ data }: any) => data),
    },
  };
  const config: any = { get: (_k: string, d?: string) => d ?? "" };
  const security: any = { log: jest.fn(async () => undefined) };
  return new PidAppsService(prisma, config, security);
}

describe("PidAppsService.findActiveForOrigin (consent-screen identity)", () => {
  it("serves name/logo when the origin is one of the app's registered origins", async () => {
    const app = await serviceWith(["https://app.example"]).findActiveForOrigin("pidapp_a", "https://app.example");
    expect(app).toMatchObject({ name: "Game", logoUrl: "https://cdn.example/logo.png" });
  });

  it("returns null for a foreign origin (no borrowed branding)", async () => {
    await expect(serviceWith(["https://app.example"]).findActiveForOrigin("pidapp_a", "https://evil.example")).resolves.toBeNull();
  });

  it("returns null for a malformed origin instead of throwing", async () => {
    await expect(serviceWith(["https://app.example"]).findActiveForOrigin("pidapp_a", "not a url")).resolves.toBeNull();
  });
});
