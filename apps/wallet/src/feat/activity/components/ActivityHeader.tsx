import { Text, TouchableOpacity, View } from "../../../shared/primitives";
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
      <View style={{ flexDirection: "row" }} className="items-center justify-between">
        <Text style={s.title}>Activity</Text>
        <TouchableOpacity onPress={onRefresh} disabled={busy}>
          <View className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface">
            <RefreshCw size={16} className="text-foreground" />
          </View>
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: "row" }} className="border border-border">
        <TabButton label="All" active={tab === "all"} onPress={() => onTabChange("all")} />
        <TabButton label="Onchain" active={tab === "onchain"} onPress={() => onTabChange("onchain")} />
        <TabButton label="IDR" active={tab === "idr"} onPress={() => onTabChange("idr")} />
      </View>
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityState={{ selected: active }}
      className="flex-1"
    >
      <View className={`w-full items-center py-2.5 ${active ? "bg-foreground" : "bg-background"}`}>
        <Text className={`font-sans text-[13px] font-medium ${active ? "text-background" : "text-muted-foreground"}`}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}
