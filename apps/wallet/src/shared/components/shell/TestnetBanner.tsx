import { useNetworkMode } from "../../hooks/useNetworkMode";

// Announcement bar at the very top of the app (above the header, nav and info
// rail): the persistent TESTNET warning — ANT-15 safety req 4. Mounted once by
// AppColumn so every screen, push and column layout carries it.
export function TestnetBanner() {
  const net = useNetworkMode();
  if (!net.testnet) return null;
  return (
    <div className="w-full border-b border-secondary bg-secondary px-6 py-2 text-center">
      <span className="font-sans text-xs font-bold tracking-[1px] text-foreground">TESTNET — test money only</span>
    </div>
  );
}
