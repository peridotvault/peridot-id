import type { ReactNode } from "react";
import { BrandTop } from "../../../shared/components/shell/BrandTop";
import { ProfileMenu } from "../../../shared/components/shell/ProfileMenu";
import type { AccountMenuModel } from "../../../shared/components/shell/AccountMenu";

// Shared chrome for every app-facing ceremony on the PeridotID origin: scrim,
// brand topbar (with the account popover when the flow has one) and one centered
// card. Consent (login) and approval (a dapp's request) must read as the same
// product — the card is the only thing that differs.
export function ConsentShell({
  children,
  sessionLabel,
  avatarUrl,
  level,
  accountMenu,
  seamless,
  footer,
}: {
  /** Card body. */
  children: ReactNode;
  sessionLabel?: string | null;
  avatarUrl?: string | null;
  level?: number | null;
  /** Omit in approval: switching identity mid-approval is the popup's job. */
  accountMenu?: AccountMenuModel;
  /** No card surface: the login page sits straight on the scrim (no border). */
  seamless?: boolean;
  /** Public chrome under the card (sign-in only): the card keeps the space. */
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col absolute inset-0 z-10">
      <div className="absolute inset-0 bg-black/60" />
      <div className="flex relative z-10 items-center justify-between gap-3 px-6 pb-3 pt-5">
        <BrandTop />
        {accountMenu && (
          <ProfileMenu
            displayName={sessionLabel ?? null}
            avatarUrl={avatarUrl ?? null}
            level={level ?? null}
            label="Accounts"
            menu={accountMenu}
            variant={seamless ? "text" : "avatar"}
          />
        )}
      </div>
      {/* relative + z lifts the card above the absolute scrim. The scroller is
          the wrapper (not the card) so a tall approval — unknown program block
          plus a fiat quote — stays reachable instead of clipping at the top. */}
      <div className="flex flex-1 relative z-10 overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-6">
          <div
            className={`flex w-full max-w-[380px] flex-col gap-3 p-5 ${
              seamless ? "" : "rounded-xl border border-border bg-surface"
            }`}
          >
            {children}
          </div>
        </div>
      </div>
      {footer ? <div className="relative z-10 shrink-0">{footer}</div> : null}
    </div>
  );
}
