// The origin is the one value on a consent screen the user can verify for
// themselves, so it stays visible under the app's name even when the app
// supplies its own branding. Host (not path) keeps the port when the app runs
// on one — `https://a.com` and `https://a.com:8443` are different principals.
export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Middle-truncated so a long subdomain can't push the domain suffix off-screen. */
function middle(text: string, max = 32): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

export function AppOriginBadge({ origin, className }: { origin: string; className?: string }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-md border border-border bg-elevated px-2 py-1 font-mono text-xs text-paragraph ${className ?? ""}`}
      title={origin}
    >
      {middle(originHost(origin))}
    </span>
  );
}
