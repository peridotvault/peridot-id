import { useState } from "react";

/**
 * Catalogue icon with an explicit fallback. Only an `<img>` is rendered — never
 * SVG/HTML from the catalogue (no injection surface) — and no credentials are
 * sent with the request (no token leak to asset hosts).
 */
export function ProviderIcon({
  provider,
  size = 28,
}: {
  provider: { name: string; imageUrl: string | null };
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!provider.imageUrl || failed) {
    return (
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-muted/50 text-xs font-semibold text-muted-foreground"
        style={{ width: size, height: size }}
      >
        {provider.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={provider.imageUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-md border border-line bg-background object-contain"
      style={{ width: size, height: size }}
    />
  );
}
