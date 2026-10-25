/** Target environment. Auto-detected from `NODE_ENV` (see `detectEnv`). */
export type PeridotEnv = "production" | "sandbox";

/** API + popup hosts per environment. Chains/RPC come from the API registry, never here.
 *  ANT-400 hard cutover: canonical hosts are `*.peridot.id` only.
 *  Legacy hosts are removed. */
const PRESETS: Record<PeridotEnv, { baseUrl: string; popupBaseUrl: string }> = {
  production: {
    baseUrl: "https://api.peridot.id",
    popupBaseUrl: "https://peridot.id",
  },
  sandbox: {
    baseUrl: "https://sandbox-api.peridot.id",
    popupBaseUrl: "https://sandbox.peridot.id",
  },
};

/** Legacy hosts (pre-canonical). Removed in ANT-400 — kept as an empty set for import compat. */
export const LEGACY_HOSTS = new Set<string>([]);

/** No-op since ANT-400 (legacy hosts removed). Kept for import compat. */
export function warnOnLegacyHost(_url: string | undefined): void {
  return;
}

/**
 * Explicit `env` wins; otherwise `NODE_ENV === "production"` → production and
 * everything else (unset, `development`, `staging`, `test`, …) → sandbox.
 */
export function detectEnv(override?: PeridotEnv): PeridotEnv {
  if (override === "production" || override === "sandbox") return override;
  const nodeEnv = typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
  return nodeEnv === "production" ? "production" : "sandbox";
}

/**
 * Canonical API + popup hosts for an environment — the same table `Peridot()`
 * uses internally. For backends that talk to PeridotID server-to-server
 * (no browser SDK): `resolvePeridotUrls("sandbox").baseUrl`.
 */
export function resolvePeridotUrls(env?: PeridotEnv): { baseUrl: string; popupBaseUrl: string } {
  return PRESETS[detectEnv(env)];
}
