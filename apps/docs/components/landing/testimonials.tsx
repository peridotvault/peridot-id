"use client";

import { AsciiPortrait } from "@/components/landing/ascii-portrait";
import { CornerPlus, Kicker } from "@/components/landing/corner-plus";
import { CutButton } from "@/components/landing/cut-button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type CSSProperties, type ReactNode } from "react";

type Testimonial = {
  quote: string;
  name: string;
  role: string;
  image: string;
};

const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "The flexibility is really what made the difference. Our studio ships a new game every quarter — I wire up a new title and in two clicks it already shares the same identity. That is a real advantage when you are moving quickly.",
    name: "Olivier Reinaud",
    role: "Co-founder at NetZero Games",
    image: "/testimonials/person-1.jpg",
  },
  {
    quote:
      "We cut login churn from minutes to seconds. Instead of drowning players in new accounts, Peridot ID hands them the one Google sign-in that just works — every single time.",
    name: "Priya Anand",
    role: "Head of Platform at Halcyon",
    image: "/testimonials/person-2.jpg",
  },
  {
    quote:
      "Consolidating six auth flows into one identity paid for itself in a quarter. The session and audit trail alone turned a two-week compliance scramble into an afternoon. Nothing slips through anymore.",
    name: "Marcus Webb",
    role: "Staff Engineer at Arc Play",
    image: "/testimonials/person-3.jpg",
  },
];

export function Testimonials(): ReactNode {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const active = TESTIMONIALS[index];
  if (!active) return null;

  const go = (delta: number) => {
    setDirection(delta);
    setIndex((i) => (i + delta + TESTIMONIALS.length) % TESTIMONIALS.length);
  };

  return (
    <section className="mx-auto max-w-[1440px] px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10">
      <div className="grid items-stretch gap-10 lg:grid-cols-[1fr_1.35fr] lg:gap-12">
        <div className="flex items-center">
          <div
            style={{ "--cut": "28px" } as CSSProperties}
            className="relative aspect-[4/5] w-full overflow-hidden [clip-path:polygon(var(--cut)_0,100%_0,100%_calc(100%-var(--cut)),calc(100%-var(--cut))_100%,0_100%,0_var(--cut))]"
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={active.image}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35 }}
                className="absolute inset-0"
              >
                <AsciiPortrait
                  src={active.image}
                  className="block h-full w-full object-cover"
                />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className="relative flex flex-col lg:border-l lg:border-border lg:pl-12">
          <CornerPlus className="left-0 top-0 hidden -translate-x-1/2 -translate-y-1/2 lg:block" />
          <CornerPlus className="bottom-0 left-0 hidden -translate-x-1/2 translate-y-1/2 lg:block" />
          <Kicker>Real reviews from real studios</Kicker>

          <div className="mt-6 flex-1">
            <AnimatePresence mode="wait">
              <motion.blockquote
                key={active.quote}
                initial={{ opacity: 0, x: direction * 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * -24 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="text-balance font-serif text-2xl font-normal leading-[1.28] tracking-[-0.01em] sm:text-3xl lg:text-[2.25rem] lg:leading-[1.3]"
              >
                {active.quote}
              </motion.blockquote>
            </AnimatePresence>
          </div>

          <div className="mt-10 flex items-end justify-between gap-6">
            <div className="flex items-center gap-4">
              <div className="flex gap-2">
                <CutButton
                  variant="outline"
                  iconOnly
                  onClick={() => go(-1)}
                  aria-label="Previous testimonial"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </CutButton>
                <CutButton
                  variant="outline"
                  iconOnly
                  onClick={() => go(1)}
                  aria-label="Next testimonial"
                >
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </CutButton>
              </div>
              <div className="flex items-center gap-1.5">
                {TESTIMONIALS.map((t, i) => (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => {
                      setDirection(i > index ? 1 : -1);
                      setIndex(i);
                    }}
                    aria-label={`Show testimonial ${i + 1}`}
                    aria-current={i === index}
                    className={`h-2 rounded-[2px] transition-all duration-300 focus-ring ${
                      i === index
                        ? "w-5 bg-[#2f80ff]"
                        : "w-2 bg-border hover:bg-muted-foreground/50"
                    }`}
                  />
                ))}
              </div>
            </div>

            <div className="text-right">
              <div className="text-sm font-semibold tracking-tight">
                {active.name}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {active.role}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
