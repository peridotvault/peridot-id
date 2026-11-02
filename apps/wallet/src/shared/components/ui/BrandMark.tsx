// Brand lockup: the PeridotID horizontal logo (peridot mark + PID wordmark).
// One component so the masthead can't drift between shell and auth screens.
const SIZES = {
  md: "h-10",
  lg: "h-16",
} as const;

export function BrandMark({ size = "lg" }: { size?: keyof typeof SIZES }) {
  return <img src="/logo/logo-text.svg" alt="PeridotID" className={`${SIZES[size]} w-auto`} />;
}
