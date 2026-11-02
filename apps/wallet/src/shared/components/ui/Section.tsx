import type { ComponentProps } from "react";

// Stacked block of a screen. The container owns the lines (brand.md): the top
// border runs rail to rail, so a Section carries no padding of its own — the
// content inside does (`SectionHead` for titles/text, `px-6` on list rows).
// The first block on a screen passes className="border-t-0".
export function Section({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section {...rest} className={`border-t border-line ${className ?? ""}`}>
      {children}
    </section>
  );
}

/** Padded text/title block inside a Section. */
export function SectionHead({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div {...rest} className={`px-6 py-5 ${className ?? ""}`}>
      {children}
    </div>
  );
}
