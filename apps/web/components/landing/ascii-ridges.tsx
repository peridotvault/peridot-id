"use client";

import React, { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

// Glowing-ridges flow field rendered through a glyph atlas pipeline.
// No video, no palette — ridge luminance tinted by a single uColor.
//
// Raw-WebGL renderer (no three.js / react-three-fiber): one fullscreen
// triangle, DPR capped at 1, 30fps cap with dt-advanced motion, pause
// off-screen, draw-once under prefers-reduced-motion. Same shaders, same
// uniforms, same motion as before — only the scaffolding changed.

const MAX_LAYERS = 15;
const MAX_DETAIL = 10;

const vertexShader = `
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;

  #define MAX_LAYERS ${MAX_LAYERS}
  #define MAX_DETAIL ${MAX_DETAIL}

  varying vec2 vUv;

  uniform vec2 uMouse;
  uniform vec2 uResolution;
  uniform sampler2D uFontTexture;
  uniform float uCharCount;
  uniform vec3 uColor;
  uniform bool uInvert;
  uniform float uSize;
  uniform float uHasMouse;
  uniform float uInteractIntensity;
  uniform float uFlow;
  uniform float uChurn;
  uniform int uLayers;
  uniform int uDetail;
  uniform float uTurbulence;
  uniform float uZoom;
  uniform vec2 uShift;
  uniform float uRidgeFrequency;
  uniform float uRidgePhase;
  uniform float uDensity;
  uniform float uSwirl;
  uniform float uExposure;
  uniform float uGain;
  uniform float uRotation;
  uniform float uGrain;
  uniform float uOpacity;

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract(p.x * p.y);
  }

  // ponytail: tanh is ES 3.00+; this file compiles as ES 1.00 (no #version
  // line, unlike three.js which prepends 300 es). Bit-near-identical.
  float tanh_sat(float x) {
    float ax = clamp(x, -10.0, 10.0);
    float e = exp(2.0 * ax);
    return (e - 1.0) / (e + 1.0);
  }

  void main() {
    float c = cos(uRotation);
    float sn = sin(uRotation);
    vec2 turned = mat2(c, -sn, sn, c) * (vUv - 0.5) + 0.5;
    vec2 uv = (turned - 1.0) * uZoom - uShift;

    vec2 muv = vec2(
      uMouse.x / max(uResolution.x, 1.0),
      uMouse.y / max(uResolution.y, 1.0)
    );
    vec2 mdiff = vUv - muv;
    float mdist = length(mdiff * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0));
    float interaction = smoothstep(0.45, 0.0, mdist) * uHasMouse;
    uv += (mdiff / max(mdist, 1e-4)) * interaction * uInteractIntensity * 0.08;

    vec2 p = (uv + vec2(0.6, -0.1)) * uDensity;

    uv *= sin(log(max(abs(uv.y), 1e-4)) * uRidgeFrequency + uRidgePhase);

    float radius = normalize(vec3(length(uv), 0.1, 0.51)).x;
    float drift = (log2(radius) * 15.0 + uFlow) * uSwirl;
    float bearing = sin(atan(uv.y, uv.x));
    vec2 push = sin(vec2(bearing, drift));

    float film = 0.0;
    for (int i = 0; i < MAX_LAYERS; i++) {
      if (i >= uLayers) break;
      float layer = float(i) + 1.0;

      vec2 v = p;
      float f = 1.0;
      for (int k = 0; k < MAX_DETAIL; k++) {
        if (k >= uDetail) break;
        v += (tan(cos(v.yx * f + f + layer - uChurn)) * uTurbulence + 2.5) / f;
        v += push;
        f *= 1.5;
      }

      film += 1.0 / (5.0 * length(v));
    }

    float light = tanh_sat(max(film, 0.0) * uExposure) * uGain;

    float noise = hash(gl_FragCoord.xy + fract(uChurn) * 1000.0) - 0.5;
    light *= 1.0 + noise * uGrain;
    light *= uOpacity;

    float gray = clamp(light, 0.0, 1.0);
    if (uInvert) {
      gray = 1.0 - gray;
    }

    vec2 pix = vUv * uResolution;
    float gridSize = uSize;
    float charIndex = floor(gray * (uCharCount - 1.0));
    charIndex = clamp(charIndex, 0.0, uCharCount - 1.0);

    vec2 cellUV = fract(pix / gridSize);
    float charWidth = 1.0 / uCharCount;
    vec2 atlasUV = vec2((cellUV.x * charWidth) + (charIndex * charWidth), cellUV.y);

    vec4 fontSample = texture2D(uFontTexture, atlasUV);
    float alpha = fontSample.a;

    vec3 targetColor = uColor * (gray + 0.1);
    // Linear-to-sRGB encode: uColor arrives linear (three.js
    // ColorManagement convention) so output matches the old renderer.
    targetColor = pow(targetColor, vec3(0.4545));
    vec3 finalColor = targetColor * alpha;

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Same conversion three.js ColorManagement applies on Color.set(hex).
function parseColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1] ?? "87ee83", 16) : 0x87ee83;
  const toLin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [toLin((v >> 16) & 255), toLin((v >> 8) & 255), toLin(v & 255)];
}

function makeFontCanvas(chars: string, fontSize: number = 64): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = chars.length * fontSize;
  canvas.height = fontSize;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(
        chars[i] ?? " ",
        i * fontSize + fontSize / 2,
        fontSize / 2
      );
    }
  }
  return canvas;
}

export interface AsciiRidgesProps {
  characters?: string;
  color?: string;
  invert?: boolean;
  elementSize?: number;
  hasCursorInteraction?: boolean;
  interactIntensity?: number;
  layers?: number;
  detail?: number;
  turbulence?: number;
  zoom?: number;
  shiftX?: number;
  shiftY?: number;
  ridgeFrequency?: number;
  ridgePhase?: number;
  density?: number;
  flowSpeed?: number;
  churnSpeed?: number;
  swirl?: number;
  exposure?: number;
  gain?: number;
  rotation?: number;
  grain?: number;
  opacity?: number;
  paused?: boolean;
  className?: string;
}

const AsciiRidges: React.FC<AsciiRidgesProps> = (props) => {
  const {
    color = "#349b65",
    invert = false,
    elementSize = 12.0,
    hasCursorInteraction = true,
    interactIntensity = 1.0,
    layers = 12,
    detail = 5,
    turbulence = 0.6,
    zoom = 1.1,
    shiftX = 0.45,
    shiftY = 0.5,
    ridgeFrequency = 1,
    ridgePhase = 2,
    density = 11,
    flowSpeed = 0.1,
    churnSpeed = 1,
    swirl = 16,
    exposure = 0.2,
    gain = 1.5,
    rotation = 0,
    grain = 0.25,
    opacity = 0.75,
    paused = false,
    className = "",
  } = props;
  const propsRef = useRef(props);
  propsRef.current = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: 0, y: 0 });
  const reducedMotion = useReducedMotion();

  const still = paused || reducedMotion === true;

  useEffect(() => {
    const wrap = containerRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    let gl: WebGLRenderingContext | null = null;
    try {
      gl =
        (canvas.getContext("webgl2", {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          powerPreference: "high-performance",
        }) as WebGLRenderingContext | null) ??
        (canvas.getContext("webgl", {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          powerPreference: "high-performance",
        }) as WebGLRenderingContext | null);
    } catch {
      gl = null;
    }
    if (!gl) return;
    const ctx: WebGLRenderingContext = gl;
    // A lost context (e.g. reclaimed by the browser) can't compile or draw.
    if (ctx.isContextLost()) return;

    const compile = (type: number, stage: string, src: string) => {
      const sh = ctx.createShader(type);
      if (!sh) throw new Error(`[AsciiRidges] ${stage} shader alloc failed`);
      ctx.shaderSource(sh, src);
      ctx.compileShader(sh);
      if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
        throw new Error(`[AsciiRidges] ${stage} shader compile failed: ${ctx.getShaderInfoLog(sh) ?? "unknown error"}`);
      }
      return sh;
    };
    let program: WebGLProgram;
    try {
      program = ctx.createProgram() as WebGLProgram;
      ctx.attachShader(program, compile(ctx.VERTEX_SHADER, "vertex", vertexShader));
      ctx.attachShader(program, compile(ctx.FRAGMENT_SHADER, "fragment", fragmentShader));
      ctx.linkProgram(program);
      if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) {
        throw new Error(`[AsciiRidges] link failed: ${ctx.getProgramInfoLog(program) ?? "unknown error"}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[AsciiRidges] shader failed", e);
      return;
    }
    ctx.useProgram(program);

    const posLoc = ctx.getAttribLocation(program, "position");
    const buf = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
    ctx.bufferData(
      ctx.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      ctx.STATIC_DRAW
    );
    ctx.enableVertexAttribArray(posLoc);
    ctx.vertexAttribPointer(posLoc, 2, ctx.FLOAT, false, 0, 0);

    const U = (name: string) => ctx.getUniformLocation(program, name);
    const loc: Record<string, WebGLUniformLocation | null> = Object.fromEntries(
      [
        "uMouse", "uResolution", "uFontTexture", "uCharCount", "uColor",
        "uInvert", "uSize", "uHasMouse", "uInteractIntensity", "uFlow",
        "uChurn", "uLayers", "uDetail", "uTurbulence", "uZoom", "uShift",
        "uRidgeFrequency", "uRidgePhase", "uDensity", "uSwirl", "uExposure",
        "uGain", "uRotation", "uGrain", "uOpacity",
      ].map((n) => [n, U(n)])
    );
    const setU = (name: string, v: number | boolean | number[]) => {
      const l = loc[name];
      if (typeof v === "boolean") ctx.uniform1i(l, v ? 1 : 0);
      else if (typeof v === "number") {
        // int uniforms reject uniform1f — dispatch exactly like before.
        if (name === "uLayers" || name === "uDetail") ctx.uniform1i(l, Math.round(v));
        else ctx.uniform1f(l, v);
      }
      else if (v.length === 3) ctx.uniform3f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      else ctx.uniform2f(l, v[0] ?? 0, v[1] ?? 0);
    };

    const tex = ctx.createTexture();
    const uploadAtlas = (chars: string) => {
      ctx.bindTexture(ctx.TEXTURE_2D, tex);
      ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, 1);
      ctx.texImage2D(
        ctx.TEXTURE_2D,
        0,
        ctx.RGBA,
        ctx.RGBA,
        ctx.UNSIGNED_BYTE,
        makeFontCanvas(chars)
      );
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    };
    const rawChars = propsRef.current.characters ?? " .:-+*=%@#";
    const safeChars = rawChars.length > 0 ? rawChars : " ";
    uploadAtlas(safeChars);
    let atlasChars = safeChars;

    ctx.clearColor(0, 0, 0, 0);
    ctx.enable(ctx.BLEND);
    ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);

    let flow = 0;
    let churn = 0;
    let mx = 0;
    let my = 0;
    let raf = 0;
    let inView = true;
    let last = -1;
    let lastDraw = -1;
    const FRAME_MS = 1000 / 30; // 30fps cap: halves paints, flow/churn still advance on real time.

    const resize = () => {
      // Backdrop only: cap at 1.0 — halves pixels vs dpr 1.5+, and the mask +
      // veil hide the softness. Hero and CSS sizing untouched.
      const dpr = 1;
      const w = Math.max(1, Math.floor(wrap.clientWidth * dpr));
      const h = Math.max(1, Math.floor(wrap.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    resize();

    const draw = (p: AsciiRidgesProps) => {
      const raw = p.characters ?? " .:-+*=%@#";
      const chars = raw.length > 0 ? raw : " ";
      if (chars !== atlasChars) {
        atlasChars = chars;
        uploadAtlas(chars);
      }
      ctx.viewport(0, 0, canvas.width, canvas.height);
      ctx.clear(ctx.COLOR_BUFFER_BIT);
      ctx.activeTexture(ctx.TEXTURE0);
      ctx.bindTexture(ctx.TEXTURE_2D, tex);
      ctx.uniform1i(loc.uFontTexture, 0);
      const [r, g, b] = parseColor(p.color ?? "#349b65");
      mx += (mouse.current.x - mx) * 0.1;
      my += (mouse.current.y - my) * 0.1;
      const vals: Array<[string, number | boolean | number[]]> = [
        ["uResolution", [canvas.width, canvas.height]],
        ["uColor", [r, g, b]],
        ["uInvert", p.invert ?? false],
        ["uSize", p.elementSize ?? 12],
        ["uHasMouse", p.hasCursorInteraction ? 1 : 0],
        ["uInteractIntensity", p.interactIntensity ?? 1],
        ["uFlow", flow],
        ["uChurn", churn],
        ["uLayers", Math.round(clamp(p.layers ?? 12, 1, MAX_LAYERS))],
        ["uDetail", Math.round(clamp(p.detail ?? 5, 1, MAX_DETAIL))],
        ["uTurbulence", Math.max(p.turbulence ?? 0.6, 0)],
        ["uZoom", Math.max(p.zoom ?? 1.1, 0.05)],
        ["uShift", [p.shiftX ?? 0.45, p.shiftY ?? 0.5]],
        ["uRidgeFrequency", p.ridgeFrequency ?? 1],
        ["uRidgePhase", p.ridgePhase ?? 2],
        ["uDensity", Math.max(p.density ?? 11, 0.1)],
        ["uSwirl", p.swirl ?? 16],
        ["uExposure", Math.max(p.exposure ?? 0.2, 0)],
        ["uGain", Math.max(p.gain ?? 0, 0)],
        ["uRotation", ((p.rotation ?? 0) * Math.PI) / 180],
        ["uGrain", clamp(p.grain ?? 0.25, 0, 2)],
        ["uOpacity", clamp(p.opacity ?? 0.75, 0, 1)],
        ["uCharCount", chars.length],
        ["uMouse", [mx, my]],
      ];
      for (const [n, v] of vals) setU(n, v);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    };

    const p0 = propsRef.current;
    if (still) {
      draw(p0);
    } else {
      const loop = (t: number) => {
        raf = requestAnimationFrame(loop);
        if (!inView) return;
        const p = propsRef.current;
        if (!p.paused) {
          const dt = last < 0 ? 0.016 : Math.min((t - last) / 1000, 0.05);
          flow += dt * (p.flowSpeed ?? 0.1);
          churn += dt * (p.churnSpeed ?? 1);
        }
        last = t;
        if (lastDraw >= 0 && t - lastDraw < FRAME_MS) return;
        lastDraw = t;
        draw(p);
      };
      raf = requestAnimationFrame(loop);
    }

    const ro = new ResizeObserver(() => {
      resize();
      if (still) draw(propsRef.current);
    });
    ro.observe(wrap);

    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? true;
      },
      { rootMargin: "120px" }
    );
    io.observe(wrap);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      ctx.deleteTexture(tex);
      ctx.deleteProgram(program);
      // NOTE: no loseContext() here — it kills the canvas' context, so a
      // StrictMode remount (or any re-init) gets a dead context back from
      // getContext and every compile fails. GC reclaims it on unmount.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mouse.current = {
      x: e.clientX - rect.left,
      y: rect.height - (e.clientY - rect.top),
    };
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-full w-full cursor-text overflow-hidden",
        className
      )}
      onMouseMove={handleMouseMove}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
};

export default AsciiRidges;
