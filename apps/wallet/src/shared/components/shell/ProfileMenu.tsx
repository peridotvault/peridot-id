import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AccountMenu, type AccountMenuModel } from "./AccountMenu";
import { ProfileButton } from "./ProfileButton";
import { Pressable } from "../ui/Pressable";
import { ChevronDown } from "../icons";

// Profile corner: the avatar button (level chip included) plus its account
// popover. One component so the shell topbar, the desktop rail and the auth
// screens all open the same menu instead of three different treatments.
export function ProfileMenu({
  displayName,
  avatarUrl,
  level,
  label,
  menu,
  onProfile,
  variant = "avatar",
}: {
  displayName: string | null;
  avatarUrl: string | null;
  level: number | null;
  /** Accessibility label while the menu holds accounts (auth screens). */
  label?: string;
  menu: AccountMenuModel;
  /** Profile row in the menu; omit when the screen is the profile itself. */
  onProfile?: () => void;
  /** "text" = the signed-out login page: no avatar to show, just the list. */
  variant?: "avatar" | "text";
}) {
  const anchor = useRef<HTMLDivElement>(null);
  // The menu is portaled to <body>, so its position comes from the button.
  const [pos, setPos] = useState<CSSProperties | null>(null);
  // Stays mounted through the exit animation instead of vanishing on close.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (menu.open) {
      setMounted(true);
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) {
        setPos({
          position: "fixed",
          top: rect.bottom + 8,
          right: Math.max(8, window.innerWidth - rect.right),
        });
      }
      return;
    }
    const timer = setTimeout(() => setMounted(false), 140);
    return () => clearTimeout(timer);
  }, [menu.open]);

  return (
    <div ref={anchor} className="relative flex shrink-0">
      {variant === "text" ? (
        <Pressable
          onPress={menu.open ? menu.closeMenu : menu.openMenu}
          accessibilityLabel={label ?? "Accounts"}
        >
          <div className="flex items-center gap-1 rounded-lg border border-line px-3 py-2 hover:bg-surface">
            <span className="font-sans text-sm text-foreground">{label ?? "Accounts"}</span>
            <ChevronDown
              size={14}
              aria-hidden
              className={`text-muted-foreground transition-transform ${menu.open ? "rotate-180" : ""}`}
            />
          </div>
        </Pressable>
      ) : (
        <ProfileButton
          displayName={displayName}
          avatarUrl={avatarUrl}
          level={level}
          label={label}
          onProfile={menu.open ? menu.closeMenu : menu.openMenu}
        />
      )}
      {mounted && pos && (
        <AccountMenu
          accounts={menu.accounts}
          busy={menu.busy}
          error={menu.error}
          onSelect={menu.select}
          onAdd={menu.add}
          onProfile={onProfile}
          onClose={menu.closeMenu}
          closing={!menu.open}
          style={pos}
        />
      )}
    </div>
  );
}
