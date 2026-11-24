import { cn } from "../../styles/cn";

/** Public source of truth for the code behind this app (footer + About page). */
export const SOURCE_CODE_URL = "https://github.com/peridotvault/peridot-id";

// Quiet bottom bar for the public surfaces (sign-in, /about): copyright plus
// the two things a stranger looks for. No language switch yet — copy is
// English-only until the whole wallet is translated.
export function PageFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-4 font-sans text-xs text-muted-foreground",
        className,
      )}
    >
      <span>© PeridotID</span>
      <nav className="flex items-center gap-4">
        <a href="/about" className="outline-0 hover:text-foreground focus-visible:underline">
          About
        </a>
        <a
          href={SOURCE_CODE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="outline-0 hover:text-foreground focus-visible:underline"
        >
          Source code
        </a>
      </nav>
    </footer>
  );
}
