"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "motion/react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

// Glowing-ridges flow field rendered through a glyph atlas pipeline.
// No video, no palette — ridge luminance tinted by a single uColor.

const MAX_LAYERS = 15;
const MAX_DETAIL = 10;

const vertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
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

    float light = tanh(max(film, 0.0) * uExposure) * uGain;

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
    vec3 finalColor = targetColor * alpha;

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

const createFontTexture = (
  chars: string,
  fontSize: number = 64
): THREE.Texture => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();

  const charCount = chars.length;
  const width = charCount * fontSize;
  const height = fontSize;

  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);

  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < charCount; i++) {
    const char = chars[i] ?? " ";
    const x = i * fontSize + fontSize / 2;
    const y = fontSize / 2;
    ctx.fillText(char, x, y);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface RidgeUniforms {
  uMouse: THREE.IUniform<THREE.Vector2>;
  uResolution: THREE.IUniform<THREE.Vector2>;
  uFontTexture: THREE.IUniform<THREE.Texture | null>;
  uCharCount: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  uInvert: THREE.IUniform<boolean>;
  uSize: THREE.IUniform<number>;
  uHasMouse: THREE.IUniform<number>;
  uInteractIntensity: THREE.IUniform<number>;
  uFlow: THREE.IUniform<number>;
  uChurn: THREE.IUniform<number>;
  uLayers: THREE.IUniform<number>;
  uDetail: THREE.IUniform<number>;
  uTurbulence: THREE.IUniform<number>;
  uZoom: THREE.IUniform<number>;
  uShift: THREE.IUniform<THREE.Vector2>;
  uRidgeFrequency: THREE.IUniform<number>;
  uRidgePhase: THREE.IUniform<number>;
  uDensity: THREE.IUniform<number>;
  uSwirl: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uGain: THREE.IUniform<number>;
  uRotation: THREE.IUniform<number>;
  uGrain: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
}

interface SceneProps {
  mouse: React.MutableRefObject<THREE.Vector2>;
  characters: string;
  color: string;
  invert: boolean;
  size: number;
  hasMouse: boolean;
  interactIntensity: number;
  layers: number;
  detail: number;
  turbulence: number;
  zoom: number;
  shiftX: number;
  shiftY: number;
  ridgeFrequency: number;
  ridgePhase: number;
  density: number;
  flowSpeed: number;
  churnSpeed: number;
  swirl: number;
  exposure: number;
  gain: number;
  rotation: number;
  grain: number;
  opacity: number;
  paused: boolean;
}

const Scene: React.FC<SceneProps> = ({
  mouse,
  characters,
  color,
  invert,
  size: elementSize,
  hasMouse,
  interactIntensity,
  layers,
  detail,
  turbulence,
  zoom,
  shiftX,
  shiftY,
  ridgeFrequency,
  ridgePhase,
  density,
  flowSpeed,
  churnSpeed,
  swirl,
  exposure,
  gain,
  rotation,
  grain,
  opacity,
  paused,
}) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const flow = useRef(0);
  const churn = useRef(0);
  const { gl, size } = useThree();

  const safeCharacters = characters.length > 0 ? characters : " ";

  const fontTextureRef = useRef<THREE.Texture | null>(null);

  const uniforms = useMemo(
    () => ({
      uMouse: { value: new THREE.Vector2(0, 0) },
      uResolution: { value: new THREE.Vector2(size.width, size.height) },
      uFontTexture: { value: null as THREE.Texture | null },
      uCharCount: { value: safeCharacters.length },
      uColor: { value: new THREE.Color(color) },
      uInvert: { value: invert },
      uSize: { value: elementSize },
      uHasMouse: { value: hasMouse ? 1.0 : 0.0 },
      uInteractIntensity: { value: interactIntensity },
      uFlow: { value: 0 },
      uChurn: { value: 0 },
      uLayers: { value: Math.round(clamp(layers, 1, MAX_LAYERS)) },
      uDetail: { value: Math.round(clamp(detail, 1, MAX_DETAIL)) },
      uTurbulence: { value: Math.max(turbulence, 0) },
      uZoom: { value: Math.max(zoom, 0.05) },
      uShift: { value: new THREE.Vector2(shiftX, shiftY) },
      uRidgeFrequency: { value: ridgeFrequency },
      uRidgePhase: { value: ridgePhase },
      uDensity: { value: Math.max(density, 0.1) },
      uSwirl: { value: swirl },
      uExposure: { value: Math.max(exposure, 0) },
      uGain: { value: Math.max(gain, 0) },
      uRotation: { value: (rotation * Math.PI) / 180 },
      uGrain: { value: clamp(grain, 0, 2) },
      uOpacity: { value: clamp(opacity, 0, 1) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    const texture = createFontTexture(safeCharacters);
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    fontTextureRef.current = texture;
    return () => {
      texture.dispose();
      fontTextureRef.current = null;
    };
  }, [safeCharacters]);

  useFrame((_, delta) => {
    if (materialRef.current) {
      const u = materialRef.current.uniforms as unknown as RidgeUniforms;
      if (!paused) {
        const step = Math.min(delta, 0.05);
        flow.current += step * flowSpeed;
        churn.current += step * churnSpeed;
      }
      const pixelRatio = gl.getPixelRatio();
      u.uResolution.value.set(
        size.width * pixelRatio,
        size.height * pixelRatio
      );
      u.uColor.value.set(color);
      u.uInvert.value = invert;
      u.uSize.value = elementSize;
      u.uHasMouse.value = hasMouse ? 1.0 : 0.0;
      u.uInteractIntensity.value = interactIntensity;
      u.uFlow.value = flow.current;
      u.uChurn.value = churn.current;
      u.uLayers.value = Math.round(clamp(layers, 1, MAX_LAYERS));
      u.uDetail.value = Math.round(clamp(detail, 1, MAX_DETAIL));
      u.uTurbulence.value = Math.max(turbulence, 0);
      u.uZoom.value = Math.max(zoom, 0.05);
      u.uShift.value.set(shiftX, shiftY);
      u.uRidgeFrequency.value = ridgeFrequency;
      u.uRidgePhase.value = ridgePhase;
      u.uDensity.value = Math.max(density, 0.1);
      u.uSwirl.value = swirl;
      u.uExposure.value = Math.max(exposure, 0);
      u.uGain.value = Math.max(gain, 0);
      u.uRotation.value = (rotation * Math.PI) / 180;
      u.uGrain.value = clamp(grain, 0, 2);
      u.uOpacity.value = clamp(opacity, 0, 1);
      u.uCharCount.value = safeCharacters.length;

      if (fontTextureRef.current) {
        u.uFontTexture.value = fontTextureRef.current;
      }

      if (mouse.current) {
        u.uMouse.value.lerp(mouse.current, 0.1);
      }
    }
  });

  return (
    <mesh ref={meshRef} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent={true}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
};

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

const AsciiRidges: React.FC<AsciiRidgesProps> = ({
  characters = " .:-+*=%@#",
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
}) => {
  const mouse = useRef(new THREE.Vector2(0, 0));
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = React.useState(true);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? true),
      { rootMargin: "120px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const still = paused || reducedMotion === true;

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = rect.height - (e.clientY - rect.top);
    mouse.current.set(x, y);
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
      <Canvas
        orthographic
        camera={{ position: [0, 0, 1], zoom: 1 }}
        dpr={[1, 1.5]}
        frameloop={inView ? (still ? "demand" : "always") : "never"}
        gl={{
          alpha: true,
          antialias: false,
          powerPreference: "high-performance",
        }}
      >
        <Scene
          mouse={mouse}
          characters={characters}
          color={color}
          invert={invert}
          size={elementSize}
          hasMouse={hasCursorInteraction}
          interactIntensity={interactIntensity}
          layers={layers}
          detail={detail}
          turbulence={turbulence}
          zoom={zoom}
          shiftX={shiftX}
          shiftY={shiftY}
          ridgeFrequency={ridgeFrequency}
          ridgePhase={ridgePhase}
          density={density}
          flowSpeed={flowSpeed}
          churnSpeed={churnSpeed}
          swirl={swirl}
          exposure={exposure}
          gain={gain}
          rotation={rotation}
          grain={grain}
          opacity={opacity}
          paused={still}
        />
      </Canvas>
    </div>
  );
};

export default AsciiRidges;
