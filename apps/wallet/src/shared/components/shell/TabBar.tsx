import type { ReactNode } from "react";
import { Pressable } from "../ui/Pressable";
import { Activity, House, Settings } from "../icons";
import { useWideLayout } from "../../hooks/useWideLayout";
import { theme } from "../../styles/theme";
import { BrandTop } from "./BrandTop";

export type TabKey = "home" | "activity" | "settings";


// Tab bar. Two shapes from one component, switched at the same breakpoint as
// the header (768): below it the tabs sit under the content, above it they dock
// left as a sidebar.
//   sidebar  — two-column desktop: brand on top, profile docked at the bottom.
//   rail     — three-column desktop: same tabs and brand, no profile (InfoRail
//              carries it) and no border (the content rail already draws one).
//
// Styled with Tailwind (tokens in shared/styles/tokens.css @theme, same values as
// shared/theme.ts). flexDirection stays a style prop: inline beats any class.
export function TabBar({
  current,
  go,
  variant = "auto",
  footer,
}: {
  current: TabKey;
  go: (s: TabKey) => void;
  variant?: "auto" | "rail";
  /** Docked under the tabs (desktop sidebar only) — the profile corner. */
  footer?: ReactNode;
}) {
  const wide = useWideLayout();
  const rail = variant === "rail";

  if (rail || wide) {
    return (
      <nav
        aria-label="Primary"
        className={`flex shrink-0 flex-col bg-background py-4 ${rail ? "" : "min-h-dvh"}`}
        style={{ width: rail ? theme.layout.navWidth : theme.layout.sidebarWidth }}
      >
        <div className="px-4 pb-6">
          <BrandTop />
        </div>
        <Tab side icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
        <Tab side icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
        <Tab side icon={Settings} label="Settings" active={current === "settings"} onPress={() => go("settings")} />
        {footer && <div className="mt-auto px-4 pt-8">{footer}</div>}
      </nav>
    );
  }

  return (
    <div className="flex border-t border-line bg-background pb-3.5 pt-2.5">
      <Tab icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
      <Tab icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
      <Tab icon={Settings} label="Settings" active={current === "settings"} onPress={() => go("settings")} />
    </div>
  );
}

function Tab({
  icon: Icon,
  label,
  active,
  onPress,
  side,
}: {
  icon: typeof House;
  label: string;
  active: boolean;
  onPress: () => void;
  side?: boolean;
}) {
  const tone = active ? "text-foreground" : "text-muted-foreground";
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      className={side ? undefined : "flex-1"}
    >
      <div
        style={side ? { flexDirection: "row" } : undefined}
        className={
          side
            ? `flex w-full items-center gap-3 border-b border-line px-4 py-3 hover:bg-surface ${
                active ? "bg-surface shadow-[inset_2px_0_0_var(--color-accent)]" : ""
              }`
            : "flex w-full flex-col items-center gap-1"
        }
      >
        <Icon size={20} className={tone} />
        <span className={`font-sans font-medium ${side ? "text-sm" : "text-xs"} ${tone}`}>{label}</span>
      </div>
    </Pressable>
  );
}
