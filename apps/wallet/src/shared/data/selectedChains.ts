// Chain-selection store (ANT-616/ANT-624/ANT-625 spec). The user picks which
// registry chains the wallet serves; data hooks filter client-side to the
// selected set (OQ2: server fan-out is phase 2 — v1 sends no new header/query,
// so mode:all requests stay byte-identical to today).
//
// Storage contract (§5): key `pid_selected_chains` (pid_network_mode is
// untouched), shape {version:1, mode:"all"|"custom", chains:[{namespace,
// reference}]}. Default/absent/corrupt = all. Multi-toggle store with strict
// enforcement: "only the chain they use" = a single-element custom set.
// Unknown references at load are dropped (empty custom set falls back to All
// + a one-line notice). Deselecting the last chain is refused with an
// explanation (FR5).
//
// Selection applies before the first fetch: hooks read getSelection()
// synchronously in load(). A change persists and emits — the hook opens the
// network transition window around mutating calls (signing stays blocked,
// same failsafe as a network switch), and data hooks reload then close the
// window via endNetworkTransition().

import type { Chain } from "@peridotvault/pid-types";

// NOTE: this module is intentionally import-free (type-only imports erase
// at runtime) so `node --test` can exercise it without a bundler — the
// repo convention for wallet unit tests. The hook (`useSelectedChains`)
// supplies the configured API origin and opens the network transition
// window around mutating calls (see below).

export const SELECTED_CHAINS_KEY = "pid_selected_chains";

export interface ChainRef {
  namespace: string;
  reference: string;
}

export type SelectionMode = "all" | "custom";

export interface SelectedChains {
  version: 1;
  mode: SelectionMode;
  chains: ChainRef[];
}

const ALL: SelectedChains = { version: 1, mode: "all", chains: [] };

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

export function subscribeSelectedChains(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Parse raw storage text. Absent/corrupt/wrong-version → All (fail open to
 *  today's behavior; never strand the wallet on an unreadable preference). */
export function parseStoredSelection(raw: string | null | undefined): SelectedChains {
  if (!raw) return { ...ALL };
  try {
    const v = JSON.parse(raw) as Partial<SelectedChains>;
    if (typeof v !== "object" || v === null || v.version !== 1) return { ...ALL };
    if (v.mode === "all") return { ...ALL };
    if (v.mode !== "custom" || !Array.isArray(v.chains)) return { ...ALL };
    const chains = v.chains.filter(
      (c): c is ChainRef =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as ChainRef).namespace === "string" &&
        typeof (c as ChainRef).reference === "string" &&
        (c as ChainRef).namespace.length > 0 &&
        (c as ChainRef).reference.length > 0,
    );
    if (chains.length === 0) return { ...ALL };
    return { version: 1, mode: "custom", chains };
  } catch {
    return { ...ALL };
  }
}

function storage(): Storage | null {
  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    /* private mode — in-memory session only */
  }
  return null;
}

function readStored(): SelectedChains {
  try {
    return parseStoredSelection(storage()?.getItem(SELECTED_CHAINS_KEY) ?? null);
  } catch {
    return { ...ALL };
  }
}

let mem: SelectedChains = readStored();

/** Synchronous read — call at the top of every data load so the selection
 *  applies before the first fetch (FR3). */
export function getSelection(): SelectedChains {
  return mem;
}

/** True when the row belongs to the selected set (all mode selects all). */
export function isChainSelected(sel: SelectedChains, namespace: string, reference: string): boolean {
  if (sel.mode === "all") return true;
  return sel.chains.some((c) => c.namespace === namespace && c.reference === reference);
}

/** Solana RPC reads run only when Solana is selected (custom without a
 *  solana entry skips getBalance/tokens/nfts/history/activation entirely —
 *  strict, no unselected request fires). */
export function isSolanaSelected(sel: SelectedChains = mem): boolean {
  if (sel.mode === "all") return true;
  return sel.chains.some((c) => c.namespace === "solana");
}

