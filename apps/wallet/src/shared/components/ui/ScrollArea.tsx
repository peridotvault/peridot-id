import type { HTMLAttributes, ReactNode } from "react";
import { flatten, type StyleProp } from "../../styles/stylesheet";

type ScrollAreaProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  style?: StyleProp;
  contentContainerStyle?: StyleProp;
  horizontal?: boolean;
  children?: ReactNode;
};

// DOM-first scroll container: outer clip div + inner content div, same
// call-shape as the old RN shim (contentContainerStyle, horizontal).
//
// The inner wrapper must be able to GROW: `flex: 1` (basis 0) pins it to the
// container height, so long content overflowed without ever creating a
// scrollbar. `min-height/width: 100%` fills the area for short content and
// lets tall content extend it.
export function ScrollArea({ style, contentContainerStyle, horizontal, children, ...rest }: ScrollAreaProps) {
  return (
    <div
      {...rest}
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        overflowX: horizontal ? "auto" : "hidden",
        overflowY: horizontal ? "hidden" : "auto",
        minHeight: 0,
        minWidth: 0,
        ...flatten(style),
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: horizontal ? "row" : "column",
          flexShrink: 0,
          ...(horizontal ? { minWidth: "100%" } : { minHeight: "100%" }),
          ...flatten(contentContainerStyle),
        }}
      >
        {children}
      </div>
    </div>
  );
}
