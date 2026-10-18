// Replay Cam for PolyTrack 0.6.3 (PolyModLoader).
// ReplayMod-style camera paths for the game's replay viewer (Leaderboard -> Watch):
// place keyframes with the free camera, play the path back as one smooth shot
// with speed ramps, and record the picture straight to a video file.
//
// The game already has the free camera ("/", WASD, Z/C, Shift, drag to look),
// pausing (Space) and hiding its UI (H). This mod drives those: it changes the
// time step the viewer advances by and poses the free camera after the viewer
// has moved it, just before the frame is drawn.

const { PolyMod } = await import(new URL("PolyTypes.js", document.baseURI).href);

// The game swaps the global Math for its own deterministic one once it starts.
const MATH = Math;
const TAU = 2 * MATH.PI;
const STORE = "ptReplayCam.v1";
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];
const SAME_TIME = 0.0005; // keyframes closer than this in the replay share one moment (a freeze)
const LEAD_IN = 0.5; // seconds the first frame is held before a path starts
const RECORD_FPS = 60;

// Read in the game's own scope: Sg is the replay viewer, wt the free camera,
// M.O9p three.js' Euler; the WeakMaps hold the viewer's private fields.
const NATIVE = `({
  defined: () => { try { return typeof Sg === "function" && typeof wt === "function"; } catch { return false; } },
  viewerClass: () => Sg,
  spectatorClass: () => wt,
  Euler: () => M.O9p,
  time: (v) => (0, R.gn)(v, lg, "f"),
  setTime: (v, t) => (0, R.GG)(v, lg, t, "f"),
  endTime: (v) => (0, R.gn)(v, cg, "f"),
  timeline: (v) => (0, R.gn)(v, ug, "f"),
  spectator: (v) => (0, R.gn)(v, hg, "f"),
  renderer: (v) => (0, R.gn)(v, eg, "f"),
  ui: (v) => (0, R.gn)(v, dg, "f"),
  car: (v) => (0, R.gn)(v, sg, "f")[(0, R.gn)(v, ag, "f")].car,
})`;

const clamp = (x, a, b) => MATH.min(b, MATH.max(a, x));
const smooth = (u) => u * u * (3 - 2 * u);
const wrapPi = (a) => a - TAU * MATH.round(a / TAU);

// ---------------------------------------------------------------- path maths
// Keyframes are sorted by replay time. Each segment lasts (replay time) / (mean
// speed) seconds of video, or `hold` seconds when both ends share one moment.
function plan(keys) {
  const points = [];
  let vt = 0, prevYaw = null;
  keys.forEach((k, i) => {
    let yaw = k.yaw;
    if (prevYaw !== null) yaw += TAU * MATH.round((prevYaw - yaw) / TAU); // turn the short way
    prevYaw = yaw;
    if (i > 0) {
      const p = keys[i - 1], dt = k.t - p.t;
      vt += dt < SAME_TIME ? MATH.max(0.1, k.hold) : dt / ((p.speed + k.speed) / 2);
    }
    points.push({ key: k, vt, v: [k.pos[0], k.pos[1], k.pos[2], yaw, k.pitch, k.roll, k.fov] });
  });
  return { points, total: vt };
}

// Catmull-Rom with knots at the keyframes' video times (Barry-Goldman), so the
// camera keeps its speed through keyframes that are unevenly spaced.
function catmull(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const mix = (a, b, ta, tb) => {
    const w = (t - ta) / (tb - ta);
    return a.map((x, i) => x + (b[i] - x) * w);
  };
  const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, t0, t2), mix(a2, a3, t1, t3), t1, t2);
}

function sample(path, vt) {
  const P = path.points;
  vt = clamp(vt, 0, path.total);
  let i = 0;
  while (i < P.length - 2 && vt > P[i + 1].vt) i++;
  const a = P[i], b = P[i + 1], span = b.vt - a.vt;
  const u = clamp((vt - a.vt) / span, 0, 1);
  // Speed changes linearly over the segment; replay time is its integral.
  const dt = b.key.t - a.key.t;
  let t = a.key.t;
  if (dt >= SAME_TIME) {
    const s0 = a.key.speed, s1 = b.key.speed;
    t += (dt * (s0 * u + ((s1 - s0) * u * u) / 2)) / ((s0 + s1) / 2);
  }
  const pa = P[i - 1] ?? { vt: a.vt - span, v: a.v };
  const pb = P[i + 2] ?? { vt: b.vt + span, v: b.v };
  const v = catmull(pa.v, a.v, b.v, pb.v, pa.vt, a.vt, b.vt, pb.vt, vt);
  return {
    t, pos: v.slice(0, 3), yaw: v[3], pitch: v[4], roll: v[5], fov: v[6],
    aim: a.key.aim + (b.key.aim - a.key.aim) * smooth(u),
    speed: a.key.speed + (b.key.speed - a.key.speed) * u,
  };
}

