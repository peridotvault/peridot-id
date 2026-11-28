import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, LogOut, ShieldCheck } from "lucide-react";
import { Popover } from "@peridotvault/pid-ui";
import { cn } from "../lib/cn";

const ROW =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/40 focus-ring";

/**
 * Topbar identity: the pid itself is the account button. Its popover holds
 * Admin (admins only) and Sign out, so both consoles share one account menu.
 * Chrome (scrim, position, motion) is the wallet's Popover — packages/ui.
 */
export function ProfileMenu({
  pid,
  isAdmin,
  signOut,
}: {
  pid: string;
  isAdmin: boolean;
  signOut: () => void;
}) {
  const navigate = useNavigate();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  if (!pid) return null;
  const close = () => setOpen(false);

  return (
    <div ref={anchor} className="relative flex shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex max-w-48 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-ring"
      >
        <span className="truncate" title={pid}>
          {pid}
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      <Popover open={open} onClose={close} anchor={anchor} label="Account">
        {isAdmin && (
          <button
            type="button"
            role="menuitem"
            className={ROW}
            onClick={() => {
              close();
              void navigate("/admin");
            }}
          >
            <ShieldCheck className="size-4 shrink-0" aria-hidden />
            Admin
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={ROW}
          onClick={() => {
            close();
            void signOut();
          }}
        >
          <LogOut className="size-4 shrink-0" aria-hidden />
          Sign out
        </button>
      </Popover>
    </div>
  );
}
