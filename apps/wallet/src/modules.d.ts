// Loosen third-party types that resolve against a different @types/react copy
// than this app's React 19.0 (the JSX component types end up incompatible).

declare module "react-native-qrcode-svg" {
  import type { ComponentType } from "react";
  const QRCode: ComponentType<Record<string, unknown>>;
  export default QRCode;
}

declare module "lucide-react-native" {
  import type { ComponentType } from "react";
  type LucideIcon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  export const ArrowDownLeft: LucideIcon;
  export const ArrowDownUp: LucideIcon;
  export const ArrowLeft: LucideIcon;
  export const ArrowUpRight: LucideIcon;
  export const Check: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const Coins: LucideIcon;
  export const Copy: LucideIcon;
  export const Info: LucideIcon;
  export const KeyRound: LucideIcon;
  export const Link2: LucideIcon;
  export const LogOut: LucideIcon;
  export const Monitor: LucideIcon;
  export const Plus: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const Rocket: LucideIcon;
  export const Settings: LucideIcon;
  export const Shield: LucideIcon;
  export const Trash2: LucideIcon;
  export const TriangleAlert: LucideIcon;
  export const User: LucideIcon;
}