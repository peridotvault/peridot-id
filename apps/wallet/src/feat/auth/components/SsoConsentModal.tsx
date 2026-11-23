import { useState } from "react";
import { Pressable } from "../../../shared/components/ui/Pressable";
import { Check } from "../../../shared/components/icons";
import { UIButton } from "../../../shared/components/ui/UIButton";
import type { AccountMenuModel } from "../../../shared/components/shell/AccountMenu";
import { AppIdentity } from "./AppIdentity";
import { ConsentShell } from "./ConsentShell";

// App-scoped consent card: who is asking (logo, name, origin), what they
// receive, and one primary action. The shell header stays (brand left, profile
// right) so the account popover — not a link in the card — is how the user
// changes identity, like Internet Identity.
export function SsoConsentModal({
  origin,
  appName,
  logoUrl,
  description,
  sessionLabel,
  avatarUrl,
  level,
  busy,
  error,
  onAllow,
  onDeny,
  verified,
  accountMenu,
}: {
  origin: string;
  /** Registered app name; falls back to a neutral heading (never the origin). */
  appName?: string | null;
  /** Owner-set logo; null renders the generic tile. */
  logoUrl?: string | null;
  /** Owner-set tagline; null falls back to PeridotID's own line. */
  description?: string | null;
  sessionLabel: string;
  /** Signed-in identity's avatar and level for the header chip. */
  avatarUrl?: string | null;
  level?: number | null;
  busy: boolean;
  error: string | null;
  onAllow: () => void;
  onDeny: () => void;
  /** Verified partner: PeridotID fee waived for this app (trust signal). */
  verified?: boolean;
  accountMenu: AccountMenuModel;
}) {
  const [open, setOpen] = useState(false);

  return (
    <ConsentShell
      sessionLabel={sessionLabel}
      avatarUrl={avatarUrl}
      level={level}
      accountMenu={accountMenu}
    >
      <AppIdentity
        origin={origin}
        appName={appName}
        logoUrl={logoUrl}
        description={description}
        verified={verified}
        title={appName ? `Continue to ${appName}` : "Continue to this app"}
        subtitle="with your PeridotID"
      />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {/* II renders the options above the primary button: the card grows
          upward from fixed Continue / Deny / switch at the bottom. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="flex max-h-40 flex-col gap-2 overflow-y-auto border-t border-line pt-3">
            <span className="font-sans text-xs font-medium text-muted-foreground">This app receives</span>
            {["Your PeridotID", "Display name and avatar", "Email from the sign-in method you used"].map((item) => (
              <span key={item} className="flex items-center gap-2 font-sans text-xs text-paragraph">
                <Check size={14} className="shrink-0 text-success" aria-hidden="true" />
                {item}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">Never your passkeys, wallet keys or balances.</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col mt-1 gap-3">
        <UIButton title={busy ? "Authenticating…" : "Continue"} onPress={onAllow} disabled={busy} variant="primary" />
        <div className="flex items-center justify-center">
          <Pressable onPress={onDeny} disabled={busy} accessibilityRole="button" accessibilityLabel="Deny sign-in">
            <span className="font-sans text-sm text-danger">Deny</span>
          </Pressable>
        </div>
        {/* II's bottom row: a small switch on the left, not a centered link. */}
        <Pressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="switch"
          accessibilityState={{ checked: open }}
          accessibilityLabel="Show all options"
          className="self-start"
        >
          <div className="flex items-center gap-2 py-1">
            <div
              className={`flex h-5 w-10 shrink-0 items-center rounded-sm border p-[2px] ${
                open ? "justify-end border-accent bg-accent" : "justify-start border-border bg-surface"
              }`}
            >
              <span aria-hidden className={`h-full w-3.5 shrink-0 rounded-sm ${open ? "bg-background" : "bg-muted-foreground"}`} />
            </div>
            <span className="font-sans text-sm text-foreground">Show all options</span>
          </div>
        </Pressable>
      </div>
    </ConsentShell>
  );
}
