import { useState } from "react";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../workspace/api";
import { Card, DIVIDER, ERROR, FIELD, MUTED, MiniButton } from "../../workspace/ui";

// EVM rows stay off until BOTH are active (the API derives a deposit address
// from the pair), so the UI has to say which one is missing.
const CONTRACT_TYPES = ["factory", "account_implementation"] as const;

/** Typed contracts for one chain (factory, account implementation, …). */
export function ChainContracts({
  client,
  chain,
  onChanged,
}: {
  client: PeridotClient;
  chain: Chain;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const contracts = chain.contracts ?? [];
  const activeTypes = new Set(contracts.filter((k) => k.isActive).map((k) => k.type));
  const missing = CONTRACT_TYPES.filter((t) => !activeTypes.has(t));

  return (
    <Card>
      <div className="flex flex-col gap-2">
        {contracts.map((k) => (
          <div key={k.type} className="flex items-center gap-2 font-mono text-xs">
            <span className="w-44 shrink-0 font-sans font-medium">{k.type}</span>
            <span className="truncate" title={k.address}>{k.address}</span>
            {!k.isActive && <span className={`font-sans ${ERROR}`}>disabled</span>}
          </div>
        ))}
        {contracts.length === 0 && (
          <p className={`text-sm ${MUTED}`}>
            No contracts yet — set both factory and account_implementation below.
          </p>
        )}
        {contracts.length > 0 && missing.length > 0 && (
          <p className={`text-sm ${MUTED}`}>
            Wallets show no deposit address for this chain until both are set — missing{" "}
            {missing.join(" + ")}.
          </p>
        )}
      </div>
      {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
      <div className={`mt-3 pt-3 ${DIVIDER}`}>
        <ContractForm client={client} chainId={chain.id} onChanged={onChanged} onError={setError} />
      </div>
    </Card>
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
      <MiniButton variant="solid" size="lg"
        type="button"
        onClick={save}
        disabled={busy}
      >
        {busy ? "Saving…" : "Set contract"}
      </MiniButton>
    </div>
  );
}
