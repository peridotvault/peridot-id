import { useEffect, useState } from "react";
import type { AppUsersPage, PeridotClient } from "@peridotvault/pid-sdk-js";

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
  const button = "rounded border border-border px-3 py-2 text-xs disabled:opacity-50";
  const formatTime = (value: string) => new Date(value).toLocaleString();
  return (
    <section aria-labelledby="app-users-title" className="border border-border p-4">
      <h2 id="app-users-title" className="text-sm font-semibold">Users</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        People who completed login to this app. Each PID appears once, across all login methods.
        History starts when user tracking is enabled; older logins are not backfilled. Times use your local timezone.
      </p>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setQ(search.trim()); setPage(1); }}>
        <label className="flex flex-col gap-1 text-xs">
          Search PID
          <input value={search} onChange={event => setSearch(event.target.value)} maxLength={100}
            placeholder="Search by PID" className="rounded border border-border bg-background px-3 py-2" />
        </label>
        <button type="submit" className={`${button} self-end`}>Search</button>
        <button type="button" className={`${button} self-end`} onClick={() => setRetry(n => n + 1)} disabled={loading}>Refresh</button>
      </form>
      {loading && <p role="status" className="mt-3 text-sm">Loading users…</p>}
      {error && <div role="alert" className="mt-3 text-sm">{error} <button className={button} onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
      {result && <>
        <p role="status" className="mt-3 text-xs text-muted-foreground">{result.total.toLocaleString()} {q ? "matching users" : "users"}</p>
        {result.users.length === 0 ? <p className="mt-3 text-sm">{q ? "No users match this PID." : "No recorded users yet. Users appear after completing login to this app."}</p> :
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Users of this application</caption>
              <thead><tr>{["PID", "Name", "First recorded login", "Latest login"].map(label => <th key={label} scope="col" className="p-2 font-medium">{label}</th>)}</tr></thead>
              <tbody>{result.users.map(user => <tr key={user.pid} className="border-t border-border">
                <td className="p-2 font-mono">{user.pid}</td><td className="p-2">{user.displayName ?? "—"}</td>
                <td className="p-2"><time dateTime={user.firstLoginAt}>{formatTime(user.firstLoginAt)}</time></td>
                <td className="p-2"><time dateTime={user.lastLoginAt}>{formatTime(user.lastLoginAt)}</time></td>
              </tr>)}</tbody>
            </table>
          </div>}
        <nav aria-label="User list pages" className="mt-3 flex items-center gap-3">
          <button className={button} disabled={page <= 1} onClick={() => setPage(n => n - 1)}>Previous</button>
          <span className="text-xs">Page {page}</span>
          <button className={button} disabled={page * result.pageSize >= result.total} onClick={() => setPage(n => n + 1)}>Next</button>
        </nav>
      </>}
    </section>
  );
}
