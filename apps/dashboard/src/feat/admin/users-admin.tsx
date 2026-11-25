import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, MUTED, SECTION_LABEL, MiniButton } from "../../shared/ui/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../shared/ui/table";

interface UserRow {
  pid: string;
  displayName: string | null;
  balanceIdr: string;
  loginMethod: string | null;
  lastLoginAt: string | null;
}

interface UsersPage {
  page: number;
  pageSize: number;
  total: number;
  users: UserRow[];
}

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });

/** Admin identity directory — read only (no delete), balance highest first. */
export function UsersAdmin({ client }: { client: PeridotClient }) {
  const [data, setData] = useState<UsersPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      setError(null);
      try {
        setData(unwrap(await client.get<UsersPage>(`/v1/admin/users?page=${targetPage}`), "Loading users"));
      } catch (e) {
        setData(null);
        setError(e instanceof Error ? e.message : "Could not load users");
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load(page);
  }, [page, load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={SECTION_LABEL}>Users — fiat balance, highest first</p>
        <p className={`text-xs ${MUTED}`}>{data ? `${data.total} users` : ""}</p>
      </div>
      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton onClick={() => void load(page)}>Retry</MiniButton>
        </div>
      )}
      {!data && loading && <p role="status" className={`mt-3 text-sm ${MUTED}`}>Loading users…</p>}
      {data?.users.length === 0 && <p className={`mt-3 text-sm ${MUTED}`}>No users yet.</p>}
      {data && data.users.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <Table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="py-2 pr-3">PID</TableHead>
                <TableHead className="py-2 pr-3">Name</TableHead>
                <TableHead className="py-2 pr-3 text-right">Fiat (IDR)</TableHead>
                <TableHead className="py-2 pr-3">Login</TableHead>
                <TableHead className="py-2 pr-3">Last login</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.users.map((user) => (
                <TableRow key={user.pid} className="border-b border-line/60">
                  <TableCell className="py-2 pr-3 font-mono">{user.pid}</TableCell>
                  <TableCell className="py-2 pr-3">{user.displayName ?? "—"}</TableCell>
                  <TableCell className="py-2 pr-3 text-right font-mono">{idr.format(Number(user.balanceIdr))}</TableCell>
                  <TableCell className="py-2 pr-3">{user.loginMethod ?? "—"}</TableCell>
                  <TableCell className="py-2 pr-3 font-mono">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center gap-2">
          <MiniButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
            Previous
          </MiniButton>
          <span className={`text-xs ${MUTED}`}>Page {page} of {totalPages}</span>
          <MiniButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={loading || page >= totalPages}>
            Next
          </MiniButton>
        </div>
      )}
    </Card>
  );
}
