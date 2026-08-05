import { CornerPlus } from "@/components/landing/corner-plus";
import { CutButton } from "@/components/landing/cut-button";
import type { CSSProperties, ReactNode } from "react";

const BRAND = { slug: "spotify_wordmark", name: "Spotify", ratio: 73 / 22 };

function InlineWordmark(): ReactNode {
  const mask = `url(/logos/${BRAND.slug}.svg) center / contain no-repeat`;
  return (
    <span
      role="img"
      aria-label={BRAND.name}
      style={
        {
          height: "0.78em",
          width: `${(0.78 * BRAND.ratio).toFixed(3)}em`,
          verticalAlign: "-0.02em",
          mask,
          WebkitMask: mask,
        } as CSSProperties
      }
      className="mr-[0.34em] inline-block bg-foreground align-middle"
    />
  );
}

export function CaseStudy(): ReactNode {
  return (
    <section className="mx-auto max-w-[1440px] px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10">
      <div className="relative border border-border">
        <CornerPlus className="left-0 top-0 -translate-x-1/2 -translate-y-1/2" />
        <CornerPlus className="right-0 top-0 translate-x-1/2 -translate-y-1/2" />
        <CornerPlus className="bottom-0 left-0 -translate-x-1/2 translate-y-1/2" />
        <CornerPlus className="bottom-0 right-0 translate-x-1/2 translate-y-1/2" />

        <div className="grid gap-y-8 lg:grid-cols-[1.55fr_1fr]">
          <div className="px-6 py-10 sm:px-10 sm:py-14 lg:px-14 lg:py-16">
            <h2 className="text-balance font-serif text-[1.75rem] font-normal leading-[1.22] tracking-[-0.01em] sm:text-4xl lg:text-[2.5rem] lg:leading-[1.2]">
              <InlineWordmark />
              unified every player account across games, web, and mobile — giving
              each studio one provable source of truth.
            </h2>
          </div>

          <div className="relative flex flex-col justify-center gap-7 px-6 pb-10 sm:px-10 sm:pb-14 lg:border-l lg:border-border lg:px-12 lg:py-16">
            <CornerPlus className="left-0 top-0 hidden -translate-x-1/2 -translate-y-1/2 lg:block" />
            <CornerPlus className="bottom-0 left-0 hidden -translate-x-1/2 translate-y-1/2 lg:block" />
            <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
              Spotify replaced six disconnected auth flows with Peridot ID,
              wiring sign-in, sessions, and audit into a single governed pipeline
              — and cut time to first session by 10×.
            </p>
            <CutButton
              href="/docs"
              variant="outline"
              className="self-start"
            >
              Read the docs
            </CutButton>
          </div>
        </div>
      </div>
    </section>
  );
}
