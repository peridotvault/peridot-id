import { createUISFX, type CueName, type PlayingSFX, type UISFXPlayer } from "uisfx";
import { prefStorage } from "../data/db.ts";

// One pack for the whole wallet: zen's pure tones and dry wood sit under the
// UI instead of announcing themselves — feedback, not decoration.
export const SOUND_PACK = "zen";

// Feedback, not a soundtrack: well under half so no cue ever startles.
export const SOUND_VOLUME = 0.4;

// uisfx persists { pack, volume, enabled } under this key; readSoundEnabled
// reads that same shape, so there is no second preference store.
export const SOUND_PREF_KEY = "pid:sound";

/** Product events worth a cue. Not every control: outcomes and state changes. */
export type SoundAction =
  | "signed-in"
  | "signed-out"
  | "account-switched"
  | "approved"
  | "cancelled"
  | "failed"
  | "copied"
  | "saved"
  | "checked"
  | "unchecked"
  | "selected"
  | "sent"
  | "pending"
  | "checkout-opened"
  | "purchased"
  | "code-sent"
  | "progress-step"
  | "complete"
  | "hovered"
  | "pressed"
  | "closed";

/** Cue = what happened, not which control was pressed. */
export const CUE: Record<SoundAction, CueName> = {
  "signed-in": "connect",
  "signed-out": "disconnect",
  "account-switched": "select",
  approved: "success",
  // Same reason as `closed`: the pack's `cancel` is two notes. One release.
  cancelled: "release",
  failed: "error",
  copied: "copy",
  saved: "success",
  checked: "check",
  unchecked: "uncheck",
  selected: "select",
  sent: "success",
  pending: "info",
  "checkout-opened": "checkout",
  purchased: "purchase",
  "code-sent": "notification",
  "progress-step": "progress-step",
  complete: "complete",
  hovered: "hover",
  pressed: "press",
  // `close` in this pack is two notes 55ms apart, which reads as a double blip.
  // `back` is one descending note: one dismiss, one sound.
  closed: "back",
};

/** Visible processes that keep a loop until they end. */
export type SoundLoop = "send" | "provisioning";

export const LOOP_CUE: Record<SoundLoop, CueName> = {
  send: "processing",
  provisioning: "processing",
};

/** On unless the user turned it off; unreadable storage must never mute. */
export function readSoundEnabled(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    const raw = storage?.getItem(SOUND_PREF_KEY);
    if (!raw) return true;
    return (JSON.parse(raw) as { enabled?: unknown }).enabled !== false;
  } catch {
    return true;
  }
}

// One player for the page lifetime: module scope survives StrictMode remounts
// and HMR, so no duplicate AudioContexts and no duplicated cues.
let ui: UISFXPlayer | null = null;
// Web Audio only starts from a real gesture; until then background cues are
// dropped instead of queued.
let unlocked = false;
const loops = new Map<SoundLoop, PlayingSFX>();

// The preference lives in IndexedDB (Dexie `prefs`) behind a synchronous
// mirror, so the player can read it the moment audio unlocks.
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return prefStorage();
}

function player(): UISFXPlayer | null {
  if (typeof window === "undefined") return null;
  if (!ui) {
    const store = storage();
    ui = createUISFX({
      pack: SOUND_PACK,
      volume: SOUND_VOLUME,
      enabled: readSoundEnabled(store),
      preferences: store ? { key: SOUND_PREF_KEY, storage: store } : undefined,
    });
    // Persist the default pack and volume too (and overwrite older stored
    // values), so the preference file is complete and can never pin the
    // previous pack for an existing user.
    ui.setPack(SOUND_PACK);
    ui.setVolume(SOUND_VOLUME);
  }
  return ui;
}

/** Unlock audio on the first pointer or key contact (capture = before React). */
export function installSoundUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const onGesture = () => {
    const p = player();
    if (!p) return;
    unlocked = true;
    void p.unlock();
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  return () => {
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
  };
}

