import { useState } from "react";
import { Globe } from "../../../shared/components/icons";

// App tile on the consent screens: the owner-set logo, or a generic glyph when
// the app has none or the URL fails to decode (never a broken-image icon).
export function AppLogo({
  logoUrl,
  name,
  size = "md",
}: {
  logoUrl?: string | null;
  name?: string | null;
  size?: "sm" | "md";
}) {
  // Keyed by value, so a later valid logo still renders after one fails.
  const [failed, setFailed] = useState<string | null>(null);
  const src = logoUrl && logoUrl !== failed ? logoUrl : null;

  return (
    <div
      className={`flex ${size === "md" ? "h-20 w-20" : "h-10 w-10"} shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface`}
    >
      {src ? (
        <img
          src={src}
          alt={name ? `${name} logo` : "App logo"}
          className="h-full w-full object-contain"
          onError={() => setFailed(src)}
        />
      ) : (
        <Globe size={size === "md" ? 24 : 16} className="text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}
