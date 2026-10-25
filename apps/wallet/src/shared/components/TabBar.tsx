import { Pressable } from "./Pressable";
import { Activity, House, Settings } from "../icons";
import { useWideLayout } from "../hooks/useWideLayout";

export type TabKey = "home" | "activity" | "settings";


// Bottom tab bar — shown on the tab roots only (home/activity/settings).
// Pushes (send, profile, …) render above it. Profile is no longer a tab: it
// opens from the top bar's photo, so the bar carries Settings instead.
//
// Styled with Tailwind (tokens in src/index.css @theme, same values as
// shared/theme.ts). flexDirection stays a style prop: inline beats any class.
export function TabBar({ current, go }: { current: TabKey; go: (s: TabKey) => void }) {
  const wide = useWideLayout();

  if (wide) {
    return (
      <div className="flex flex-col w-[232px] gap-1 bg-background px-3 py-5">
        <Tab side icon={House} label="Home" active={current === "home"} onPress={() => go("home")} />
        <Tab side icon={Activity} label="Activity" active={current === "activity"} onPress={() => go("activity")} />
        <Tab side icon={Settings} label="Settings" active={current === "settings"} onPress={() => go("settings")} />
      </div>
    );
  }

  return (
    <div style={{ flexDirection: "row" }} className="flex flex-col border-t border-border bg-background pb-3.5 pt-2.5">
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
        className={side ? `flex flex-col w-full items-center gap-3 p-3 ${active ? "bg-muted" : ""}` : "flex flex-col w-full items-center gap-1"}
      >
        <Icon size={20} className={tone} />
        <span className={`font-sans font-medium ${side ? "text-sm" : "text-xs"} ${tone}`}>{label}</span>
      </div>
    </Pressable>
  );
}
