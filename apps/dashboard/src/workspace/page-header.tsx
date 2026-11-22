import type { ReactNode } from "react";
import { EYEBROW_UPPER, MUTED } from "./ui";

/** Page header. The page container owns horizontal padding and width; this only
 *  sets the type scale so every screen starts the same way. */
export function PageHeader({
  eyebrow,
  title,
  description,
  meta,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  /** Small identity row (ids, status) that belongs to the title, not prose. */
  meta?: ReactNode;
}) {
  return (
    <header className="pb-6">
      <p className={EYEBROW_UPPER}>{eyebrow}</p>
      <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-[-0.01em] sm:text-4xl">{title}</h1>
      {meta && <div className="mt-3">{meta}</div>}
      {description && <p className={`mt-2 max-w-2xl text-sm ${MUTED}`}>{description}</p>}
    </header>
  );
}
