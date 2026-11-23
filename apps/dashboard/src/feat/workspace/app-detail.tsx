"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Switch } from "../../shared/ui/switch";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import type { ReactNode } from "react";
import { ProviderIcon } from "../../shared/ui/provider-icon";
import { WebhookDeliveries } from "./webhook-deliveries";
import { unwrap } from "../../shared/api";
import { normalizeOriginInput } from "./origins";
import { isAppSection, PROTOCOL_LABEL, PROVIDER_GROUP_LABEL, type AppFee, type PidApp, type ProviderMeta } from "../../shared/app-types";
import type { UsageReport } from "@peridotvault/pid-sdk-js";
import { Badge, Card, DIVIDER, ERROR, FIELD, METRIC, MUTED, SECTION_LABEL, Segmented, SegmentedItem, WARN, MiniButton } from "../../shared/ui/kit";

/** Sandbox MVP faucet (FR-3): visibility driven ONLY by GET /v1/env
 *  (server-derived), never by a client env var. Contract shapes from
 *  ANT-287 §3 FR-2 — implemented against the live endpoint; before the
 *  Backend child lands this 404s and the card stays hidden/empty. */
interface EnvInfo {
  env: string;
  dokuMode: string;
  docs: string;
}

interface TestCreditView {
  ok: boolean;
  creditId: string;
  amountMinor: number;
  currency: string;
  env: string;
  dailyRemainingMinor: number;
}

const OPS: { key: string; label: string; hint: string }[] = [
  { key: "topup", label: "Top-up", hint: "Charged when a user funds through this app." },
  { key: "transaction", label: "Transaction", hint: "Charged on sends initiated through this app." },
  { key: "withdraw", label: "Withdraw (bank)", hint: "Charged on bank payouts initiated through this app." },
];

/** Keys is the one section with too much to fit on one page: two tabs inside. */
type KeysTab = "keys" | "domains";

const KEY_TABS: { key: KeysTab; label: string }[] = [
  { key: "keys", label: "API Keys" },
  { key: "domains", label: "Domains & Clients" },
];

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

/** Client-side origin check lives in ./origins (exported for unit tests). */

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard unavailable or denied — caller surfaces the failure.
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  // ANT-341 FR7: reset timer cleaned up on unmount.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <MiniButton
      onClick={() => {
        void copy(text).then((ok) => {
          // ANT-333: only claim success when the clipboard write succeeded.
          setState(ok ? "done" : "failed");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState("idle"), 1500);
        });
      }}
      title={state === "failed" ? "Copy failed — your browser blocked clipboard access" : undefined}
      className="font-mono"
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </MiniButton>
  );
}

/** Accessible on/off switch (Integrations): ui-sdk Switch with the dashboard skin. */
/** App settings. Every API call is owner-scoped server-side, so a non-owner
 *  gets 404 and never sees another developer's app. */
