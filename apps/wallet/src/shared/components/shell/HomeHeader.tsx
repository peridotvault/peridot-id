import { BrandTop } from "./BrandTop";
import { ProfileButton } from "./ProfileButton";

// Phone / two-column header: logo left, profile right. The identity itself
// (PID + display name) lives on Profile, not here.
export function HomeHeader({
  displayName,
  avatarUrl,
  level,
  onProfile,
}: {
  displayName: string | null;
  avatarUrl: string | null;
  level: number | null;
  onProfile: () => void;
}) {
  return (
    <div style={{ flexDirection: "row" }} className="flex items-center justify-between gap-3">
      <BrandTop />
      <ProfileButton displayName={displayName} avatarUrl={avatarUrl} level={level} onProfile={onProfile} />
    </div>
  );
}
