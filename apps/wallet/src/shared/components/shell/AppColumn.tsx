import type { ReactNode } from "react";

import { styles as s } from "../../styles/theme";
import { useWideLayout } from "../../hooks/useWideLayout";

// App column: caps every wallet screen at the sm width and centers it.
// No-op on phones (<576pt); constrains + centers on wide web.
// Past the md breakpoint optional chrome docks around the content: `top`
// spans the full 1400 frame, `side` (the tab bar) docks left as a sidebar
// while the sm column stays centered in the remainder. Below the breakpoint
// the same nodes stack top/bottom inside the column.
// `overlay` (the push stack top) covers the WHOLE shell — top bar and
// sidebar/tab bar included — while keeping the same sm width cap, so a push
// reads as its own full screen on mobile and wide web alike.
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
  const body = <div style={s.stackBox} className="flex flex-col">{children}</div>;
  const shell =
    wide && (top || side) ? (
      <div style={s.shell} className="flex flex-col">
        <div style={s.frame} className="flex flex-col">
          {top}
          <div style={s.wideRow} className="flex flex-col">
            {side}
            <div style={s.contentWrap} className="flex flex-col">{body}</div>
          </div>
        </div>
      </div>
    ) : (
      <div style={s.shell} className="flex flex-col">
        <div style={s.column} className="flex flex-col">
          {top}
          {body}
          {side}
        </div>
      </div>
    );
  if (!overlay) return shell;
  return (
    <div style={s.rootFill} className="flex flex-col">
      {shell}
      <div style={s.overlayFull} className="flex flex-col">
        <div style={s.column} className="flex flex-col">{overlay}</div>
      </div>
    </div>
  );
}
