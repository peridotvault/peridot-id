import { Pressable } from "../../../shared/components/Pressable";

// Identity header (shell chrome). Left: PID + display name. Right: profile
// photo with the level chip beside it — tapping opens Profile. The level rides
// on the profile.me() read TopBar already does, so showing it costs nothing.
export function HomeHeader({
  pid,
  displayName,
  avatarUrl,
  level,
  onProfile,
}: {
  pid: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  level: number | null;
  onProfile: () => void;
}) {
  const initial = (displayName ?? "?").slice(0, 1).toUpperCase();
  return (
    <div style={{ flexDirection: "row" }} className="flex flex-col items-center justify-between gap-3">
      <div className="flex flex-col flex-1 gap-1">
        <span className="font-sans text-xl font-semibold text-foreground">{pid ?? "…"}</span>
        {displayName ? <span className="font-sans text-sm text-muted-foreground">{displayName}</span> : null}
      </div>
      <Pressable
        onPress={onProfile}
        accessibilityLabel={level === null ? "Profile" : `Profile, level ${level}`}
      >
        <div className="flex bg-surface py-1 pr-1 pl-2 gap-2 border border-border">
          {level !== null && (
            <div className="flex items-center justify-center min-w-6 px-1">
              <span className="font-level leading-none text-foreground">{level}</span>
            </div>
          )}
          <div className="h-10 w-10 border-border border">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full" />
            ) : (
              <div className="flex flex-col h-full w-full items-center justify-center" aria-label="No profile photo">
                <span aria-hidden="true" className="font-serif text-base">
                  {initial}
                </span>
              </div>
            )}
          </div>
        </div>
      </Pressable>
    </div>
  );
}
