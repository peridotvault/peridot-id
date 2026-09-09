"use client";
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "motion/react";
import * as THREE from "three";
import { cn } from "@/lib/utils";
export interface GlowingRidgesProps {
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
    colorA?: string;
    colorB?: string;
    colorC?: string;
    colorCycle?: number;
    rotation?: number;
    grain?: number;
    opacity?: number;
    backgroundColor?: string;
    blend?: "add" | "ink";
    paused?: boolean;
    dpr?: number;
    className?: string;
    children?: ReactNode;
}
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

uniform vec2 uResolution;
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
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uColorCycle;
uniform float uRotation;
uniform float uGrain;
uniform float uOpacity;
uniform vec3 uBackground;
uniform float uInk;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y);
}




vec3 palette(float layer) {
  vec3 w = 0.25 + 1.0 * cos(layer * uColorCycle + vec3(0.0, 2.094, 4.189));
  return uColorA * w.x + uColorB * w.y + uColorC * w.z;
}

void main() {


  float c = cos(uRotation);
  float sn = sin(uRotation);
  vec2 turned = mat2(c, -sn, sn, c) * (vUv - 0.5) + 0.5;
  vec2 uv = (turned - 1.0) * uZoom - uShift;


  vec2 p = (uv + vec2(0.6, -0.1)) * uDensity;



  uv *= sin(log(max(abs(uv.y), 1e-4)) * uRidgeFrequency + uRidgePhase);

  float radius = normalize(vec3(length(uv), 0.1, 0.51)).x;
  float drift = (log2(radius) * 15.0 + uFlow) * uSwirl;
  float bearing = sin(atan(uv.y, uv.x));
  vec2 push = sin(vec2(bearing, drift));

  vec3 film = vec3(0.0);
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

    film += palette(layer) / (5.0 * length(v));
  }

  vec3 light = tanh(max(film, 0.0) * uExposure) * uGain;


  float noise = hash(gl_FragCoord.xy + fract(uChurn) * 1000.0) - 0.5;
  light *= 1.0 + noise * uGrain;
  light *= uOpacity;

  vec3 lit = uBackground + light;



  float amount = max(light.r, max(light.g, light.b));
  float coverage = smoothstep(0.08, 0.6, amount);
  vec3 pigment = amount > 0.0001 ? light / amount : vec3(1.0);
  vec3 inked = uBackground * mix(vec3(1.0), pigment * 0.75, coverage);

  gl_FragColor = vec4(clamp(mix(lit, inked, uInk), 0.0, 1.0), 1.0);
}
`;
const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));
const makeColor = (value: string, fallback: string) => {
    const color = new THREE.Color();
    try {
        color.setStyle(value, THREE.LinearSRGBColorSpace);
    } catch {
        color.setStyle(fallback, THREE.LinearSRGBColorSpace);
    }
    return color;
};
const updateColor = (target: THREE.Color, value: string) => {
    try {
        target.setStyle(value, THREE.LinearSRGBColorSpace);
    } catch { }
};
const subscribeToDpr = (notify: () => void) => {
    const media = window.matchMedia("(min-resolution: 2dppx)");
    media.addEventListener("change", notify);
    window.addEventListener("resize", notify);
    return () => {
        media.removeEventListener("change", notify);
        window.removeEventListener("resize", notify);
    };
};
const readDpr = () =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
interface FilmProps {
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
    colorA: string;
    colorB: string;
    colorC: string;
    colorCycle: number;
    rotation: number;
    grain: number;
    opacity: number;
    backgroundColor: string;
    blend: "add" | "ink";
    paused: boolean;
}
const Film = ({
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
    colorA,
    colorB,
    colorC,
    colorCycle,
    rotation,
    grain,
    opacity,
    backgroundColor,
    blend,
    paused,
}: FilmProps) => {
    const materialRef = useRef<THREE.ShaderMaterial>(null);
    const flow = useRef(0);
    const churn = useRef(0);
    const { gl, size, invalidate } = useThree();
    const uniforms = useMemo(
        () => ({
            uResolution: { value: new THREE.Vector2(1, 1) },
            uFlow: { value: 0 },
            uChurn: { value: 0 },
            uLayers: { value: 12 },
            uDetail: { value: 5 },
            uTurbulence: { value: 0.6 },
            uZoom: { value: 1.1 },
            uShift: { value: new THREE.Vector2(0.45, 0.5) },
            uRidgeFrequency: { value: 1 },
            uRidgePhase: { value: 2 },
            uDensity: { value: 11 },
            uSwirl: { value: 16 },
            uExposure: { value: 0.25 },
            uGain: { value: 2 },
            uColorA: { value: makeColor("#ff6a2a", "#ff6a2a") },
            uColorB: { value: makeColor("#22d3ee", "#22d3ee") },
            uColorC: { value: makeColor("#c026d3", "#c026d3") },
            uColorCycle: { value: 0.4 },
            uRotation: { value: 0 },
            uGrain: { value: 0.25 },
            uOpacity: { value: 0.75 },
            uBackground: { value: makeColor("#000000", "#000000") },
            uInk: { value: 0 },
        }),
        [],
    );
    useEffect(() => {
        const material = materialRef.current;
        if (!material) return;
        updateColor(material.uniforms.uColorA.value, colorA);
        updateColor(material.uniforms.uColorB.value, colorB);
        updateColor(material.uniforms.uColorC.value, colorC);
        updateColor(material.uniforms.uBackground.value, backgroundColor);
        invalidate();
    }, [colorA, colorB, colorC, backgroundColor, invalidate]);
    useEffect(() => {
        invalidate();
    }, [
        layers,
        detail,
        turbulence,
        zoom,
        shiftX,
        shiftY,
        ridgeFrequency,
        ridgePhase,
        density,
        swirl,
        exposure,
        gain,
        colorCycle,
        rotation,
        grain,
        opacity,
        blend,
        invalidate,
    ]);
    useFrame((_, delta) => {
        const material = materialRef.current;
        if (!material) return;
        if (!paused) {
            const step = Math.min(delta, 0.05);
            flow.current += step * flowSpeed;
            churn.current += step * churnSpeed;
        }
        const pixelRatio = gl.getPixelRatio();
        const values = material.uniforms;
        values.uResolution.value.set(
            size.width * pixelRatio,
            size.height * pixelRatio,
        );
        values.uFlow.value = flow.current;
        values.uChurn.value = churn.current;
        values.uLayers.value = Math.round(clamp(layers, 1, MAX_LAYERS));
        values.uDetail.value = Math.round(clamp(detail, 1, MAX_DETAIL));
        values.uTurbulence.value = Math.max(turbulence, 0);
        values.uZoom.value = Math.max(zoom, 0.05);
        values.uShift.value.set(shiftX, shiftY);
        values.uRidgeFrequency.value = ridgeFrequency;
        values.uRidgePhase.value = ridgePhase;
        values.uDensity.value = Math.max(density, 0.1);
        values.uSwirl.value = swirl;
        values.uExposure.value = Math.max(exposure, 0);
        values.uGain.value = Math.max(gain, 0);
        values.uColorCycle.value = colorCycle;
        values.uRotation.value = (rotation * Math.PI) / 180;
        values.uGrain.value = clamp(grain, 0, 2);
        values.uOpacity.value = clamp(opacity, 0, 1);
        values.uInk.value = blend === "ink" ? 1 : 0;
    });
    return (
        <mesh frustumCulled={false}>
            <planeGeometry args={[1, 1]} />
            <shaderMaterial
                ref={materialRef}
                vertexShader={vertexShader}
                fragmentShader={fragmentShader}
                uniforms={uniforms}
                depthTest={false}
                depthWrite={false}
            />
        </mesh>
    );
};
export const GlowingRidges = ({
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
    exposure = 0.25,
    gain = 2,
    colorA = "#ff6a2a",
    colorB = "#22d3ee",
    colorC = "#c026d3",
    colorCycle = 0.4,
    rotation = 0,
    grain = 0.25,
    opacity = 0.75,
    backgroundColor = "#000000",
    blend = "add",
    paused = false,
    dpr = 1,
    className,
    children,
}: GlowingRidgesProps) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(true);
    const reducedMotion = useReducedMotion();
    const deviceDpr = useSyncExternalStore(subscribeToDpr, readDpr, () => 1);
    const pixelRatio = Math.min(deviceDpr, Math.max(dpr, 0.5));
    useEffect(() => {
        const node = rootRef.current;
        if (!node || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            ([entry]) => setVisible(entry.isIntersecting),
            { threshold: 0 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    const still = paused || Boolean(reducedMotion);
    return (
        <div ref={rootRef} className={cn("relative overflow-hidden", className)}>
            <div className="absolute inset-0">
                <Canvas
                    orthographic
                    dpr={pixelRatio}
                    frameloop={visible && !still ? "always" : "demand"}
                    gl={{
                        antialias: false,
                        alpha: false,
                        powerPreference: "high-performance",
                    }}
                >
                    <Film
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
                        colorA={colorA}
                        colorB={colorB}
                        colorC={colorC}
                        colorCycle={colorCycle}
                        rotation={rotation}
                        grain={grain}
                        opacity={opacity}
                        backgroundColor={backgroundColor}
                        blend={blend}
                        paused={still}
                    />
                </Canvas>
            </div>
            {children ? (
                <div className="relative z-10 h-full w-full">{children}</div>
            ) : null}
        </div>
    );
};
export default GlowingRidges;
