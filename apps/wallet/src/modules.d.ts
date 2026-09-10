// Loosen third-party types that resolve against a different @types/react copy
// than this app's React 19.0 (the JSX component types end up incompatible).

declare module "react-native-qrcode-svg" {
  import type { ComponentType } from "react";
  const QRCode: ComponentType<Record<string, unknown>>;
  export default QRCode;
}
// NOTE: lucide icons come from per-icon deep imports via src/icons.ts
// (package's own types) — never from the "lucide-react-native" root, which
// defeats tree-shaking and ships all ~1500 icons.