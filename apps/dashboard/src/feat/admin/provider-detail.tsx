import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../workspace/api";
import { Card, ERROR, FIELD, MUTED, SECTION_LABEL, WARN, MiniButton } from "../../workspace/ui";
import { PageHeader } from "../../workspace/page-header";
import { readiness, type AdminProvider, type ChainFamilyRow } from "./provider-utils";

/** One provider: display, availability, OAuth client, per-family chain policy. */
export function ProviderDetail({ client, code }: { client: PeridotClient; code: string }) {
  const [row, setRow] = useState<AdminProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRow(unwrap(await client.get<AdminProvider>(`/v1/admin/providers/${code}`), "Loading provider"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load provider");
    }
  }, [client, code]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setRow(unwrap(await client.patch<AdminProvider>(`/v1/admin/providers/${code}`, body), "Saving provider"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save provider");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Provider"
        title={row?.name ?? code}
        description={row ? `${row.code} · ${row.protocol} · ${readiness(row).label}` : code}
      />
      <div className="mt-6 flex flex-col gap-6">
        <p className="text-sm">
          <Link to="/admin/providers" className="text-muted-foreground transition-colors hover:text-foreground">
            ← Back to providers
          </Link>
        </p>

        {error && (
          <Card>
            <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          </Card>
        )}

        {!row && !error && (
          <Card>
            <p role="status" className={`text-sm ${MUTED}`}>Loading…</p>
          </Card>
        )}

        {row && (
          <>
            <Card>
              <EditMetadata row={row} busy={busy} onSave={patch} />
            </Card>

            {row.protocol === "oauth" && (
              <Card>
                <OAuthForm
                  client={client}
                  code={code}
                  row={row}
                  onChanged={async () => {
                    await load();
                  }}
                />
              </Card>
            )}

            {row.protocol === "wallet_signature" && (
              <Card>
                <ChainPolicy client={client} code={code} />
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}

function EditMetadata({
  row,
  busy,
  onSave,
}: {
  row: AdminProvider;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(row.name);
  const [imageUrl, setImageUrl] = useState(row.imageUrl ?? "");

  // Reflect the saved row (trimmed name, cleared icon) without remounting.
  useEffect(() => {
    setName(row.name);
    setImageUrl(row.imageUrl ?? "");
  }, [row.code, row.name, row.imageUrl]);

  return (
    <div>
      <p className={SECTION_LABEL}>Display & availability</p>
      <p className={`mt-1 text-xs ${MUTED}`}>
        The code and protocol are immutable once apps reference them.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs">
          Display name
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs">
          Icon URL
          <input className={FIELD} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <MiniButton
          onClick={() => void onSave({ name: name.trim(), imageUrl: imageUrl.trim() || null })}
          disabled={busy || !name.trim()}
        >
          Save display
        </MiniButton>
        <MiniButton
          onClick={() => void onSave({ isAvailable: !row.isAvailable })}
          disabled={busy || (!row.isAvailable && (!row.isSupported || !row.isConfigured))}
        >
          {row.isAvailable ? "Disable provider" : "Enable provider"}
        </MiniButton>
        <span className={`text-xs ${MUTED}`}>
          {row.isSupported ? "Adapter implemented" : "No adapter implemented"}
          {row.protocol === "oauth" ? ` · config: ${row.configSource}` : ""}
        </span>
      </div>
    </div>
  );
}

function OAuthForm({
  client,
  code,
  row,
  onChanged,
}: {
  client: PeridotClient;
  code: string;
  row: AdminProvider;
  onChanged: () => Promise<void>;
}) {
  const oauth = row.oauth;
  const [clientId, setClientId] = useState(oauth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState((oauth?.scopes ?? []).join(" "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await client.put(`/v1/admin/providers/${code}/oauth`, {
          clientId: clientId.trim(),
          ...(clientSecret ? { clientSecret } : {}),
          ...(scopes.trim() ? { scopes: scopes.trim().split(/\s+/) } : {}),
        }),
        "Saving OAuth configuration",
      );
      setClientSecret("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save OAuth configuration");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className={SECTION_LABEL}>OAuth client</p>
      <p className={`mt-1 text-xs ${MUTED}`}>
        Platform-level credentials — the client secret is write-only and never returned. Redirect URI
        is fixed by the API (no admin-supplied endpoints).
      </p>
      {!row.isSupported && (
        <p className={`mt-1 text-xs ${WARN}`}>
          No OAuth adapter is implemented for this provider yet; credentials cannot be saved.
        </p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs">
          Client ID
          <input className={FIELD} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className="text-xs">
          Client secret {oauth?.hasSecret ? "(leave blank to keep)" : ""}
          <input
            className={FIELD}
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </label>
        <label className="text-xs sm:col-span-2">
          Scopes (space separated)
          <input className={FIELD} value={scopes} onChange={(e) => setScopes(e.target.value)} />
        </label>
        {oauth && (
          <p className={`text-xs sm:col-span-2 ${MUTED}`}>
            Redirect URI: <code className="break-all font-mono">{oauth.redirectUri}</code>
            {oauth.secretUpdatedAt ? ` · secret updated ${new Date(oauth.secretUpdatedAt).toLocaleString()}` : ""}
          </p>
        )}
      </div>
      {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
      <div className="mt-3">
        <MiniButton
          variant="solid"
          onClick={() => void save()}
          disabled={busy || !row.isSupported || !clientId.trim()}
        >
          {busy ? "Saving…" : "Save OAuth client"}
        </MiniButton>
      </div>
    </div>
  );
}

function ChainPolicy({ client, code }: { client: PeridotClient; code: string }) {
  const [families, setFamilies] = useState<ChainFamilyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFamilies(unwrap(await client.get<ChainFamilyRow[]>("/v1/admin/chain-families"), "Loading chain families"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load chain families");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (namespace: string, mode: "all" | "selected", chainIds: string[]) => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await client.put(`/v1/admin/providers/${code}/chains/${namespace}`, { mode, chainIds }),
        "Saving chain policy",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save chain policy");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className={SECTION_LABEL}>Supported chains</p>
      <p className={`mt-1 text-xs ${MUTED}`}>
        Per chain family: every chain, or an explicit selection. Empty selection means unconfigured,
        never “all chains”.
      </p>
      {error && <p role="alert" className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      {families && families.length === 0 && <p className={`mt-2 text-sm ${MUTED}`}>No chain families yet.</p>}
      <div className="mt-3 flex flex-col gap-4">
        {(families ?? []).map((family) => (
          <FamilyPolicy key={family.code} family={family} busy={busy} onSave={save} />
        ))}
      </div>
    </div>
  );
}

function FamilyPolicy({
  family,
  busy,
  onSave,
}: {
  family: ChainFamilyRow;
  busy: boolean;
  onSave: (namespace: string, mode: "all" | "selected", chainIds: string[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<"all" | "selected">("selected");
  const [ids, setIds] = useState<string[]>([]);

  return (
    <div className="border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs">{family.code}</p>
        <select
          className="h-8 rounded-sm border border-input bg-background px-2 text-xs focus-ring"
          value={mode}
          onChange={(e) => setMode(e.target.value as "all" | "selected")}
        >
          <option value="selected">Selected chains</option>
          <option value="all">All chains</option>
        </select>
      </div>
      {mode === "selected" && (
        <ul className="mt-2 flex flex-col gap-1">
          {family.chains.length === 0 && <li className={`text-xs ${MUTED}`}>No chains in this family.</li>}
          {family.chains.map((chain) => (
            <li key={chain.id}>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={ids.includes(chain.id)}
                  onChange={(e) =>
                    setIds((prev) => (e.target.checked ? [...prev, chain.id] : prev.filter((id) => id !== chain.id)))
                  }
                />
                <span>{chain.name ?? chain.reference}</span>
                <span className="font-mono text-muted-foreground">{chain.reference}</span>
                {!chain.isActive && <span className={WARN}>inactive</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        <MiniButton
          onClick={() => void onSave(family.code, mode, mode === "all" ? [] : ids)}
          disabled={busy || (mode === "selected" && ids.length === 0 && family.chains.length > 0)}
        >
          Save {family.code} policy
        </MiniButton>
      </div>
    </div>
  );
}
