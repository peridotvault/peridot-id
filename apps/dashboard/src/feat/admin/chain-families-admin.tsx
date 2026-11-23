import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, FIELD, MUTED, SECTION_LABEL, MiniButton } from "../../shared/ui/kit";
import type { ChainFamilyRow } from "./provider-utils";

/** Chain family registry: which chains exist per family (namespaces). */
export function ChainFamiliesAdmin({ client }: { client: PeridotClient }) {
  const [families, setFamilies] = useState<ChainFamilyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFamilies(unwrap(await client.get<ChainFamilyRow[]>("/v1/admin/chain-families"), "Loading chain families"));
    } catch (e) {
      setFamilies(null);
      setError(e instanceof Error ? e.message : "Could not load chain families");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(await client.post("/v1/admin/chain-families", { code: code.trim() }), "Creating chain family");
      setCode("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create chain family");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <p className={SECTION_LABEL}>Chain families</p>
        <p className={`mt-1 text-xs ${MUTED}`}>
          A family is a signing namespace (e.g. <code className="font-mono">solana</code>,{" "}
          <code className="font-mono">eip155</code>). Chains are added to a family from the Chains
          tab; wallet providers select chains per family.
        </p>
        {error && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
            <MiniButton onClick={() => void load()}>Retry</MiniButton>
          </div>
        )}
        {!families && !error && <p role="status" className={`mt-3 text-sm ${MUTED}`}>Loading…</p>}
        {families?.length === 0 && <p className={`mt-3 text-sm ${MUTED}`}>No families registered yet.</p>}
        <ul className="mt-4 flex flex-col gap-4">
          {(families ?? []).map((family) => (
            <li key={family.code} className="border-t border-line pt-3">
              <p className="font-mono text-xs font-semibold">{family.code}</p>
              {family.chains.length === 0 ? (
                <p className={`mt-1 text-xs ${MUTED}`}>No chains in this family.</p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {family.chains.map((chain) => (
                    <li key={chain.id} className={chain.isActive ? "" : MUTED}>
                      {chain.name ?? chain.reference}{" "}
                      <span className="font-mono text-muted-foreground">{chain.reference}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Add chain family</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Family code
            <input className={`${FIELD} font-mono`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="eip155" />
          </label>
          <MiniButton variant="solid" onClick={() => void create()} disabled={busy || !code.trim()}>
            {busy ? "Creating…" : "Create family"}
          </MiniButton>
        </div>
      </Card>
    </div>
  );
}
