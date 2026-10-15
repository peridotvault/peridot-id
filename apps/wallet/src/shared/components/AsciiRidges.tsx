// WebGL backdrop: raw-WebGL port of the R3F AsciiRidges ridge field
// (apps/web/components/landing/ascii-ridges.tsx — same shaders, same
// uniforms, same motion). Zero dependencies: three/fiber only ever provided
// scaffolding. Where shader compile fails (software GL drivers), a Canvas2D
// port below renders the same field per cell.

import React, { useEffect, useRef, useState } from "react";

// GL probe: compile AND link the real shaders on an offscreen canvas, once
// per page load. A trivial probe is useless here — this driver's failure hits
// the real vertex shader while toys compile fine. Same source + same driver
// makes the verdict airtight: pass means the real setup will succeed, fail
// takes the Canvas2D path. (No SSR in this app, so render-time probe is safe.)
let glProbe: boolean | null = null;
// Log the software-GL fallback once per page load: every backdrop mount
// (×2 under StrictMode) hits the same driver failure and would repeat it.
let shaderWarned = false;
function glAvailable(): boolean {
  if (glProbe !== null) return glProbe;
  glProbe = false;
  try {
    if (typeof document === "undefined") return glProbe;
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return glProbe;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return glProbe;
    // Mirror the real path below: some drivers lack highp in fragment
    // shaders, so probe the mediump fallback too before giving up.
    const fragMed = fragmentShader.replace("precision highp float;", "precision mediump float;");
    gl.shaderSource(vs, vertexShader);
    gl.compileShader(vs);
    gl.shaderSource(fs, fragmentShader);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      gl.shaderSource(fs, fragMed);
      gl.compileShader(fs);
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    glProbe =
      (gl.getShaderParameter(vs, gl.COMPILE_STATUS) as boolean) &&
      (gl.getShaderParameter(fs, gl.COMPILE_STATUS) as boolean) &&
      (gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean);
    if (!glProbe) {
      // eslint-disable-next-line no-console
      console.warn("[AsciiRidges] GL probe failed; renderer:", renderer, "— using Canvas2D");
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    glProbe = false;
  }
  return glProbe;
}

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
    // ColorManagement convention) and three encodes on output — without
    // this the backdrop renders much darker than the R3F reference.
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
}

