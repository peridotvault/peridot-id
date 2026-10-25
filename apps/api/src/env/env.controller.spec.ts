import { ConfigService } from "@nestjs/config";
import { EnvController } from "./env.controller";

function ctrl(store: Record<string, string> = {}) {
  const base: Record<string, string> = { DOKU_MODE: "sandbox", ...store };
  const config = { get: (k: string, d?: string) => base[k] ?? d ?? "" } as unknown as ConfigService;
  return new EnvController(config);
}

describe("EnvController (GET /v1/env)", () => {
  it("reports sandbox from the server env flag", () => {
    expect(ctrl().env()).toEqual({ env: "sandbox", dokuMode: "sandbox", docs: "https://docs.peridot.id" });
  });

  it("reports production with no sandbox marker", () => {
    expect(ctrl({ DOKU_MODE: "production" }).env()).toEqual({
      env: "production",
      dokuMode: "production",
      docs: "https://docs.peridot.id",
    });
  });

  it("uses DOCS_URL when configured", () => {
    expect(ctrl({ DOCS_URL: "https://docs.example.com" }).env().docs).toBe("https://docs.example.com");
  });

  it("never echoes client input (no request params are read)", () => {
    // The handler takes zero request arguments by construction — even a
    // `?env=production` query or body cannot influence the response.
    expect(ctrl().env.length).toBe(0);
    expect(ctrl({ DOKU_MODE: "sandbox" }).env()).toMatchObject({ env: "sandbox" });
  });
});
