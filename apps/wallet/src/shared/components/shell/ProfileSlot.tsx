import { useHeaderProfile } from "../../hooks/useHeaderProfile";
import { useAccountMenu } from "../../hooks/useAccountMenu";
import { ProfileMenu } from "./ProfileMenu";

// Profile corner outside the phone header: the desktop sidebar docks it under
// the tabs. Same popover as the header, so switching identity works the same
// on every layout.
export function ProfileSlot({
  onProfile,
  onSwitched,
  refreshKey,
}: {
  onProfile: () => void;
  onSwitched: () => void;
  refreshKey: string;
}) {
  const { displayName, avatarUrl, level } = useHeaderProfile(refreshKey);
  const menu = useAccountMenu(onSwitched);

  return (
    <ProfileMenu
      displayName={displayName}
      avatarUrl={avatarUrl}
      level={level}
      menu={menu}
      onProfile={onProfile}
    />
  );
}