export const AsciiRidgesGL: React.FC<AsciiRidgesProps> = (props) => {
  const {
    characters = " .:-+*=%@#",
    color = "#87ee83",
    invert = false,
    elementSize = 10.0,
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
    exposure = 0.3,
    gain = 2,
    rotation = 0,
    grain = 0.25,
    opacity = 0.9,
    paused = false,
  } = props;
  const propsRef = useRef(props);
  propsRef.current = props;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: 0, y: 0 });
  // Set when the real context fails to compile/link (software GL, context
  // exhaustion from many mounts): render the Canvas2D port instead of black.
  const [failed, setFailed] = useState(false);

  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = paused || reduced;

  useEffect(() => {
    const wrap = wrapRef.current;
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
    if (!gl) {
      setFailed(true);
      return;
    }
    const ctx: WebGLRenderingContext = gl;

    const compile = (type: number, src: string) => {
      const sh = ctx.createShader(type);
      if (!sh) throw new Error("shader alloc failed");
      ctx.shaderSource(sh, src);
      ctx.compileShader(sh);
      if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
        // Info log is null (not "") on several software-GL drivers — fall
        // back to a readable message instead of "Error: null".
        throw new Error(ctx.getShaderInfoLog(sh) || "compile failed (empty info log)");
      }
      return sh;
    };
    let program: WebGLProgram;
    try {
      program = ctx.createProgram() as WebGLProgram;
      ctx.attachShader(program, compile(ctx.VERTEX_SHADER, vertexShader));
      // Some laptop/mobile GPUs lack highp precision in fragment shaders
      // (compile fails with an empty info log). Query first, fall back to
      // mediump — visually identical for this ASCII field.
      const highpOk = (ctx.getShaderPrecisionFormat?.(ctx.FRAGMENT_SHADER, ctx.HIGH_FLOAT)?.precision ?? 0) > 0;
      const fragSrc = highpOk
        ? fragmentShader
        : fragmentShader.replace("precision highp float;", "precision mediump float;");
      try {
        ctx.attachShader(program, compile(ctx.FRAGMENT_SHADER, fragSrc));
      } catch {
        ctx.attachShader(program, compile(ctx.FRAGMENT_SHADER, fragmentShader.replace("precision highp float;", "precision mediump float;")));
      }
      ctx.linkProgram(program);
      if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) {
        throw new Error(ctx.getProgramInfoLog(program) || "link failed (empty info log)");
      }
    } catch (e) {
      // Not fatal: the Canvas2D port below renders the same field.
      if (!shaderWarned) {
        shaderWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[AsciiRidges] shader failed — using Canvas2D", e);
      }
      setFailed(true);
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
    const loc = {
      uMouse: U("uMouse"),
      uResolution: U("uResolution"),
      uFontTexture: U("uFontTexture"),
      uCharCount: U("uCharCount"),
      uColor: U("uColor"),
      uInvert: U("uInvert"),
      uSize: U("uSize"),
      uHasMouse: U("uHasMouse"),
      uInteractIntensity: U("uInteractIntensity"),
      uFlow: U("uFlow"),
      uChurn: U("uChurn"),
      uLayers: U("uLayers"),
      uDetail: U("uDetail"),
      uTurbulence: U("uTurbulence"),
      uZoom: U("uZoom"),
      uShift: U("uShift"),
      uRidgeFrequency: U("uRidgeFrequency"),
      uRidgePhase: U("uRidgePhase"),
      uDensity: U("uDensity"),
      uSwirl: U("uSwirl"),
      uExposure: U("uExposure"),
      uGain: U("uGain"),
      uRotation: U("uRotation"),
      uGrain: U("uGrain"),
      uOpacity: U("uOpacity"),
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
    // Default charset must match the component default below: raw props have
    // no defaults applied, and a single-space atlas renders everything
    // transparent (black screen) when the caller omits `characters`.
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
    const FRAME_MS = 1000 / 30; // 30fps cap: halves paints, flow/churn still advance on real time. Revert: delete this + the two lastDraw lines.

    const resize = () => {
      // Backdrop only: cap at 1.0 — halves pixels vs dpr 1.5+, and the veil +
      // low opacity hide the softness. Hero and CSS sizing untouched.
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
      ctx.uniform2f(loc.uResolution, canvas.width, canvas.height);
      const [r, g, b] = parseColor(p.color ?? "#87ee83");
      ctx.uniform3f(loc.uColor, r, g, b);
      ctx.uniform1i(loc.uInvert, p.invert ? 1 : 0);
      ctx.uniform1f(loc.uSize, p.elementSize ?? 10);
      ctx.uniform1f(loc.uHasMouse, p.hasCursorInteraction ? 1 : 0);
      ctx.uniform1f(loc.uInteractIntensity, p.interactIntensity ?? 1);
      ctx.uniform1f(loc.uFlow, flow);
      ctx.uniform1f(loc.uChurn, churn);
      ctx.uniform1i(
        loc.uLayers,
        Math.round(clamp(p.layers ?? 12, 1, MAX_LAYERS))
      );
      ctx.uniform1i(
        loc.uDetail,
        Math.round(clamp(p.detail ?? 5, 1, MAX_DETAIL))
      );
      ctx.uniform1f(loc.uTurbulence, Math.max(p.turbulence ?? 0.6, 0));
      ctx.uniform1f(loc.uZoom, Math.max(p.zoom ?? 1.1, 0.05));
      ctx.uniform2f(loc.uShift, p.shiftX ?? 0.45, p.shiftY ?? 0.5);
      ctx.uniform1f(loc.uRidgeFrequency, p.ridgeFrequency ?? 1);
      ctx.uniform1f(loc.uRidgePhase, p.ridgePhase ?? 2);
      ctx.uniform1f(loc.uDensity, Math.max(p.density ?? 11, 0.1));
      ctx.uniform1f(loc.uSwirl, p.swirl ?? 16);
      ctx.uniform1f(loc.uExposure, Math.max(p.exposure ?? 0.3, 0));
      ctx.uniform1f(loc.uGain, Math.max(p.gain ?? 0, 0));
      ctx.uniform1f(
        loc.uRotation,
        (((p.rotation ?? 0) * Math.PI) / 180)
      );
      ctx.uniform1f(loc.uGrain, clamp(p.grain ?? 0.25, 0, 2));
      ctx.uniform1f(loc.uOpacity, clamp(p.opacity ?? 0.9, 0, 1));
      ctx.uniform1f(loc.uCharCount, chars.length);
      // CSS-px mouse vs device-px resolution: same mapping as the R3F version.
      mx += (mouse.current.x - mx) * 0.1;
      my += (mouse.current.y - my) * 0.1;
      ctx.uniform2f(loc.uMouse, mx, my);
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

    const onMove = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      mouse.current = {
        x: e.clientX - rect.left,
        y: rect.height - (e.clientY - rect.top),
      };
    };
    wrap.addEventListener("mousemove", onMove);

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
      wrap.removeEventListener("mousemove", onMove);
      ro.disconnect();
      io.disconnect();
      ctx.deleteTexture(tex);
      ctx.deleteProgram(program);
      ctx
        .getExtension("WEBGL_lose_context")
        ?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return <AsciiRidges2D {...props} />;

  return (
    <div
      ref={wrapRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: "hidden",
        opacity: 0.25,
        // Backdrop must never intercept clicks: it paints above static
        // siblings (e.g. the login buttons) in DOM order.
        pointerEvents: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
      {/* Black veil: melts the ridges into the app background, soft like the web hero. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(to bottom, #0a0a0a 0%, transparent 25%, transparent 80%, #0a0a0a 100%)",
        }}
      />
    </div>
  );
};

// Canvas2D fallback: the same ridge field evaluated per cell on the CPU.
// Mirrors the fragment main() above operation-for-operation (same defaults,
// same advance rates) — keep the two in sync.
const AsciiRidges2D: React.FC<AsciiRidgesProps> = (props) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: 0, y: 0 });
  const propsRef = useRef(props);
  propsRef.current = props;

  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = props.paused || reduced;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frac = (x: number) => x - Math.floor(x);
    const hash2 = (x: number, y: number) => {
      let px = frac(x * 443.897);
      let py = frac(y * 441.423);
      const d = px * (py + 19.19) + py * (px + 19.19);
      px += d;
      py += d;
      return frac(px * py);
    };
    // Reversed smoothstep(0.45, 0.0, x), formula-literal like ANGLE evaluates it.
    const russell = (x: number) => {
      const t = clamp((x - 0.45) / (0.0 - 0.45), 0, 1);
      return t * t * (3 - 2 * t);
    };

    const resize = () => {
      const w = Math.max(1, Math.floor(wrap.clientWidth));
      const h = Math.max(1, Math.floor(wrap.clientHeight));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    resize();

    let flow = 0;
    let churn = 0;
    let mx = 0;
    let my = 0;
    let raf = 0;
    let inView = true;
    let last = -1;
    let lastDraw = -1;
    const FRAME_MS = 1000 / 30;

    const draw = (p: AsciiRidgesProps) => {
      const raw = p.characters ?? " .:-+*=%@#";
      const chars = raw.length > 0 ? raw : " ";
      const size = p.elementSize ?? 10;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.font = `bold ${size}px monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = p.color ?? "#87ee83";

      const rot = ((p.rotation ?? 0) * Math.PI) / 180;
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      const zoom = Math.max(p.zoom ?? 1.1, 0.05);
      const shx = p.shiftX ?? 0.45;
      const shy = p.shiftY ?? 0.5;
      const layers = Math.round(clamp(p.layers ?? 12, 1, MAX_LAYERS));
      const detail = Math.round(clamp(p.detail ?? 5, 1, MAX_DETAIL));
      const turbulence = Math.max(p.turbulence ?? 0.6, 0);
      const exposure = Math.max(p.exposure ?? 0.3, 0);
      const gain = Math.max(p.gain ?? 0, 0);
      const swirl = p.swirl ?? 16;
      const density = Math.max(p.density ?? 11, 0.1);
      const grain = clamp(p.grain ?? 0.25, 0, 2);
      const opacity = clamp(p.opacity ?? 0.9, 0, 1);
      const hasMouse = p.hasCursorInteraction ? 1 : 0;
      const intensity = p.interactIntensity ?? 1;
      const ridgeFreq = p.ridgeFrequency ?? 1;
      const ridgePhase = p.ridgePhase ?? 2;
      const invert = p.invert ?? false;
      const churnF = frac(churn);

      mx += (mouse.current.x - mx) * 0.1;
      my += (mouse.current.y - my) * 0.1;

      for (let gy = 0, cy = size / 2; cy < h + size / 2; gy++, cy += size) {
        for (let gx = 0, cx = size / 2; cx < w + size / 2; gx++, cx += size) {
          const vUvx = cx / w;
          const vUvy = cy / h;
          // mat2(c, -sn, sn, c) is column-major: rows are (c, sn), (-sn, c).
          const tx = (vUvx - 0.5) * c + (vUvy - 0.5) * sn + 0.5;
          const ty = (vUvx - 0.5) * -sn + (vUvy - 0.5) * c + 0.5;
          let uvx = (tx - 1.0) * zoom - shx;
          let uvy = (ty - 1.0) * zoom - shy;

          const muvx = mx / Math.max(w, 1);
          const muvy = my / Math.max(h, 1);
          const mdx = vUvx - muvx;
          const mdy = vUvy - muvy;
          const mdist = Math.hypot(mdx * (w / Math.max(h, 1)), mdy);
          const interaction = russell(mdist) * hasMouse;
          const push = Math.max(mdist, 1e-4);
          uvx += ((mdx / push) * interaction * intensity * 0.08);
          uvy += ((mdy / push) * interaction * intensity * 0.08);

          const px = (uvx + 0.6) * density;
          const py = (uvy - 0.1) * density;
          // Scalar multiply, like the shader — applies to both components.
          const ridge = Math.sin(Math.log(Math.max(Math.abs(uvy), 1e-4)) * ridgeFreq + ridgePhase);
          uvx *= ridge;
          uvy *= ridge;

          const L = Math.hypot(uvx, uvy);
          const radius = L / Math.hypot(L, 0.1, 0.51);
          const drift = (Math.log2(radius) * 15.0 + flow) * swirl;
          const bearing = Math.sin(Math.atan2(uvy, uvx));
          const pushx = Math.sin(bearing);
          const pushy = Math.sin(drift);

          let film = 0;
          for (let i = 0; i < MAX_LAYERS; i++) {
            if (i >= layers) break;
            const layer = i + 1;
            let vx = px;
            let vy = py;
            let f = 1;
            for (let k = 0; k < MAX_DETAIL; k++) {
              if (k >= detail) break;
              // GLSL evaluates both components from the old v — snapshot first.
              const ox = vx;
              const oy = vy;
              vx += ((Math.tan(Math.cos(oy * f + f + layer - churn)) * turbulence + 2.5) / f + pushx);
              vy += ((Math.tan(Math.cos(ox * f + f + layer - churn)) * turbulence + 2.5) / f + pushy);
              f *= 1.5;
            }
            film += 1 / (5 * Math.hypot(vx, vy));
          }

          let light = Math.tanh(Math.max(film, 0) * exposure) * gain;
          light *= 1 + (hash2(cx + churnF * 1000, cy + churnF * 1000) - 0.5) * grain;
          light *= opacity;
          let gray = clamp(light, 0, 1);
          if (invert) gray = 1 - gray;
          const ci = clamp(Math.floor(gray * (chars.length - 1)), 0, chars.length - 1);
          const ch = chars[ci] ?? " ";
          if (ch === " ") continue;
          ctx.globalAlpha = clamp(gray + 0.1, 0, 1);
          ctx.fillText(ch, gx * size, gy * size);
        }
      }
      ctx.globalAlpha = 1;
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

    const onMove = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      mouse.current = {
        x: e.clientX - rect.left,
        y: rect.height - (e.clientY - rect.top),
      };
    };
    wrap.addEventListener("mousemove", onMove);

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
      wrap.removeEventListener("mousemove", onMove);
      ro.disconnect();
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: "hidden",
        opacity: 0.25,
        // Backdrop must never intercept clicks: it paints above static
        // siblings (e.g. the login buttons) in DOM order.
        pointerEvents: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(to bottom, #0a0a0a 0%, transparent 25%, transparent 80%, #0a0a0a 100%)",
        }}
      />
    </div>
  );
};

export const AsciiRidges: React.FC<AsciiRidgesProps> = (props) =>
  glAvailable() ? <AsciiRidgesGL {...props} /> : <AsciiRidges2D {...props} />;

export default AsciiRidges;
