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
export function ScrollArea({ style, contentContainerStyle, horizontal, children, ...rest }: ScrollAreaProps) {
  return (
    <div
      {...rest}
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        overflowX: horizontal ? "auto" : "hidden",
        overflowY: horizontal ? "hidden" : "auto",
        ...flatten(style),
      }}
    >
      <div style={{ display: "flex", flexDirection: horizontal ? "row" : "column", flex: 1, ...flatten(contentContainerStyle) }}>
        {children}
      </div>
    </div>
  );
}
