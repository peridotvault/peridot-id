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
