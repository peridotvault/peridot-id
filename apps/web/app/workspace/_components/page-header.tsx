"use client";

import { CornerPlus } from "@/components/landing/corner-plus";
import { EYEBROW_UPPER, MUTED } from "./ui";

/** Framed workspace header: landing stats-panel border + corner marks, solid surface. */
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
    <div className="relative border border-border bg-background px-6 py-8 sm:px-8 sm:py-10">
      <CornerPlus className="left-0 top-0 -translate-x-1/2 -translate-y-1/2" />
      <CornerPlus className="right-0 top-0 translate-x-1/2 -translate-y-1/2" />
      <CornerPlus className="bottom-0 left-0 -translate-x-1/2 translate-y-1/2" />
      <CornerPlus className="bottom-0 right-0 translate-x-1/2 translate-y-1/2" />
      <p className={EYEBROW_UPPER}>{eyebrow}</p>
      <h1 className="mt-2 font-serif text-4xl font-normal leading-[1.12] tracking-[-0.01em] sm:text-5xl">
        {title}
      </h1>
      {description && (
        <p className={`mt-3 max-w-xl text-sm sm:text-base ${MUTED}`}>{description}</p>
      )}
    </div>
  );
}
