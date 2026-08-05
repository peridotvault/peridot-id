"use client";

import { CutButton } from "@/components/landing/cut-button";
import { CornerPlus } from "@/components/landing/corner-plus";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

type QA = { question: string; answer: string };

const FAQS: QA[] = [
  {
    question: "What exactly is Peridot ID?",
    answer:
      "Peridot ID is a unified identity platform that collapses sign-in, session management, and player profiles into one system of record. Every game, web app, and tool in the ecosystem reads the same identity — so players sign in once and it just works everywhere.",
  },
  {
    question: "Which products and environments does Peridot ID cover?",
    answer:
      "Peridot ID works across web, mobile, and desktop titles from a single control plane. The SDKs cover the common frameworks in minutes, while a full REST API handles anything custom behind your own infrastructure.",
  },
  {
    question: "How does Peridot ID handle data security and compliance?",
    answer:
      "Data is encrypted in transit and at rest with hardware-backed keys, and every sign-in is written to an immutable audit trail. Peridot ID is SOC 2 Type II and ISO 27001 certified, with regional data residency available for GDPR and HIPAA programs.",
  },
  {
    question: "How long does it take to deploy?",
    answer:
      "Most studios ship their first sign-in on day one. Wire up Google OAuth through the guided setup, and Peridot ID starts managing sessions immediately — no professional-services engagement or multi-quarter rollout required.",
  },
  {
    question: "Will it integrate with our existing stack?",
    answer:
      "Yes. Peridot ID ships with native SDKs for the common frameworks plus a full REST API and webhooks, so you can wire unified auth into whatever you already run.",
  },
  {
    question: "How is access controlled and audited?",
    answer:
      "Granular role-based access, SSO, and SCIM provisioning keep permissions tight, while every login and change is logged and exportable. Sessions can be revoked the instant a risky pattern is detected.",
  },
  {
    question: "Can Peridot ID be self-hosted?",
    answer:
      "Teams with strict data-control requirements can run Peridot ID entirely within their own VPC or private cloud. You keep full ownership of the data plane while still receiving managed updates to the identity engine.",
  },
];

const EASE = [0.22, 1, 0.36, 1] as const;

function FaqItem({
  item,
  isOpen,
  onToggle,
  index,
}: {
  item: QA;
  isOpen: boolean;
  onToggle: () => void;
  index: number;
}): ReactNode {
  const panelId = `faq-panel-${index}`;
  const buttonId = `faq-button-${index}`;

  return (
    <div className="border-dotted border-border [&:not(:first-child)]:border-t">
      <h3>
        <button
          id={buttonId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="focus-ring flex w-full items-center justify-between gap-6 py-5 pr-1 text-left lg:py-6 lg:pl-12"
        >
          <span className="text-base font-medium tracking-tight sm:text-lg">
            {item.question}
          </span>
          <motion.span
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronDown className="h-5 w-5" aria-hidden="true" />
          </motion.span>
        </button>
      </h3>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="max-w-xl pb-6 pr-6 text-sm leading-relaxed text-muted-foreground lg:pl-12">
              {item.answer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Faq(): ReactNode {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const accordionRef = useRef<HTMLDivElement | null>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const node = accordionRef.current;
    if (node === null) return;

    let peak = 0;
    let width = node.offsetWidth;

    const observer = new ResizeObserver(() => {
      if (node.offsetWidth !== width) {
        width = node.offsetWidth;
        peak = 0;
        setMinHeight(undefined);
        return;
      }
      const next = node.offsetHeight;
      if (next > peak) {
        peak = next;
        setMinHeight(next);
      }
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="mx-auto max-w-[1440px] px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10">
      <div className="relative grid border-y border-border lg:grid-cols-[0.85fr_1.15fr]">
        {/* Outer frame corners */}
        <CornerPlus className="left-0 top-0 -translate-x-1/2 -translate-y-1/2" />
        <CornerPlus className="right-0 top-0 translate-x-1/2 -translate-y-1/2" />
        <CornerPlus className="bottom-0 left-0 -translate-x-1/2 translate-y-1/2" />
        <CornerPlus className="bottom-0 right-0 translate-x-1/2 translate-y-1/2" />

        {/* Left: heading */}
        <div className="border-b border-border py-10 lg:border-b-0 lg:border-r lg:py-16 lg:pr-12">
          <h2 className="text-balance font-serif text-4xl font-normal leading-[1.05] tracking-[-0.01em] sm:text-5xl lg:text-[3.5rem]">
            Frequently asked questions
          </h2>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-muted-foreground sm:text-base">
            Everything you need to know about deploying Peridot ID. Can&apos;t find
            an answer? Our team is one message away.
          </p>
          <div className="mt-8">
            <CutButton href="/docs" variant="outline">
              Browse the docs
            </CutButton>
          </div>
        </div>

        {/* Right: accordion */}
        <div
          ref={accordionRef}
          className="relative"
          style={minHeight !== undefined ? { minHeight } : undefined}
        >
          {/* Plus marks where the divider meets the frame */}
          <CornerPlus className="left-0 top-0 hidden -translate-x-1/2 -translate-y-1/2 lg:block" />
          <CornerPlus className="bottom-0 left-0 hidden -translate-x-1/2 translate-y-1/2 lg:block" />
          {FAQS.map((item, i) => (
            <FaqItem
              key={item.question}
              item={item}
              index={i}
              isOpen={openIndex === i}
              onToggle={() => setOpenIndex((cur) => (cur === i ? null : i))}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
