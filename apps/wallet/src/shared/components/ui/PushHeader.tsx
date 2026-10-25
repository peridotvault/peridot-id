import type { ReactNode } from "react";

import { styles as s } from "../../styles/theme";
import { BackButton } from "./BackButton";

/**
 * Header for every pushed screen: back arrow, then title (and optional
 * subtitle). One component so all pushes read the same on mobile and wide
 * web — screens that used to put "Back" in a button at the bottom now use
 * this. `label` overrides the arrow text (e.g. "Close" on approve flows).
 */
export function PushHeader({
  title,
  onBack,
  subtitle,
  label,
}: {
  title: ReactNode;
  onBack: () => void;
  subtitle?: ReactNode;
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackButton onPress={onBack} label={label} />
      <h1 style={s.title}>{title}</h1>
      {subtitle ? <p style={s.subtitle}>{subtitle}</p> : null}
    </div>
  );
}
