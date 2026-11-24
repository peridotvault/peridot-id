// UI SFX semantics: the cue table must stay valid against the installed
// catalog, and sound must stay optional and silent without a browser.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CUES, cueNames, getPlaybackMode, packNames } from "uisfx";
import {
  CUE,
  LOOP_CUE,
  SOUND_PACK,
  SOUND_PREF_KEY,
  installInteractionSounds,
  installSoundUnlock,
  isSoundOn,
  play,
  readSoundEnabled,
  setSoundOn,
  startLoop,
  stopAllSounds,
  stopLoop,
} from "../src/shared/sfx/player.ts";

function storageOf(value) {
  return { getItem: (key) => (key === SOUND_PREF_KEY ? value : null) };
}

describe("sound pack + cue table", () => {
  it("uses an installed pack", () => {
    assert.ok(packNames.includes(SOUND_PACK));
  });

  it("maps every action to a valid cue", () => {
    for (const [action, cue] of Object.entries(CUE)) {
      assert.ok(cueNames.includes(cue), `${action} → ${cue} is not in the catalog`);
    }
  });

  it("dismiss cues are a single note", () => {
    // A two-note cue reads as two sounds on one click (the pack's `close` and
    // `cancel` are two notes 55–80 ms apart). Dismiss must be one sound.
    for (const action of ["closed", "cancelled"]) {
      assert.equal(CUES.find((c) => c.name === CUE[action]).notes.length, 1, `${action} → ${CUE[action]}`);
    }
  });

  it("describes states, not just presses", () => {
    // Global input feedback requested by the product: hover, press, close.
    assert.equal(CUE.hovered, "hover");
    assert.equal(CUE.pressed, "press");
    assert.notEqual(CUE.closed, CUE.pressed);
    // Opposite states get opposite cues.
    assert.notEqual(CUE.checked, CUE.unchecked);
    assert.notEqual(CUE["signed-in"], CUE["signed-out"]);
    assert.equal(CUE.sent, "success");
    assert.equal(CUE.failed, "error");
    assert.equal(CUE.purchased, "purchase");
    assert.notEqual(CUE.purchased, CUE["checkout-opened"]);
  });

  it("only loops real loop cues", () => {
    for (const [process, cue] of Object.entries(LOOP_CUE)) {
      assert.ok(cueNames.includes(cue), `${process} → ${cue} is not in the catalog`);
      assert.equal(getPlaybackMode(cue), "loop", `${cue} must be a loop cue`);
    }
  });
});

describe("sound preference", () => {
  it("defaults to on", () => {
    assert.equal(readSoundEnabled(null), true);
    assert.equal(readSoundEnabled(storageOf(null)), true);
  });

  it("reads the enabled flag uisfx persists", () => {
    assert.equal(readSoundEnabled(storageOf(JSON.stringify({ pack: SOUND_PACK, volume: 0.7, enabled: false }))), false);
    assert.equal(readSoundEnabled(storageOf(JSON.stringify({ pack: SOUND_PACK, volume: 0.7, enabled: true }))), true);
  });

  it("never mutes because storage is corrupt", () => {
    assert.equal(readSoundEnabled(storageOf("{not json")), true);
    assert.equal(readSoundEnabled({ getItem: () => { throw new Error("denied"); } }), true);
  });
});

describe("player without a browser", () => {
  it("no-ops instead of touching window or throwing", () => {
    assert.equal(typeof installSoundUnlock(), "function");
    assert.equal(typeof installInteractionSounds(), "function");
    assert.doesNotThrow(() => play("signed-in"));
    assert.doesNotThrow(() => startLoop("send"));
    assert.doesNotThrow(() => stopLoop("send"));
    assert.doesNotThrow(() => stopAllSounds());
    assert.doesNotThrow(() => setSoundOn(false));
    assert.equal(isSoundOn(), true);
  });
});
