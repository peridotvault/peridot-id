import {
  chainRowInNetwork,
  identityRouteForbidden,
  networkConsistencyError,
  pidNetwork,
  stripTestnetHost,
} from "./network";

describe("pidNetwork", () => {
  it("defaults to mainnet", () => {
    expect(pidNetwork(undefined)).toBe("mainnet");
    expect(pidNetwork("")).toBe("mainnet");
    expect(pidNetwork("garbage")).toBe("mainnet");
  });

  it("accepts testnet case-insensitively", () => {
    expect(pidNetwork("testnet")).toBe("testnet");
    expect(pidNetwork(" TESTNET ")).toBe("testnet");
  });
});

describe("identityRouteForbidden", () => {
  it("never blocks on mainnet", () => {
    expect(identityRouteForbidden("/v1/auth/login", "mainnet")).toBe(false);
  });

  it("claims identity prefixes and their subpaths on testnet", () => {
    for (const path of [
      "/v1/auth",
      "/v1/auth/google/callback",
      "/v1/identity/me",
      "/v1/pids/ifal%40pid",
      "/v1/profile",
      "/v1/credentials/abc",
    ]) {
      expect(identityRouteForbidden(path, "testnet")).toBe(true);
    }
  });

  it("keeps data routes local on testnet", () => {
    for (const path of [
      "/v1/chains",
      "/v1/fiat/deposits",
      "/v1/experience/levels",
      "/v1/authx",
      "/v1/identities",
      "/v1/apps",
      // App registry is per-network: these two only need `pid_apps`, so the
      // testnet stack serves them from its own DB instead of forwarding to a
      // mainnet registry that never heard of the app.
      "/v1/auth/app-info",
      "/v1/auth/token",
    ]) {
      expect(identityRouteForbidden(path, "testnet")).toBe(false);
    }
  });
});

describe("stripTestnetHost", () => {
  it("maps a testnet API host to its mainnet sibling", () => {
    expect(stripTestnetHost("https://testnet-api.peridot.id")).toBe("https://api.peridot.id");
  });

  it("still accepts the legacy sandbox host (published SDKs bake it)", () => {
    expect(stripTestnetHost("https://sandbox-api.peridot.id")).toBe("https://api.peridot.id");
  });

  it("returns null for mainnet, localhost, and garbage", () => {
    expect(stripTestnetHost("https://api.peridot.id")).toBeNull();
    expect(stripTestnetHost("http://localhost:3300")).toBeNull();
    expect(stripTestnetHost("not a url")).toBeNull();
  });
});

describe("networkConsistencyError", () => {
  it("rejects a testnet flag on a non-sandbox host in production", () => {
    expect(networkConsistencyError("testnet", "https://api.peridot.id", "production")).toMatch(/testnet-\* host/);
    expect(networkConsistencyError("testnet", undefined, "production")).toMatch(/testnet-\* host/);
  });

  it("rejects a mainnet flag on a sandbox host in production", () => {
    expect(networkConsistencyError("mainnet", "https://testnet-api.peridot.id", "production")).toMatch(/must not own/);
  });

  it("accepts the matching pairs and exempts local dev", () => {
    expect(networkConsistencyError("mainnet", "https://api.peridot.id", "production")).toBeNull();
    expect(networkConsistencyError("testnet", "https://testnet-api.peridot.id", "production")).toBeNull();
    expect(networkConsistencyError("testnet", "https://sandbox-api.peridot.id", "production")).toBeNull();
    expect(networkConsistencyError("testnet", "http://localhost:3300", "development")).toBeNull();
    expect(networkConsistencyError("mainnet", "http://localhost:3300", "development")).toBeNull();
  });
});

describe("chainRowInNetwork", () => {
  it("keeps each deployed stack on its own chain rows", () => {
    expect(chainRowInNetwork(false, "mainnet", "production")).toBe(true);
    expect(chainRowInNetwork(true, "mainnet", "production")).toBe(false);
    expect(chainRowInNetwork(true, "testnet", "production")).toBe(true);
    expect(chainRowInNetwork(false, "testnet", "production")).toBe(false);
  });

  it("serves both sets in local dev (one stack, wallet filters by mode)", () => {
    expect(chainRowInNetwork(true, "mainnet", "development")).toBe(true);
    expect(chainRowInNetwork(false, "mainnet", "development")).toBe(true);
  });
});
