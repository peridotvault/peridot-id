"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChainFeePolicy, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, DIVIDER, ERROR, FIELD, MUTED, SECTION_LABEL, WARN, MiniButton } from "./ui";

/** Daily quote-vs-actual aggregate for the subsidy dashboard (admin, NFR-4). */
export interface SubsidyDailySummary {
  day: string;
  count: number;
  quotedTotal: string;
  actualTotal: string;
  subsidyTotal: string;
}

interface MinimaDraft {
  namespace: "solana" | "eip155";
  reference: string;
  minFee: string;
}

const digitsOnly = (v: string) => v.replace(/\D/g, "");
const pctOnly = (v: string) => v.replace(/[^\d.]/g, "");
const toBps = (percent: string) => Math.round((Number(percent) || 0) * 100);

function fmtBps(bps: number): string {
  return `${bps / 100}%`;
}

function fmtDateTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
}

/**
 * Chain fee-policy console (ANT-736, backend ANT-730; ANT-748 pure 50%):
 * the fee-policy admin surface over GET/POST /v1/admin/fee-policies,
 * POST /v1/admin/fee-policies/:version/activate, and
 * GET /v1/admin/subsidy-ledger/summary.
 *
 * Pure-percentage by default (ANT-743): publishing with no chain rows yields
 * a pure bps policy (no minima map). Per-chain floor rows are legacy-only —
 * any row provided must still sit at or above the chain's on-chain settlement
 * floor (ChainMinBelowFloor otherwise); fresh quotes pick up the active
 * version within the 30s policy cache TTL. Admin-only; the API enforces the
 * same on every write.
 */
