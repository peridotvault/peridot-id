import { AsciiIcon } from "@/components/landing/ascii-icon";
import { CutButton } from "@/components/landing/cut-button";
import { ArrowRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

type Shape = "scan" | "shield" | "key";

type Feature = {
  shape: Shape;
  title: string;
  body: string;
  meta: string;
  href: string;
};

const FEATURES: Feature[] = [
  {
    shape: "scan",
    title: "One identity, every product",
    body: "Every game, web app, and tool in the ecosystem reads the same player profile — sign in once and it just works everywhere.",
    meta: "Identity · Peridot ID Core",
    href: "/docs/getting-started",
  },
  {
    shape: "shield",
    title: "Sessions without the drift",
    body: "Centralized session management keeps tokens fresh, valid, and revocable — no more duplicated logins or stale auth state.",
    meta: "Sessions · Peridot ID Auth",
    href: "/docs/authentication",
  },
  {
    shape: "key",
    title: "Provable, sealed control",
    body: "OAuth2-ready flows, hardware-backed keys, and full audit trails keep every sign-in accountable and ready for any auditor.",
    meta: "Governance · Peridot ID Vault",
    href: "/docs/api",
  },
];

const CARD_CLIP =
  "polygon(0 0, calc(100% - 34px) 0, 100% 34px, 100% 100%, 0 100%)";

export function Features(): ReactNode {
  const clip = { clipPath: CARD_CLIP } as CSSProperties;

  return (
    <section className="mx-auto max-w-[1440px] px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10">
      <div className="max-w-2xl">
        <h2 className="text-balance font-serif text-3xl font-normal leading-[1.12] tracking-[-0.01em] sm:text-4xl lg:text-[2.75rem]">
          One platform that{" "}
          <span className="font-sans font-semibold tracking-tight">unifies</span>,{" "}
          <span className="font-sans font-semibold tracking-tight">secures</span>,
          and{" "}
          <span className="font-sans font-semibold tracking-tight">scales</span>{" "}
          every sign-in
        </h2>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Peridot ID collapses fragmented accounts into a single system of record
          — built to sign in, manage sessions, and prove control without the
          integration tax.
        </p>
      </div>

      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
        {FEATURES.map((feature) => (
          <div key={feature.title} className="bg-border p-px" style={clip}>
            <article
              className="flex h-full flex-col bg-background p-6 sm:p-7"
              style={clip}
            >
              <h3 className="text-lg font-semibold tracking-tight">
                {feature.title}
              </h3>

              <div className="my-5 border-t border-dotted border-border" />
              <div className="flex justify-center py-6 sm:py-8">
                <AsciiIcon shape={feature.shape} />
              </div>
              <div className="mb-6 border-t border-dotted border-border" />

              <p className="text-sm leading-relaxed text-muted-foreground">
                {feature.body}
              </p>

              <div className="mt-auto flex items-center justify-between gap-4 pt-8">
                <span className="text-xs font-medium text-muted-foreground">
                  {feature.meta}
                </span>
                <CutButton
                  href={feature.href}
                  variant="outline"
                  iconOnly
                  aria-label={`Learn more about ${feature.title}`}
                >
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </CutButton>
              </div>
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}
