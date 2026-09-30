import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { NftItem } from "@peridotvault/pid-solana";
import { theme, styles as s } from "../../../shared/theme";
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
      <View style={styles.plainTabs}>
        <TabButton label="Tokens" active={tab === "tokens"} onPress={() => onTabChange("tokens")} />
        <TabButton label="Items" active={tab === "items"} onPress={() => onTabChange("items")} />
      </View>
      {tab === "tokens" ? (
        <>
          {coins.length === 0 && !busy && (
            <Text style={s.hint}>No assets yet — receive SOL to your address to get started.</Text>
          )}
          {coins.map((coin) => (
            <View key={coin.key} style={styles.coinRow}>
              <View style={styles.coinMeta}>
                <Text style={styles.coinSymbol}>{coin.symbol}</Text>
                {coin.symbol !== "SOL" && <Text style={styles.coinMint}>{coin.key.slice(0, 4)}…{coin.key.slice(-4)}</Text>}
              </View>
              <Text style={styles.coinAmount}>{coin.amount}</Text>
            </View>
          ))}
        </>
      ) : (
        <>
          {nfts.length === 0 && !busy && (
            <Text style={s.hint}>No items yet — SPL collectibles in this wallet appear here.</Text>
          )}
          {nfts.map((nft) => (
            <View key={nft.mint} style={styles.coinRow}>
              <View style={styles.coinMeta}>
                <Text style={styles.coinSymbol}>{nft.name ?? "Unnamed item"}</Text>
                <Text style={styles.coinMint}>{nft.mint.slice(0, 4)}…{nft.mint.slice(-4)}</Text>
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
      <Text style={[styles.plainTabLabel, active && styles.plainTabLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  coinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  coinMeta: { flex: 1 },
  coinSymbol: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  coinMint: { fontSize: 11, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  coinAmount: { fontSize: 15, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  plainTabs: { flexDirection: "row", gap: 20, paddingVertical: 6 },
  plainTabLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.mutedForeground, fontFamily: theme.fonts.sansMedium, paddingBottom: 4 },
  plainTabLabelActive: { color: theme.colors.foreground, borderBottomWidth: 1, borderBottomColor: theme.colors.foreground },
});
