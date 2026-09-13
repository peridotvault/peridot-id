"use client";

import { useState } from "react";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { ERROR, FIELD, MUTED } from "./ui";
import { CutButton } from "@/components/landing/cut-button";

export function EditChainForm({
  client,
  chain,
  onDone,
}: {
  client: PeridotClient;
  chain: Chain;
  onDone: () => void;
}) {
  const [name, setName] = useState(chain.name);
  const [symbol, setSymbol] = useState(chain.nativeSymbol);
  const [decimals, setDecimals] = useState(String(chain.decimals ?? ""));
  const [rpcUrls, setRpcUrls] = useState((chain.rpcUrls ?? []).join("\n"));
  const [explorerUrl, setExplorerUrl] = useState(chain.explorerUrl ?? "");
  const [logoUrl, setLogoUrl] = useState(chain.logoUrl ?? "");
  const [isTestnet, setIsTestnet] = useState(chain.isTestnet);
  const [isActive, setIsActive] = useState(chain.isActive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || !symbol.trim()) {
      setError("Name and native symbol are required.");
      return;
    }
    const parsedDecimals = decimals.trim() === "" ? undefined : Number.parseInt(decimals.trim(), 10);
    if (parsedDecimals !== undefined && (!Number.isInteger(parsedDecimals) || parsedDecimals < 0)) {
      setError("Decimals must be a whole number of 0 or more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.admin
        .updateChain(chain.id, {
          name: name.trim(),
          nativeSymbol: symbol.trim(),
          ...(parsedDecimals !== undefined ? { decimals: parsedDecimals } : {}),
          rpcUrls: rpcUrls.split("\n").map((u) => u.trim()).filter(Boolean),
          ...(explorerUrl.trim() ? { explorerUrl: explorerUrl.trim() } : {}),
          ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
          isTestnet,
          isActive,
        })
        .then((r) => unwrap({ ok: true, data: r }, "Saving chain"));
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className={`rounded-lg border border-border px-3 py-2 font-mono text-xs ${MUTED}`}>
        {chain.namespace}:{chain.reference} · id {chain.id}
      </div>
      {error && <p className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-sm">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className={FIELD} />
        </label>
        <label className="text-sm">
          Native symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={12} className={FIELD} />
        </label>
        <label className="text-sm">
          Decimals
          <input
            value={decimals}
            onChange={(e) => setDecimals(e.target.value)}
            inputMode="numeric"
            placeholder="18"
            className={`${FIELD} font-mono`}
          />
        </label>
        <label className="text-sm">
          Explorer URL
          <input
            value={explorerUrl}
            onChange={(e) => setExplorerUrl(e.target.value)}
            placeholder="https://…"
            inputMode="url"
            maxLength={256}
            className={FIELD}
          />
        </label>
        <label className="text-sm sm:col-span-2">
          Logo URL
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…"
            inputMode="url"
            maxLength={512}
            className={FIELD}
          />
        </label>
        <label className="text-sm sm:col-span-2">
          RPC URLs <span className={MUTED}>(one per line, max 5)</span>
          <textarea
            value={rpcUrls}
            onChange={(e) => setRpcUrls(e.target.value)}
            placeholder="https://…"
            rows={3}
            spellCheck={false}
            className={`${FIELD} font-mono`}
          />
        </label>
      </div>
      <div className="mt-3 flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isTestnet}
            onChange={(e) => setIsTestnet(e.target.checked)}
            className="h-4 w-4 accent-brand-1"
          />
          Testnet
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 accent-brand-1"
          />
          Active
        </label>
      </div>
      <CutButton
        type="button"
        onClick={save}
        disabled={busy}
        className={`mt-4 ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        {busy ? "Saving…" : "Save chain"}
      </CutButton>
    </div>
  );
}