/** Selected namespaces, or null for all-mode (no filtering). */
export function selectedNamespaces(sel: SelectedChains = mem): Set<string> | null {
  if (sel.mode === "all") return null;
  return new Set(sel.chains.map((c) => c.namespace));
}

/** Keep chain/activity rows to the selected set. Rows carry `chain` (and
 *  legacy `network`); all-mode returns the input untouched. */
export function filterChainRowsForSelection<T extends { chain?: unknown; network?: unknown }>(
  rows: T[],
  sel: SelectedChains = mem,
): T[] {
  const ns = selectedNamespaces(sel);
  if (ns === null) return rows;
  return (rows ?? []).filter((r) => {
    const c = typeof r.chain === "string" ? r.chain : null;
    const n = typeof r.network === "string" ? r.network : null;
    return (c !== null && ns.has(c)) || (n !== null && ns.has(n));
  });
}

/** Keep chain accounts to the selected set (EVM deposit-target filtering in
 *  v1 runs through this — no EVM RPC fan-out). All-mode returns input. */
export function filterChainAccountsForSelection<T extends { chainNamespace: string; chainReference: string }>(
  rows: T[],
  sel: SelectedChains = mem,
): T[] {
  if (sel.mode === "all") return rows ?? [];
  return (rows ?? []).filter((r) => isChainSelected(sel, r.chainNamespace, r.chainReference));
}

// --- registry rows (GET /v1/chains) -----------------------------------------

const CHAINS_TTL_MS = 30_000;

let cachedChains: Chain[] | null = null;
let chainsAt = 0;
let chainsInFlight: Promise<Chain[]> | null = null;
/** Bumped on every successful registry refresh — reactive views subscribe. */
let chainsVersion = 0;

export function getChainsVersion(): number {
  return chainsVersion;
}

function apiBaseUrl(configured?: string): string {
  try {
    if (configured) return configured.replace(/\/$/, "");
  } catch {
    /* ignore — fall through to the window-derived fallback */
  }
  try {
    if (typeof window !== "undefined") return `http://${window.location.hostname}:3300`;
  } catch {
    /* non-DOM runtime — fall through */
  }
  return "http://localhost:3300";
}

/** Last-known registry rows (sync). Null until the first successful fetch. */
export function getCachedChains(): Chain[] | null {
  return cachedChains;
}

/** Test helper: drop the registry cache + in-flight slot. */
export function resetChainsCacheForTests(): void {
  cachedChains = null;
  chainsAt = 0;
  chainsInFlight = null;
  chainsVersion = 0;
}

/**
 * Registry rows with 30s TTL + in-flight dedup (mirrors the
 * solana-availability pattern — no per-render storms; QA asserts p95
 * switch-to-rendered ≤ 5s against the same budget). The hook passes the
 * configured API origin (VITE_API_URL-aware); unconfigured callers fall
 * back to the window host. On success the stored selection is sanitized
 * against the fresh rows (AC8): unknown refs are dropped, an emptied custom
 * set falls back to All with a notice, and subscribers re-render. Failures
 * reject — callers show last-known data with a retry (AC9 fail-closed, no
 * silent All-switch).
 */
