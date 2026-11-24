import { useHeaderProfile } from "../../hooks/useHeaderProfile";
import { useAccountMenu } from "../../hooks/useAccountMenu";
import { HomeHeader } from "./HomeHeader";

// Phone header (<768): brand + profile on one row. The persistent TESTNET badge
// lives in TestnetBanner, above the header. Mounted once by the shell on tab
// roots so it never unmounts on navigation. From 768 up it is not rendered at
// all — the brand and the profile move into the sidebar (three-column desktop
// keeps the brand in the nav and moves the profile to InfoRail).
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
