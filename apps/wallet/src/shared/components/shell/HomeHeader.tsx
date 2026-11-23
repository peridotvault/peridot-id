import { BrandTop } from "./BrandTop";
import { ProfileMenu } from "./ProfileMenu";
import type { AccountMenuModel } from "./AccountMenu";

// Phone / two-column header: logo left, profile right. The identity itself
// (PID + display name) lives on Profile, not here — the profile button opens the
// account popover so switching identity never needs a separate screen.
export function HomeHeader({
  displayName,
  avatarUrl,
  level,
  menu,
  onProfile,
}: {
  displayName: string | null;
  avatarUrl: string | null;
  level: number | null;
  menu: AccountMenuModel;
  onProfile: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <BrandTop />
      <ProfileMenu displayName={displayName} avatarUrl={avatarUrl} level={level} menu={menu} onProfile={onProfile} />
    </div>
  );
}
