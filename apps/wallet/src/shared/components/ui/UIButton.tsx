import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "../../styles/cn";

// Wallet button: shadcn Button + the label layout callers already expect
// (title, optional icon, optional note under it).
type Variant = "primary" | "outline" | "danger";

export function UIButton({
  title,
  note,
  icon,
  onPress,
  disabled,
  variant = "outline",
  align = "center",
  className,
  sfx,
}: {
  title: string;
  note?: string;
  icon?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  variant?: Variant;
  align?: "center" | "left";
  className?: string;
  /** Dismiss actions get the close cue instead of the plain press. */
  sfx?: "close" | "scrim" | "action";
}) {
  return (
    <Button variant={variant} align={align} disabled={disabled} onClick={onPress} className={className} sfx={sfx}>
      <span
        className={cn(
          "flex items-center gap-2.5 font-sans text-sm font-medium tracking-[0.4px]",
          align === "left" ? "justify-start" : "justify-center",
        )}
      >
        {/* Fixed icon slot keeps every left-aligned label on the same x. */}
        {align === "left" && (
          <span className="flex w-[18px] shrink-0 items-center justify-center">{icon}</span>
        )}
        {align === "center" && icon}
        {title}
      </span>
      {note && <span className="font-sans text-xs text-muted-foreground">{note}</span>}
    </Button>
  );
}
