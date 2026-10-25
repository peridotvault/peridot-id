"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient, Token, TokenDeployment } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, ERROR, MUTED, MiniButton } from "./ui";
import { PageHeader } from "./page-header";

/** Admin token registry: one card per token, deployments per chain below. */
export function TokensManager({ client }: { client: PeridotClient }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setTokens(await client.admin.tokens().then((r) => unwrap({ ok: true, data: r }, "Loading tokens")));
  }, [client]);

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load tokens"))
      .finally(() => setLoading(false));
  }, [load]);

  const retry = useCallback(() => {
    setLoading(true);
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load tokens"))
      .finally(() => setLoading(false));
  }, [load]);

  return (
    <section className="mt-8">
      <PageHeader
        eyebrow="Token registry"
        title="Tokens"
        description="One token, many chains. Only registered deployments render in wallets."
      />
      {error && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={retry}>
            Retry
          </MiniButton>
        </div>
      )}
      {loading ? (
        <p role="status" className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : tokens.length === 0 ? (
        <div className="mt-4">
          <p className={`text-sm ${MUTED}`}>No tokens registered yet — add your first token below.</p>
          <Link
            to="/tokens/create"
            className="focus-ring mt-3 flex min-h-32 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:w-1/2 lg:w-1/3"
          >
            <span aria-hidden="true" className="text-2xl leading-none">+</span>
            Add token
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-4">
            <Link
              to="/tokens/create"
              className="focus-ring flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:w-1/2 lg:w-1/3"
            >
              <span aria-hidden="true" className="text-2xl leading-none">+</span>
              Add token
            </Link>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {tokens.map((t) => (
              <TokenCard key={t.id} client={client} token={t} onChanged={load} onError={setError} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function TokenCard({
  client,
  token,
  onChanged,
  onError,
}: {
  client: PeridotClient;
  token: Token;
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const update = async (deploymentId: string, input: { isVisible?: boolean; isPinned?: boolean }) => {
    setBusy(true);
    onError(null);
    try {
      await client.admin.updateTokenDeployment(deploymentId, input).then((r) => unwrap({ ok: true, data: r }, "Updating deployment"));
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      await client.admin.uploadTokenLogo(token.id, file).then((r) => unwrap({ ok: true, data: r }, "Uploading logo"));
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3">
        {token.logoUrl ? (
          <img src={token.logoUrl} alt="" className="h-8 w-8 rounded-full" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-bold">
            {token.symbol.slice(0, 3)}
          </span>
        )}
        <div className="flex flex-col">
          <span className="font-semibold tracking-tight">{token.symbol}</span>
          <span className={`text-xs ${MUTED}`}>{token.name}</span>
        </div>
        <label className="ml-auto inline-flex cursor-pointer items-center rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          Logo
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {token.deployments.length === 0 ? (
        <p className={`mt-3 text-xs ${MUTED}`}>No chains yet — this token renders nowhere.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {token.deployments.map((d) => (
            <DeploymentRow key={d.id} deployment={d} busy={busy} onToggle={(input) => update(d.id, input)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeploymentRow({
  deployment: d,
  busy,
  onToggle,
}: {
  deployment: TokenDeployment;
  busy: boolean;
  onToggle: (input: { isVisible?: boolean; isPinned?: boolean }) => Promise<void>;
}) {
  return (
    <li className={`flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs ${d.isVisible ? "" : "opacity-60"}`}>
      <span className="font-medium">{d.chainName}</span>
      <span className={`font-mono ${MUTED}`}>
        {d.mint.slice(0, 8)}…{d.mint.slice(-6)} · {d.decimals} dec
      </span>
      {d.isPinned && <span className={MUTED}>· pinned</span>}
      {!d.isVisible && <span className={`font-semibold ${ERROR}`}>· hidden</span>}
      <span className="ml-auto flex gap-1">
        <MiniButton size="sm" disabled={busy} onClick={() => onToggle({ isVisible: !d.isVisible })}>
          {d.isVisible ? "Hide" : "Show"}
        </MiniButton>
        <MiniButton size="sm" disabled={busy} onClick={() => onToggle({ isPinned: !d.isPinned })}>
          {d.isPinned ? "Unpin" : "Pin"}
        </MiniButton>
      </span>
    </li>
  );
}
