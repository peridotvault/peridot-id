import { useCallback, useState } from "react";
import type { AccountView } from "@peridotvault/pid-types";
import { usePeridot } from "../app/AppContext";
import type { AccountMenuModel } from "../components/shell/AccountMenu";

/** Shell account popover: lists the identities in this browser and switches
 *  between them. `onSwitched` lets the shell re-bootstrap onto the new one. */
export function useAccountMenu(onSwitched: () => void): AccountMenuModel {
  const { peridot } = usePeridot();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openMenu = useCallback(() => {
    setError(null);
    setOpen(true);
    peridot.auth
      .accounts()
      .then((res) => setAccounts(Array.isArray(res) ? (res as AccountView[]) : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [peridot]);

  const closeMenu = useCallback(() => setOpen(false), []);

  const select = useCallback(
    async (pid: string) => {
      if (accounts.some((a) => a.pid === pid && a.isActive)) {
        setOpen(false);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (!(await peridot.auth.switchAccount(pid))) throw new Error("Couldn't switch account.");
        setOpen(false);
        onSwitched();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [peridot, accounts, onSwitched],
  );

  return { open, accounts, busy, error, openMenu, closeMenu, select: (pid) => void select(pid) };
}
