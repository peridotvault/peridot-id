/**
 * Deployment network. Identity (PID, passkey, profile, session) lives ONLY in
 * the mainnet deployment; the testnet stack stores chain/fiat/XP data keyed by
 * an opaque `pid` string plus a shadow `Identity` row for foreign keys.
 *
 * One env var, default mainnet: `PID_NETWORK=testnet` is set by the test stack
 * only. Everything else derives from it, so there is no per-route config.
 */
export type PidNetwork = "mainnet" | "testnet";

export function pidNetwork(raw: string | undefined = process.env.PID_NETWORK): PidNetwork {
  return (raw ?? "").trim().toLowerCase() === "testnet" ? "testnet" : "mainnet";
}

export function isTestnetNetwork(raw?: string): boolean {
  return pidNetwork(raw) === "testnet";
}

/**
 * HTTP prefixes owned by identity. The testnet deployment holds no identity
 * tables, so these routes are forwarded to the mainnet API instead of being
 * served locally — the testnet DB can never mint a PID, credential, or session.
 */
export const IDENTITY_ROUTE_PREFIXES = [
  "/v1/auth",
  "/v1/identity",
  "/v1/pids",
  "/v1/profile",
  "/v1/credentials",
] as const;

/** True when `pathname` belongs to identity and the deployment is testnet. */
export function identityRouteForbidden(
  pathname: string,
  network: PidNetwork = pidNetwork(),
): boolean {
  if (network === "mainnet") return false;
  return IDENTITY_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Mainnet API origin for a sandbox host, derived from the deployment's own
 * `API_URL` (`https://sandbox-api.peridot.id` → `https://api.peridot.id`) so
 * the test stack needs no extra env var. Returns null on a non-sandbox host
 * (local dev, mainnet): there is nothing to forward to.
 */
export function stripSandboxHost(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (!url.hostname.startsWith("sandbox-")) return null;
  url.hostname = url.hostname.slice("sandbox-".length);
  return url.origin;
}
