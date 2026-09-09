import { useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

// Pure-React-Native port of the web AsciiRidges ridge field
// (apps/web/components/landing/ascii-ridges.tsx): same flow math and glyph
// ramp, rendered into a single <Text> so it runs on native + web with zero
// new dependencies. Mobile-tuned: 8 layers x 3 detail, ~20fps.

const CHARS = " .:-+*=%@#".split("");

const LAYERS = 8;
const DETAIL = 3;
const TURBULENCE = 0.6;
const ZOOM = 1.1;
const SHIFT_X = 0.45;
const SHIFT_Y = 0.5;
const RIDGE_FREQUENCY = 1;
const RIDGE_PHASE = 2;
const DENSITY = 11;
const SWIRL = 16;
const FLOW_SPEED = 0.1;
const CHURN_SPEED = 1;
const EXPOSURE = 0.3;
const GAIN = 2;

function ridgeGray(nx: number, ny: number, flow: number, churn: number): number {
  // rotation = 0, so turned = v
  const uvx = (nx - 1) * ZOOM - SHIFT_X;
  const uvy = (ny - 1) * ZOOM - SHIFT_Y;

  let px = (uvx + 0.6) * DENSITY;
  let py = (uvy - 0.1) * DENSITY;

  const shaped =
    Math.sin(
      Math.log(Math.max(Math.abs(uvy), 1e-4)) * RIDGE_FREQUENCY + RIDGE_PHASE,
    );
  const suvx = uvx * shaped;
  const suvy = uvy * shaped;

  const len = Math.hypot(suvx, suvy);
  const radius = len / Math.hypot(len, 0.1, 0.51);
  const drift = (Math.log2(Math.max(radius, 1e-4)) * 15 + flow) * SWIRL;
  const bearing = Math.sin(Math.atan2(suvy, suvx));
  const pushX = Math.sin(bearing);
  const pushY = Math.sin(drift);

  let film = 0;
  for (let i = 0; i < LAYERS; i++) {
    const layer = i + 1;
    let vx = px;
    let vy = py;
    let f = 1;
    for (let k = 0; k < DETAIL; k++) {
      // ponytail: read both components first — the shader's v.yx swizzle
      // updates vx/vy simultaneously; sequential update warps the pattern
      const ox = vx;
      const oy = vy;
      vx +=
        ((Math.tan(Math.cos(oy * f + f + layer - churn)) * TURBULENCE + 2.5) /
          f +
          pushX);
      vy +=
        ((Math.tan(Math.cos(ox * f + f + layer - churn)) * TURBULENCE + 2.5) /
          f +
          pushY);
      f *= 1.5;
    }
    film += 1 / (5 * Math.hypot(vx, vy));
  }

  const light = Math.tanh(Math.max(film, 0) * EXPOSURE) * GAIN;
  return Math.min(1, Math.max(0, light));
}

function buildFrame(cols: number, rows: number, tick: number): string {
  const flow = tick * 0.05 * FLOW_SPEED;
  const churn = tick * 0.05 * CHURN_SPEED;
  const lines: string[] = [];
  for (let cy = 0; cy < rows; cy++) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) {
      const gray = ridgeGray((cx + 0.5) / cols, 1 - (cy + 0.5) / rows, flow, churn);
      line += CHARS[Math.min(CHARS.length - 1, Math.floor(gray * (CHARS.length - 1)))] ?? " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

type Props = {
  tint?: string;
  opacity?: number;
  cellSize?: number;
  intervalMs?: number;
  // web-only knobs (AsciiRidges.web.tsx): accepted so shared call sites
  // typecheck — tsc resolves through AsciiRidges.tsx — ignored here.
  exposure?: number;
  gain?: number;
  elementSize?: number;
  layers?: number;
  detail?: number;
};

export function AsciiRidges({
  tint = "#87ee83",
  opacity = 0.7,
  cellSize = 14,
  intervalMs = 50,
}: Props) {
  const { width, height } = useWindowDimensions();
  const cols = Math.max(8, Math.floor(width / cellSize));
  const rows = Math.max(8, Math.floor(height / cellSize));
  const [tick, setTick] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (alive) setReduced(!!v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [reduced, intervalMs]);

  const frame = useMemo(() => buildFrame(cols, rows, tick), [cols, rows, tick]);

  return (
    <View style={styles.backdrop} pointerEvents="none">
      <Text
        style={[
          styles.text,
          {
            color: tint,
            opacity,
            fontSize: cellSize,
            lineHeight: Math.round(cellSize * 1.25),
          },
        ]}
      >
        {frame}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  text: {
    fontFamily: "monospace",
  },
});
