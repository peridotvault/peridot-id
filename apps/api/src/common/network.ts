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

/**
 * Routes inside an identity prefix that the testnet stack must serve ITSELF:
 * they only need the app registry (`pid_apps`), which every stack owns
 * separately by design (docs/NETWORK_MODES.md). Forwarding them to mainnet made
 * a testnet app unusable — `app-info` 404 and machine-token 401 "Invalid
 * client" with no hint that the app simply lives on the other network.
 */
export const LOCAL_APP_ROUTES = ["/v1/auth/app-info", "/v1/auth/token"] as const;

/** True when `pathname` belongs to identity and the deployment is testnet. */
export function identityRouteForbidden(
  pathname: string,
  network: PidNetwork = pidNetwork(),
): boolean {
  if (network === "mainnet") return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if ((LOCAL_APP_ROUTES as readonly string[]).includes(path)) return false;
  return IDENTITY_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Chain/money scoping. Identity is shared, chain rows are not: a deployed
 * stack must never serve the other network's registry or chain accounts.
 * Local dev is exempt — it runs one stack holding both sets, and the wallet
 * filters by mode client-side (one API for both modes on localhost).
 */
export function chainRowInNetwork(
  isTestnetRow: boolean,
  network: PidNetwork = pidNetwork(),
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (nodeEnv !== "production") return true;
  return isTestnetRow === (network === "testnet");
}

/** Non-mainnet API hostname prefixes: canonical `testnet-`, legacy `sandbox-`. */
const TESTNET_HOST_PREFIXES = ["testnet-", "sandbox-"] as const;

/**
 * Mainnet API origin for a testnet host, derived from the deployment's own
 * `API_URL` (`https://testnet-api.peridot.id` → `https://api.peridot.id`) so
 * the test stack needs no extra env var. `sandbox-` is still accepted: SDK
 * builds that predate the rename bake it. Returns null on a mainnet host
 * (local dev, production): there is nothing to forward to.
 */
export function stripTestnetHost(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  const prefix = TESTNET_HOST_PREFIXES.find((p) => url.hostname.startsWith(p));
  if (!prefix) return null;
  url.hostname = url.hostname.slice(prefix.length);
  return url.origin;
}

/**
 * Boot guard: `PID_NETWORK` decides whether this deployment holds identity, so
 * it must match the deployment's own API host in production. A flipped flag
 * would either serve identity routes from a DB that has none (testnet DB,
 * flag mainnet) or refuse every login while looking healthy (mainnet host,
 * flag testnet — no sandbox host to derive a peer from). Local dev is exempt:
 * one API serves both modes on localhost.
 */
export function networkConsistencyError(
  network: PidNetwork,
  apiUrl: string | undefined,
  nodeEnv: string | undefined,
): string | null {
  if (nodeEnv !== "production") return null;
  const testnetHost = stripTestnetHost((apiUrl ?? "").trim()) !== null;
  if (network === "testnet" && !testnetHost) {
    return "PID_NETWORK=testnet requires an API_URL on a testnet-* host (the mainnet origin is derived from it)";
  }
  if (network === "mainnet" && testnetHost) {
    return "PID_NETWORK=mainnet on a testnet-* API_URL — this stack would hold identity it must not own";
  }
  return null;
}
