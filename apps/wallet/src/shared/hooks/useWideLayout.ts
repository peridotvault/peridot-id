import { useWindowDimensions } from "react-native";
import { theme } from "../theme";

// True past the md breakpoint: the tab bar docks left as a sidebar.
// Reactive on web resize; phones (and portrait tablets) stay bottom-bar.
export function useWideLayout() {
  const { width } = useWindowDimensions();
  return width >= theme.layout.sidebarBreakpoint;
}
