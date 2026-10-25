import { Pressable } from "../../../shared/components/Pressable";
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
      <div style={{ flexDirection: "row" }} className="flex flex-col gap-5 py-1.5">
        <TabButton label="Tokens" active={tab === "tokens"} onPress={() => onTabChange("tokens")} />
        <TabButton label="Items" active={tab === "items"} onPress={() => onTabChange("items")} />
      </div>
      {tab === "tokens" ? (
        <>
          {coins.length === 0 && !busy && (
            <p style={s.hint}>No assets yet — receive SOL to your address to get started.</p>
          )}
          {coins.map((coin) => (
            <div key={coin.key} style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3 border-b border-border py-2.5">
              <div className="flex flex-col flex-1">
                <span className="font-sans text-base font-semibold text-foreground">{coin.symbol}</span>
                {coin.symbol !== "SOL" && <span className="font-sans text-xs text-muted-foreground">{coin.key.slice(0, 4)}…{coin.key.slice(-4)}</span>}
              </div>
              <span className="font-mono text-base font-medium text-foreground">{coin.amount}</span>
            </div>
          ))}
        </>
      ) : (
        <>
          {nfts.length === 0 && !busy && (
            <p style={s.hint}>No items yet — SPL collectibles in this wallet appear here.</p>
          )}
          {nfts.map((nft) => (
            <div key={nft.mint} style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3 border-b border-border py-2.5">
              <div className="flex flex-col flex-1">
                <span className="font-sans text-base font-semibold text-foreground">{nft.name ?? "Unnamed item"}</span>
                <span className="font-sans text-xs text-muted-foreground">{nft.mint.slice(0, 4)}…{nft.mint.slice(-4)}</span>
              </div>
            </div>
          ))}
          {nfts.length > 0 && (
            <p style={s.hint}>SPL collectibles only — Token-2022 and compressed NFTs need a DAS RPC.</p>
          )}
        </>
      )}
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityState={{ selected: active }}>
      <span className={`pb-1 font-sans text-sm font-medium ${active ? "border-b border-foreground text-foreground" : "text-muted-foreground"}`}>{label}</span>
    </Pressable>
  );
}
