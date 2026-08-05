"use client";

import { CornerPlus } from "@/components/landing/corner-plus";
import { useReducedMotion } from "@/lib/motion";
import { animate, useInView } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type Brand = { slug: string; name: string; width: number; height: number };

type Stat = {
  value: number;
  prefix?: string;
  suffix?: string;
  label: string;
  brand: Brand;
};

const STATS: Stat[] = [
  {
    value: 97,
    suffix: "%",
    label: "Reduction in login churn",
    brand: { slug: "stripe_wordmark", name: "Stripe", width: 62, height: 26 },
  },
  {
    value: 6,
    label: "Auth flows replaced by one identity",
    brand: { slug: "dropbox_wordmark", name: "Dropbox", width: 104, height: 28 },
  },
  {
    value: 10,
    suffix: "x",
    label: "Faster time to first session",
    brand: { slug: "vercel_wordmark", name: "Vercel", width: 92, height: 18 },
  },
];

const EASE = [0.22, 1, 0.36, 1] as const;

function StatBrand({ brand }: { brand: Brand }): ReactNode {
  const mask = `url(/logos/${brand.slug}.svg) center / contain no-repeat`;
  return (
    <span
      role="img"
      aria-label={brand.name}
      style={
        {
          width: brand.width,
          height: brand.height,
          mask,
          WebkitMask: mask,
        } as CSSProperties
      }
      className="block shrink-0 bg-foreground opacity-50"
    />
  );
}

function StatNumber({
  value,
  prefix,
  suffix,
  inView,
  reduce,
  delay,
}: {
  value: number;
  prefix: string;
  suffix: string;
  inView: boolean;
  reduce: boolean;
  delay: number;
}): ReactNode {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      const raf = requestAnimationFrame(() => setDisplay(value));
      return () => cancelAnimationFrame(raf);
    }
    const controls = animate(0, value, {
      duration: 1.6,
      delay,
      ease: EASE,
      onUpdate: (latest) => setDisplay(latest),
    });
    return () => controls.stop();
  }, [inView, reduce, value, delay]);

  return (
    <span className="block font-serif text-5xl font-normal leading-none tracking-[-0.02em] tabular-nums sm:text-6xl">
      <span aria-hidden="true">{`${prefix}${Math.round(display)}${suffix}`}</span>
      <span className="sr-only">{`${prefix}${value}${suffix}`}</span>
    </span>
  );
}

export function Stats(): ReactNode {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const inView = useInView(panelRef, { once: true, margin: "-80px" });

  return (
    <section
      id="customers"
      className="mx-auto max-w-[1440px] scroll-mt-24 px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10"
    >
      <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
        <div className="lg:pt-6">
          <h2 className="text-balance font-serif text-3xl font-normal leading-[1.12] tracking-[-0.01em] sm:text-4xl lg:text-[2.75rem]">
            Real outcomes from teams running{" "}
            <span className="font-sans font-semibold tracking-tight">
              Peridot ID
            </span>
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            From faster sign-in to a leaner stack, studios cut the friction and
            consolidate auth the moment Peridot ID goes live — with full
            governance from day one.
          </p>
        </div>

        <div ref={panelRef} className="relative border border-border">
          <CornerPlus className="left-0 top-0 -translate-x-1/2 -translate-y-1/2" />
          <CornerPlus className="right-0 top-0 translate-x-1/2 -translate-y-1/2" />
          <CornerPlus className="bottom-0 left-0 -translate-x-1/2 translate-y-1/2" />
          <CornerPlus className="bottom-0 right-0 translate-x-1/2 translate-y-1/2" />

          {STATS.map((stat, i) => (
            <div
              key={stat.label}
              className={`relative flex items-center justify-between gap-6 px-6 py-9 sm:px-8 sm:py-11 ${
                i > 0 ? "border-t border-border" : ""
              }`}
            >
              {i > 0 && (
                <>
                  <CornerPlus className="left-0 top-0 -translate-x-1/2 -translate-y-1/2" />
                  <CornerPlus className="right-0 top-0 translate-x-1/2 -translate-y-1/2" />
                </>
              )}
              <div>
                <StatNumber
                  value={stat.value}
                  prefix={stat.prefix ?? ""}
                  suffix={stat.suffix ?? ""}
                  inView={inView}
                  reduce={reduce}
                  delay={i * 0.12}
                />
                <p className="mt-3 text-sm text-muted-foreground sm:text-base">
                  {stat.label}
                </p>
              </div>
              <StatBrand brand={stat.brand} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
