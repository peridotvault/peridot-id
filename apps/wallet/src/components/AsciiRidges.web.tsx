/// <reference lib="dom" />
// Lazy shell: the raw-WebGL canvas loads in its own async chunk so login
// paints with zero animation tax. Metro resolves this file on web and
// AsciiRidges.native.tsx everywhere else.

import React from "react";
import type { AsciiRidgesProps } from "./AsciiRidgesCanvas";

const AsciiRidgesCanvas = React.lazy(() => import("./AsciiRidgesCanvas"));

export const AsciiRidges: React.FC<AsciiRidgesProps> = (props) => (
  <React.Suspense fallback={null}>
    <AsciiRidgesCanvas {...props} />
  </React.Suspense>
);

export default AsciiRidges;
