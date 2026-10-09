// Animation state machine for the VRM: loads Mixamo clips, crossfades between
// them, and handles the intro (fall-flat -> stand-up -> idle).
import * as THREE from "three";
import { loadMixamoAnimation } from "./loadMixamoAnimation.js";

const CLIP_FILES = {
  idle: "/animations/idle.fbx",
  thinking: "/animations/thinking.fbx",
  talking: "/animations/talking.fbx",
  dance: "/animations/dance.fbx",
  "fall-flat": "/animations/fall-flat.fbx",
  "stand-up": "/animations/stand-up.fbx",
};

export class AnimationController {
  constructor(vrm) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = {}; // name -> THREE.AnimationAction
    this.current = null; // current action name
    this._onIntroDone = null;

    this.mixer.addEventListener("finished", (e) => {
      if (this._onFinished) this._onFinished(e);
    });
  }

  async loadAll() {
    const entries = Object.entries(CLIP_FILES);
    const clips = await Promise.all(
      entries.map(([, url]) => loadMixamoAnimation(url, this.vrm))
    );
    entries.forEach(([name], i) => {
      const action = this.mixer.clipAction(clips[i]);
      this.actions[name] = action;
    });
  }

  update(delta) {
    this.mixer.update(delta);
  }

  // Crossfade to a looping clip.
  play(name, fade = 0.4) {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;

    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.enabled = true;
    next.fadeIn(fade);
    next.play();

    if (this.current && this.actions[this.current]) {
      this.actions[this.current].crossFadeTo(next, fade, false);
    }
    this.current = name;
  }

  // Play a one-shot clip once; resolves when finished.
  playOnce(name, { skip = 0, timeScale = 1 } = {}) {
    return new Promise((resolve) => {
      const action = this.actions[name];
      if (!action) return resolve();

      // Fade out whatever is currently playing.
      if (this.current && this.actions[this.current]) {
        this.actions[this.current].fadeOut(0.3);
      }

      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.timeScale = timeScale;
      action.enabled = true;
      if (skip > 0) action.time = skip;
      action.fadeIn(0.2);
      action.play();
      this.current = name;

      const handler = (e) => {
        if (e.action === action) {
          this.mixer.removeEventListener("finished", handler);
          action.timeScale = 1;
          resolve();
        }
      };
      this.mixer.addEventListener("finished", handler);
    });
  }

  // The intro: fall-flat (once) -> stand-up (skip 2.5s, 1.6x) -> idle loop.
  async playIntro() {
    await this.playOnce("fall-flat");
    await this.playOnce("stand-up", { skip: 2.5, timeScale: 1.6 });
    this.play("idle", 0.4);
  }
}
