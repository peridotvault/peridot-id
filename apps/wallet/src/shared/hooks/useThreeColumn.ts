import { useWindowDimensions } from "./useWindowDimensions";
import { theme } from "../styles/theme";

// True past the three-column breakpoint: nav | content | info, like the
// desktop shells people already know. Below it the shell keeps two columns
// (nav + content) and then a single column on phones.
export function useThreeColumn() {
  const { width } = useWindowDimensions();
  return width >= theme.layout.threeColumnBreakpoint;
}
