"use client";

import { SmoothScroll } from "@/components/landing/smooth-scroll";
import { ReducedMotionProvider } from "@/lib/motion";
import type { ReactNode } from "react";

export function LandingProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <ReducedMotionProvider>
      <SmoothScroll>{children}</SmoothScroll>
    </ReducedMotionProvider>
  );
}
