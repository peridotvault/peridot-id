import { useCallback, useEffect, useState } from "react";
import type { Chain, PeridotClient, Token, TokenDeployment } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, MUTED, SECTION_LABEL, MiniButton } from "../../shared/ui/kit";
import { AddTokenForm } from "./add-token-form";

/** Token deployments on one chain. Registration starts pre-filled with it. */
export function ChainTokens({
  client,
  chain,
  onChanged,
}: {
  client: PeridotClient;
  chain: Chain;
  onChanged: () => Promise<void>;
}) {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setTokens(await client.admin.tokens().then((r) => unwrap({ ok: true, data: r }, "Loading tokens")));
  }, [client]);

  useEffect(() => {
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load tokens"));
  }, [load]);

  const refresh = async () => {
    await load();
    await onChanged();
  };

  const toggle = async (deploymentId: string, input: { isVisible?: boolean; isPinned?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await client.admin
        .updateTokenDeployment(deploymentId, input)
        .then((r) => unwrap({ ok: true, data: r }, "Updating deployment"));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (tokenId: string, file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await client.admin
        .uploadTokenLogo(tokenId, file)
        .then((r) => unwrap({ ok: true, data: r }, "Uploading logo"));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const rows = (tokens ?? [])
    .map((token) => ({ token, deployment: token.deployments.find((d) => d.chainId === chain.id) }))
    .filter((row): row is { token: Token; deployment: TokenDeployment } => Boolean(row.deployment));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Tokens on this chain</p>
            <p className={`mt-1 text-xs ${MUTED}`}>
              Only registered deployments render in wallets. One token can live on many chains.
            </p>
          </div>
          <MiniButton onClick={() => setAdding((v) => !v)}>
            {adding ? "Close" : "Register token"}
          </MiniButton>
        </div>
        {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
      </Card>

      {adding && (
        <AddTokenForm
          client={client}
          defaultChainId={chain.id}
          onDone={() => {
            setAdding(false);
            void refresh().catch((e: unknown) =>
              setError(e instanceof Error ? e.message : "Failed to reload tokens"),
            );
          }}
          onError={setError}
        />
      )}

      {!tokens && !error && (
        <Card>
          <p role="status" className={`text-sm ${MUTED}`}>Loading tokens…</p>
        </Card>
      )}

      {tokens && rows.length === 0 && (
        <Card>
          <p className={`text-sm ${MUTED}`}>No tokens on this chain yet.</p>
        </Card>
      )}

      {rows.map(({ token, deployment }) => (
        <Card key={token.id}>
          <div className="flex items-center gap-3">
            {token.logoUrl ? (
              <img src={token.logoUrl} alt="" className="h-8 w-8 rounded-full" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-bold">
                {token.symbol.slice(0, 3)}
              </span>
            )}
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-semibold tracking-tight">{token.symbol}</span>
              <span className={`truncate text-xs ${MUTED}`}>{token.name}</span>
            </div>
            <label className="ml-auto inline-flex shrink-0 cursor-pointer items-center rounded-md border border-line px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
              Logo
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  void upload(token.id, e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <ul className="mt-3">
            <li className={`flex flex-wrap items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-xs ${deployment.isVisible ? "" : "opacity-60"}`}>
              <span className="font-mono">
                {deployment.mint.slice(0, 8)}…{deployment.mint.slice(-6)} · {deployment.decimals} dec
              </span>
              {deployment.isPinned && <span className={MUTED}>· pinned</span>}
              {!deployment.isVisible && <span className={`font-semibold ${ERROR}`}>· hidden</span>}
              <span className="ml-auto flex gap-1">
                <MiniButton size="sm" disabled={busy} onClick={() => void toggle(deployment.id, { isVisible: !deployment.isVisible })}>
                  {deployment.isVisible ? "Hide" : "Show"}
                </MiniButton>
                <MiniButton size="sm" disabled={busy} onClick={() => void toggle(deployment.id, { isPinned: !deployment.isPinned })}>
                  {deployment.isPinned ? "Unpin" : "Pin"}
                </MiniButton>
              </span>
            </li>
          </ul>
        </Card>
      ))}
    </div>
  );
}
