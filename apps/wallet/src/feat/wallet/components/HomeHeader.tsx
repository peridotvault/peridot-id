import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import { Link2 } from "../../../shared/icons";

export function HomeHeader({
  pid,
  displayName,
  onConnections,
}: {
  pid: string | null;
  displayName: string | null;
  onConnections: () => void;
}) {
  return (
    <View style={{ flexDirection: "row" }} className="items-center justify-between">
      <View className="flex-1 gap-1">
        <Text className="font-sans text-xl font-semibold text-foreground">{pid ?? "…"}</Text>
        {displayName ? <Text className="font-sans text-[13px] text-muted-foreground">{displayName}</Text> : null}
      </View>
      <TouchableOpacity onPress={onConnections} accessibilityLabel="App connections">
        <View className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface">
          <Link2 size={18} className="text-foreground" />
        </View>
      </TouchableOpacity>
    </View>
  );
}
