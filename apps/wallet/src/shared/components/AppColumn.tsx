import type { ReactNode } from "react";
import { View } from "react-native";
import { styles as s } from "../theme";
import { useWideLayout } from "../hooks/useWideLayout";

// App column: caps every wallet screen at the sm width and centers it.
// No-op on phones (<576pt); constrains + centers on wide web.
// Past the md breakpoint optional chrome docks around the content: `top`
// spans the full 1400 frame, `side` (the tab bar) docks left as a sidebar
// while the sm column stays centered in the remainder. Below the breakpoint
// the same nodes stack top/bottom inside the column.
// `overlay` (the push stack top) covers the content box only — opaque, so
// TopBar/sidebar stay visible while a push is open.
export function AppColumn({
  top,
  side,
  overlay,
  children,
}: {
  top?: ReactNode;
  side?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const wide = useWideLayout();
  const body = (
    <View style={s.stackBox}>
      {children}
      {overlay && <View style={s.overlay}>{overlay}</View>}
    </View>
  );
  if (wide && (top || side)) {
    return (
      <View style={s.shell}>
        <View style={s.frame}>
          {top}
          <View style={s.wideRow}>
            {side}
            <View style={s.contentWrap}>{body}</View>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={s.shell}>
      <View style={s.column}>
        {top}
        {body}
        {side}
      </View>
    </View>
  );
}
