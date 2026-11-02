import type { ReactNode } from "react";

import { styles as s } from "../../styles/theme";
import { useWideLayout } from "../../hooks/useWideLayout";
import { useThreeColumn } from "../../hooks/useThreeColumn";

// App shell. One content column everywhere; the chrome around it changes:
//
//   phones (<768)      rail(top + body + bottom tabs)
//   desktop (768–1279) [sidebar | rail(top + body)]
//   wide (>=1280)      [nav | rail(body) | info]
//
// The page scrolls, not the content column: nav/info/top bar/tab bar stick to
// the viewport edges and only a side column whose own content overflows gets an
// inner scrollbar. That keeps one scrollbar per screen — the window's.
//
// Rails: exactly ONE element owns the vertical frame lines (`s.rail`) — the
// column, the stack box and the overlay must never draw their own, or the
// lines double up one pixel apart (brand.md).
export function AppColumn({
  top,
  side,
  info,
  overlay,
  children,
}: {
  top?: ReactNode;
  side?: ReactNode;
  info?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const wide = useWideLayout();
  const three = useThreeColumn();
  const body = <div style={s.stackBox} className="flex flex-col">{children}</div>;
  const stickyTop = "sticky top-0 z-20 bg-background";
  const stickyBottom = "sticky bottom-0 z-20";

  const shell =
    three && info ? (
      <div style={s.shell} className="flex flex-col">
        <div style={s.threeCol} className="flex">
          <div style={s.stickyCol} className="flex flex-col">{side}</div>
          <div style={s.rail} className="flex flex-col">{body}</div>
          <div style={s.stickyCol} className="flex flex-col">{info}</div>
        </div>
      </div>
    ) : wide && (top || side) ? (
      <div style={s.shell} className="flex flex-col">
        <div style={s.frame} className="flex flex-col">
          <div style={s.wideRow} className="flex">
            <div style={s.stickyCol} className="flex flex-col">{side}</div>
            <div style={s.contentWrap} className="flex flex-col">
              <div style={s.rail} className="flex flex-col">
                <div className={stickyTop}>{top}</div>
                {body}
              </div>
            </div>
          </div>
        </div>
      </div>
    ) : (
      <div style={s.shell} className="flex flex-col">
        <div style={s.rail} className="flex flex-col">
          <div className={stickyTop}>{top}</div>
          {body}
          <div className={stickyBottom}>{side}</div>
        </div>
      </div>
    );
  if (!overlay) return shell;
  return (
    <div style={s.rootFill} className="flex flex-col">
      {shell}
      <div style={s.overlayFull} className="flex flex-col">
        <div style={s.rail} className="flex flex-col">{overlay}</div>
      </div>
    </div>
  );
}
