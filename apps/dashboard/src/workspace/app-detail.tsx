"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { normalizeOriginInput } from "./origins";
import type { AppFee, PidApp } from "./app-types";
import { Card, DIVIDER, ERROR, FIELD, MUTED, SECTION_LABEL, WARN, MiniButton } from "./ui";

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
  return (
    <MiniButton
      onClick={() => {
        void copy(text).then((ok) => {
          // ANT-333: only claim success when the clipboard write succeeded.
          setState(ok ? "done" : "failed");
          setTimeout(() => setState("idle"), 1500);
        });
      }}
      title={state === "failed" ? "Copy failed — your browser blocked clipboard access" : undefined}
      className="font-mono"
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </MiniButton>
  );
}

/** App settings. Every API call is owner-scoped server-side, so a non-owner
 *  gets 404 and never sees another developer's app. */
export function AppDetail({ client, appId }: { client: PeridotClient; appId: string }) {
  const [app, setApp] = useState<PidApp | null>(null);
  const [fees, setFees] = useState<Record<string, AppFee>>({});
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [revealedWebhook, setRevealedWebhook] = useState<string | null>(null);
  // Sandbox faucet state — env comes from GET /v1/env only (never a client var).
  const [envInfo, setEnvInfo] = useState<EnvInfo | null>(null);
  const [faucetAmount, setFaucetAmount] = useState("50000");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [dailyRemaining, setDailyRemaining] = useState<number | null>(null);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const a = unwrap(await client.get<PidApp>(`/v1/apps/${appId}`), "Loading app");
      setApp(a);
      setName(a.name);
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

  const save = async (patch: { name?: string; allowedOrigins?: string[]; isActive?: boolean }, done?: () => void) => {
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
      <section className="mt-8">
        <p role="status" className={`text-sm ${MUTED}`}>Loading…</p>
      </section>
    );
  }

  if (notFound || !app) {
    return (
      <section className="mt-8">
        <Link to="/" className={`text-sm ${MUTED} hover:underline`}>
          ← All apps
        </Link>
        <Card className="mt-4">
          <p className="font-semibold">App not found</p>
          <p className={`mt-1 text-sm ${MUTED}`}>This app does not exist or you do not have access to it.</p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <Link to="/" className={`text-sm ${MUTED} hover:underline`}>
        ← All apps
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {editingName ? (
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={`${FIELD} text-xl font-semibold`} />
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">
            {app.name} {!app.isActive && <span className={`text-sm font-normal ${MUTED}`}>(disabled)</span>}{" "}
            {app.isVerified && (
              <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-semibold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                <span aria-hidden="true">✓</span> Verified partner — 0% PeridotID fee
              </span>
            )}
          </h1>
        )}
        <div className="flex shrink-0 gap-2">
          {editingName ? (
            <>
              <MiniButton
                onClick={() => {
                  if (!name.trim()) {
                    setError("Give the app a name first.");
                    return;
                  }
                  void save({ name: name.trim() }, () => setEditingName(false));
                }}
                disabled={busy || !name.trim()}
                className="font-semibold"
              >
                Save
              </MiniButton>
              <MiniButton
                onClick={() => {
                  setName(app.name);
                  setEditingName(false);
                }}
                disabled={busy}
              >
                Cancel
              </MiniButton>
            </>
          ) : (
            <MiniButton onClick={() => setEditingName(true)} disabled={busy} className="font-semibold">
              Rename
            </MiniButton>
          )}
          <MiniButton onClick={() => void save({ isActive: !app.isActive })} disabled={busy}>
            {app.isActive ? "Disable" : "Enable"}
          </MiniButton>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className={MUTED}>client_id</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{app.clientId}</code>
        <CopyButton text={app.clientId} />
      </div>

      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={() => void load()}>
            Retry
          </MiniButton>
        </div>
      )}
      {msg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}

      <div className="mt-6 grid gap-4">
        <Card>
          <p className={SECTION_LABEL}>Your fiat balance</p>
          <p className="mt-2 text-2xl font-semibold">{balance === null ? "—" : fmtIdr(balance)}</p>
          <p className={`mt-1 text-xs ${MUTED}`}>
            Your own spendable fiat-ledger balance — user-scoped, so the same value shows on every app
            page. Not per-app escrow.
          </p>
        </Card>

        {isSandboxEnv && (
          <Card>
            <p className={SECTION_LABEL}>Sandbox faucet — test credit</p>
            <p className={`mt-1 text-xs ${MUTED}`}>
              Instant test money for this sandbox workspace. No DOKU checkout, no real funds.
              {dailyRemaining !== null
                ? ` ${fmtIdr(String(dailyRemaining))} remaining today.`
                : " Daily cap Rp100.000 per identity."}
            </p>
            {faucetError && <p className={`mt-2 text-xs ${ERROR}`}>{faucetError}</p>}
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

        <Card>
          <p className={SECTION_LABEL}>Allowed origins</p>
          <p className={`mt-1 text-xs ${MUTED}`}>
            Login redirects and API calls are accepted from these websites. Bare http(s) origin only —
            scheme + host + optional port, no path. e.g. https://mygame.dev
          </p>
          {app.allowedOrigins.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {app.allowedOrigins.map((o) => (
                <li key={o} className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5">
                  <code className="break-all font-mono text-xs">{o}</code>
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
          {originError && <p className={`mt-2 text-xs ${ERROR}`}>{originError}</p>}
        </Card>

        <Card>
          <p className={SECTION_LABEL}>Backend secret</p>
          {revealed ? (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-black/50">{revealed}</code>
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
              <MiniButton onClick={() => void rotateSecret()} disabled={busy} className="font-semibold">
                {app.clientSecretPrefix ? "Rotate" : "Generate"}
              </MiniButton>
            </div>
          )}
        </Card>

        <Card>
          <p className={SECTION_LABEL}>Webhook endpoint</p>
          <p className={`mt-1 text-xs ${MUTED}`}>
            PeridotID POSTs signed ledger events here (e.g. <code className="font-mono">fiat.transfer.posted</code> when
            funds land on this app&apos;s escrow account). Every callback carries{" "}
            <code className="font-mono">X-Pid-Signature: sha256=&lt;hex&gt;</code> over the raw body.
          </p>
          {revealedWebhook ? (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-black/50">
                  {revealedWebhook}
                </code>
                <div className="flex shrink-0 gap-2">
                  <CopyButton text={revealedWebhook} />
                  <MiniButton onClick={() => setRevealedWebhook(null)}>Dismiss</MiniButton>
                </div>
              </div>
            </div>
          ) : app.webhookUrl ? (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5">
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
      </div>
    </section>
  );
}
