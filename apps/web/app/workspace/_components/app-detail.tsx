"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import type { AppFee, PidApp } from "./app-types";
import { Card, DIVIDER, ERROR, FIELD, MUTED, SECTION_LABEL, WARN, MiniButton } from "./ui";

const OPS: { key: string; label: string; hint: string }[] = [
  { key: "topup", label: "Top-up", hint: "Charged when a user funds through this app." },
  { key: "transaction", label: "Transaction", hint: "Charged on sends initiated through this app." },
  { key: "withdraw", label: "Withdraw (bank)", hint: "Charged on bank payouts initiated through this app." },
];

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard unavailable — ignore
  }
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <MiniButton
      onClick={() => {
        void copy(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="font-mono"
    >
      {done ? "Copied" : "Copy"}
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
  const [revealed, setRevealed] = useState<string | null>(null);

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
    const origin = newOrigin.trim();
    if (!origin || !app) return;
    const normalized = origin.replace(/\/+$/, "");
    if (app.allowedOrigins.includes(normalized)) {
      setNewOrigin("");
      return;
    }
    void save({ allowedOrigins: [...app.allowedOrigins, origin] }, () => setNewOrigin(""));
  };

  const rotateSecret = async () => {
    if (!window.confirm("Generate a new backend secret? The current one stops working immediately.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = unwrap(await client.post<{ secret: string; prefix: string }>(`/v1/apps/${appId}/secret`, {}), "Secret rotation");
      setRevealed(res.secret);
      await load();
    } catch {
      setError("Secret rotation failed.");
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

  if (loading) {
    return (
      <section className="mt-8">
        <p className={`text-sm ${MUTED}`}>Loading…</p>
      </section>
    );
  }

  if (notFound || !app) {
    return (
      <section className="mt-8">
        <Link href="/workspace" className={`text-sm ${MUTED} hover:underline`}>
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
      <Link href="/workspace" className={`text-sm ${MUTED} hover:underline`}>
        ← All apps
      </Link>

      <div className="mt-3 flex items-center justify-between gap-3">
        {editingName ? (
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={`${FIELD} text-xl font-semibold`} />
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">
            {app.name} {!app.isActive && <span className={`text-sm font-normal ${MUTED}`}>(disabled)</span>}
          </h1>
        )}
        <div className="flex shrink-0 gap-2">
          <MiniButton
            onClick={() => (editingName ? void save({ name: name.trim() }, () => setEditingName(false)) : setEditingName(true))}
            disabled={busy}
            className="font-semibold"
          >
            {editingName ? "Save" : "Rename"}
          </MiniButton>
          <MiniButton onClick={() => void save({ isActive: !app.isActive })} disabled={busy}>
            {app.isActive ? "Disable" : "Enable"}
          </MiniButton>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className={MUTED}>client_id</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{app.clientId}</code>
        <CopyButton text={app.clientId} />
      </div>

      {error && <p className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
      {msg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}

      <div className="mt-6 grid gap-4">
        <Card>
          <p className={SECTION_LABEL}>Escrow balance</p>
          <p className="mt-2 text-2xl font-semibold">{balance === null ? "—" : fmtIdr(balance)}</p>
          <p className={`mt-1 text-xs ${MUTED}`}>The app account&apos;s spendable fiat-ledger balance.</p>
        </Card>

        <Card>
          <p className={SECTION_LABEL}>Allowed origins</p>
          <p className={`mt-1 text-xs ${MUTED}`}>
            Login redirects and API calls are accepted from these websites.
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
              onChange={(e) => setNewOrigin(e.target.value)}
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
        </Card>

        <Card>
          <p className={SECTION_LABEL}>Backend secret</p>
          {revealed ? (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-black/50">{revealed}</code>
                <CopyButton text={revealed} />
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
          <p className={SECTION_LABEL}>App fees</p>
          <p className={`mt-1 text-xs ${MUTED}`}>
            Stacked on top of the global PeridotID fee (0.1%, min Rp100, no cap) and credited to this app&apos;s account.
            Enabled operations apply when the movement is initiated through this app.
          </p>
          <div className="mt-3 grid gap-2">
            {OPS.map((op) => {
              const f = fees[op.key];
              if (!f) return null;
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
