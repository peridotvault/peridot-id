"use client";

import { useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, ERROR, FIELD, MUTED } from "./ui";
import { CutButton } from "@/components/landing/cut-button";

export function AddChainForm({
  client,
  onDone,
  onError,
}: {
  client: PeridotClient;
  onDone: () => void;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [symbol, setSymbol] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim() || !reference.trim() || !symbol.trim()) {
      setError("Name, chain id, and native symbol are required.");
      return;
    }
    setBusy(true);
    setError(null);
    onError(null);
    try {
      await client.admin
        .createChain({ namespace: "eip155", reference: reference.trim(), name: name.trim(), nativeSymbol: symbol.trim() })
        .then((r) => unwrap({ ok: true, data: r }, "Adding chain"));
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Add failed";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h3 className="font-semibold tracking-tight">Register a new EVM chain</h3>
      <p className={`mt-1 text-sm ${MUTED}`}>Metadata and RPCs are editable after — set its factory contract next.</p>
      {error && <p className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-sm">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Base Sepolia" maxLength={64} className={FIELD} />
        </label>
        <label className="text-sm">
          Chain id
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="84532" maxLength={16} className={FIELD} />
        </label>
        <label className="text-sm">
          Native symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="ETH" maxLength={12} className={FIELD} />
        </label>
      </div>
      <CutButton
        type="button"
        onClick={create}
        disabled={busy}
        className={`mt-3 ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        {busy ? "Adding…" : "Add chain"}
      </CutButton>
    </Card>
  );
}
