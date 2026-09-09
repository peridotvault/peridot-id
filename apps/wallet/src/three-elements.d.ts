// Re-applies @react-three/fiber's JSX augmentation from our side. Fiber declares the
// same merge, but depending on how pnpm dedupes the duplicate @types/react copies
// (native 19.0.14 vs web 19.2.18) its copy can attach to a types instance our JSX
// namespace doesn't use. Merging here targets the exact instances this app compiles
// against; if fiber's own augmentation loads too, interface merging is harmless.
import type { ThreeElements } from "@react-three/fiber";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

declare module "react/jsx-dev-runtime" {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

export {};
