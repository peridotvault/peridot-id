import type { ReactNode } from "react";

// Ported verbatim from apps/docs/components/landing/corner-plus.tsx (PlusSvg +
// CornerPlus only — the Kicker export is landing-specific and not ported).

function PlusSvg({ className }: { className: string }): ReactNode {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className}>
      <path
        d="M12 4v16M4 12h16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CornerPlus({ className }: { className: string }): ReactNode {
  return (
    <PlusSvg
      className={`pointer-events-none absolute z-10 h-3.5 w-3.5 text-brand-1 dark:text-brand-2 ${className}`}
    />
  );
}
