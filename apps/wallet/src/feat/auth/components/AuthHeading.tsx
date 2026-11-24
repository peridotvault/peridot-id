import { AppOriginBadge } from "./AppOriginBadge";

// Card heading for the identity steps (sign-in, email code, PID claim): the
// origin badge the user verifies, the screen's h1 (exactly one per screen) and
// an optional line under it. No logo and no tagline — the brand lives in the
// topbar, so these screens stay one seamless surface. App cards that introduce
// an app (consent, approval) put this under their logo + tagline block.
export function AuthHeading({
  origin,
  title,
  subtitle,
  verified,
  align = "left",
}: {
  origin?: string | null;
  title: string;
  subtitle?: string;
  /** Verified partner: PeridotID fee waived (trust signal). */
  verified?: boolean;
  /** Heading alignment; identity steps centre it, app cards keep it left. */
  align?: "left" | "center";
}) {
  const pos = align === "center" ? "self-center text-center" : "self-start text-left";
  return (
    <div className="flex flex-col items-center gap-2">
      {origin ? <AppOriginBadge origin={origin} /> : null}
      <h1 className={`${pos} font-sans text-xl font-semibold text-foreground`}>{title}</h1>
      {subtitle ? (
        <span className={`${pos} font-sans text-sm text-paragraph`}>{subtitle}</span>
      ) : null}
      {verified ? (
        <span className="text-center font-sans text-xs text-success">
          <span aria-hidden="true">✓ </span>Verified partner — 0% PeridotID fee
        </span>
      ) : null}
    </div>
  );
}
