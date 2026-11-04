// Deposit cards (Receive): smart-account rows + registry labels. The registry
// row wins so a chain registered in the dashboard after provisioning shows its
// real name/symbol; the built-in table stays as the offline fallback.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDepositTargets } from "../src/feat/chain/utils/depositTargets.ts";

const account = (over) => ({
  id: "ca-1",
  chainNamespace: "eip155",
  chainReference: "11155111",
  address: "0xabc",
  accountType: "smart_account",
  status: "inactivated",
  activationBalance: null,
  activationRequired: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const chain = (over) => ({
  id: "ch-1",
  namespace: "eip155",
  reference: "11155111",
  name: "sepolia",
  nativeSymbol: "ETH",
  decimals: 18,
  rpcUrls: [],
  explorerUrl: null,
  logoUrl: null,
  isTestnet: true,
  isActive: true,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("buildDepositTargets", () => {
  it("labels an EVM row from the registry (chain added after provisioning)", () => {
    const [t] = buildDepositTargets([account({})], [chain({})]);
    assert.equal(t.label, "sepolia");
    assert.equal(t.sublabel, "ETH");
    assert.equal(t.key, "eip155-11155111");
    assert.equal(t.qrValue, "0xabc");
  });

  it("falls back to the built-in table for a known chain without registry rows", () => {
    const [t] = buildDepositTargets([account({ chainReference: "97" })], []);
    assert.equal(t.label, "BNB Testnet");
    assert.equal(t.sublabel, "tBNB");
  });

  it("falls back to a generic label for an unregistered unknown chain", () => {
    const [t] = buildDepositTargets([account({ chainReference: "31337" })]);
    assert.equal(t.label, "EVM 31337");
    assert.equal(t.sublabel, "native");
  });

  it("keeps Solana rows and skips linked addresses", () => {
    const targets = buildDepositTargets(
      [
        account({ chainNamespace: "solana", chainReference: "devnet", address: "So1" }),
        account({ accountType: "linked_address", chainNamespace: "solana" }),
      ],
      [chain({ namespace: "solana", reference: "devnet", name: "solana-devnet", nativeSymbol: "SOL" })],
    );
    assert.equal(targets.length, 1);
    assert.equal(targets[0].label, "Solana");
    assert.equal(targets[0].qrValue, "solana:So1");
  });
});
