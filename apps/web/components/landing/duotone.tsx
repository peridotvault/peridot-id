import type { ReactNode } from "react";

export const DUOTONE_CONTAINER =
  "bg-[#dcefe3] [filter:saturate(1.15)] [isolation:isolate] dark:bg-[#07170f] dark:[filter:saturate(1.35)]";

export const DUOTONE_BASE =
  "[filter:grayscale(1)_contrast(0.85)_brightness(1.55)] dark:[filter:grayscale(1)_contrast(1.2)_brightness(1.08)]";

export function DuotoneOverlay(): ReactNode {
  return (
    <>
      <div className="absolute inset-0 bg-[#349b65] mix-blend-color dark:bg-[#1f7a4d]" />
      <div className="absolute inset-0 bg-[#87ee83] opacity-30 mix-blend-multiply dark:bg-[#0d2b1c] dark:opacity-40" />
      <div className="absolute inset-0 bg-white opacity-25 mix-blend-screen dark:bg-[#5fce8f] dark:opacity-25" />
    </>
  );
}
