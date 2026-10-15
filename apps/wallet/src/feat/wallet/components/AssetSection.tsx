import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import type { NftItem } from "@peridotvault/pid-solana";
import { styles as s } from "../../../shared/theme";
import type { Coin } from "../utils/assets";

// Tokens/Items tabs + lists. TabButton stays here (not shared): Home's
// bare-text underline variant differs from Activity's boxed pill.
export function AssetSection({
  tab,
  onTabChange,
  coins,
  nfts,
  busy,
}: {
  tab: "tokens" | "items";
  onTabChange: (tab: "tokens" | "items") => void;
  coins: Coin[];
  nfts: NftItem[];
  busy: boolean;
}) {
  return (
    <>
      <View style={{ flexDirection: "row" }} className="gap-5 py-1.5">
        <TabButton label="Tokens" active={tab === "tokens"} onPress={() => onTabChange("tokens")} />
        <TabButton label="Items" active={tab === "items"} onPress={() => onTabChange("items")} />
      </View>
      {tab === "tokens" ? (
        <>
          {coins.length === 0 && !busy && (
            <Text style={s.hint}>No assets yet — receive SOL to your address to get started.</Text>
          )}
          {coins.map((coin) => (
            <View key={coin.key} style={{ flexDirection: "row" }} className="items-center gap-3 border-b border-border py-2.5">
              <View className="flex-1">
                <Text className="font-sans text-[15px] font-semibold text-foreground">{coin.symbol}</Text>
                {coin.symbol !== "SOL" && <Text className="font-sans text-[11px] text-muted-foreground">{coin.key.slice(0, 4)}…{coin.key.slice(-4)}</Text>}
              </View>
              <Text className="font-mono text-[15px] font-medium text-foreground">{coin.amount}</Text>
            </View>
          ))}
        </>
      ) : (
        <>
          {nfts.length === 0 && !busy && (
            <Text style={s.hint}>No items yet — SPL collectibles in this wallet appear here.</Text>
          )}
          {nfts.map((nft) => (
            <View key={nft.mint} style={{ flexDirection: "row" }} className="items-center gap-3 border-b border-border py-2.5">
              <View className="flex-1">
                <Text className="font-sans text-[15px] font-semibold text-foreground">{nft.name ?? "Unnamed item"}</Text>
                <Text className="font-sans text-[11px] text-muted-foreground">{nft.mint.slice(0, 4)}…{nft.mint.slice(-4)}</Text>
              </View>
            </View>
          ))}
          {nfts.length > 0 && (
            <Text style={s.hint}>SPL collectibles only — Token-2022 and compressed NFTs need a DAS RPC.</Text>
          )}
        </>
      )}
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityState={{ selected: active }}>
      <Text className={`pb-1 font-sans text-sm font-medium ${active ? "border-b border-foreground text-foreground" : "text-muted-foreground"}`}>{label}</Text>
    </TouchableOpacity>
  );
}