export function AppDetail({
  client,
  appId,
  users,
  xp,
}: {
  client: PeridotClient;
  appId: string;
  /** Section slots owned by the page: a feature never imports another feature. */
  users?: ReactNode;
  xp?: ReactNode;
}) {
  const [app, setApp] = useState<PidApp | null>(null);
  const [fees, setFees] = useState<Record<string, AppFee>>({});
  const [balance, setBalance] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [revealedWebhook, setRevealedWebhook] = useState<string | null>(null);
  // Section comes from ?section= — the app sidebar (WorkspaceLayout) drives it.
  const [params] = useSearchParams();
  const section = isAppSection(params.get("section")) ? params.get("section") : "overview";
  const [keysTab, setKeysTab] = useState<KeysTab>("keys");
  const [catalog, setCatalog] = useState<ProviderMeta[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  // Sandbox faucet state — env comes from GET /v1/env only (never a client var).
  const [envInfo, setEnvInfo] = useState<EnvInfo | null>(null);
  const [faucetAmount, setFaucetAmount] = useState("50000");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [dailyRemaining, setDailyRemaining] = useState<number | null>(null);

  // ANT-341 FR7: flash timeout cleaned up on unmount (no setState-after-unmount).
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const flash = (m: string) => {
    setMsg(m);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setMsg(null), 2500);
  };

  // Catalogue metadata comes from the API only — no per-page provider copies.
  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const rows = unwrap(await client.get<ProviderMeta[]>("/v1/providers"), "Loading providers");
      setCatalog(rows);
    } catch (e) {
      setCatalog(null);
      setCatalogError(e instanceof Error ? e.message : "Could not load providers");
    } finally {
      setCatalogLoading(false);
    }
  }, [client]);

  const load = useCallback(async () => {
    // ANT-341 FR7: never fire API calls with an empty app id.
    if (!appId) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const a = unwrap(await client.get<PidApp>(`/v1/apps/${appId}`), "Loading app");
      setApp(a);
      setName(a.name);
      setLogoUrl(a.logoUrl ?? "");
      setDescription(a.description ?? "");
      const f = unwrap(await client.get<AppFee[]>(`/v1/apps/${appId}/fees`), "Loading fees");
      setFees(Object.fromEntries(f.map((x) => [x.operation, x])));
      try {
        const bal = unwrap(await client.get<{ balanceIdr: string }>("/v1/fiat/balance"), "Balance");
        setBalance(bal.balanceIdr);
      } catch {
        setBalance(null);
      }
      // Sandbox affordance: server-derived env only. Production (or a backend
      // without FR-1 yet) leaves envInfo null → no faucet card.
      try {
        const env = unwrap(await client.get<EnvInfo>("/v1/env"), "Env");
        setEnvInfo(env);
      } catch {
        setEnvInfo(null);
      }
      // Web3 usage is reported, never charged — a failure must not hide the app.
      try {
        const u = await client.usage.monthly(appId);
        setUsage("month" in u ? u : null);
      } catch {
        setUsage(null);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : "Failed to load app";
      if (/404|not found|access/i.test(m)) setNotFound(true);
      else setError(m);
    } finally {
      setLoading(false);
    }
  }, [client, appId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const save = async (
    patch: { name?: string; logoUrl?: string; description?: string; allowedOrigins?: string[]; isActive?: boolean; loginMethods?: string[] },
    done?: () => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const a = unwrap(await client.patch<PidApp>(`/v1/apps/${appId}`, patch), "Save");
      setApp(a);
      done?.();
      flash("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  /** Drag/drop or click: upload the logo bytes, store returns the proxy URL. */
  const uploadLogo = async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Logo must be a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > 512 * 1024) {
      setError("Logo must be 512KB or smaller.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("logo", file);
      const a = unwrap(await client.postForm<PidApp>(`/v1/apps/${appId}/logo`, form), "Upload logo");
      setApp(a);
      setLogoUrl(a.logoUrl ?? "");
      flash("Logo updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const addOrigin = () => {
    const raw = newOrigin.trim();
    if (!raw || !app) return;
    const checked = normalizeOriginInput(raw);
    if ("error" in checked) {
      setOriginError(checked.error);
      return;
    }
    setOriginError(null);
    if (app.allowedOrigins.includes(checked.origin)) {
      setNewOrigin("");
      return;
    }
    void save({ allowedOrigins: [...app.allowedOrigins, checked.origin] }, () => setNewOrigin(""));
  };

  const rotateSecret = async () => {
    if (!window.confirm("Generate a new backend secret? The previous secret keeps working for 24h (grace window) while you roll out the new one.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = unwrap(await client.post<{ secret: string; prefix: string; graceExpiresAt: string | null }>(`/v1/apps/${appId}/secret`, {}), "Secret rotation");
      setRevealed(res.secret);
      await load();
    } catch {
      setError("Secret rotation failed.");
    } finally {
      setBusy(false);
    }
  };

  /** Set (or replace) the ledger-callback endpoint. The signing secret is
   *  returned ONCE — shown with copy + dismiss, never fetched again. */
  const saveWebhook = async () => {
    const url = newWebhookUrl.trim();
    if (!url || !app) return;
    setBusy(true);
    setError(null);
    try {
      const res = unwrap(
        await client.post<{ url: string; secret: string }>(`/v1/apps/${appId}/webhook`, { url }),
        "Save webhook",
      );
      setApp({ ...app, webhookUrl: res.url });
      setRevealedWebhook(res.secret);
      setNewWebhookUrl("");
      flash("Webhook saved. Copy the signing secret now.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save webhook failed.");
    } finally {
      setBusy(false);
    }
  };

  /** Remove the ledger-callback endpoint (and its signing secret). */
  const clearWebhook = async () => {
    if (!window.confirm("Remove this webhook endpoint? PeridotID will stop signing callbacks to it.")) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(await client.delete<{ url: string | null }>(`/v1/apps/${appId}/webhook`), "Remove webhook");
      if (app) setApp({ ...app, webhookUrl: null });
      setRevealedWebhook(null);
      flash("Webhook removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove webhook failed.");
    } finally {
      setBusy(false);
    }
  };

  const usableProviders = (catalog ?? []).filter((p) => p.isAvailable && p.isSupported);
  // Missing field = server returned every available provider; mirror that.
  const enabledMethods = app?.loginMethods ?? usableProviders.map((p) => p.code);

  const toggleMethod = (key: string, next: boolean) => {
    const set = new Set(enabledMethods);
    if (next) set.add(key);
    else set.delete(key);
    if (set.size === 0) {
      setError("Keep at least one login method on.");
      return;
    }
    void save({ loginMethods: usableProviders.map((p) => p.code).filter((k) => set.has(k)) });
  };

  const patchFee = (op: string, patch: Partial<AppFee>) => {
    setFees((prev) => ({ ...prev, [op]: { ...prev[op], ...patch } }));
  };

  const saveFee = async (op: string) => {
    const f = fees[op];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const saved = unwrap(
        await client.put<AppFee>(`/v1/apps/${appId}/fees/${op}`, {
          percentBps: Number(f.percentBps) || 0,
          minIdr: f.minIdr || "0",
          maxIdr: f.maxIdr || "0",
          enabled: !!f.enabled,
        }),
        "Save fee",
      );
      patchFee(op, saved);
      flash(`${OPS.find((o) => o.key === op)?.label ?? op} fee saved.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  /** Sandbox faucet: instant test credit (FR-2 contract). Server-gated —
   *  production returns 404 (route absent) and the card is never shown there. */
  const requestFaucet = async () => {
    const amountMinor = Number(faucetAmount.replace(/\D/g, "")) || 0;
    if (amountMinor <= 0) {
      setFaucetError("Enter an amount greater than 0.");
      return;
    }
    setFaucetBusy(true);
    setFaucetError(null);
    try {
      const res = unwrap(
        await client.post<TestCreditView>("/v1/fiat/test-credit", { amountMinor }),
        "Faucet request",
      );
      setDailyRemaining(res.dailyRemainingMinor);
      flash(`Test credit +${fmtIdr(String(res.amountMinor))} (${res.creditId}).`);
      await load();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Faucet request failed.";
      // Production oracle-safety: 404 means route absent (expected on prod).
      setFaucetError(/404|not found/i.test(m) ? "Faucet is not available in this environment." : m);
    } finally {
      setFaucetBusy(false);
    }
  };

  const isSandboxEnv = envInfo?.env === "sandbox";

  if (loading) {
    return (
      <section>
        <p role="status" className={`text-sm ${MUTED}`}>Loading…</p>
      </section>
    );
  }

  if (notFound || !app) {
    return (
      <section>
        <Link to="/" className={`inline-flex items-center gap-1 text-sm ${MUTED} transition-colors hover:text-foreground`}>
          <span aria-hidden="true">←</span> All apps
        </Link>
        <Card>
          <p className="font-semibold">App not found</p>
          <p className={`mt-1 text-sm ${MUTED}`}>This app does not exist or you do not have access to it.</p>
        </Card>
      </section>
    );
  }

  return (
    <>
      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={() => void load()}>
            Retry
          </MiniButton>
        </div>
      )}
      {msg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}

      {/* Keyed by section so a sidebar click re-runs the entrance animation. */}
      <div key={section} className="section-in">
          {section === "overview" && (
            <div className="grid gap-3">
              <Card>
                <p className={SECTION_LABEL}>Your fiat balance</p>
                <p className={`mt-2 text-2xl ${METRIC}`}>{balance === null ? "—" : fmtIdr(balance)}</p>
                <p className={`mt-1 text-xs ${MUTED}`}>
                  Your own spendable fiat-ledger balance — user-scoped, so the same value shows on every app
                  page. Not per-app escrow.
                </p>
              </Card>

              {isSandboxEnv && (
                <Card>
                  <p className={SECTION_LABEL}>Sandbox faucet — test credit</p>
                  <p className={`mt-1 text-xs ${MUTED}`}>
                    Instant test money for this sandbox workspace. No checkout required, no real funds.
                    {dailyRemaining !== null
                      ? ` ${fmtIdr(String(dailyRemaining))} remaining today.`
                      : " Daily cap Rp100.000 per identity."}
                  </p>
                  {faucetError && <p role="alert" className={`mt-2 text-xs ${ERROR}`}>{faucetError}</p>}
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <label htmlFor="faucet-amount" className="sr-only">
                      Faucet amount in IDR
                    </label>
                    <input
                      id="faucet-amount"
                      value={faucetAmount}
                      onChange={(e) => setFaucetAmount(e.target.value.replace(/\D/g, ""))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void requestFaucet();
                      }}
                      inputMode="numeric"
                      placeholder="50000"
                      className={`${FIELD} font-mono text-xs`}
                    />
                    <MiniButton
                      variant="solid"
                      size="sm"
                      onClick={() => void requestFaucet()}
                      disabled={faucetBusy}
                      className="self-start sm:self-end"
                    >
                      {faucetBusy ? "Minting…" : "Get test credit"}
                    </MiniButton>
                  </div>
                </Card>
              )}

              {usage && (
                <Card>
                  <p className={SECTION_LABEL}>Web3 usage — {usage.month}</p>
                  <p className={`mt-1 text-xs ${MUTED}`}>
                    Distinct PIDs per app per UTC month, counted once however often they sign in or however
                    many wallets they link. Total covers every login method; Web3 counts only PIDs that
                    proved an external wallet, and the free allowance applies to that number — Web2-only
                    usage stays unlimited. Reporting only: nothing is charged and nothing is blocked.
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className={`text-xs ${MUTED}`}>Total PIDs</dt>
                      <dd className="font-mono tabular-nums">{usage.totalPids.toLocaleString("en-US")}</dd>
                    </div>
                    <div>
                      <dt className={`text-xs ${MUTED}`}>Web3 PIDs</dt>
                      <dd className="font-mono tabular-nums">{usage.web3Pids.toLocaleString("en-US")}</dd>
                    </div>
                    <div>
                      <dt className={`text-xs ${MUTED}`}>Billable</dt>
                      <dd className="font-mono tabular-nums">{usage.billablePids.toLocaleString("en-US")}</dd>
                    </div>
                    <div>
                      <dt className={`text-xs ${MUTED}`}>Free allowance</dt>
                      <dd className="font-mono tabular-nums">{usage.freeAllowance.toLocaleString("en-US")}</dd>
                    </div>
                  </dl>
                  <p className={`mt-2 text-xs ${MUTED}`}>
                    Over allowance: <span className="font-mono tabular-nums">{usage.overagePids.toLocaleString("en-US")}</span>
                  </p>
                </Card>
              )}
            </div>
          )}

          {section === "users" && users}

          {section === "xp" && xp}

          {(section === "general" || section === "keys" || section === "fees") && (
            <div>
              {section === "general" && (
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="break-words text-xl font-semibold tracking-tight">
                      {app.name}
                      {!app.isActive && <span className={`ml-2 align-middle text-sm font-normal ${MUTED}`}>(disabled)</span>}
                    </h1>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="inline-flex max-w-full items-center gap-2 rounded-md border border-line bg-muted/40 px-2.5 py-1">
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                          Client ID
                        </span>
                        <code className="min-w-0 truncate font-mono text-xs">{app.clientId}</code>
                        <CopyButton text={app.clientId} />
                      </span>
                      {app.isVerified && (
                        <Badge tone="success">
                          <span aria-hidden="true">✓</span> Verified partner — 0% PeridotID fee
                        </Badge>
                      )}
                    </div>
                  </div>
                  <MiniButton onClick={() => void save({ isActive: !app.isActive })} disabled={busy}>
                    {app.isActive ? "Disable app" : "Enable app"}
                  </MiniButton>
                </div>
              )}

              {section === "keys" && (
                <Segmented aria-label="App keys">
                  {KEY_TABS.map((t) => (
                    <SegmentedItem key={t.key} active={keysTab === t.key} onClick={() => setKeysTab(t.key)}>
                      {t.label}
                    </SegmentedItem>
                  ))}
                </Segmented>
              )}

              <div className="grid gap-3">
                {section === "keys" && keysTab === "keys" && (
                  <>
                    <Card>
                      <p className={SECTION_LABEL}>App ID (client_id)</p>
                      <p className={`mt-1 text-xs ${MUTED}`}>
                        Public identifier sent in login and token requests. Safe to ship in your frontend.
                      </p>
                      <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/40 px-3 py-1.5">
                        <code className="min-w-0 flex-1 break-all font-mono text-xs">{app.clientId}</code>
                        <CopyButton text={app.clientId} />
                      </div>
                    </Card>

                    <Card>
                      <p className={SECTION_LABEL}>App secret</p>
                      <p className={`mt-1 text-xs ${MUTED}`}>
                        Server-side only. Required for confidential clients at code exchange and token requests.
                      </p>
                      {revealed ? (
                        <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                          <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <code className="break-all rounded-sm bg-black/40 px-2 py-1 font-mono text-xs">{revealed}</code>
                            <CopyButton text={revealed} />
                            <MiniButton onClick={() => setRevealed(null)}>Dismiss</MiniButton>
                          </div>
                        </div>
                      ) : (
                        <div className={`mt-2 flex items-center gap-2 text-xs ${MUTED}`}>
                          {app.clientSecretPrefix ? (
                            <span>
                              <code className="font-mono">{app.clientSecretPrefix}…</code>
                              {app.clientSecretCreatedAt && <> · set {new Date(app.clientSecretCreatedAt).toLocaleDateString()}</>}
                            </span>
                          ) : (
                            <span>No secret — backend token works with client_id alone.</span>
                          )}
                          <MiniButton onClick={() => void rotateSecret()} disabled={busy}>
                            {app.clientSecretPrefix ? "Rotate" : "Generate"}
                          </MiniButton>
                        </div>
                      )}
                    </Card>
                  </>
                )}

                {section === "general" && (
                  <Card>
                    <p className={SECTION_LABEL}>App name</p>
                    <p className={`mt-1 text-xs ${MUTED}`}>Shown on the sign-in card and in this dashboard.</p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={60}
                        aria-label="App name"
                        className={`${FIELD} mt-0 flex-1`}
                      />
                      <MiniButton
                        variant="solid"
                        disabled={busy || !name.trim() || name.trim() === app.name}
                        onClick={() => void save({ name: name.trim() })}
                      >
                        Save name
                      </MiniButton>
                    </div>
                  </Card>
                )}

                {section === "general" && (
                  <Card>
                    <p className={SECTION_LABEL}>App logo</p>
                    <p className={`mt-1 text-xs ${MUTED}`}>
                      Shows on the PeridotID sign-in card. Square PNG, JPEG or WebP, 512KB max.
                    </p>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label="Upload app logo"
                      aria-busy={uploading}
                      onClick={() => fileRef.current?.click()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          fileRef.current?.click();
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragging(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) void uploadLogo(file);
                      }}
                      className={`mt-3 flex cursor-pointer items-center gap-4 rounded-lg border border-dashed p-4 transition-colors focus-ring ${dragging ? "border-primary bg-muted/40" : "border-line hover:bg-muted/40"}`}
                    >
                      {logoUrl.trim() ? (
                        <img
                          src={logoUrl.trim()}
                          alt=""
                          className="h-14 w-14 shrink-0 rounded-md border border-line bg-muted/40 object-contain"
                        />
                      ) : (
                        <div
                          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-line bg-muted/40 text-xs text-muted-foreground"
                          aria-hidden="true"
                        >
                          logo
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{uploading ? "Uploading…" : "Click or drop an image"}</p>
                        <p className={`mt-0.5 text-xs ${MUTED}`}>PNG, JPEG or WebP · 512KB max · square looks best</p>
                      </div>
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void uploadLogo(file);
                      }}
                    />
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Or paste an image URL
                      </summary>
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <input
                          value={logoUrl}
                          onChange={(e) => setLogoUrl(e.target.value)}
                          maxLength={2048}
                          placeholder="https://cdn.mygame.dev/logo.png"
                          aria-label="App logo URL"
                          className={`${FIELD} mt-0 flex-1`}
                        />
                        <MiniButton
                          variant="solid"
                          disabled={busy || !logoUrl.trim()}
                          onClick={() => void save({ logoUrl: logoUrl.trim() })}
                        >
                          Save URL
                        </MiniButton>
                      </div>
                    </details>
                    {app.logoUrl && (
                      <div className="mt-2">
                        <MiniButton
                          disabled={busy}
                          onClick={() => {
                            setLogoUrl("");
                            void save({ logoUrl: "" });
                          }}
                        >
                          Remove logo
                        </MiniButton>
                      </div>
                    )}
                  </Card>
                )}

                {section === "general" && (
                  <Card>
                    <p className={SECTION_LABEL}>App description</p>
                    <p className={`mt-1 text-xs ${MUTED}`}>
                      One line under your app name on the sign-in card. Keep it under ~120 characters — the wallet
                      clamps it to two lines.
                    </p>
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={160}
                      placeholder="Your game, your items, your coins."
                      aria-label="App description"
                      className={`${FIELD} mt-3`}
                    />
                    <div className="mt-2 flex gap-2">
                      <MiniButton
                        variant="solid"
                        disabled={busy}
                        onClick={() => void save({ description: description.trim() })}
                      >
                        Save description
                      </MiniButton>
                      {app.description && (
                        <MiniButton
                          disabled={busy}
                          onClick={() => {
                            setDescription("");
                            void save({ description: "" });
                          }}
                        >
                          Remove
                        </MiniButton>
                      )}
                    </div>
                  </Card>
                )}

                {section === "keys" && keysTab === "domains" && (
                  <>
                    <Card>
                      <p className={SECTION_LABEL}>Allowed origins</p>
                      <p className={`mt-1 text-xs ${MUTED}`}>
                        Login redirects and API calls are accepted from these websites. Bare http(s) origin only —
                        scheme + host + optional port, no path. e.g. https://mygame.dev
                      </p>
                      {app.allowedOrigins.length > 0 ? (
                        <ul className="mt-2 flex flex-col gap-1.5">
                          {app.allowedOrigins.map((o) => (
                            <li key={o} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5">
                              <code className="min-w-0 break-all font-mono text-xs">{o}</code>
                              <MiniButton
                                onClick={() => void save({ allowedOrigins: app.allowedOrigins.filter((x) => x !== o) })}
                                disabled={busy}
                              >
                                Delete
                              </MiniButton>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={`mt-2 text-xs ${WARN}`}>No origins yet — logins for this app will be rejected until you add one.</p>
                      )}
                      <div className="mt-2 flex gap-2">
                        <input
                          value={newOrigin}
                          onChange={(e) => {
                            setNewOrigin(e.target.value);
                            if (originError) setOriginError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addOrigin();
                          }}
                          placeholder="https://mygame.dev"
                          inputMode="url"
                          className={`${FIELD} font-mono text-xs`}
                        />
                        <MiniButton variant="solid" size="sm" onClick={addOrigin} disabled={busy || !newOrigin.trim()} className="self-end">
                          Add
                        </MiniButton>
                      </div>
                      {originError && <p role="alert" className={`mt-2 text-xs ${ERROR}`}>{originError}</p>}
                    </Card>

                    <Card>
                      <p className={SECTION_LABEL}>Webhook endpoint</p>
                      <p className={`mt-1 text-xs ${MUTED}`}>
                        PeridotID POSTs signed ledger events here (e.g. <code className="font-mono">fiat.transfer.posted</code> when
                        funds land on this app&apos;s escrow account). Every callback carries{" "}
                        <code className="font-mono">X-Pid-Signature: sha256=&lt;hex&gt;</code> over the raw body.
                      </p>
                      {revealedWebhook ? (
                        <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                          <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
                          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                            <code className="min-w-0 flex-1 break-all rounded-sm bg-black/40 px-2 py-1 font-mono text-xs">
                              {revealedWebhook}
                            </code>
                            <div className="flex shrink-0 gap-2">
                              <CopyButton text={revealedWebhook} />
                              <MiniButton onClick={() => setRevealedWebhook(null)}>Dismiss</MiniButton>
                            </div>
                          </div>
                        </div>
                      ) : app.webhookUrl ? (
                        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5">
                          <code className="min-w-0 flex-1 break-all font-mono text-xs">{app.webhookUrl}</code>
                          <MiniButton onClick={() => void clearWebhook()} disabled={busy}>
                            Remove
                          </MiniButton>
                        </div>
                      ) : (
                        <p className={`mt-2 text-xs ${MUTED}`}>No webhook — ledger events will not be pushed to this app.</p>
                      )}
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <label htmlFor="webhook-url" className="sr-only">
                          Webhook endpoint URL
                        </label>
                        <input
                          id="webhook-url"
                          value={newWebhookUrl}
                          onChange={(e) => setNewWebhookUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveWebhook();
                          }}
                          placeholder="https://mygame.dev/peridot/webhook"
                          inputMode="url"
                          className={`${FIELD} font-mono text-xs`}
                        />
                        <MiniButton
                          variant="solid"
                          size="sm"
                          onClick={() => void saveWebhook()}
                          disabled={busy || !newWebhookUrl.trim()}
                          className="self-start sm:self-end"
                        >
                          {app.webhookUrl ? "Replace" : "Set endpoint"}
                        </MiniButton>
                      </div>
                      <p className={`mt-1 text-xs ${MUTED}`}>https required (http allowed only for localhost). Setting a new URL rotates the signing secret.</p>
                    </Card>

                    <WebhookDeliveries key={appId} client={client} appId={appId} />
                  </>
                )}

                {section === "fees" && (
                  <Card>
                    <p className={SECTION_LABEL}>App fees</p>
                    <p className={`mt-1 text-xs ${MUTED}`}>
                      Stacked on top of the global PeridotID fee (0.1%, min Rp100, no cap) and credited to this app&apos;s account.
                      Enabled operations apply when the movement is initiated through this app.
                    </p>
                    <div className="mt-3 grid gap-2">
                      {OPS.map((op) => {
                        const f: AppFee = fees[op.key] ?? {
                          operation: op.key,
                          percentBps: 0,
                          minIdr: "0",
                          maxIdr: "0",
                          enabled: false,
                        };
                        return (
                          <div key={op.key} className={`pt-3 first:pt-0 first:border-0 ${DIVIDER}`}>
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold">{op.label}</p>
                                <p className={`text-xs ${MUTED}`}>{f.enabled ? op.hint : "Off"}</p>
                              </div>
                              <label className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={f.enabled}
                                  onChange={(e) => patchFee(op.key, { enabled: e.target.checked })}
                                />
                                Enabled
                              </label>
                            </div>
                            {f.enabled && (
                              <>
                                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
                                  <label className="text-xs">
                                    Percent (%)
                                    <input
                                      value={f.percentBps ? f.percentBps / 100 : ""}
                                      onChange={(e) => patchFee(op.key, { percentBps: Math.round((Number(e.target.value) || 0) * 100) })}
                                      inputMode="decimal"
                                      placeholder="0"
                                      className={`${FIELD} font-mono text-xs`}
                                    />
                                  </label>
                                  <label className="text-xs">
                                    Min (IDR)
                                    <input
                                      value={f.minIdr}
                                      onChange={(e) => patchFee(op.key, { minIdr: e.target.value.replace(/\D/g, "") })}
                                      inputMode="numeric"
                                      placeholder="0"
                                      className={`${FIELD} font-mono text-xs`}
                                    />
                                  </label>
                                  <label className="text-xs">
                                    Max (IDR, 0 = no cap)
                                    <input
                                      value={f.maxIdr}
                                      onChange={(e) => patchFee(op.key, { maxIdr: e.target.value.replace(/\D/g, "") })}
                                      inputMode="numeric"
                                      placeholder="0"
                                      className={`${FIELD} font-mono text-xs`}
                                    />
                                  </label>
                                  <div className="flex items-end">
                                    <MiniButton variant="solid" size="sm" onClick={() => void saveFee(op.key)} disabled={busy} className="w-full">
                                      Save
                                    </MiniButton>
                                  </div>
                                </div>
                                <p className={`mt-1 text-xs ${MUTED}`}>
                                  {f.percentBps / 100}% · {Number(f.minIdr) > 0 ? `min ${fmtIdr(f.minIdr)}` : "no minimum"} ·{" "}
                                  {Number(f.maxIdr) > 0 ? `max ${fmtIdr(f.maxIdr)}` : "no cap"}
                                </p>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          )}

          {section === "integrations" && (
            <div className="grid gap-3">
              <Card>
                <p className={SECTION_LABEL}>Login methods</p>
                <p className={`mt-1 text-xs ${MUTED}`}>
                  Choose how users can sign in to this app. Provider names and icons come from the
                  platform catalogue. Turning a method off blocks new logins through it; existing
                  sessions and first-party wallet access are unaffected. Passkey and email are Web2
                  methods, not OAuth.
                </p>
              </Card>

              {catalogLoading && (
                <Card>
                  <p role="status" className="text-sm">Loading providers…</p>
                </Card>
              )}
              {catalogError && (
                <Card>
                  <p role="alert" className={`text-sm ${ERROR}`}>{catalogError}</p>
                  <MiniButton className="mt-2" onClick={() => void loadCatalog()} disabled={catalogLoading}>
                    Retry
                  </MiniButton>
                </Card>
              )}
              {catalog && catalog.length === 0 && (
                <Card>
                  <p className={`text-sm ${MUTED}`}>No providers are registered yet.</p>
                </Card>
              )}
              {(["web2", "web3"] as const).map((group) => {
                const rows = (catalog ?? []).filter((p) => p.category === group);
                if (rows.length === 0) return null;
                return (
                  <Card key={group}>
                    <p className={SECTION_LABEL}>{PROVIDER_GROUP_LABEL[group]}</p>
                    <ul className="mt-4 flex flex-col gap-3">
                      {rows.map((provider) => {
                        const usable = provider.isAvailable && provider.isSupported;
                        const on = usable && enabledMethods.includes(provider.code);
                        return (
                          <li key={provider.code} className="flex items-start justify-between gap-4">
                            <div className="flex min-w-0 items-start gap-3">
                              <ProviderIcon provider={provider} />
                              <div className="min-w-0">
                                <p className="text-sm font-semibold">{provider.name}</p>
                                <p className={`mt-0.5 text-xs ${MUTED}`}>
                                  {PROTOCOL_LABEL[provider.protocol]}
                                  {provider.adapter ? ` · ${provider.adapter}` : ""}
                                </p>
                                {!provider.isSupported && (
                                  <p className={`mt-0.5 text-xs ${WARN}`}>Adapter not implemented — cannot be enabled yet.</p>
                                )}
                                {provider.isSupported && !provider.isAvailable && (
                                  <p className={`mt-0.5 text-xs ${WARN}`}>Not available platform-wide.</p>
                                )}
                              </div>
                            </div>
                            <Switch
                              checked={on}
                              disabled={busy || !usable}
                              aria-label={`${provider.name} login`}
                              onCheckedChange={(next) => toggleMethod(provider.code, next)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                );
              })}
            </div>
          )}
      </div>
    </>
  );
}
