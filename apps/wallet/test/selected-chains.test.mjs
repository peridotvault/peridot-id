// Unit tests for the chain-selection store (ANT-625 FR3/FR5, AC1/AC8).
// Run: `node --test test/` from apps/wallet (Node >= 22, type stripping).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SELECTED_CHAINS_KEY,
  applyChainToggle,
  dismissSelectionNotice,
  filterChainAccountsForSelection,
  filterChainRowsForSelection,
  getSelection,
  getSelectionNotice,
  isChainSelected,
  isSolanaSelected,
  parseStoredSelection,
  refreshRegistryChains,
  resetChainsCacheForTests,
  resetSelectionForTests,
  sanitizeSelection,
  selectedNamespaces,
  selectionLabelFor,
  setSelectionAll,
  setSelectionCustom,
  toggleChainSelection,
} from "../src/shared/data/selectedChains.ts";

// In-memory localStorage behind a window stub (set after imports so module
// init sees no DOM, exactly like the bundler-less unit runtime).
const memStore = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
    setItem: (k, v) => void memStore.set(k, String(v)),
    removeItem: (k) => void memStore.delete(k),
    clear: () => memStore.clear(),
  },
};

const SOL = { namespace: "solana", reference: "Dev111" };
const EVM97 = { namespace: "eip155", reference: "97" };
const EVM10143 = { namespace: "eip155", reference: "10143" };

const ROWS = [
  { namespace: "solana", reference: "Dev111", name: "Solana Devnet", isTestnet: true },
  { namespace: "eip155", reference: "97", name: "BNB Testnet", isTestnet: true },
  { namespace: "eip155", reference: "10143", name: "Monad Testnet", isTestnet: true },
];

function stubFetch(rows = ROWS) {
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
}

const ALL = { version: 1, mode: "all", chains: [] };

beforeEach(() => {
  memStore.clear();
  resetSelectionForTests();
  resetChainsCacheForTests();
  stubFetch();
});

describe("parseStoredSelection", () => {
  it("defaults absent/empty to all", () => {
    assert.deepEqual(parseStoredSelection(null), ALL);
    assert.deepEqual(parseStoredSelection(undefined), ALL);
    assert.deepEqual(parseStoredSelection(""), ALL);
  });

  it("defaults corrupt/wrong-version to all (never strands the wallet)", () => {
    assert.deepEqual(parseStoredSelection("not-json{"), ALL);
    assert.deepEqual(parseStoredSelection(JSON.stringify({ version: 2, mode: "custom", chains: [SOL] })), ALL);
    assert.deepEqual(parseStoredSelection(JSON.stringify({ version: 1, mode: "weird", chains: [SOL] })), ALL);
  });

  it("keeps a valid custom set, drops malformed entries, empties to all", () => {
    const custom = { version: 1, mode: "custom", chains: [SOL, { namespace: "", reference: "x" }, null] };
    assert.deepEqual(parseStoredSelection(JSON.stringify(custom)), { version: 1, mode: "custom", chains: [SOL] });
    const empty = { version: 1, mode: "custom", chains: [] };
    assert.deepEqual(parseStoredSelection(JSON.stringify(empty)), ALL);
  });
});

describe("selection predicates", () => {
  it("all-mode selects every row", () => {
    assert.equal(isChainSelected(ALL, "solana", "whatever"), true);
    assert.equal(isSolanaSelected(ALL), true);
    assert.equal(selectedNamespaces(ALL), null);
  });

  it("custom mode matches exact namespace+reference pairs", () => {
    const sel = { version: 1, mode: "custom", chains: [EVM97] };
    assert.equal(isChainSelected(sel, "eip155", "97"), true);
    assert.equal(isChainSelected(sel, "eip155", "10143"), false);
    assert.equal(isChainSelected(sel, "solana", "97"), false);
    assert.equal(isSolanaSelected(sel), false);
    assert.deepEqual(selectedNamespaces(sel), new Set(["eip155"]));
  });

  it("custom single-solana selects solana reads", () => {
    assert.equal(isSolanaSelected({ version: 1, mode: "custom", chains: [SOL] }), true);
  });
});

