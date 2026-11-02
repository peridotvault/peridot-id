import { useNetworkMode } from "../../hooks/useNetworkMode";
import { useHeaderProfile } from "../../hooks/useHeaderProfile";
import { HomeHeader } from "./HomeHeader";

// Header for phone / two-column layouts: brand + profile on one row, plus the
// persistent TESTNET badge (ANT-15 safety req 4). Mounted once by the shell on
// tab roots so it never unmounts on navigation. On three-column desktop it is
// not rendered — the brand moves into the nav and the profile into InfoRail.
export function TopBar({
  onProfile,
  refreshKey,
}: {
  onProfile: () => void;
  refreshKey: string;
}) {
  const net = useNetworkMode();
  const { displayName, avatarUrl, level } = useHeaderProfile(refreshKey);

  return (
    <div className="flex flex-col">
      <div className="px-6 pb-3 pt-5">
        <HomeHeader displayName={displayName} avatarUrl={avatarUrl} level={level} onProfile={onProfile} />
      </div>
      {net.testnet && (
        <div className="border-t border-secondary bg-secondary px-6 py-1.5">
          <span className="font-sans text-xs font-bold tracking-[1px] text-foreground">TESTNET</span>
        </div>
      )}
    </div>
  );
}