export function ChainFeesManager({ client }: { client: PeridotClient }) {
  const [versions, setVersions] = useState<ChainFeePolicy[] | null>(null);
  const [summary, setSummary] = useState<SubsidyDailySummary[] | null>(null);
  const [days, setDays] = useState(30);
  const [bps, setBps] = useState("");
  const [fxSource, setFxSource] = useState("");
  const [fxAsOf, setFxAsOf] = useState("");
  const [minima, setMinima] = useState<MinimaDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [v, s] = await Promise.all([
        unwrap(await client.get<ChainFeePolicy[]>("/v1/admin/fee-policies"), "Loading fee policies"),
        unwrap(
          await client.get<SubsidyDailySummary[]>(`/v1/admin/subsidy-ledger/summary?days=${days}`),
          "Loading subsidy summary",
        ),
      ]);
      setVersions(v);
      setSummary(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chain fees");
    } finally {
      setLoading(false);
    }
  }, [client, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const rows = minima
        .map((m) => ({ namespace: m.namespace, reference: m.reference.trim(), minFee: digitsOnly(m.minFee) || "0" }))
        .filter((m) => m.reference !== "");
      const created = unwrap(
        await client.post<ChainFeePolicy>("/v1/admin/fee-policies", {
          bps: toBps(bps),
          minima: rows,
          ...(fxSource.trim() ? { fxSource: fxSource.trim() } : {}),
          ...(fxAsOf.trim() ? { fxAsOf: fxAsOf.trim() } : {}),
        }),
        "Publish policy",
      );
      setVersions((prev) => (prev ? [created, ...prev] : [created]));
      flash(`Published chain fee policy v${created.version} (inactive — activate to quote from it).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed.");
    } finally {
      setBusy(false);
    }
  };

  const activate = async (version: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = unwrap(
        await client.post<{ version: number; previousVersion: number }>(`/v1/admin/fee-policies/${version}/activate`, {}),
        "Activate policy",
      );
      setVersions((prev) => prev?.map((v) => ({ ...v, active: v.version === res.version })) ?? prev);
      flash(`Activated chain fee policy v${res.version} (was v${res.previousVersion}).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activate failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <p role="status" className={`text-sm ${MUTED}`}>Loading chain fee policies…</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={() => void load()}>
            Retry
          </MiniButton>
        </div>
      )}
      {msg && (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {msg}
        </p>
      )}

      <Card>
        <div className="flex items-center justify-between gap-3">
          <p className={SECTION_LABEL}>Chain fee-policy versions</p>
          {versions?.some((v) => v.active) && (
            <span className={`text-xs ${MUTED}`}>
              active v{versions.find((v) => v.active)?.version}
            </span>
          )}
        </div>
        <p className={`mt-1 text-xs ${MUTED}`}>
          Pure percentage leg (no chain rows = pure 50%-style policy) + optional legacy per-chain floor rows (base units, keyed by CAIP-2 pair). Publishing creates an
          inactive version — activate it before wallets quote from it.
        </p>
        {versions == null || versions.length === 0 ? (
          <p className={`mt-3 text-sm ${MUTED}`}>
            No chain fee-policy versions yet — publish the first one below.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {versions.map((v) => (
              <li key={v.version} className={`pt-3 first:pt-0 first:border-0 ${DIVIDER}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">v{v.version}</span>
                  {v.active ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                      active
                    </span>
                  ) : (
                    <MiniButton size="sm" onClick={() => void activate(v.version)} disabled={busy}>
                      Activate
                    </MiniButton>
                  )}
                  <span className={`text-xs ${MUTED}`}>
                    {fmtBps(v.bps)} · {Object.keys(v.minFee ?? {}).length} chain{Object.keys(v.minFee ?? {}).length === 1 ? "" : "s"} · updated {fmtDateTime(v.updatedAt)}
                  </span>
                </div>
                <p className={`mt-1 font-mono text-xs ${MUTED}`}>
                  {Object.entries(v.minFee ?? {}).map(([chain, floor]) => `${chain}=${floor}`).join(" · ") || "pure percentage — no chain minima"}
                </p>
                <p className={`mt-0.5 text-xs ${MUTED}`}>
                  FX: {v.fxSource}{v.fxAsOf ? ` · as of ${fmtDateTime(v.fxAsOf)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Publish new version</p>
        <p className={`mt-1 text-xs ${MUTED}`}>
          Starts inactive. Pure percentage is the default — add a legacy floor row only when a chain needs one.
          Any floor row must sit at or above the chain&apos;s on-chain settlement floor
          (rejected with ChainMinBelowFloor otherwise).
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-xs">
            Percent (%)
            <input
              value={bps}
              onChange={(e) => setBps(pctOnly(e.target.value))}
              inputMode="decimal"
              placeholder="0.5"
              className={`${FIELD} font-mono text-xs`}
            />
          </label>
          <label className="text-xs">
            FX source
            <input
              value={fxSource}
              onChange={(e) => setFxSource(e.target.value)}
              placeholder="CoinGecko USD/IDR"
              className={`${FIELD} font-mono text-xs`}
            />
          </label>
          <label className="text-xs">
            FX as of (ISO-8601)
            <input
              value={fxAsOf}
              onChange={(e) => setFxAsOf(e.target.value)}
              placeholder="2026-10-27T00:00:00Z"
              className={`${FIELD} font-mono text-xs`}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {minima.length === 0 && (
            <p className={`text-xs ${MUTED}`}>
              No floor rows — this publishes a pure percentage policy. Add a chain row only for a legacy floor.
            </p>
          )}
          {minima.map((m, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <label className="text-xs">
                Namespace
                <select
                  value={m.namespace}
                  onChange={(e) =>
                    setMinima((prev) => prev.map((row, j) => (j === i ? { ...row, namespace: e.target.value as MinimaDraft["namespace"] } : row)))
                  }
                  className={`${FIELD} font-mono text-xs`}
                >
                  <option value="solana">solana</option>
                  <option value="eip155">eip155</option>
                </select>
              </label>
              <label className="text-xs">
                Reference {m.namespace === "eip155" ? "(chain id)" : "(genesis hash)"}
                <input
                  value={m.reference}
                  onChange={(e) =>
                    setMinima((prev) => prev.map((row, j) => (j === i ? { ...row, reference: e.target.value } : row)))
                  }
                  placeholder={m.namespace === "eip155" ? "84532" : "EtWTRABZa68…"}
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <label className="text-xs">
                Legacy floor (base units)
                <input
                  value={m.minFee}
                  onChange={(e) =>
                    setMinima((prev) => prev.map((row, j) => (j === i ? { ...row, minFee: digitsOnly(e.target.value) } : row)))
                  }
                  inputMode="numeric"
                  placeholder="17000"
                  className={`${FIELD} font-mono text-xs`}
                />
              </label>
              <div className="flex items-end gap-2">
                <MiniButton size="sm" onClick={() => setMinima((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </MiniButton>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <MiniButton
              size="sm"
              onClick={() => setMinima((prev) => [...prev, { namespace: "solana", reference: "", minFee: "" }])}
            >
              Add chain
            </MiniButton>
            <MiniButton variant="solid" size="sm" onClick={() => void publish()} disabled={busy || !bps}>
              Publish
            </MiniButton>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={SECTION_LABEL}>Subsidy ledger summary</p>
          <label className="flex items-center gap-2 text-xs">
            <span className={MUTED}>Window</span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className={`${FIELD} font-mono text-xs`}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
        </div>
        <p className={`mt-1 text-xs ${MUTED}`}>
          Daily quote-vs-actual aggregates (base units). Negative subsidy = surplus collected above actual cost.
        </p>
        {summary == null || summary.length === 0 ? (
          <p className={`mt-3 text-sm ${MUTED}`}>No subsidy rows in this window yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className={MUTED}>
                  <th scope="col" className="py-1 pr-3 font-medium">Day</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Txns</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Quoted</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Actual</th>
                  <th scope="col" className="py-1 font-medium">Subsidy</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {summary.map((row) => (
                  <tr key={row.day} className={DIVIDER}>
                    <td className="py-1 pr-3">{row.day}</td>
                    <td className="py-1 pr-3">{row.count}</td>
                    <td className="py-1 pr-3">{row.quotedTotal}</td>
                    <td className="py-1 pr-3">{row.actualTotal}</td>
                    <td className={`py-1 ${row.subsidyTotal.startsWith("-") ? "" : WARN}`}>{row.subsidyTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
