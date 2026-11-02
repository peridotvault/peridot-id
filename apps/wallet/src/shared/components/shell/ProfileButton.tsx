import { Pressable } from "../ui/Pressable";

// Profile affordance (shell chrome): level chip + avatar, opens Profile.
// Presentational — the caller owns the profile read.
export function ProfileButton({
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
  const initial = (displayName ?? "?").slice(0, 1).toUpperCase();
  return (
    <Pressable
      onPress={onProfile}
      accessibilityLabel={level === null ? "Profile" : `Profile, level ${level}`}
    >
      <div className="flex items-center gap-2 border border-line py-1 pr-1 pl-2 hover:bg-surface">
        {level !== null && (
          <div className="flex min-w-6 items-center justify-center px-1">
            <span className="font-sans font-semibold leading-none text-foreground">{level}</span>
          </div>
        )}
        <div className="h-10 w-10 border border-line">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center" aria-label="No profile photo">
              <span aria-hidden="true" className="font-sans text-base">
                {initial}
              </span>
            </div>
          )}
        </div>
      </div>
    </Pressable>
  );
}