describe("toggleChainSelection", () => {
  it("all + turning a row OFF becomes custom with every other row", () => {
    const { selection, notice, changed } = toggleChainSelection(ALL, ROWS, "solana", "Dev111");
    assert.equal(notice, null);
    assert.equal(changed, true);
    assert.deepEqual(selection, { version: 1, mode: "custom", chains: [EVM97, EVM10143] });
  });

  it("refuses to deselect the last chain (FR5 guard)", () => {
    const single = { version: 1, mode: "custom", chains: [SOL] };
    const { selection, notice, changed } = toggleChainSelection(single, ROWS, "solana", "Dev111");
    assert.deepEqual(selection, single);
    assert.equal(changed, false);
    assert.match(notice ?? "", /At least one chain must stay selected/);
  });

  it("refuses all->empty when the registry has a single row", () => {
    const { selection, notice, changed } = toggleChainSelection(ALL, [ROWS[0]], "solana", "Dev111");
    assert.deepEqual(selection, ALL);
    assert.equal(changed, false);
    assert.match(notice ?? "", /At least one chain must stay selected/);
  });

  it("custom add/remove round-trips; covering all rows collapses to all", () => {
    const start = { version: 1, mode: "custom", chains: [SOL] };
    const added = toggleChainSelection(start, ROWS, "eip155", "97");
    assert.deepEqual(added.selection, { version: 1, mode: "custom", chains: [SOL, EVM97] });
    const removed = toggleChainSelection(added.selection, ROWS, "solana", "Dev111");
    assert.deepEqual(removed.selection, { version: 1, mode: "custom", chains: [EVM97] });
    const full = toggleChainSelection(
      { version: 1, mode: "custom", chains: [SOL, EVM97] },
      ROWS,
      "eip155",
      "10143",
    );
    assert.deepEqual(full.selection, ALL);
  });

  it("ignores unknown rows (stale list)", () => {
    const { selection, notice, changed } = toggleChainSelection(ALL, ROWS, "eip155", "99999");
    assert.deepEqual(selection, ALL);
    assert.equal(changed, false);
    assert.match(notice ?? "", /Unknown chain/);
  });
});

describe("sanitizeSelection (AC8)", () => {
  it("drops unknown refs; emptied custom falls back to all", () => {
    const sel = { version: 1, mode: "custom", chains: [SOL, { namespace: "eip155", reference: "99999" }] };
    const { selection, dropped } = sanitizeSelection(sel, ROWS);
    assert.equal(dropped, 1);
    assert.deepEqual(selection, { version: 1, mode: "custom", chains: [SOL] });
    const gone = sanitizeSelection(
      { version: 1, mode: "custom", chains: [{ namespace: "eip155", reference: "99999" }] },
      ROWS,
    );
    assert.equal(gone.dropped, 1);
    assert.deepEqual(gone.selection, ALL);
  });

  it("all-mode never drops", () => {
    assert.deepEqual(sanitizeSelection(ALL, []), { selection: ALL, dropped: 0 });
  });
});

describe("selectionLabelFor", () => {
  it("labels all / single (registry name, ref fallback) / multi", () => {
    assert.equal(selectionLabelFor(ALL, ROWS), "All chains");
    assert.equal(selectionLabelFor({ version: 1, mode: "custom", chains: [EVM97] }, ROWS), "BNB Testnet");
    assert.equal(
      selectionLabelFor({ version: 1, mode: "custom", chains: [{ namespace: "eip155", reference: "999" }] }, ROWS),
      "eip155:999",
    );
    assert.equal(
      selectionLabelFor({ version: 1, mode: "custom", chains: [SOL, EVM97] }, ROWS),
      "2 chains",
    );
  });
});

