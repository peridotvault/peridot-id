"use client";

import { useEffect, useState } from "react";
import type { Chain, PeridotClient, TokenPreview } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, ERROR, FIELD, MUTED, MiniButton, WARN } from "./ui";
import { CutButton } from "./cut-button";

interface ChainRow {
  key: number;
  chainId: string;
  mint: string;
  decimals: string;
  preview: TokenPreview | null;
  checking: boolean;
}

let nextKey = 1;

/**
 * Register token flow: metadata once on top, chains below, ONE Save button.
 * Each chain row is picked from the chains table and checked (chain RPC +
 * CoinGecko) before the single atomic save.
 */
export function AddTokenForm({
  client,
  onDone,
  onError,
}: {
  client: PeridotClient;
  onDone: () => void;
  onError: (e: string | null) => void;
}) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [withLogo, setWithLogo] = useState(true);
  const [rows, setRows] = useState<ChainRow[]>([{ key: 0, chainId: "", mint: "", decimals: "", preview: null, checking: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.admin
      .chains()
      .then((r) => unwrap({ ok: true, data: r }, "Loading chains"))
      .then((list) => setChains(list.filter((c) => c.isActive)))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : "Failed to load chains";
        setError(message);
        onError(message);
      });
  }, [client, onError]);

  const patchRow = (key: number, patch: Partial<ChainRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const checkRow = async (row: ChainRow) => {
    const chain = chains.find((c) => c.id === row.chainId);
    if (!chain || !row.mint.trim()) {
      setError("Pick a chain and enter its mint address first.");
      return;
    }
    patchRow(row.key, { checking: true });
    setError(null);
    onError(null);
    try {
      const p = await client.admin
        .previewToken({ chainNamespace: chain.namespace, chainReference: chain.reference, mint: row.mint.trim() })
        .then((r) => unwrap({ ok: true, data: r }, "Checking mint"));
      const patch: Partial<ChainRow> = { preview: p };
      if (p.onchain.decimals !== undefined && !row.decimals) patch.decimals = String(p.onchain.decimals);
      patchRow(row.key, patch);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Check failed";
      setError(message);
      onError(message);
    } finally {
      patchRow(row.key, { checking: false });
    }
  };

  const save = async () => {
    if (!symbol.trim() || !name.trim()) {
      setError("Symbol and name are required.");
      return;
    }
    const deployments: { chainId: string; mint: string; decimals: number }[] = [];
    for (const r of rows) {
      const dec = Number(r.decimals);
      if (!r.chainId || !r.mint.trim() || !Number.isInteger(dec) || dec < 0) {
        setError("Every chain row needs a chain, a mint, and integer decimals (Check fills decimals).");
        return;
      }
      deployments.push({ chainId: r.chainId, mint: r.mint.trim(), decimals: dec });
    }
    const logoSourceUrl = withLogo ? rows.map((r) => r.preview?.autofill?.logoSourceUrl).find((u) => !!u) : undefined;
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const created = await client.admin
        .createToken({
          symbol: symbol.trim().toUpperCase(),
          name: name.trim(),
          logoSourceUrl: logoSourceUrl ?? undefined,
          deployments,
        })
        .then((r) => unwrap({ ok: true, data: r }, "Saving token"));
      // Manual logo wins over the CoinGecko fetch: same Save button, chained
      // behind the create (a failed upload warns but keeps the token).
      if (logoFile) {
        try {
          await client.admin
            .uploadTokenLogo(created.id, logoFile)
            .then((r) => unwrap({ ok: true, data: r }, "Uploading logo"));
        } catch (e) {
          setError(`Token saved, but the logo upload failed: ${e instanceof Error ? e.message : "unknown error"}`);
        }
      }
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Save failed";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h3 className="font-semibold tracking-tight">Token metadata</h3>
      <p className={`mt-1 text-sm ${MUTED}`}>Once per token — chains hang below, one Save at the bottom.</p>
      {error && <p role="alert" className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-sm">
          Symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="USDT" maxLength={24} className={FIELD} />
        </label>
        <label className="text-sm">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tether" maxLength={64} className={FIELD} />
        </label>
        <label className="text-sm sm:col-span-2">
          Logo image <span className={MUTED}>(PNG/JPEG/WebP ≤ 512KB — wins over CoinGecko)</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
            className={`${FIELD} file:mr-2 file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-xs`}
          />
        </label>
      </div>

      <h3 className="mt-5 font-semibold tracking-tight">Chains</h3>
      <div className="mt-2 flex flex-col gap-3">
        {rows.map((r) => {
          const chain = chains.find((c) => c.id === r.chainId);
          return (
            <div key={r.key} className="rounded border border-border p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <label className="text-sm">
                  Chain
                  <select value={r.chainId} onChange={(e) => patchRow(r.key, { chainId: e.target.value, preview: null })} className={FIELD}>
                    <option value="">Pick…</option>
                    {chains.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.namespace}:{c.reference})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm sm:col-span-2">
                  Mint address
                  <input value={r.mint} onChange={(e) => patchRow(r.key, { mint: e.target.value, preview: null })} placeholder={chain?.namespace === "eip155" ? "0x…" : "Base58…"} maxLength={88} className={FIELD} />
                </label>
                <label className="text-sm">
                  Decimals
                  <input value={r.decimals} onChange={(e) => patchRow(r.key, { decimals: e.target.value })} placeholder="6" inputMode="numeric" maxLength={3} className={FIELD} />
                </label>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <MiniButton size="sm" disabled={r.checking || busy} onClick={() => checkRow(r)}>
                  {r.checking ? "Checking…" : "Check"}
                </MiniButton>
                {rows.length > 1 && (
                  <MiniButton size="sm" disabled={busy} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    Remove
                  </MiniButton>
                )}
              </div>
              {r.preview && (
                <div className="mt-2 text-sm">
                  <p>
                    On-chain decimals:{" "}
                    {r.preview.onchain.decimals !== undefined ? <strong>{r.preview.onchain.decimals}</strong> : <span className={ERROR}>{r.preview.onchain.error ?? "unknown"}</span>}
                    {r.preview.coingecko && <> · CoinGecko: <strong>{r.preview.coingecko.name}</strong>{r.preview.coingecko.addressMatch ? "" : <span className={WARN}> (address differs)</span>}</>}
                  </p>
                  {r.preview.conflicts.map((c) => (
                    <p key={c} className={`mt-1 ${WARN}`}>{c}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2">
        <MiniButton size="sm" disabled={busy} onClick={() => setRows((rs) => [...rs, { key: nextKey++, chainId: "", mint: "", decimals: "", preview: null, checking: false }])}>
          + Add chain
        </MiniButton>
      </div>

      {rows.some((r) => r.preview?.autofill?.logoSourceUrl) && !logoFile && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withLogo} onChange={(e) => setWithLogo(e.target.checked)} />
          Fetch CoinGecko logo into our storage
        </label>
      )}
      <div className="mt-3">
        <CutButton type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save token"}
        </CutButton>
      </div>
    </Card>
  );
}