// Yaw and pitch that point a camera at `to` (three.js cameras look down -Z).
function aimAngles(from, to) {
  const dx = to.x - from[0], dy = to.y - from[1], dz = to.z - from[2];
  const flat = MATH.hypot(dx, dz);
  if (flat + MATH.abs(dy) < 1e-6) return null;
  return [MATH.atan2(-dx, -dz), MATH.atan2(dy, flat)];
}

const fmt = (t) => t.toFixed(3) + " s";

class ReplayCam extends PolyMod {
  #pml;
  #native = null;
  #patched = false;
  #failed = false;

  viewer = null; // the replay viewer on screen
  keys = []; // { t, pos, yaw, pitch, roll, fov, speed, aim, hold }
  speed = 1; // playback speed outside paths
  roll = 0;
  fov = 70;
  aimLive = false;
  guide = false;
  realDt = null;
  #held = new Set();
  #pose = null; // pose for the free camera this frame
  #play = null; // { path, vt, lead, record }
  #rec = null;
  #ui = null;
  #savedUi = null;

  constructor() {
    super();
    this.preInit = (pml) => (this.#pml = pml);
    this.init = (pml) => this.#init(pml);
    this.postInit = () => this.#patch();
    this.onGameLoad = () => {
      this.#patch();
      if (!this.#patched) console.error("[Replay Cam] this game version is not supported (no replay viewer found).");
    };
  }

  #init(pml) {
    this.#pml = pml;
    this.#native = pml.getFromPolyTrack(NATIVE);
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if (saved && Array.isArray(saved.keys)) this.keys = saved.keys.filter(validKey);
    } catch {}
    this.#patch();
    globalThis.__ptReplayCam = this;
    try {
      if (!this.savedLatest) {
        this.savedLatest = true; // see Car Collisions: link-imported mods are otherwise pinned
        pml.saveModsToLocalStorage();
      }
    } catch {}
  }

