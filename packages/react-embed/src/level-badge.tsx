"use client";

// Reusable Level badge (ANT-89 M3). Read-only display of
// GET /v1/users/{pid}/level for integrators who CHOOSE to show it —
// no XP amounts are accepted or generated client-side.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Peridot, type ApiError, type LevelSummary, type PeridotEnv } from "@peridotvault/pid-sdk-js";

/** Minimal client surface the badge needs (a full PeridotClient satisfies it). */
export interface LevelBadgeClient {
  level: {
    get(pid: string): Promise<LevelSummary | ApiError>;
  };
}

export interface PeridotLevelBadgeProps {
  /** PID to display (e.g. `ifal@pid`). Null/empty renders the empty state. */
  pid?: string | null;
  /** Integrator-owned client (preferred — reuses their auth). */
  client?: LevelBadgeClient;
  /** Used only when `client` is omitted: env for an internal client. */
  env?: PeridotEnv;
  /** Used only when `client` is omitted: API origin override (self-host). */
  baseUrl?: string;
  /** Show the within-level progress bar. Default true. */
  showProgress?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Renderable badge state (pure — every variant is SSR-testable via the view). */
export type LevelBadgeState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; summary: LevelSummary };

export function isLevelApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "statusCode" in value;
}

export function levelErrorMessage(value: LevelSummary | ApiError): string | null {
  if (!isLevelApiError(value)) return null;
  if (value.statusCode === 404) return "Unknown user";
  const msg = (value as { message?: unknown }).message;
  const text = Array.isArray(msg) ? msg.join(" ") : typeof msg === "string" ? msg : null;
  return text ?? "Couldn't load the level";
}

/** Compact thousands formatting for the XP total (1,701 — never abbreviated). */
export function formatBadgeXp(totalXp: number): string {
  if (!Number.isFinite(totalXp)) return "0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(totalXp);
}

const badgeRow: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  maxWidth: "100%",
  flexWrap: "wrap",
  fontSize: "0.875rem",
  lineHeight: 1.4,
};

const pill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: "9999px",
  padding: "0.125rem 0.625rem",
  fontWeight: 600,
  border: "1px solid currentColor",
  whiteSpace: "nowrap",
};

/**
 * Pure presentational badge — every state (empty / loading / error / ready)
 * renders here with no effects, so all four are verifiable server-side.
 * Layout is fluid (no fixed widths); the progress bar exposes
 * `role="progressbar"` with value attributes.
 */
export function PeridotLevelBadgeView({
  state,
  showProgress = true,
  onRetry,
  className,
  style,
}: {
  state: LevelBadgeState;
  showProgress?: boolean;
  onRetry?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  if (state.status === "empty") {
    return (
      <span className={className} style={{ ...badgeRow, ...style }} aria-label="No user selected">
        <span style={pill}>Lv —</span>
        <span style={{ opacity: 0.65 }}>No user selected</span>
      </span>
    );
  }

  if (state.status === "loading") {
    return (
      <span className={className} style={{ ...badgeRow, ...style }} role="status" aria-live="polite">
        <span style={pill} aria-hidden="true">
          Lv …
        </span>
        <span style={{ opacity: 0.65 }}>Loading level…</span>
      </span>
    );
  }

  if (state.status === "error") {
    return (
      <span className={className} style={{ ...badgeRow, ...style }} role="alert">
        <span style={pill}>Lv —</span>
        <span style={{ opacity: 0.8 }}>{state.message}</span>
        <button
          type="button"
          onClick={onRetry}
          style={{ textDecoration: "underline", cursor: "pointer", background: "none", border: 0, padding: 0 }}
        >
          Retry
        </button>
      </span>
    );
  }

  const { level, total_xp, progress_percentage } = state.summary;
  return (
    <span
      className={className}
      style={{ ...badgeRow, ...style }}
      aria-label={`Level ${level}, ${formatBadgeXp(total_xp)} total XP`}
    >
      <span style={pill}>Lv {level}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatBadgeXp(total_xp)} XP</span>
      {showProgress && (
        <span
          role="progressbar"
          aria-label={`Progress within level ${level}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress_percentage)}
          title={`${progress_percentage}% to next level`}
          style={{
            display: "inline-block",
            height: "0.375rem",
            minWidth: "4rem",
            flex: "1 1 4rem",
            maxWidth: "10rem",
            borderRadius: "9999px",
            border: "1px solid currentColor",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "block",
              height: "100%",
              width: `${Math.min(100, Math.max(0, progress_percentage))}%`,
              borderRadius: "inherit",
              background: "currentColor",
            }}
          />
        </span>
      )}
    </span>
  );
}

/**
 * Level badge: `Lv 5 · 1,701 XP` with an optional within-level progress bar.
 * Owns fetching via the integrator's client (or a narrow internal one) and
 * delegates every state to {@link PeridotLevelBadgeView}.
 */
export function PeridotLevelBadge({
  pid,
  client,
  env,
  baseUrl,
  showProgress = true,
  className,
  style,
}: PeridotLevelBadgeProps) {
  const owned = useMemo(
    () => client ?? Peridot({ env, baseUrl }),
    // Reuse an integrator-passed client verbatim; only build when absent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );
  const [state, setState] = useState<LevelBadgeState>(pid ? { status: "loading" } : { status: "empty" });
  // Bump to retry after an error without changing props.
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    if (!pid) {
      setState({ status: "empty" });
      return;
    }
    setState({ status: "loading" });
    try {
      const data = await owned.level.get(pid);
      const message = levelErrorMessage(data);
      if (message) setState({ status: "error", message });
      else setState({ status: "ready", summary: data as LevelSummary });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : "Couldn't load the level" });
    }
  }, [owned, pid]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  return (
    <PeridotLevelBadgeView
      state={state}
      showProgress={showProgress}
      onRetry={() => setAttempt((n) => n + 1)}
      className={className}
      style={style}
    />
  );
}
