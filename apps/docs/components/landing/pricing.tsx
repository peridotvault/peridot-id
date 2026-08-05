"use client";

import { AsciiIcon, type Shape } from "@/components/landing/ascii-icon";
import { CutButton } from "@/components/landing/cut-button";
import { useReducedMotion } from "@/lib/motion";
import { CircleCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type CSSProperties, type ReactNode } from "react";

type Tier = {
  name: string;
  blurb: string;
  monthly: number;
  yearly: number;
  icon: Shape;
  features: string[];
  cta: string;
  highlighted?: boolean;
};

const TIERS: Tier[] = [
  {
    name: "Starter",
    blurb: "For small studios unlocking the basics.",
    monthly: 12,
    yearly: 9,
    icon: "bolt",
    features: [
      "Up to 1,000 monthly active players",
      "Google sign-in",
      "Session management",
      "7-day audit retention",
      "Community support",
    ],
    cta: "Start for free",
  },
  {
    name: "Team",
    blurb: "Shared identity for fast-moving products.",
    monthly: 28,
    yearly: 21,
    icon: "plus",
    features: [
      "Everything in Starter",
      "Unlimited titles",
      "Unified player profiles",
      "90-day audit retention",
      "SSO & SCIM provisioning",
      "Priority support",
    ],
    cta: "Start free trial",
    highlighted: true,
  },
  {
    name: "Scale",
    blurb: "Provable governance for large ecosystems.",
    monthly: 48,
    yearly: 36,
    icon: "bars",
    features: [
      "Everything in Team",
      "Row-level access control",
      "SAML / OIDC SSO",
      "Immutable audit trail",
      "1-year audit retention",
      "Custom domain & SLAs",
    ],
    cta: "Start free trial",
  },
];

const EASE = [0.22, 1, 0.36, 1] as const;

const CARD_CLIP =
  "polygon(0 0, calc(100% - 34px) 0, 100% 34px, 100% 100%, 0 100%)";

function PriceValue({
  value,
  yearly,
  reduce,
}: {
  value: number;
  yearly: boolean;
  reduce: boolean;
}): ReactNode {
  const enterY = reduce ? 0 : yearly ? "-110%" : "110%";
  const exitY = reduce ? 0 : yearly ? "110%" : "-110%";

  return (
    <span className="relative inline-flex overflow-hidden tabular-nums leading-none">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: enterY, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: exitY, opacity: 0 }}
          transition={{ duration: reduce ? 0.001 : 0.45, ease: EASE }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function Toggle({
  yearly,
  setYearly,
  reduce,
}: {
  yearly: boolean;
  setYearly: (value: boolean) => void;
  reduce: boolean;
}): ReactNode {
  const options = [
    { id: "monthly", label: "Monthly", value: false },
    { id: "yearly", label: "Yearly", value: true },
  ] as const;

  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted p-1">
      {options.map((opt) => {
        const isActive = opt.value === yearly;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => setYearly(opt.value)}
            aria-pressed={isActive}
            className="focus-ring relative rounded-[5px] px-4 py-1.5 text-sm font-medium"
          >
            {isActive && (
              <motion.span
                layoutId="pricing-toggle-active"
                className="absolute inset-0 rounded-[5px] bg-background shadow-sm"
                transition={
                  reduce
                    ? { duration: 0.001 }
                    : { type: "spring", stiffness: 420, damping: 34 }
                }
              />
            )}
            <span
              className={`relative z-10 flex items-center gap-2 transition-colors ${
                isActive ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {opt.label}
              {opt.value && (
                <span className="rounded-[3px] bg-[#2f80ff] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                  -25%
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Pricing(): ReactNode {
  const [yearly, setYearly] = useState(false);
  const reduce = useReducedMotion();
  const clip = { clipPath: CARD_CLIP } as CSSProperties;

  return (
    <section
      id="pricing"
      className="mx-auto max-w-[1440px] scroll-mt-24 px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10"
    >
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-balance font-serif text-3xl font-normal leading-[1.12] tracking-[-0.01em] sm:text-4xl lg:text-[2.75rem]">
            One identity, priced to{" "}
            <span className="font-sans font-semibold tracking-tight">scale</span>{" "}
            with your playerbase
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Every plan runs the full Peridot ID engine. Add titles, sessions, and
            governance as your ecosystem grows — billed per user, with no
            per-sign-in surprises.
          </p>
        </div>
        <div className="shrink-0">
          <Toggle yearly={yearly} setYearly={setYearly} reduce={reduce} />
        </div>
      </div>

      <div className="mt-12 grid gap-5 lg:grid-cols-3 lg:gap-6">
        {TIERS.map((tier) => {
          const price = yearly ? tier.yearly : tier.monthly;
          return (
            <div
              key={tier.name}
              className={`p-px ${tier.highlighted ? "bg-[#2f80ff]" : "bg-border"}`}
              style={clip}
            >
              <article
                className="flex h-full flex-col bg-background p-6 sm:p-7"
                style={clip}
              >
                <header className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-lg font-semibold tracking-tight">
                        {tier.name}
                      </h3>
                      {tier.highlighted && (
                        <span className="rounded-[3px] bg-[#2f80ff] px-2 py-0.5 text-[11px] font-semibold leading-none text-white">
                          Most popular
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      {tier.blurb}
                    </p>
                  </div>
                  <AsciiIcon
                    shape={tier.icon}
                    cols={10}
                    className="-mt-1 shrink-0"
                  />
                </header>

                <div className="mt-6 flex items-end">
                  <span className="self-start pt-1 text-2xl font-semibold tracking-tight">
                    $
                  </span>
                  <span className="font-sans text-5xl font-semibold leading-none tracking-tight">
                    <PriceValue value={price} yearly={yearly} reduce={reduce} />
                  </span>
                  <span className="ml-2 pb-1 text-sm text-muted-foreground">
                    / user / mo
                  </span>
                </div>
                <div className="mt-2 h-5 text-xs text-muted-foreground">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={yearly ? "annual" : "monthly"}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduce ? 0.001 : 0.2 }}
                      className="inline-block"
                    >
                      {yearly
                        ? "billed annually per user"
                        : "billed monthly per user"}
                    </motion.span>
                  </AnimatePresence>
                </div>

                <div className="my-6 border-t border-dotted border-border" />

                <ul className="flex-1 space-y-3">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5">
                      <CircleCheck
                        className="mt-0.5 h-[18px] w-[18px] shrink-0 text-[#2f80ff]"
                        aria-hidden="true"
                      />
                      <span className="text-sm leading-relaxed text-muted-foreground">
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-8">
                  <CutButton
                    href="/docs/getting-started"
                    variant={tier.highlighted ? "solid" : "outline"}
                    fullWidth
                  >
                    {tier.cta}
                  </CutButton>
                </div>
              </article>
            </div>
          );
        })}
      </div>

      <div className="mt-6 bg-border p-px" style={clip}>
        <div
          className="flex flex-col gap-6 bg-background p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8"
          style={clip}
        >
          <div>
            <h3 className="font-serif text-xl font-normal tracking-[-0.01em] sm:text-2xl">
              Need a tailored deployment?
            </h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Talk to our team about Enterprise SLAs, on-prem and self-hosted
              installs, and custom data residency.
            </p>
          </div>
          <CutButton
            href="/docs/self-hosting"
            variant="outline"
            className="self-start shrink-0 sm:self-auto"
          >
            Read self-hosting docs
          </CutButton>
        </div>
      </div>
    </section>
  );
}