  // Wraps the viewer's update/dispose and the free camera's update.
  #patch() {
    if (this.#patched || !this.#native?.defined()) return;
    this.#patched = true;
    const mod = this;
    const viewer = this.#native.viewerClass().prototype;
    const spectator = this.#native.spectatorClass().prototype;
    const update = viewer.update, dispose = viewer.dispose, specUpdate = spectator.update;
    viewer.update = function (dt) {
      if (mod.#failed) return update.call(this, dt);
      let pass = dt;
      try {
        pass = mod.#beforeViewer(this, dt);
      } catch (error) {
        mod.#fail(error);
      }
      update.call(this, pass);
      try {
        mod.#afterViewer();
      } catch (error) {
        mod.#fail(error);
      }
    };
    viewer.dispose = function () {
      if (mod.viewer === this) mod.#leave();
      return dispose.call(this);
    };
    spectator.update = function (dt) {
      const ours = !mod.#failed && mod.viewer && mod.#native.spectator(mod.viewer) === this;
      specUpdate.call(this, ours && mod.realDt != null ? mod.realDt : dt);
      if (!ours) return;
      try {
        mod.#poseCamera(this);
      } catch (error) {
        mod.#fail(error);
      }
    };
    window.addEventListener("keydown", (e) => this.#key(e, true), true);
    window.addEventListener("keyup", (e) => this.#key(e, false), true);
    window.addEventListener("blur", () => this.#held.clear());
    window.addEventListener("wheel", (e) => this.#wheel(e), { passive: true });
    console.log("[Replay Cam] ready");
  }

  #fail(error) {
    this.#failed = true;
    console.error("[Replay Cam] stopped:", error);
    this.#stopPath(false);
    if (this.#ui) this.#ui.status.textContent = "Replay Cam stopped after an error (details in the console).";
  }

  // ---------------------------------------------------------------- per frame
  #beforeViewer(v, dt) {
    if (this.viewer !== v) {
      this.viewer = v;
      this.roll = 0;
      this.fov = 70;
      this.#buildUi();
    }
    this.realDt = dt;
    const N = this.#native, tl = N.timeline(v);
    const play = this.#play;
    if (!play) {
      this.#refreshClock();
      return tl.isPaused ? dt : dt * this.speed;
    }
    // Path playback: the path decides the replay time; the viewer is advanced
    // by exactly the difference, so engine sound and effects keep running.
    if (play.lead > 0) play.lead -= dt;
    else {
      const loaded = tl.loadedTime?.time ?? Infinity;
      const next = MATH.min(play.vt + dt, play.path.total);
      if (sample(play.path, next).t <= loaded) play.vt = next; // otherwise wait for the replay to load
    }
    const s = sample(play.path, play.vt);
    this.#pose = s;
    let step = s.t - N.time(v);
    if (step <= 1e-6 || step > 0.5) {
      N.setTime(v, clamp(s.t, 0, N.endTime(v)));
      step = 0;
    }
    tl.isPaused = step === 0;
    if (play.lead <= 0 && play.vt >= play.path.total) play.done = true;
    this.#refreshClock(s);
    return step;
  }

  #afterViewer() {
    const rec = this.#rec, play = this.#play;
    if (rec && !(play && play.lead > 0)) this.#grab(rec);
    if (play?.done) this.#stopPath(true);
  }

  // Runs inside the viewer's update, after the free camera moved and before drawing.
  #poseCamera(spec) {
    const cam = spec.camera, N = this.#native, E = N.Euler();
    const s = this.#pose;
    this.#pose = null;
    if (s) {
      if (!spec.isEnabled) spec.isEnabled = true;
      let yaw = s.yaw, pitch = s.pitch;
      if (s.aim > 0.001) {
        const a = aimAngles(s.pos, this.#target());
        if (a) {
          yaw += wrapPi(a[0] - yaw) * s.aim;
          pitch += (a[1] - pitch) * s.aim;
        }
      }
      cam.position.set(s.pos[0], s.pos[1], s.pos[2]);
      cam.quaternion.setFromEuler(new E(pitch, yaw, s.roll, "YXZ"));
      this.roll = s.roll;
      this.#setFov(cam, s.fov);
      return;
    }
    if (!spec.isEnabled) return;
    const dt = this.realDt ?? 0;
    if (this.#held.has("KeyQ")) this.roll += 1.2 * dt;
    if (this.#held.has("KeyE")) this.roll -= 1.2 * dt;
    const e = new E().setFromQuaternion(cam.quaternion, "YXZ");
    let yaw = e.y, pitch = e.x;
    if (this.aimLive) {
      const a = aimAngles([cam.position.x, cam.position.y, cam.position.z], this.#target());
      if (a) [yaw, pitch] = a;
    }
    cam.quaternion.setFromEuler(new E(pitch, yaw, this.roll, "YXZ"));
    this.#setFov(cam, this.fov);
  }

  #setFov(cam, fov) {
    if (MATH.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  #target() {
    const p = this.#native.car(this.viewer).getPosition();
    p.y += 0.5;
    return p;
  }

  #leave() {
    this.#stopPath(false);
    this.viewer = null;
    this.#ui?.root.remove();
    this.#ui?.guide.remove();
    this.#ui = null;
  }

  // ---------------------------------------------------------------- input
  #key(e, down) {
    if (!this.viewer || this.#failed) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (!down) {
      this.#held.delete(e.code);
      return;
    }
    const spec = this.#native.spectator(this.viewer);
    const act = {
      KeyK: () => this.addKey(),
      KeyG: () => (this.#play ? this.#stopPath(false) : this.playPath(false)),
      KeyF: () => this.setAim(!this.aimLive),
      KeyV: () => this.setGuide(!this.guide),
      KeyB: () => this.#ui?.root.classList.toggle("rc-min"),
      BracketLeft: () => this.setSpeed(-1),
      BracketRight: () => this.setSpeed(1),
    }[e.code];
    if (act) {
      if (!e.repeat) act();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (spec.isEnabled && (e.code === "KeyQ" || e.code === "KeyE")) {
      this.#held.add(e.code);
      e.preventDefault();
    } else if (spec.isEnabled && e.code === "KeyR" && !e.repeat) {
      this.roll = 0;
      this.fov = 70;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  #wheel(e) {
    if (!this.viewer || this.#play || e.target !== this.#native.renderer(this.viewer).canvas) return;
    if (!this.#native.spectator(this.viewer).isEnabled) return;
    this.fov = clamp(this.fov * MATH.pow(1.0015, e.deltaY), 10, 120);
  }

  // ---------------------------------------------------------------- actions
  addKey() {
    if (!this.viewer || this.#play) return;
    const N = this.#native, v = this.viewer, spec = N.spectator(v);
    const free = spec.isEnabled;
    const cam = free ? spec.camera : N.renderer(v).camera;
    const e = new (N.Euler())().setFromQuaternion(cam.quaternion, "YXZ");
    const key = {
      t: N.time(v),
      pos: [cam.position.x, cam.position.y, cam.position.z],
      yaw: e.y, pitch: e.x, roll: free ? this.roll : e.z,
      fov: free ? this.fov : cam.fov,
      speed: this.speed, aim: free && this.aimLive ? 1 : 0, hold: 2,
    };
    // After every keyframe at the same moment, so several at one time make a freeze.
    let at = this.keys.findIndex((k) => k.t > key.t + SAME_TIME);
    if (at < 0) at = this.keys.length;
    this.keys.splice(at, 0, key);
    this.#changed(`Keyframe ${at + 1} added at ${fmt(key.t)}${free ? "" : " (from the game camera)"}`);
    return key;
  }

  playPath(record, from = 0) {
    if (!this.viewer || this.#play) return;
    if (this.keys.length < 2) return this.#say("A path needs at least two keyframes (K).");
    const path = plan(this.keys);
    const ui = this.#native.ui(this.viewer);
    this.#savedUi = { gameUi: ui.isVisible, guide: this.guide };
    ui.isVisible = false;
    this.#ui?.root.classList.add("rc-hidden");
    if (this.#ui) this.#ui.guide.style.display = "none";
    this.#play = { path, vt: path.points[from]?.vt ?? 0, lead: LEAD_IN, done: false };
    if (record) this.#startRecording(record);
    this.#say(record ? "Recording the path..." : "Playing the path... (G stops)");
  }

  #stopPath(finished) {
    const play = this.#play;
    if (!play) {
      if (this.#rec) this.#stopRecording();
      return;
    }
    this.#play = null;
    if (this.#rec) this.#stopRecording();
    if (this.viewer && this.#savedUi) {
      this.#native.ui(this.viewer).isVisible = this.#savedUi.gameUi;
      this.#native.timeline(this.viewer).isPaused = true;
    }
    this.#ui?.root.classList.remove("rc-hidden");
    this.#renderUi();
    this.#say(finished ? "Path finished." : "Path stopped.");
  }

  goTo(i) {
    const k = this.keys[i];
    if (!k || !this.viewer || this.#play) return;
    const N = this.#native, spec = N.spectator(this.viewer);
    N.timeline(this.viewer).isPaused = true;
    N.setTime(this.viewer, clamp(k.t, 0, N.endTime(this.viewer)));
    this.#pose = { ...k, aim: k.aim };
    if (!spec.isEnabled) spec.isEnabled = true;
    this.fov = k.fov;
    this.#say(`At keyframe ${i + 1}.`);
  }

  setKeyFromCamera(i) {
    const old = this.keys[i];
    if (!old || this.#play) return;
    this.keys.splice(i, 1);
    const k = this.addKey();
    Object.assign(k, { speed: old.speed, hold: old.hold });
    this.#changed(`Keyframe ${this.keys.indexOf(k) + 1} set at ${fmt(k.t)}.`);
  }

  deleteKey(i) {
    this.keys.splice(i, 1);
    this.#changed(`Keyframe ${i + 1} deleted.`);
  }

  setSpeed(dir) {
    const i = SPEEDS.indexOf(this.speed);
    this.speed = SPEEDS[clamp((i < 0 ? 4 : i) + dir, 0, SPEEDS.length - 1)];
    this.#renderUi();
  }

  setAim(on) {
    this.aimLive = on;
    this.#renderUi();
  }

  setGuide(on) {
    this.guide = on;
    this.#renderUi();
  }

  #changed(message) {
    try {
      localStorage.setItem(STORE, JSON.stringify({ keys: this.keys }));
    } catch {}
    this.#renderUi();
    if (message) this.#say(message);
  }

  #say(text) {
    if (this.#ui) this.#ui.status.textContent = text;
  }

  // ---------------------------------------------------------------- recording
  // Copies each drawn frame into a canvas of its own (cropped to 9:16 if asked)
  // and records that; the game's menus are HTML on top and never show up.
  #startRecording(mode) {
    const src = this.#native.renderer(this.viewer).canvas;
    let sw = src.width, sh = src.height;
    if (mode === "tall") sw = MATH.min(sw, MATH.round((sh * 9) / 16));
    const scale = MATH.min(1, 1920 / MATH.max(sw, sh), 1080 / MATH.min(sw, sh));
    const out = document.createElement("canvas");
    out.width = MATH.round((sw * scale) / 2) * 2;
    out.height = MATH.round((sh * scale) / 2) * 2;
    const ctx = out.getContext("2d");
    const stream = out.captureStream(0);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 40e6 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const a = document.createElement("a");
      const d = new Date(), p = (n) => String(n).padStart(2, "0");
      a.download = `replaycam-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
      a.href = URL.createObjectURL(blob);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
      this.#say(`Saved ${a.download} (${out.width}x${out.height}, ${(blob.size / 1e6).toFixed(1)} MB).`);
    };
    recorder.start(1000);
    this.#rec = { recorder, ctx, out, src, mode, track: stream.getVideoTracks()[0], last: -1 };
  }

  #grab(rec) {
    const now = performance.now();
    if (rec.last >= 0 && now - rec.last < 1000 / RECORD_FPS - 2) return;
    rec.last = now;
    const { src, out, ctx } = rec;
    let sw = src.width, sh = src.height, sx = 0;
    if (rec.mode === "tall") {
      const w = MATH.min(sw, MATH.round((sh * 9) / 16));
      sx = MATH.round((sw - w) / 2);
      sw = w;
    }
    ctx.drawImage(src, sx, 0, sw, sh, 0, 0, out.width, out.height);
    rec.track.requestFrame?.();
  }

  #stopRecording() {
    const rec = this.#rec;
    this.#rec = null;
    if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
  }

  // ---------------------------------------------------------------- panel
  #buildUi() {
    this.#ui?.root.remove();
    this.#ui?.guide.remove();
    const root = document.createElement("div");
    root.className = "rc-panel";
    root.innerHTML = `
      <style>
        .rc-panel { position: fixed; top: 12px; right: 12px; width: 330px; max-height: calc(100vh - 140px); overflow: auto;
          z-index: 1000; pointer-events: auto; background: rgba(16, 20, 38, 0.88); color: #fff; border-radius: 8px;
          font: 13px/1.35 ForcedSquare, sans-serif; padding: 10px 12px; box-shadow: 0 4px 18px rgba(0,0,0,.4); user-select: none; }
        .rc-panel.rc-min > :not(.rc-head) { display: none; }
        .rc-panel.rc-hidden { display: none; }
        .rc-head { display: flex; justify-content: space-between; align-items: center; font-size: 16px; margin-bottom: 6px; }
        .rc-panel button { font: inherit; color: #fff; background: #2d3a6b; border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; margin: 2px 2px 2px 0; }
        .rc-panel button:hover { background: #3d4f91; }
        .rc-panel button.rc-on { background: #d08b1c; }
        .rc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; margin: 4px 0; }
        .rc-keys { margin: 6px 0; border-top: 1px solid #ffffff30; }
        .rc-key { display: grid; grid-template-columns: 22px 64px 1fr auto; gap: 4px; align-items: center; padding: 3px 0; border-bottom: 1px solid #ffffff18; }
        .rc-key input { width: 42px; font: inherit; background: #0c1022; color: #fff; border: 1px solid #ffffff40; border-radius: 3px; padding: 1px 3px; }
        .rc-key label { white-space: nowrap; }
        .rc-key button { padding: 2px 6px; }
        .rc-dim { color: #ffffffa0; font-size: 12px; }
        .rc-status { margin-top: 6px; color: #ffd27a; min-height: 1.3em; }
        .rc-bar { position: relative; height: 14px; background: #0c1022; border-radius: 3px; margin: 6px 0; cursor: pointer; }
        .rc-bar i { position: absolute; top: 2px; width: 3px; height: 10px; background: #d08b1c; margin-left: -1px; }
        .rc-bar b { position: absolute; top: 0; width: 2px; height: 14px; background: #fff; }
        .rc-guide { position: fixed; inset: 0; pointer-events: none; z-index: 999; display: flex; justify-content: center; }
        .rc-guide div { height: 100%; aspect-ratio: 9 / 16; max-width: 100%; box-shadow: 0 0 0 100vmax rgba(0,0,0,.55); outline: 2px dashed #ffffffa0; }
      </style>
      <div class="rc-head"><span>Replay Cam</span><span><button data-a="min" title="Hide (B)">_</button></span></div>
      <div class="rc-clock rc-dim"></div>
      <div class="rc-bar" title="Click to jump; orange marks are keyframes"></div>
      <div class="rc-row">
        <button data-a="add" title="K">+ Keyframe</button>
        <button data-a="play" title="G">Play path</button>
        <button data-a="rec-tall" title="Plays the path and saves it as a 9:16 video">Record 9:16</button>
        <button data-a="rec-full" title="Plays the path and saves the whole screen as a video">Record full</button>
      </div>
      <div class="rc-row">
        <span>Speed</span><button data-a="slower" title="[">-</button><span class="rc-speed"></span><button data-a="faster" title="]">+</button>
        <button data-a="aim" title="F: the free camera keeps the car in the middle">Aim at car</button>
        <button data-a="guide" title="V: shows the part a 9:16 video keeps">9:16 guide</button>
      </div>
      <div class="rc-dim">Free camera: <b>/</b> on/off, WASD + Z/C fly, Shift faster, drag to look, Q/E tilt, wheel zoom, R reset tilt and zoom. Space pauses, H hides the game's UI.</div>
      <div class="rc-keys"></div>
      <div class="rc-row rc-dim"><span class="rc-total"></span></div>
      <div class="rc-row">
        <button data-a="clear">Clear path</button><button data-a="copy">Copy path</button><button data-a="paste">Paste path</button>
      </div>
      <div class="rc-status"></div>`;
    const guide = document.createElement("div");
    guide.className = "rc-guide";
    guide.innerHTML = "<div></div>";
    document.body.append(root, guide);
    const q = (s) => root.querySelector(s);
    this.#ui = { root, guide, clock: q(".rc-clock"), bar: q(".rc-bar"), keys: q(".rc-keys"), total: q(".rc-total"), status: q(".rc-status"), speed: q(".rc-speed") };
    for (const type of ["keydown", "keyup", "mousedown", "wheel"]) {
      root.addEventListener(type, (e) => {
        if (type !== "keydown" || e.target.tagName === "INPUT") e.stopPropagation();
      });
    }
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      b.blur();
      const i = Number(b.dataset.i);
      ({
        min: () => root.classList.toggle("rc-min"),
        add: () => this.addKey(),
        play: () => (this.#play ? this.#stopPath(false) : this.playPath(false)),
        "rec-tall": () => this.playPath("tall"),
        "rec-full": () => this.playPath("full"),
        slower: () => this.setSpeed(-1),
        faster: () => this.setSpeed(1),
        aim: () => this.setAim(!this.aimLive),
        guide: () => this.setGuide(!this.guide),
        clear: () => confirm("Delete all keyframes?") && ((this.keys = []), this.#changed("Path cleared.")),
        copy: () => navigator.clipboard?.writeText(JSON.stringify({ replayCam: 1, keys: this.keys })).then(() => this.#say("Path copied.")),
        paste: () => this.#paste(),
        go: () => this.goTo(i),
        set: () => this.setKeyFromCamera(i),
        del: () => this.deleteKey(i),
        fromhere: () => this.playPath(false, i),
      })[b.dataset.a]?.();
    });
    this.#ui.keys.addEventListener("change", (e) => {
      const input = e.target, k = this.keys[Number(input.dataset.i)];
      if (!k) return;
      if (input.dataset.f === "aim") k.aim = input.checked ? 1 : 0;
      else {
        const x = Number(input.value);
        if (input.dataset.f === "speed" && x > 0) k.speed = clamp(x, 0.05, 8);
        if (input.dataset.f === "hold" && x >= 0) k.hold = clamp(x, 0.1, 30);
      }
      this.#changed();
    });
    this.#ui.bar.addEventListener("mousedown", (e) => {
      if (!this.viewer || this.#play) return;
      const r = this.#ui.bar.getBoundingClientRect();
      const N = this.#native, end = N.endTime(this.viewer);
      N.timeline(this.viewer).isPaused = true;
      N.setTime(this.viewer, clamp(((e.clientX - r.left) / r.width) * end, 0, end));
    });
    this.#renderUi();
    this.#say(this.keys.length ? `Loaded your last path (${this.keys.length} keyframes).` : "Press / for the free camera, then K to add keyframes.");
  }

  #paste() {
    const text = prompt("Paste a path copied with \"Copy path\":");
    if (!text) return;
    try {
      const data = JSON.parse(text);
      const keys = (data.keys || []).filter(validKey);
      if (!keys.length) throw new Error("no keyframes");
      this.keys = keys.sort((a, b) => a.t - b.t);
      this.#changed(`Pasted ${keys.length} keyframes.`);
    } catch {
      this.#say("That is not a Replay Cam path.");
    }
  }

  #renderUi() {
    const ui = this.#ui;
    if (!ui) return;
    ui.speed.textContent = this.speed + "x";
    ui.root.querySelector('[data-a="aim"]').classList.toggle("rc-on", this.aimLive);
    ui.root.querySelector('[data-a="guide"]').classList.toggle("rc-on", this.guide);
    ui.guide.style.display = this.guide && !this.#play ? "" : "none";
    const rows = this.keys.map((k, i) => {
      const freeze = i > 0 && k.t - this.keys[i - 1].t < SAME_TIME;
      return `<div class="rc-key">
        <span>${i + 1}</span><span>${fmt(k.t)}</span>
        <span>${freeze
          ? `<label title="How long the freeze lasts">hold <input data-i="${i}" data-f="hold" value="${k.hold}"> s</label>`
          : `<label title="Playback speed at this keyframe (1 = normal, 0.25 = slow motion)">x<input data-i="${i}" data-f="speed" value="${k.speed}"></label>`}
          <label title="Keep the car in the middle of the shot"><input type="checkbox" data-i="${i}" data-f="aim" ${k.aim ? "checked" : ""} style="width:auto">aim</label></span>
        <span><button data-a="go" data-i="${i}" title="Jump here">Go</button><button data-a="set" data-i="${i}" title="Replace with the current camera and time">Set</button><button data-a="fromhere" data-i="${i}" title="Play the path from here">&#9654;</button><button data-a="del" data-i="${i}" title="Delete">&times;</button></span>
      </div>`;
    });
    ui.keys.innerHTML = rows.join("") || `<div class="rc-dim" style="padding:6px 0">No keyframes yet.</div>`;
    ui.total.textContent = this.keys.length >= 2 ? `Path length: ${plan(this.keys).total.toFixed(2)} s of video` : "";
    this.#refreshClock();
  }

  #refreshClock(s) {
    const ui = this.#ui, v = this.viewer;
    if (!ui || !v) return;
    const N = this.#native, t = N.time(v), end = N.endTime(v) || 1;
    const text = `Replay ${fmt(t)}  |  speed ${s ? s.speed.toFixed(2) : this.speed}x  |  ${N.spectator(v).isEnabled ? "free camera" : "game camera"}`;
    if (ui.clock.textContent !== text) ui.clock.textContent = text;
    const marks = this.keys.map((k) => (k.t / end * 100).toFixed(2)).join(",");
    if (ui.bar.dataset.marks !== marks) {
      ui.bar.dataset.marks = marks;
      ui.bar.innerHTML = this.keys.map((k) => `<i style="left:${(k.t / end) * 100}%"></i>`).join("") + "<b></b>";
    }
    ui.bar.lastChild.style.left = clamp((t / end) * 100, 0, 100) + "%";
  }
}

function validKey(k) {
  const n = (x) => typeof x === "number" && Number.isFinite(x);
  if (!k || !n(k.t) || !Array.isArray(k.pos) || k.pos.length !== 3 || !k.pos.every(n)) return false;
  if (![k.yaw, k.pitch, k.roll, k.fov].every(n)) return false;
  k.speed = n(k.speed) && k.speed > 0 ? k.speed : 1;
  k.hold = n(k.hold) && k.hold > 0 ? k.hold : 2;
  k.aim = k.aim ? 1 : 0;
  return true;
}

export const polyMod = new ReplayCam();
export const __test = { plan, sample, aimAngles };
