import { useSyncExternalStore } from "react";

// Cached snapshot — a fresh object every call would loop useSyncExternalStore
// (it compares with Object.is). Only replace on an actual size change.
let viewport = { width: 0, height: 0 };
const serverViewport = { width: 0, height: 0 };
function readViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (viewport.width !== w || viewport.height !== h) viewport = { width: w, height: h };
  return viewport;
}
function subscribeViewport(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function useWindowDimensions() {
  return useSyncExternalStore(subscribeViewport, readViewport, () => serverViewport);
}
