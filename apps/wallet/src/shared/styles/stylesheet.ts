// Shared style helpers. Plain objects only — no elements.
// StyleSheet.create is an identity tag that preserves string-literal types;
// flatten merges RN-shaped style props (arrays, conditionals) into one
// CSSProperties for plain DOM elements.
import type { CSSProperties } from "react";

type LooseStyle = { [key: string]: string | number | boolean | undefined };

export type StyleProp = CSSProperties | LooseStyle | false | null | undefined | StyleProp[];

// RN-only keys that appear in wallet styles — expanded to real CSS.
type Expanded = {
  marginHorizontal?: CSSProperties["marginLeft"];
  marginVertical?: CSSProperties["marginTop"];
  paddingHorizontal?: CSSProperties["paddingLeft"];
  paddingVertical?: CSSProperties["paddingTop"];
  elevation?: number;
};

export function flatten(style: StyleProp): CSSProperties {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  const { marginHorizontal, marginVertical, paddingHorizontal, paddingVertical, elevation, ...rest } =
    style as CSSProperties & Expanded;
  void elevation;
  const out: CSSProperties = { ...rest };
  if (marginHorizontal !== undefined) {
    out.marginLeft ??= marginHorizontal;
    out.marginRight ??= marginHorizontal;
  }
  if (marginVertical !== undefined) {
    out.marginTop ??= marginVertical;
    out.marginBottom ??= marginVertical;
  }
  if (paddingHorizontal !== undefined) {
    out.paddingLeft ??= paddingHorizontal;
    out.paddingRight ??= paddingHorizontal;
  }
  if (paddingVertical !== undefined) {
    out.paddingTop ??= paddingVertical;
    out.paddingBottom ??= paddingVertical;
  }
  return out;
}

export const StyleSheet = {
  // Unconstrained generic with a const type parameter: preserves
  // string-literal types ("row", "center") so style objects stay assignable
  // to CSSProperties.
  create<const T>(styles: T): T {
    return styles;
  },
  flatten,
  absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as CSSProperties,
  hairlineWidth: 1,
};
