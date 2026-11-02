import { EYEBROW_UPPER, MUTED } from "./ui";

/** Workspace header: same rule language as the content blocks (no floating frame). */
export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="border-t border-line bg-background px-6 py-8 sm:px-8 sm:py-10">
      <p className={EYEBROW_UPPER}>{eyebrow}</p>
      <h1 className="mt-2 font-sans text-4xl font-normal leading-[1.12] tracking-[-0.01em] sm:text-5xl">
        {title}
      </h1>
      {description && (
        <p className={`mt-3 max-w-xl text-sm sm:text-base ${MUTED}`}>{description}</p>
      )}
    </div>
  );
}
