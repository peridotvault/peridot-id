// Network-mode store (ANT-15 req 3+4 UI). Server-driven testnet: the API
// registry is the source of truth for chain/RPC/program per selection
// (selection-scoped chain paths land server-side in ANT-24); the wallet only
// persists the user's selection and re-fetches selection-scoped data on
// switch. Balances are never merged client-side — every fetch is
// selection-scoped server-side; the client just reloads on change.
//
// Shape alignment (Theo ANT-23 spec still pending acceptance): mode maps to
// the registry Solana rows — "mainnet" ↔ reference
// 4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z, "testnet" ↔ the devnet/testnet Solana
// row. If the accepted spec picks a different shape, reconcile here first.
//
// Safety: default OFF (mainnet). Only VITE_NETWORK_MODE=testnet opts in.

import { API_BASE_URL } from "./config";

export type NetworkMode = "mainnet" | "testnet";

export const NETWORK_MODE_KEY = "pid_network_mode";

/** Failsafe: never leave signing blocked if a reload never settles.
 * 30s — QA (ANT-34 re-run) observed HomeData.load() ~30s on devnet RPC;
 * a 5s cap re-enabled signing while balances were still stale. */
const TRANSITION_FAILSAFE_MS = 30000;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* a dead subscriber must not break the store */
    }
  });
}

function readInitial(): NetworkMode {
  try {
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(NETWORK_MODE_KEY);
      if (raw === "mainnet" || raw === "testnet") return raw;
    }
  } catch {
    /* private mode — fall through to env/default */
  }
  try {
    const env = import.meta.env.VITE_NETWORK_MODE as string | undefined;
    if (env === "testnet") return "testnet";
  } catch {
    /* non-Vite runtime — ignore */
  }
  return "mainnet";
}

let mem: NetworkMode = readInitial();
let switching = false;
let failsafe: ReturnType<typeof setTimeout> | null = null;

export function getNetworkMode(): NetworkMode {
  return mem;
}

/** True when the user selected Testnet Mode. */
export function isTestnetMode(): boolean {
  return mem === "testnet";
}

/** True while a network switch is propagating (signing stays blocked). */
export function isNetworkSwitching(): boolean {
  return switching;
}

export function subscribeNetworkMode(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearFailsafe(): void {
  if (failsafe !== null) {
    clearTimeout(failsafe);
    failsafe = null;
  }
}

/**
 * Persist a mode change and open the transition window. Data hooks reload
 * on the notification and close the window via endNetworkTransition(); the
 * failsafe closes it unconditionally so signing can never stick blocked.
 */
export function setNetworkMode(mode: NetworkMode): void {
  if (mode === mem) {
    if (!switching) return;
    endNetworkTransition();
    return;
  }
  mem = mode;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    /* non-fatal */
  }
  switching = true;
  emit();
  clearFailsafe();
  failsafe = setTimeout(endNetworkTransition, TRANSITION_FAILSAFE_MS);
}

/** Idempotent: closes the transition window (notifies only on change). */
export function endNetworkTransition(): void {
  clearFailsafe();
  if (!switching) return;
  switching = false;
  emit();
}

/** Display label for the current selection. */
export function networkLabel(mode: NetworkMode = mem): string {
  return mode === "testnet" ? "Testnet" : "Mainnet";
}

/**
 * Solana mainnet presence signal (ANT-78, consumes Tyler ANT-75
 * `GET /v1/chains/solana-availability`). Data-driven re-enable of the
 * ANT-74 hide: mainnet mode shows Solana UI only when the registry reports
 * `available === true` (an active non-testnet Solana row carries a program
 * contract). Testnet mode always shows Solana UI (no fetch needed).
 *
 * Fail-closed: any fetch failure, non-200, or malformed body keeps the
 * cached value (default false) and clears the in-flight slot so the next
 * screen load retries. The 30s client TTL mirrors the server
 * `CACHE_TTL_MS` so we never fetch more often than the server recomputes;
 * concurrent callers share one in-flight request (no per-render storms —
 * call refresh from effects, never during render).
 */
export interface SolanaMainnetAvailability {
  available: boolean;
  reference: string | null;
  program: string | null;
  rpcUrl: string | null;
}

const SOLANA_AVAILABILITY_TTL_MS = 30_000;

let solanaMainnetAvailable = false;
let solanaAvailableAt = 0;
let solanaInFlight: Promise<boolean> | null = null;

function apiBaseUrl(): string {
  try {
    if (API_BASE_URL) return API_BASE_URL.replace(/\/$/, "");
  } catch {
    /* bundler-less unit runtime — fall through to window-derived fallback */
  }
  try {
    if (typeof window !== "undefined") return `http://${window.location.hostname}:3300`;
  } catch {
    /* non-DOM runtime — fall through */
  }
  return "http://localhost:3300";
}

/** Raw cached mainnet flag (default false = fail closed). Testnet callers
 * should use isSolanaAvailable() which short-circuits to true. */
export function getSolanaMainnetAvailable(): boolean {
  return solanaMainnetAvailable;
}

/** Test helper: drop the cache + in-flight slot. */
export function resetSolanaAvailabilityForTests(): void {
  solanaMainnetAvailable = false;
  solanaAvailableAt = 0;
  solanaInFlight = null;
}

/**
 * Refresh the cached mainnet flag. Testnet mode short-circuits to true
 * with no network call. Mainnet mode returns the cache when fresh (<30s),
 * otherwise shares one in-flight GET and updates the cache on success.
 */
export function refreshSolanaAvailability(): Promise<boolean> {
  if (isTestnetMode()) return Promise.resolve(true);
  const now = Date.now();
  if (solanaAvailableAt !== 0 && now - solanaAvailableAt < SOLANA_AVAILABILITY_TTL_MS) {
    return Promise.resolve(solanaMainnetAvailable);
  }
  if (solanaInFlight) return solanaInFlight;
  const run = (async (): Promise<boolean> => {
    try {
      const res = await fetch(`${apiBaseUrl()}/v1/chains/solana-availability`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return solanaMainnetAvailable;
      const body = (await res.json()) as Partial<SolanaMainnetAvailability>;
      const next = body.available === true;
      if (next !== solanaMainnetAvailable) {
        solanaMainnetAvailable = next;
        emit();
      }
      solanaAvailableAt = Date.now();
      return solanaMainnetAvailable;
    } catch {
      // Fail closed — keep the cached value so the next screen load retries.
      return solanaMainnetAvailable;
    } finally {
      solanaInFlight = null;
    }
  })();
  solanaInFlight = run;
  return run;
}

/**
 * ANT-73 / ANT-74 hide, now data-driven (ANT-78 AC3): Testnet Mode always
 * shows Solana UI; mainnet mode shows it only when the registry signal
 * reports available === true. EVM rows are unaffected either way.
 */
export function isSolanaAvailable(): boolean {
  if (isTestnetMode()) return true;
  return solanaMainnetAvailable;
}

/**
 * Explorer `?cluster=` suffix for the selection. An explicit tx network wins
 * (registry rows carry isTestnet); otherwise the current selection applies.
 */
export function explorerClusterParam(txNetwork?: string | null): string {
  const n = (txNetwork ?? "").toLowerCase();
  if (n === "devnet" || n === "testnet") return "?cluster=devnet";
  if (!txNetwork && isTestnetMode()) return "?cluster=devnet";
  return "";
}

/** Full Solana explorer URL for a signature under the current selection. */
export function solanaExplorerTxUrl(txHash: string | null, txNetwork?: string | null): string {
  return `https://explorer.solana.com/tx/${txHash ?? ""}${explorerClusterParam(txNetwork)}`;
}
