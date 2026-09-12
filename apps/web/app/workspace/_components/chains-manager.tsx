"use client";

import { useCallback, useEffect, useState } from "react";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";

const CONTRACT_TYPES = ["factory", "account_implementation", "verifier", "paymaster"] as const;

/** Admin chain registry: chains + their typed contracts (factory, implementation, …). */
export function ChainsManager({ client }: { client: PeridotClient }) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setChains(await client.admin.chains().then((r) => unwrap({ ok: true, data: r }, "Loading chains")));
  }, [client]);

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load chains"))
      .finally(() => setLoading(false));
  }, [load]);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Chains</h2>
      <p className="mt-1 text-sm text-neutral-500">
        What the wallet renders and activation uses. Deactivating hides a chain everywhere.
      </p>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="mt-4 text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {chains.map((c) => (
            <ChainCard
              key={c.id}
              client={client}
              chain={c}
              expanded={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
              onChanged={load}
              onError={setError}
            />
          ))}
          {chains.length === 0 && <p className="text-sm text-neutral-500">No chains registered.</p>}
        </div>
      )}
      <AddChainForm client={client} onChanged={load} onError={setError} />
    </section>
  );
}

function ChainCard({
  client,
  chain,
  expanded,
  onToggle,
  onChanged,
  onError,
}: {
  client: PeridotClient;
  chain: Chain;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const setActive = async (isActive: boolean) => {
    setBusy(true);
    onError(null);
    try {
      await client.admin.updateChain(chain.id, { isActive }).then((r) => unwrap({ ok: true, data: r }, "Updating chain"));
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-2xl border p-4 ${chain.isActive ? "border-neutral-200" : "border-neutral-200 opacity-60"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        {chain.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={chain.logoUrl} alt="" className="h-6 w-6 rounded-full" />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-bold">
            {chain.nativeSymbol.slice(0, 3)}
          </span>
        )}
        <span className="font-semibold">{chain.name}</span>
        <span className="text-xs text-neutral-500">
          {chain.namespace}:{chain.reference} · {chain.nativeSymbol}
        </span>
        {chain.isTestnet && <span className="text-[11px] text-neutral-400">testnet</span>}
        {!chain.isActive && <span className="text-[11px] font-semibold text-red-600">disabled</span>}
        <span className="ml-auto text-xs text-neutral-400">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-neutral-100 pt-3">
          <div className="flex flex-col gap-2">
            {(chain.contracts ?? []).map((k) => (
              <div key={k.type} className="flex items-center gap-2 font-mono text-xs">
                <span className="w-44 shrink-0 font-sans font-medium">{k.type}</span>
                <span className="truncate">{k.address}</span>
                {!k.isActive && <span className="font-sans text-red-600">disabled</span>}
              </div>
            ))}
            {(chain.contracts ?? []).length === 0 && (
              <p className="text-sm text-neutral-500">No contracts yet — set the factory below to enable this chain.</p>
            )}
          </div>
          <ContractForm client={client} chainId={chain.id} onChanged={onChanged} onError={onError} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setActive(!chain.isActive)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              {chain.isActive ? "Disable chain" : "Enable chain"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ContractForm({
  client,
  chainId,
  onChanged,
  onError,
}: {
  client: PeridotClient;
  chainId: string;
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [type, setType] = useState<string>("factory");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!address.trim()) {
      onError("Paste the contract address first.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await client.admin
        .upsertContract(chainId, { type: type as "factory", address: address.trim() })
        .then((r) => unwrap({ ok: true, data: r }, "Saving contract"));
      setAddress("");
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl bg-neutral-50 p-3 sm:flex-row sm:items-end">
      <label className="text-sm">
        Type
        <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 block rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm">
          {CONTRACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex-1 text-sm">
        Address
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm"
        />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Saving…" : "Set contract"}
      </button>
    </div>
  );
}

function AddChainForm({
  client,
  onChanged,
  onError,
}: {
  client: PeridotClient;
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [symbol, setSymbol] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || !reference.trim() || !symbol.trim()) {
      onError("Name, chain id, and native symbol are required.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await client.admin
        .createChain({ namespace: "eip155", reference: reference.trim(), name: name.trim(), nativeSymbol: symbol.trim() })
        .then((r) => unwrap({ ok: true, data: r }, "Adding chain"));
      setName("");
      setReference("");
      setSymbol("");
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-8 rounded-2xl border border-neutral-200 p-6">
      <h3 className="font-semibold">Register a new EVM chain</h3>
      <p className="mt-1 text-sm text-neutral-500">Metadata and RPCs are editable after — set its factory contract next.</p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-sm">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Base Sepolia" maxLength={64} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          Chain id
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="84532" maxLength={16} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          Native symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="ETH" maxLength={12} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
        </label>
      </div>
      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="mt-3 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Adding…" : "Add chain"}
      </button>
    </div>
  );
}
