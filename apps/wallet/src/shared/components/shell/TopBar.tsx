import { useHeaderProfile } from "../../hooks/useHeaderProfile";
import { useAccountMenu } from "../../hooks/useAccountMenu";
import { HomeHeader } from "./HomeHeader";

// Header for phone / two-column layouts: brand + profile on one row. The
// persistent TESTNET badge lives in TestnetBanner, above the header. Mounted
// once by the shell on tab roots so it never unmounts on navigation. On
// three-column desktop it is not rendered — the brand moves into the nav and
// the profile into InfoRail.
export function TopBar({
  onProfile,
  onSwitched,
  refreshKey,
}: {
  onProfile: () => void;
  /** Account switched from the profile popover: the shell re-bootstraps. */
  onSwitched: () => void;
  refreshKey: string;
}) {
  const { displayName, avatarUrl, level } = useHeaderProfile(refreshKey);
  const menu = useAccountMenu(onSwitched);

  return (
    <div className="flex flex-col">
      <div className="px-6 pb-3 pt-5">
        <HomeHeader displayName={displayName} avatarUrl={avatarUrl} level={level} menu={menu} onProfile={onProfile} />
      </div>
    </div>
  );
}
