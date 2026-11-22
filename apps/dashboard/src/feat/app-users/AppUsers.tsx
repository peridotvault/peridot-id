import { useEffect, useState } from "react";
import type { AppUsersPage, PeridotClient } from "@peridotvault/pid-sdk-js";
import { Card, FIELD, MiniButton, MUTED } from "../../workspace/ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../shared/ui/table";

/** App-scoped directory. Request cleanup prevents old app/search results leaking into the current view. */
export function AppUsers({ client, appId }: { client: PeridotClient; appId: string }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<AppUsersPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setResult(null);
    setError(null);
    void client.usage.users(appId, { q, page }).then(data => {
      if (!active) return;
      if (!("users" in data)) throw new Error("Could not load app users.");
      setResult(data);
    }).catch(() => {
      if (active) setError("Could not load app users. Please try again.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, appId, q, page, retry]);
  const formatTime = (value: string) => new Date(value).toLocaleString();
  return (
    <Card>
      <h2 id="app-users-title" className="text-base font-semibold tracking-tight">Users</h2>
      <p className={`mt-1 max-w-2xl text-xs ${MUTED}`}>
        People who completed login to this app. Each PID appears once, across all login methods.
        History starts when user tracking is enabled; older logins are not backfilled. Times use your local timezone.
      </p>
      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setQ(search.trim()); setPage(1); }}>
        <label className="text-xs">
          Search PID
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            maxLength={100}
            placeholder="Search by PID"
            className={FIELD}
          />
        </label>
        <MiniButton size="sm" type="submit">Search</MiniButton>
        <MiniButton size="sm" disabled={loading} onClick={() => setRetry(n => n + 1)}>Refresh</MiniButton>
      </form>
      {loading && <p role="status" className={`mt-4 text-sm ${MUTED}`}>Loading users…</p>}
      {error && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span>{error}</span>
          <MiniButton size="sm" onClick={() => setRetry(n => n + 1)}>Retry</MiniButton>
        </div>
      )}
      {result && (
        <>
          <p role="status" className={`mt-4 text-xs ${MUTED}`}>
            {result.total.toLocaleString()} {q ? "matching users" : "users"}
          </p>
          {result.users.length === 0 ? (
            <p className={`mt-3 text-sm ${MUTED}`}>
              {q ? "No users match this PID." : "No recorded users yet. Users appear after completing login to this app."}
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <Table className="w-full text-left text-xs">
                <caption className="sr-only">Users of this application</caption>
                <TableHeader>
                  <TableRow>
                    {["PID", "Name", "First recorded login", "Latest login", "Login provider"].map(label => (
                      <TableHead key={label} scope="col" className="py-2 pr-4 font-medium">{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.users.map(user => (
                    <TableRow key={user.pid}>
                      <TableCell className="py-2 pr-4 font-mono">{user.pid}</TableCell>
                      <TableCell className="py-2 pr-4">{user.displayName ?? "—"}</TableCell>
                      <TableCell className="py-2 pr-4"><time dateTime={user.firstLoginAt}>{formatTime(user.firstLoginAt)}</time></TableCell>
                      <TableCell className="py-2 pr-4"><time dateTime={user.lastLoginAt}>{formatTime(user.lastLoginAt)}</time></TableCell>
                      <TableCell className="py-2 pr-4">
                        {user.lastLoginProvider?.name ?? "Unknown"}
                        {user.lastLoginProvider?.evidence === "client_selected" && (
                          <span className={`block text-xs ${MUTED}`}>Selected wallet connector</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <nav aria-label="User list pages" className="mt-4 flex items-center gap-3">
            <MiniButton size="sm" disabled={page <= 1} onClick={() => setPage(n => n - 1)}>Previous</MiniButton>
            <span className="text-xs">Page {page}</span>
            <MiniButton size="sm" disabled={page * result.pageSize >= result.total} onClick={() => setPage(n => n + 1)}>Next</MiniButton>
          </nav>
        </>
      )}
    </Card>
  );
}
