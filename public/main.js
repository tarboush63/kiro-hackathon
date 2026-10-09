// Entry point: scene setup, VRM load, render loop, and wiring of UI/audio/ws.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

import { AnimationController } from "./animation.js";
import { AudioPlayer } from "./audio.js";
import { WSClient } from "./ws.js";
import { Mic, micSupported } from "./mic.js";

const EMOTIONS = ["happy", "angry", "sad", "relaxed"]; // neutral = all 0

// ---- DOM ----
const sceneEl = document.getElementById("scene");
const startScreen = document.getElementById("start-screen");
const startButton = document.getElementById("start-button");
const bubble = document.getElementById("bubble");
const chatInput = document.getElementById("chat-input");
const sendButton = document.getElementById("send-button");
const danceButton = document.getElementById("dance-button");
const micButton = document.getElementById("mic-button");

// ---- State ----
let vrm = null;
let anim = null;
const audio = new AudioPlayer();
let character = null;
let waiting = false; // awaiting an answer
let speaking = false; // audio is playing
let dancing = false;
let currentEmotion = "neutral";
let danceMusic = null;

// ---- Three.js scene ----
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
sceneEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  20
);
camera.position.set(0, 1.0, 4.0);
camera.lookAt(0, 0.75, 0);

const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1, 1, 1).normalize();
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.4));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- Blink ----
let blinkTimer = 0;
let nextBlink = 2 + Math.random() * 3;
let blinkValue = 0;
let blinking = false;

function updateBlink(delta) {
  if (!vrm || !vrm.expressionManager) return;
  blinkTimer += delta;
  if (!blinking && blinkTimer >= nextBlink) {
    blinking = true;
    blinkTimer = 0;
  }
  if (blinking) {
    // Quick close then open over ~0.2s.
    blinkValue += delta * 10;
    const v = blinkValue < 1 ? blinkValue : 2 - blinkValue;
    vrm.expressionManager.setValue("blink", Math.max(0, Math.min(1, v)));
    if (blinkValue >= 2) {
      blinking = false;
      blinkValue = 0;
      vrm.expressionManager.setValue("blink", 0);
      nextBlink = 2 + Math.random() * 3;
    }
  }
}

// ---- Emotion ----
function applyEmotion(name) {
  currentEmotion = name;
}

function updateEmotion() {
  if (!vrm || !vrm.expressionManager) return;
  const em = vrm.expressionManager;
  // Only show emotion while speaking; otherwise relax to neutral.
  const show = speaking && EMOTIONS.includes(currentEmotion);
  EMOTIONS.forEach((e) =>
    em.setValue(e, show && e === currentEmotion ? 0.7 : 0)
  );
}

// ---- Render loop ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (anim) anim.update(delta);
  if (vrm) {
    updateBlink(delta);
    audio.updateMouth(vrm);
    updateEmotion();
    vrm.update(delta);
  }
  renderer.render(scene, camera);
}
animate();

// ---- Load character config + VRM ----
async function boot() {
  character = await fetch("/character").then((r) => r.json());
  applyBackground(character.background);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(character.avatar);
  vrm = gltf.userData.vrm;

  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  scene.add(vrm.scene);

  anim = new AnimationController(vrm);
  await anim.loadAll();
  // Idle until the user clicks start.
  anim.play("idle", 0.1);
}

function applyBackground(colors) {
  if (Array.isArray(colors) && colors.length >= 2) {
    document.body.style.background = `linear-gradient(160deg, ${colors[0]} 0%, ${colors[1]} 100%)`;
  }
}

// ---- WebSocket ----
const client = new WSClient(onServerMessage);

function onServerMessage(msg) {
  if (msg.type === "answer") {
    onAnswer(msg);
  } else if (msg.type === "error") {
    onError(msg.message);
  } else if (msg.type === "partial") {
    // Live transcript while the user is talking (bonus A).
    showBubble(msg.text);
  }
}

async function onAnswer(msg) {
  stopDance(); // any answer stops dancing
  waiting = false;
  applyEmotion(msg.emotion || "neutral");

  // Show speech bubble + talking animation while speaking.
  showBubble(msg.text);
  speaking = true;
  if (anim) anim.play("talking", 0.4);

  if (msg.audio) {
    await audio.play(msg.audio, msg.visemes || []);
  }

  speaking = false;
  hideBubble();
  if (anim && !dancing) anim.play("idle", 0.4);
  setBusy(false);

  // Bonus B: looping move after voice ends.
  if (msg.move && msg.move !== "none" && msg.move === "dance") {
    startDance();
  }
}

let suppressNextError = false;

function onError(message) {
  waiting = false;
  speaking = false;
  if (anim && !dancing) anim.play("idle", 0.4);
  setBusy(false);
  if (suppressNextError) {
    // We already showed a more specific message (e.g. silent microphone).
    suppressNextError = false;
    return;
  }
  showBubble(message || "Sorry, please try again.");
  setTimeout(hideBubble, 2500);
}

// ---- UI ----
function showBubble(text) {
  bubble.textContent = text;
  bubble.classList.remove("hidden");
}
function hideBubble() {
  bubble.classList.add("hidden");
}