describe("strict row filters (AC1-AC4)", () => {
  const accounts = [
    { chainNamespace: "solana", chainReference: "Dev111", accountType: "smart_account" },
    { chainNamespace: "eip155", chainReference: "97", accountType: "smart_account" },
    { chainNamespace: "eip155", chainReference: "10143", accountType: "linked_address" },
  ];

  it("all-mode returns every row untouched (byte-identical behavior)", () => {
    assert.equal(filterChainAccountsForSelection(accounts, ALL), accounts);
    assert.equal(filterChainRowsForSelection([{ chain: "solana" }], ALL).length, 1);
  });

  it("custom filters chain accounts to the selected set (deposit targets)", () => {
    const sel = { version: 1, mode: "custom", chains: [EVM97] };
    assert.deepEqual(filterChainAccountsForSelection(accounts, sel), [accounts[1]]);
  });

  it("custom filters history rows by chain/network (AC3)", () => {
    const rows = [
      { chain: "solana", network: "solana", id: "a" },
      { chain: "eip155", network: "eip155", id: "b" },
    ];
    const sel = { version: 1, mode: "custom", chains: [EVM97] };
    assert.deepEqual(filterChainRowsForSelection(rows, sel).map((r) => r.id), ["b"]);
  });
});

describe("store writes + registry refresh", () => {
  it("setSelectionCustom persists and setSelectionAll restores", async () => {
    await refreshRegistryChains();
    assert.equal(setSelectionCustom([EVM97]), true);
    assert.deepEqual(getSelection(), { version: 1, mode: "custom", chains: [EVM97] });
    assert.deepEqual(
      JSON.parse(memStore.get(SELECTED_CHAINS_KEY)),
      { version: 1, mode: "custom", chains: [EVM97] },
    );
    assert.equal(setSelectionAll(), true);
    assert.deepEqual(getSelection(), ALL);
    assert.equal(setSelectionAll(), false);
  });

  it("setSelectionCustom refuses an empty set (FR5 guard)", () => {
    assert.equal(setSelectionCustom([]), false);
    assert.deepEqual(getSelection(), ALL);
    assert.match(getSelectionNotice() ?? "", /At least one chain/);
  });

  it("refresh drops unknown stored refs with a notice (AC8 boot path)", async () => {
    stubFetch(ROWS);
    assert.equal(setSelectionCustom([{ namespace: "eip155", reference: "99999" }]), true);
    assert.deepEqual(getSelection(), { version: 1, mode: "custom", chains: [{ namespace: "eip155", reference: "99999" }] });
    await refreshRegistryChains();
    assert.deepEqual(getSelection(), ALL);
    assert.match(getSelectionNotice() ?? "", /no longer available/);
    dismissSelectionNotice();
    assert.equal(getSelectionNotice(), null);
  });

  it("applyChainToggle refuses the last-chain deselect and keeps the set", async () => {
    await refreshRegistryChains();
    setSelectionCustom([SOL]);
    assert.equal(applyChainToggle("solana", "Dev111"), false);
    assert.deepEqual(getSelection(), { version: 1, mode: "custom", chains: [SOL] });
    assert.match(getSelectionNotice() ?? "", /At least one chain/);
  });

  it("applyChainToggle writes through and persists", async () => {
    await refreshRegistryChains();
    assert.equal(applyChainToggle("solana", "Dev111"), true);
    assert.deepEqual(getSelection(), { version: 1, mode: "custom", chains: [EVM97, EVM10143] });
    assert.deepEqual(
      JSON.parse(memStore.get(SELECTED_CHAINS_KEY)).mode,
      "custom",
    );
  });

  it("registry failure rejects (AC9 — caller shows retry, no silent switch)", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(refreshRegistryChains(), /unavailable/);
    assert.deepEqual(getSelection(), ALL);
  });
});
