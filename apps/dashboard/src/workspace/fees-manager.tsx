"use client";

import { useCallback, useEffect, useState } from "react";
import type { FeePolicyView, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import type { PaymentFeeRate } from "./app-types";
import { Card, DIVIDER, ERROR, FIELD, MUTED, SECTION_LABEL, MiniButton } from "./ui";
import { PageHeader } from "./page-header";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

interface RateDraft {
  percent: string;
  flatIdr: string;
  minIdr: string;
  maxIdr: string;
  enabled: boolean;
}

function toDraft(r: PaymentFeeRate): RateDraft {
  return {
    percent: r.percentBps ? String(r.percentBps / 100) : "",
    flatIdr: r.flatIdr,
    minIdr: r.minIdr,
    maxIdr: r.maxIdr,
    enabled: r.enabled,
  };
}

const pctOnly = (v: string) => v.replace(/[^\d.]/g, "");
const digitsOnly = (v: string) => v.replace(/\D/g, "");
const toBps = (percent: string) => Math.round((Number(percent) || 0) * 100);

type Tab = "peridot" | "doku";

/**
 * Admin fees console. Two tabs:
 *  - PeridotID: platform fee (append-only versioned) + its PPN.
 *  - DOKU: which payment methods are offered, each method's gateway fee, and the
 *    DOKU-wide PPN.
 * Admin-only; the API enforces the same on every write.
 */
export function FeesManager({ client }: { client: PeridotClient }) {
  const [tab, setTab] = useState<Tab>("peridot");
  const [policy, setPolicy] = useState<FeePolicyView | null>(null);
  const [policyDraft, setPolicyDraft] = useState({ percent: "", minIdr: "", maxIdr: "", taxPercent: "0" });
  const [rates, setRates] = useState<PaymentFeeRate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RateDraft>>({});
  const [dokuTaxPercent, setDokuTaxPercent] = useState("0");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = unwrap(await client.get<FeePolicyView>("/v1/fiat/fee-policy"), "Loading fee policy");
      setPolicy(p);
      setPolicyDraft({
        percent: p.percentBps ? String(p.percentBps / 100) : "",
        minIdr: p.minIdr,
        maxIdr: p.maxIdr,
        taxPercent: p.taxBps ? String(p.taxBps / 100) : "0",
      });
      const r = unwrap(await client.get<PaymentFeeRate[]>("/v1/fiat/admin/payment-fee-rates"), "Loading gateway fees");
      setRates(r);
      setDrafts(Object.fromEntries(r.map((x) => [x.methodKey, toDraft(x)])));
      const t = unwrap(await client.get<{ taxBps: number }>("/v1/fiat/admin/doku-tax"), "Loading DOKU tax");
      setDokuTaxPercent(t.taxBps ? String(t.taxBps / 100) : "0");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load fees");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePolicy = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = unwrap(
        await client.post<FeePolicyView>("/v1/fiat/admin/fee-policy", {
          percentBps: toBps(policyDraft.percent),
          minIdr: policyDraft.minIdr || "0",
          maxIdr: policyDraft.maxIdr || "0",
          taxBps: toBps(policyDraft.taxPercent),
        }),
        "Save policy",
      );
      setPolicy(saved);
      setPolicyDraft({
        percent: saved.percentBps ? String(saved.percentBps / 100) : "",
        minIdr: saved.minIdr,
        maxIdr: saved.maxIdr,
        taxPercent: saved.taxBps ? String(saved.taxBps / 100) : "0",
      });
      flash(`Published PeridotID fee policy v${saved.version}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveDokuTax = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = unwrap(
        await client.put<{ taxBps: number }>("/v1/fiat/admin/doku-tax", { taxBps: toBps(dokuTaxPercent) }),
        "Save DOKU tax",
      );
      setDokuTaxPercent(saved.taxBps ? String(saved.taxBps / 100) : "0");
      flash("DOKU PPN saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveRate = async (methodKey: string, draft: RateDraft) => {
    setBusy(true);
    setError(null);
    try {
      // "*" must not be sent raw in the path (routers read it as a wildcard).
      const enc = methodKey === "*" ? "%2A" : encodeURIComponent(methodKey);
      const saved = unwrap(
        await client.put<PaymentFeeRate>(`/v1/fiat/admin/payment-fee-rates/${enc}`, {
          percentBps: toBps(draft.percent),
          flatIdr: draft.flatIdr || "0",
          minIdr: draft.minIdr || "0",
          maxIdr: draft.maxIdr || "0",
          enabled: !!draft.enabled,
        }),
        "Save rate",
      );
      // Preserve display fields (label/category) — the PUT response only has numbers.
      setRates((prev) => prev.map((r) => (r.methodKey === saved.methodKey ? { ...r, ...saved } : r)));
      setDrafts((prev) => ({ ...prev, [saved.methodKey]: toDraft(saved) }));
      flash(`${saved.methodKey} saved.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const patchDraft = (methodKey: string, patch: Partial<RateDraft>) =>
    setDrafts((prev) => ({ ...prev, [methodKey]: { ...prev[methodKey], ...patch } }));

  if (loading) {
    return (
      <section className="mt-8">
        <p className={`text-sm ${MUTED}`}>Loading…</p>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <PageHeader
        eyebrow="Treasury"
        title="Fees"
        description="The PeridotID platform fee and the DOKU payment-gateway fees and PPN charged on top-ups."
      />
      {error && <p className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
      {msg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}

      <div className="mt-6 flex w-fit gap-1 rounded-md border border-border bg-muted p-1" role="tablist" aria-label="Fee settings">
        {(["peridot", "doku"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`rounded-[3px] px-3 py-1 text-sm font-medium transition-colors focus-ring ${
              tab === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {k === "peridot" ? "PeridotID" : "DOKU"}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4">
        {tab === "peridot" ? (
          <Card>
            <div className="flex items-center justify-between gap-3">
              <p className={SECTION_LABEL}>PeridotID platform fee</p>
              {policy && <span className={`text-xs ${MUTED}`}>active v{policy.version}</span>}
            </div>
            <p className={`mt-1 text-xs ${MUTED}`}>
              Applied to every fiat movement for Public Apps. Verified Apps pay 0%. PPN is added on top of the
              fee. Saving publishes a new version — past movements keep their snapshotted fee.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
              <label className="text-xs">
                Percent (%)
                <input
                  value={policyDraft.percent}
                  onChange={(e) => setPolicyDraft((d) => ({ ...d, percent: pctOnly(e.target.value) }))}
                  inputMode="decimal"
                  placeholder="0.1"
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <label className="text-xs">
                Min (IDR)
                <input
                  value={policyDraft.minIdr}
                  onChange={(e) => setPolicyDraft((d) => ({ ...d, minIdr: digitsOnly(e.target.value) }))}
                  inputMode="numeric"
                  placeholder="100"
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <label className="text-xs">
                Max (IDR, 0 = no cap)
                <input
                  value={policyDraft.maxIdr}
                  onChange={(e) => setPolicyDraft((d) => ({ ...d, maxIdr: digitsOnly(e.target.value) }))}
                  inputMode="numeric"
                  placeholder="0"
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <label className="text-xs">
                PPN (%)
                <input
                  value={policyDraft.taxPercent}
                  onChange={(e) => setPolicyDraft((d) => ({ ...d, taxPercent: pctOnly(e.target.value) }))}
                  inputMode="decimal"
                  placeholder="11"
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <div className="flex items-end">
                <MiniButton variant="solid" size="sm" onClick={() => void savePolicy()} disabled={busy} className="w-full">
                  Publish
                </MiniButton>
              </div>
            </div>
            {policy && (
              <p className={`mt-2 text-xs ${MUTED}`}>
                {policy.percentBps / 100}% · {Number(policy.minIdr) > 0 ? `min ${fmtIdr(policy.minIdr)}` : "no minimum"} ·{" "}
                {Number(policy.maxIdr) > 0 ? `max ${fmtIdr(policy.maxIdr)}` : "no cap"} · PPN {policy.taxBps / 100}%
              </p>
            )}
          </Card>
        ) : (
          <Card>
            <p className={SECTION_LABEL}>DOKU payment methods</p>
            <p className={`mt-1 text-xs ${MUTED}`}>
              Tick the methods users can top up with. Checked = shown in the wallet and the gateway fee + PPN are
              charged; unchecked = hidden and not charged. DOKU PPN applies on top of every method's fee and is
              shown to users as part of “Fee Transfer”.
            </p>

            <div className="mt-3 flex items-end gap-2">
              <label className="w-40 text-xs">
                DOKU PPN (%)
                <input
                  value={dokuTaxPercent}
                  onChange={(e) => setDokuTaxPercent(pctOnly(e.target.value))}
                  inputMode="decimal"
                  placeholder="11"
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <MiniButton variant="solid" size="sm" onClick={() => void saveDokuTax()} disabled={busy} className="mb-0.5">
                Save PPN
              </MiniButton>
            </div>

            <div className="mt-4 grid gap-3">
              {rates.map((r) => {
                const d = drafts[r.methodKey] ?? toDraft(r);
                return (
                  <div key={r.methodKey} className={`pt-3 first:pt-0 first:border-0 ${DIVIDER}`}>
                    <label className="flex items-center gap-2 text-sm font-semibold">
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={(e) => void saveRate(r.methodKey, { ...d, enabled: e.target.checked })}
                        disabled={busy}
                      />
                      {r.label}
                      <code className={`font-mono text-xs font-normal ${MUTED}`}>{r.methodKey}</code>
                    </label>
                    {d.enabled ? (
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <label className="text-xs">
                          Percent (%)
                          <input value={d.percent} onChange={(e) => patchDraft(r.methodKey, { percent: pctOnly(e.target.value) })} inputMode="decimal" placeholder="0" className={`${FIELD} font-mono text-xs`} />
                        </label>
                        <label className="text-xs">
                          Flat (IDR)
                          <input value={d.flatIdr} onChange={(e) => patchDraft(r.methodKey, { flatIdr: digitsOnly(e.target.value) })} inputMode="numeric" placeholder="0" className={`${FIELD} font-mono text-xs`} />
                        </label>
                        <label className="text-xs">
                          Min (IDR)
                          <input value={d.minIdr} onChange={(e) => patchDraft(r.methodKey, { minIdr: digitsOnly(e.target.value) })} inputMode="numeric" placeholder="0" className={`${FIELD} font-mono text-xs`} />
                        </label>
                        <label className="text-xs">
                          Max (IDR, 0 = no cap)
                          <input value={d.maxIdr} onChange={(e) => patchDraft(r.methodKey, { maxIdr: digitsOnly(e.target.value) })} inputMode="numeric" placeholder="0" className={`${FIELD} font-mono text-xs`} />
                        </label>
                        <div className="flex items-end">
                          <MiniButton variant="solid" size="sm" onClick={() => void saveRate(r.methodKey, d)} disabled={busy} className="w-full">
                            Save
                          </MiniButton>
                        </div>
                      </div>
                    ) : (
                      <p className={`mt-1 text-xs ${MUTED}`}>Hidden — users cannot top up with this method.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </section>
  );
}