let busyTimeout = null;

function setBusy(busy) {
  waiting = busy;
  sendButton.disabled = busy;
  if (busyTimeout) {
    clearTimeout(busyTimeout);
    busyTimeout = null;
  }
  if (busy) {
    if (anim) anim.play("thinking", 0.4);
    // Safety net: never stay stuck waiting forever if a reply goes missing.
    busyTimeout = setTimeout(() => {
      if (waiting) onError("Sorry, I lost my train of thought. Try again.");
    }, 25000);
  }
}

function sendMessage() {
  if (waiting) return;
  let text = chatInput.value.trim();
  if (!text) return;
  text = text.slice(0, 500);

  stopDance();
  chatInput.value = "";
  setBusy(true);
  client.sendChat(text);
}

sendButton.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

// ---- Dance ----
function startDance() {
  if (!anim) return;
  dancing = true;
  danceButton.classList.add("active");
  anim.play("dance", 0.4);
  if (!danceMusic) {
    danceMusic = new Audio("/music/dance.mp3");
    danceMusic.loop = true;
  }
  danceMusic.currentTime = 0;
  danceMusic.play().catch(() => {});
}

function stopDance() {
  if (!dancing) return;
  dancing = false;
  danceButton.classList.remove("active");
  if (danceMusic) {
    danceMusic.pause();
  }
  if (anim && !speaking && !waiting) anim.play("idle", 0.4);
}

danceButton.addEventListener("click", () => {
  if (dancing) stopDance();
  else startDance();
});

// ---- Microphone (bonus A) ----
let mic = null;
let recording = false;

async function setupMic() {
  // Only show the button if the browser AND server both support it.
  let serverOk = false;
  try {
    serverOk = (await fetch("/capabilities").then((r) => r.json())).microphone;
  } catch (e) {
    serverOk = false;
  }
  if (!micSupported() || !serverOk) {
    micButton.classList.add("hidden");
    return;
  }
  micButton.classList.remove("hidden");

  // Pass a getter so the mic always uses the CURRENT socket (survives reconnects).
  mic = new Mic(() => client.socket);
  mic.onAutoStop = () => endRecording();

  // Live level meter so it's obvious whether the mic is picking up sound.
  mic.onLevel = (peak) => {
    if (!recording) return;
    const bars = Math.max(1, Math.round(peak * 20));
    showBubble(
      `Listening ${"\u2588".repeat(bars)}${"\u2591".repeat(20 - bars)}`
    );
  };

  // Hold-to-talk via pointer events. Pointer capture keeps the release bound to
  // the button even if the cursor drifts off it while holding.
  micButton.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      micButton.setPointerCapture(e.pointerId);
    } catch (err) {
      /* not critical */
    }
    startRecording();
  });
  micButton.addEventListener("pointerup", (e) => {
    try {
      micButton.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* not critical */
    }
    endRecording();
  });
  micButton.addEventListener("pointercancel", endRecording);

  // Hold Space to talk, but not while typing in the text box.
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && document.activeElement !== chatInput && !e.repeat) {
      e.preventDefault();
      startRecording();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && document.activeElement !== chatInput) {
      e.preventDefault();
      endRecording();
    }
  });
}

async function startRecording() {
  if (recording || waiting || !mic) return;
  recording = true;
  stopDance();
  micButton.classList.add("recording");
  // Use the shared AudioContext gesture unlock too.
  audio.init();
  if (anim) anim.play("thinking", 0.4);
  showBubble("Listening...");
  try {
    await mic.start();
  } catch (e) {
    console.error("mic start failed", e);
    recording = false;
    micButton.classList.remove("recording");
    showBubble("I can't reach your microphone. Try typing.");
    setTimeout(hideBubble, 2500);
    if (anim && !dancing) anim.play("idle", 0.4);
  }
}

function endRecording() {
  if (!recording || !mic) return;
  recording = false;
  micButton.classList.remove("recording");

  const sentAudio = mic.chunksSent > 0;
  const wasSilent = sentAudio && mic.peak < 0.02;

  mic.stop();

  if (wasSilent) {
    // No point waiting on Transcribe: the audio had no sound in it.
    suppressNextError = true; // don't let the server's generic error override this
    showBubble(
      "Your microphone sent only silence. Check that it isn't muted and that the right input device is selected."
    );
    setTimeout(hideBubble, 6000);
    if (anim && !dancing) anim.play("idle", 0.4);
    return;
  }

  // Server will transcribe, then answer (or send an error). Keep thinking.
  setBusy(true);
}

// ---- Click to start ----
startButton.addEventListener("click", async () => {
  audio.init(); // unlock audio from the user gesture
  startScreen.classList.add("hidden");

  if (anim) {
    await anim.playIntro();
  }
  // Milestone 5: speak the greeting after the intro.
  client.sendGreeting();
});

// ---- Go ----
boot().catch((err) => {
  console.error("boot failed", err);
});

setupMic().catch((err) => {
  console.error("mic setup failed", err);
});