export function refreshRegistryChains(configuredBaseUrl?: string): Promise<Chain[]> {
  const now = Date.now();
  if (cachedChains !== null && now - chainsAt < CHAINS_TTL_MS) {
    if (sanitizeAgainstRegistry(cachedChains)) emit();
    return Promise.resolve(cachedChains);
  }
  if (chainsInFlight) return chainsInFlight;
  const run = (async (): Promise<Chain[]> => {
    const res = await fetch(`${apiBaseUrl(configuredBaseUrl)}/v1/chains`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Chain registry unavailable (${res.status})`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("Chain registry returned an unexpected shape");
    cachedChains = body as Chain[];
    chainsAt = Date.now();
    chainsVersion += 1;
    sanitizeAgainstRegistry(cachedChains);
    emit();
    return cachedChains;
  })();
  chainsInFlight = run;
  const clear = () => {
    if (chainsInFlight === run) chainsInFlight = null;
  };
  run.then(clear, clear);
  return run;
}

/** Drop stored refs absent from the registry. Returns the dropped count. */
export function sanitizeSelection(sel: SelectedChains, registry: Chain[]): { selection: SelectedChains; dropped: number } {
  if (sel.mode === "all") return { selection: sel, dropped: 0 };
  const known = new Set(registry.map((c) => `${c.namespace}\u0000${c.reference}`));
  const kept = sel.chains.filter((c) => known.has(`${c.namespace}\u0000${c.reference}`));
  const dropped = sel.chains.length - kept.length;
  if (kept.length === 0) return { selection: { ...ALL }, dropped };
  if (dropped === 0) return { selection: sel, dropped: 0 };
  return { selection: { version: 1, mode: "custom", chains: kept }, dropped };
}

function sanitizeAgainstRegistry(registry: Chain[]): boolean {
  const { selection, dropped } = sanitizeSelection(mem, registry);
  if (dropped === 0) return false;
  mem = selection;
  persist();
  setNotice(
    selection.mode === "all"
      ? "Saved chain selection is no longer available — showing all chains."
      : `Removed ${dropped} unavailable chain${dropped === 1 ? "" : "s"} from your selection.`,
  );
  return true;
}

// Cross-tab: another tab's write wins on next read here (last-write-wins);
// re-read and re-render so both tabs agree without a reload.
if (typeof window !== "undefined") {
  try {
    window.addEventListener("storage", (e) => {
      if (e.key !== SELECTED_CHAINS_KEY) return;
      mem = readStored();
      emit();
    });
  } catch {
    /* non-DOM runtime — same-tab behavior is unaffected */
  }
}

// --- notices -----------------------------------------------------------------

let notice: string | null = null;

export function getSelectionNotice(): string | null {
  return notice;
}

function setNotice(next: string | null): void {
  if (notice === next) return;
  notice = next;
  emit();
}

/** Dismiss the current selection notice (user-acknowledged). */
export function dismissSelectionNotice(): void {
  setNotice(null);
}

/** Test helper: clear the notice + reset storage-backed memory to All. */
export function resetSelectionForTests(): void {
  mem = { ...ALL };
  notice = null;
}

// --- writes ------------------------------------------------------------------

function persist(): void {
  try {
    storage()?.setItem(SELECTED_CHAINS_KEY, JSON.stringify(mem));
  } catch {
    /* private mode — in-memory session only */
  }
}

function commit(next: SelectedChains): void {
  mem = next;
  persist();
  // The hook opens the network transition window around mutating calls
  // (same signing-block + failsafe as a network switch); data hooks reload
  // on the notification and close the window via endNetworkTransition().
  emit();
}

/** Master row: show everything (today's behavior, byte-identical requests).
 *  Returns false when already all (no write, no notification). */
export function setSelectionAll(): boolean {
  if (mem.mode === "all" && mem.chains.length === 0) return false;
  setNotice(null);
  commit({ ...ALL });
  return true;
}

/** Replace the custom set wholesale (master-row OFF keeps every row on until
 *  the user deselects). Empty input is refused (FR5 deselect-last guard);
 *  returns false when nothing was written. */
export function setSelectionCustom(chains: ChainRef[]): boolean {
  const clean = chains.filter((c) => c.namespace.length > 0 && c.reference.length > 0);
  if (clean.length === 0) {
    setNotice("At least one chain must stay selected.");
    return false;
  }
  setNotice(null);
  commit({ version: 1, mode: "custom", chains: clean });
  return true;
}

export interface ToggleResult {
  selection: SelectedChains;
  /** Set when the toggle was refused (deselect-last guard) or ignored. */
  notice: string | null;
  /** False when nothing was written (guard refusal / unknown row). */
  changed: boolean;
}

/**
 * Flip one registry row. Pure core (testable without storage/DOM).
 * - all-mode + turning a row OFF → custom set of every other registry row.
 * - custom: add/remove membership; covering every registry row collapses to
 *   all; removing the last row is refused (FR5) with an explanatory notice.
 * - unknown rows are ignored (can only happen against a stale list).
 */
export function toggleChainSelection(
  sel: SelectedChains,
  registry: Chain[],
  namespace: string,
  reference: string,
): ToggleResult {
  const known = registry.filter((c) => typeof c.namespace === "string" && typeof c.reference === "string");
  if (!known.some((c) => c.namespace === namespace && c.reference === reference)) {
    return { selection: sel, notice: "Unknown chain — the chain list was refreshed.", changed: false };
  }
  const key = (ns: string, ref: string) => `${ns}\u0000${ref}`;
  if (sel.mode === "all") {
    const rest = known.filter((c) => !(c.namespace === namespace && c.reference === reference));
    if (rest.length === 0) {
      return { selection: sel, notice: "At least one chain must stay selected.", changed: false };
    }
    return {
      selection: {
        version: 1,
        mode: "custom",
        chains: rest.map((c) => ({ namespace: c.namespace, reference: c.reference })),
      },
      notice: null,
      changed: true,
    };
  }
  const has = sel.chains.some((c) => c.namespace === namespace && c.reference === reference);
  if (has) {
    const rest = sel.chains.filter((c) => !(c.namespace === namespace && c.reference === reference));
    if (rest.length === 0) {
      return { selection: sel, notice: "At least one chain must stay selected.", changed: false };
    }
    return { selection: { version: 1, mode: "custom", chains: rest }, notice: null, changed: true };
  }
  const next = [...sel.chains, { namespace, reference }];
  const knownKeys = new Set(known.map((c) => key(c.namespace, c.reference)));
  if (next.length >= known.length && next.every((c) => knownKeys.has(key(c.namespace, c.reference)))) {
    return { selection: { ...ALL }, notice: null, changed: true };
  }
  return { selection: { version: 1, mode: "custom", chains: next }, notice: null, changed: true };
}

/** UI entry point: sanitize against last-known rows, apply the toggle, and
 *  surface guard notices. Unknown-row toggles refresh the list first (the
 *  hook passes the configured API origin). Returns true when written. */
export function applyChainToggle(namespace: string, reference: string, configuredBaseUrl?: string): boolean {
  const registry = cachedChains ?? [];
  const { selection: clean } = sanitizeSelection(mem, registry);
  const { selection, notice: guardNotice, changed } = toggleChainSelection(clean, registry, namespace, reference);
  if (!changed) {
    // Refused against a possibly-stale list — refresh once so the next tap
    // decides against live rows; the guard notice stays until dismissed.
    setNotice(guardNotice);
    void refreshRegistryChains(configuredBaseUrl).catch(() => undefined);
    return false;
  }
  setNotice(guardNotice);
  commit(selection);
  return true;
}

// --- labels ------------------------------------------------------------------

/** Human label for the selection: "All chains" | row name | "N chains". */
export function selectionLabelFor(sel: SelectedChains, registry: Chain[] | null): string {
  if (sel.mode === "all") return "All chains";
  if (sel.chains.length === 1) {
    const only = sel.chains[0];
    const row = (registry ?? []).find((c) => c.namespace === only.namespace && c.reference === only.reference);
    if (row?.name) return row.name;
    return `${only.namespace}:${only.reference}`;
  }
  return `${sel.chains.length} chains`;
}

/** Label against last-known registry rows (falls back to refs pre-fetch). */
export function selectionLabel(sel: SelectedChains = mem): string {
  return selectionLabelFor(sel, cachedChains);
}
