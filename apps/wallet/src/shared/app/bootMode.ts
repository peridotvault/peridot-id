// Boot-time network mode. A LEAF module (no imports) on purpose: the cache
// layer and the bundler-less unit tests (`node --test`) read it without
// pulling the SDK/env graph, and there is exactly one place that resolves a
// mode from `?env=`, storage, or the build env.
export type NetworkMode = "mainnet" | "testnet";

export const NETWORK_MODE_KEY = "pid_network_mode";

/** Persist the selection — the boot mode of the NEXT page load. */
export function persistNetworkMode(mode: NetworkMode): NetworkMode {
  try {
    window.localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    /* private mode — the in-memory value still drives this load */
  }
  return mode;
}

/**
 * Boot mode. A `?env=testnet|mainnet` param (popup/embed opened by a dapp)
 * wins and is persisted, so that window talks to the dapp's own network.
 */
export function readBootNetworkMode(): NetworkMode {
  try {
    if (typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("env");
      if (param === "testnet" || param === "mainnet") return persistNetworkMode(param);
      const raw = window.localStorage.getItem(NETWORK_MODE_KEY);
      if (raw === "mainnet" || raw === "testnet") return raw;
    }
  } catch {
    /* private mode — fall through to env/default */
  }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  if (env.VITE_NETWORK_MODE === "testnet") return "testnet";
  return "mainnet";
}
