"use client";

import dynamic from "next/dynamic";
import { softEase, useReducedMotion } from "@/lib/motion";
import { motion } from "motion/react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { AsciiRidgesProps } from "@/components/landing/ascii-ridges";

// three.js rides an async chunk so hero copy paints with zero GL tax.
// Cast: repo resolves two @types/react copies; identical at runtime.
const AsciiRidges = dynamic(
  () =>
    import("@/components/landing/ascii-ridges") as unknown as Promise<{
      default: React.ComponentType<AsciiRidgesProps>;
    }>,
  { ssr: false }
);

function useIsMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

export function HeroWaves(): ReactNode {
  const mounted = useIsMounted();
  const { resolvedTheme } = useTheme();
  const prefersReducedMotion = useReducedMotion();

  if (!mounted) return null;

  const color = resolvedTheme === "dark" ? "#87ee83" : "#349b65";
  const isDark = resolvedTheme === "dark";
  const targetOpacity = isDark ? 1 : 0.85;
  const fade =
    "linear-gradient(to bottom, transparent 0%, black 25%, black 80%, transparent 100%)";

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: targetOpacity }}
      transition={
        prefersReducedMotion
          ? { duration: 0.01 }
          : { duration: 1.6, ease: softEase, delay: 0.1 }
      }
      style={{
        maskImage: fade,
        WebkitMaskImage: fade,
        filter: isDark ? undefined : "saturate(2.4) contrast(1.25)",
      }}
    >
      <AsciiRidges
        color={color}
        elementSize={10}
        exposure={0.3}
        gain={2}
        opacity={0.9}
        hasCursorInteraction={true}
        className="opacity-80 dark:opacity-90"
      />
    </motion.div>
  );
}