// Everything the user can activate: real buttons, links, form controls and the
// ARIA roles used by menus/tabs/toggles. Disabled controls stay silent.
const INTERACTIVE =
  'button, a[href], label[for], summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], input:not([type="hidden"]), select, textarea';

function nearbyInteractive(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>(INTERACTIVE);
  if (!el || el.matches(":disabled, [aria-disabled='true']")) return null;
  return el;
}

// A control can ask for its own cue: data-sfx="close" is dismiss (X, scrim),
// "scrim" is a dismiss surface that must not chirp on hover, "action" is a
// control whose click plays its own outcome cue (so no generic press too).
type SoundKind = "control" | "close" | "scrim" | "action";

function targetOf(node: EventTarget | null): { el: HTMLElement; kind: SoundKind } | null {
  if (!(node instanceof Element)) return null;
  const marked = node.closest<HTMLElement>("[data-sfx]");
  const el = marked ?? nearbyInteractive(node);
  if (!el || el.matches(":disabled, [aria-disabled='true']")) return null;
  const tag = el.getAttribute("data-sfx");
  if (tag === "scrim" || tag === "close" || tag === "action") return { el, kind: tag };
  return { el, kind: "control" };
}

// A label and the field it wraps are one control: moving row → input must not
// chirp a second hover.
function hoverGroup(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>("label") ?? el;
}

// Escape only recedes something that is actually open; on a plain page it is a
// no-op and must stay silent.
const OVERLAY = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

// Text fields take Space as typing, not as activation.
const TEXT_INPUTS = new Set([
  "text", "email", "search", "password", "number", "tel", "url",
  "date", "datetime-local", "month", "time", "week",
]);

/** Hover + press + close feedback for every control, delegated once. */
export function installInteractionSounds(): () => void {
  if (typeof window === "undefined") return () => {};
  // The last known pointer position. A pointerover at the same spot means the
  // DOM changed under a still cursor (a sheet just closed), not that the user
  // moved onto a new control — that must never sound.
  let lastPointer: { x: number; y: number } | null = null;
  const onPointerMove = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  };
  const onPointerOver = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    if (lastPointer?.x === e.clientX && lastPointer?.y === e.clientY) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    const t = targetOf(e.target);
    // Dismiss surfaces (scrim, X) only sound when they actually dismiss.
    if (!t || t.kind === "scrim" || t.kind === "close") return;
    const from = targetOf(e.relatedTarget);
    if (from && hoverGroup(from.el) === hoverGroup(t.el)) return;
    play("hovered");
  };
  const onPointerDown = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    const t = targetOf(e.target);
    // "action" controls cue their own outcome: a press on top would double.
    if (!t || t.kind === "action") return;
    play(t.kind === "control" ? "pressed" : "closed");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (document.querySelector(OVERLAY)) play("closed");
      return;
    }
    if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
    const t = targetOf(e.target);
    if (!t || t.kind === "action") return;
    if (e.key === " " && t.el instanceof HTMLInputElement && TEXT_INPUTS.has(t.el.type)) return;
    play(t.kind === "control" ? "pressed" : "closed");
  };
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}

export function play(action: SoundAction): void {
  if (!ui || !unlocked) return;
  ui.play(CUE[action]);
}

/** Idempotent: a second start while the loop is live is ignored. */
export function startLoop(key: SoundLoop): void {
  if (!unlocked || loops.has(key)) return;
  const handle = player()?.play(LOOP_CUE[key], { loop: true }) ?? null;
  if (handle) loops.set(key, handle);
}

export function stopLoop(key: SoundLoop): void {
  const handle = loops.get(key);
  loops.delete(key);
  handle?.stop();
}

/** Global transitions (logout, mute): stop loops and every one-shot. */
export function stopAllSounds(): void {
  for (const key of [...loops.keys()]) stopLoop(key);
  ui?.stopAll();
}

export function isSoundOn(): boolean {
  return ui ? ui.isEnabled() : readSoundEnabled(storage());
}

export function setSoundOn(on: boolean): void {
  // Mute must be immediate: clear the retained loop handles before setEnabled.
  if (!on) stopAllSounds();
  player()?.setEnabled(on);
}
