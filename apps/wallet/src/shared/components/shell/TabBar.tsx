import { Pressable } from "../ui/Pressable";
import { Activity, House, Settings } from "../icons";
import { useWideLayout } from "../../hooks/useWideLayout";
import { theme } from "../../styles/theme";
import { BrandTop } from "./BrandTop";

export type TabKey = "home" | "activity" | "settings";


// Tab bar. Three shapes from one component:
//   bottom   — phones: three tabs under the content.
//   sidebar  — two-column desktop: labels docked left, header stays in the rail.
//   rail     — three-column desktop: same labels, brand on top, no border (the
//              content rail already draws the line).
//
// Styled with Tailwind (tokens in shared/styles/tokens.css @theme, same values as
// shared/theme.ts). flexDirection stays a style prop: inline beats any class.
export function TabBar({
  current,
  go,
  variant = "auto",
}: {
  current: TabKey;
  go: (s: TabKey) => void;
  variant?: "auto" | "rail";
}) {
  const wide = useWideLayout();
  const rail = variant === "rail";

  if (rail || wide) {
    return (
      <nav
        aria-label="Primary"
        className="flex shrink-0 flex-col bg-background py-4"
        style={{ width: rail ? theme.layout.navWidth : theme.layout.sidebarWidth }}
      >
        {rail && (
          <div className="px-4 pb-6">
            <BrandTop />
          </div>
        )}
        <Tab side icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
        <Tab side icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
        <Tab side icon={Settings} label="Settings" active={current === "settings"} onPress={() => go("settings")} />
      </nav>
    );
  }

  return (
    <div style={{ flexDirection: "row" }} className="flex border-t border-line bg-background pb-3.5 pt-2.5">
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
            ? `flex w-full items-center gap-3 border-b border-line px-4 py-3 transition-colors hover:bg-surface ${
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
