import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, MUTED, MiniButton } from "../workspace/ui";
import { LevelingLayout, useResource } from "../leveling/LevelingLayout";
import { formatXp } from "../leveling/xp";
import { xpAdmin } from "../leveling/api";

/** Leveling overview: XP totals, level distribution, recent + suspicious activity. */
export default function LevelingOverviewPage() {
  const { client } = useWorkspace();
  const { data, loading, error, reload } = useResource(() => xpAdmin.overview(client), [client]);

  return (
    <LevelingLayout active="overview">
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={reload}>Retry</MiniButton>
        </div>
      )}
      {loading ? (
        <p role="status" className={`text-sm ${MUTED}`}>Loading overview…</p>
      ) : data ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <p className={`text-xs font-semibold uppercase tracking-wide ${MUTED}`}>XP distributed</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{formatXp(data.totalXpDistributed)}</p>
              <p className={`mt-1 text-xs ${MUTED}`}>Net ledger sum across all users.</p>
            </Card>
            <Card>
              <p className={`text-xs font-semibold uppercase tracking-wide ${MUTED}`}>Users with XP state</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{formatXp(data.totalUsers)}</p>
              <p className={`mt-1 text-xs ${MUTED}`}>Rows in user_xp_states.</p>
            </Card>
            <Card>
              <p className={`text-xs font-semibold uppercase tracking-wide ${MUTED}`}>Unreviewed suspicious</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{formatXp(data.unreviewedSuspicious)}</p>
              <p className={`mt-1 text-xs ${MUTED}`}>Signals awaiting admin review below.</p>
            </Card>
          </div>

          <Card>
            <h2 className="text-lg font-semibold tracking-tight">Level distribution</h2>
            {data.levelDistribution.length === 0 ? (
              <p className={`mt-2 text-sm ${MUTED}`}>No leveled users yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2" aria-label="Users per level">
                {data.levelDistribution.map((d) => {
                  const max = Math.max(...data.levelDistribution.map((x) => x.users), 1);
                  return (
                    <li key={d.level} className="flex items-center gap-3">
                      <span className="w-14 shrink-0 text-sm font-medium">L{d.level}</span>
                      <span className="h-2 min-w-0 flex-1 rounded bg-muted" aria-hidden="true">
                        <span
                          className="block h-2 rounded bg-foreground"
                          style={{ width: `${Math.max(2, Math.round((d.users / max) * 100))}%` }}
                        />
                      </span>
                      <span className={`w-20 shrink-0 text-right text-sm ${MUTED}`}>{formatXp(d.users)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="text-lg font-semibold tracking-tight">Recent activity</h2>
              {data.recentActivity.length === 0 ? (
                <p className={`mt-2 text-sm ${MUTED}`}>No ledger entries yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-dotted divide-border">
                  {data.recentActivity.slice(0, 10).map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium">{e.kind}</span>
                        <span className={`block truncate text-xs ${MUTED}`}>{e.pid}</span>
                      </span>
                      <span className="shrink-0 font-medium">
                        {e.deltaXp.startsWith("-") ? "" : "+"}{formatXp(e.deltaXp)} XP
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <SuspiciousPanel />
          </div>
        </div>
      ) : null}
    </LevelingLayout>
  );
}

export function SuspiciousPanel() {
  const { client } = useWorkspace();
  const { data, loading, error, reload } = useResource(
    () => xpAdmin.suspicious(client, { reviewed: false, limit: 10 }),
    [client],
  );

  const review = async (id: string, reviewed: boolean) => {
    try {
      await xpAdmin.reviewSuspicious(client, id, { reviewed });
      reload();
    } catch {
      // Error surfaces on the next load; keep the row actionable.
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Suspicious activity</h2>
        <MiniButton size="sm" onClick={reload}>Refresh</MiniButton>
      </div>
      {error && <p role="alert" className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      {loading ? (
        <p role="status" className={`mt-2 text-sm ${MUTED}`}>Loading signals…</p>
      ) : !data || data.rows.length === 0 ? (
        <p className={`mt-2 text-sm ${MUTED}`}>No unreviewed signals. Fraud flags surface here (self-grants, abuse).</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {data.rows.map((s) => (
            <li key={s.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.signal}</span>
                <MiniButton size="xs" onClick={() => void review(s.id, true)}>Mark reviewed</MiniButton>
              </div>
              <p className={`mt-1 text-xs ${MUTED}`}>
                {[s.pid, s.appId, new Date(s.createdAt).toLocaleString()].filter(Boolean).join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
