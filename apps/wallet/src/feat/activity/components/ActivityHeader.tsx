import { Pressable } from "../../../shared/components/Pressable";
import { RefreshCw } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";
import type { Tab } from "../utils/feed";

export function ActivityHeader({
  tab,
  onTabChange,
  onRefresh,
  busy,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <>
      <div style={{ flexDirection: "row" }} className="flex flex-col items-center justify-between">
        <h1 style={s.title}>Activity</h1>
        <Pressable onPress={onRefresh} disabled={busy} accessibilityLabel="Refresh activity">
          <div className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface">
            <RefreshCw size={16} className="text-foreground" />
          </div>
        </Pressable>
      </div>

      <div style={{ flexDirection: "row" }} className="flex flex-col border border-border">
        <TabButton label="All" active={tab === "all"} onPress={() => onTabChange("all")} />
        <TabButton label="Onchain" active={tab === "onchain"} onPress={() => onTabChange("onchain")} />
        <TabButton label="IDR" active={tab === "idr"} onPress={() => onTabChange("idr")} />
      </div>
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      className="flex-1"
    >
      <div className={`flex flex-col w-full items-center py-2.5 ${active ? "bg-foreground" : "bg-background"}`}>
        <span className={`font-sans text-sm font-medium ${active ? "text-background" : "text-muted-foreground"}`}>{label}</span>
      </div>
    </Pressable>
  );
}
