import { useWindowDimensions } from "./useWindowDimensions";
import { theme } from "../styles/theme";

// True past the md breakpoint: the tab bar docks left as a sidebar and the
// phone header is replaced by the sidebar's brand + profile. The shell chrome
// switches exactly once, here — not at a second breakpoint further up.
// Reactive on web resize; phones stay bottom-bar.
export function useWideLayout() {
  const { width } = useWindowDimensions();
  return width >= theme.layout.sidebarBreakpoint;
}
