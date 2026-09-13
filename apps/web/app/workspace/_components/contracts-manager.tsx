"use client";

import { useCallback, useEffect, useState } from "react";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, DIVIDER, ERROR, FIELD, MUTED } from "./ui";
import { PageHeader } from "./page-header";
import { useWorkspace } from "./workspace-provider";
import { CutButton } from "@/components/landing/cut-button";

const CONTRACT_TYPES = ["factory", "account_implementation", "verifier", "paymaster"] as const;

/** Admin smart-contract registry: typed contracts per chain (factory, implementation, …). */
export function ContractsManager({ client }: { client: PeridotClient }) {
  const { contractChainId } = useWorkspace();
  const [chains, setChains] = useState<Chain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");

  const load = useCallback(async () => {
    setChains(await client.admin.chains().then((r) => unwrap({ ok: true, data: r }, "Loading chains")));
  }, [client]);

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load chains"))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (contractChainId) {
      setSelectedId(contractChainId);
    } else if (!selectedId && chains.length > 0) {
      const first = chains[0];
      if (first) setSelectedId(first.id);
    }
  }, [contractChainId, chains, selectedId]);

  const chain = chains.find((c) => c.id === selectedId) ?? null;

  return (
    <section className="mt-8">
      <PageHeader
        eyebrow="Smart contracts"
        title="Contracts"
        description="Set factory, implementation, verifier, and paymaster addresses per chain."
      />
      {error && <p className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      {loading ? (
        <p className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : chains.length === 0 ? (
        <p className={`mt-4 text-sm ${MUTED}`}>No chains registered.</p>
      ) : (
        <>
          <label className="mt-4 block max-w-md text-sm">
            Chain
            <select
              value={chain?.id ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
              className={`${FIELD} block`}
            >
              {chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {chain && (
            <Card className="mt-4">
              <div className="flex flex-col gap-2">
                {(chain.contracts ?? []).map((k) => (
                  <div key={k.type} className="flex items-center gap-2 font-mono text-xs">
                    <span className="w-44 shrink-0 font-sans font-medium">{k.type}</span>
                    <span className="truncate">{k.address}</span>
                    {!k.isActive && <span className={`font-sans ${ERROR}`}>disabled</span>}
                  </div>
                ))}
                {(chain.contracts ?? []).length === 0 && (
                  <p className={`text-sm ${MUTED}`}>No contracts yet — set the factory below to enable this chain.</p>
                )}
              </div>
              <div className={`mt-3 pt-3 ${DIVIDER}`}>
                <ContractForm client={client} chainId={chain.id} onChanged={load} onError={setError} />
              </div>
            </Card>
          )}
        </>
      )}
    </section>
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
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="text-sm">
        Type
        <select value={type} onChange={(e) => setType(e.target.value)} className={`${FIELD} block`}>
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
          className={`${FIELD} font-mono`}
        />
      </label>
      <CutButton
        type="button"
        onClick={save}
        disabled={busy}
        className={busy ? "pointer-events-none opacity-60" : ""}
      >
        {busy ? "Saving…" : "Set contract"}
      </CutButton>
    </div>
  );
}
