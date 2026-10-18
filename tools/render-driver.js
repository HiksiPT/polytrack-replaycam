// Frame-by-frame renderer for PolyTrack replays, pasted into the loader's page.
// Exposes window.__rc:
//   trace(step)        car positions/speeds over the focused replay
//   render(shot)       films a shot (see below) into an H.264 stream, kept in rc.clips
//   bundle()           all clips as one Blob: "RCB1", u32 header length, JSON header, streams
// A shot: { name, dur (s of video), time(u) -> replay s, cam(ctx) -> { pos, look, fov, roll } | null }
// ctx: { u, t, p: car position [x,y,z], v: car velocity [x,y,z] }. cam returning null uses the game camera.
(() => {
  if (window.__rc) return "already";
  const N = window.polyModLoader.getFromPolyTrack(`({
    Sg, wt, Euler: M.O9p,
    time: (v) => (0, R.gn)(v, lg, "f"), setTime: (v, t) => (0, R.GG)(v, lg, t, "f"),
    endTime: (v) => (0, R.gn)(v, cg, "f"), timeline: (v) => (0, R.gn)(v, ug, "f"),
    spectator: (v) => (0, R.gn)(v, hg, "f"), renderer: (v) => (0, R.gn)(v, eg, "f"),
    ui: (v) => (0, R.gn)(v, dg, "f"), entry: (v) => (0, R.gn)(v, sg, "f")[(0, R.gn)(v, ag, "f")],
  })`);
  const rc = (window.__rc = { N, viewer: null, driving: false, inStep: false, pose: null, clips: {}, status: "idle" });
  const vp = N.Sg.prototype, viewUpdate = vp.update;
  vp.update = function (dt) {
    rc.viewer = this;
    if (rc.driving && !rc.inStep) return; // the game's own loop waits while a shot renders
    return viewUpdate.call(this, dt);
  };
  const sp = N.wt.prototype, specUpdate = sp.update;
  sp.update = function (dt) {
    specUpdate.call(this, dt);
    if (rc.pose && rc.viewer && N.spectator(rc.viewer) === this) applyPose(this);
  };

  const stateAt = (t) => N.entry(rc.viewer).replay.getFrame(Math.max(0, Math.round(t * 1000)));
  const carAt = (t) => {
    const s = stateAt(t), a = stateAt(t - 0.05), b = stateAt(t + 0.05);
    const P = (x) => [x.position.x, x.position.y, x.position.z];
    const pa = P(a), pb = P(b);
    return { p: P(s), v: pb.map((x, i) => (x - pa[i]) / 0.1), kmh: s.speedKmh, frames: s.frames };
  };
  rc.carAt = carAt;

  function applyPose(spec) {
    const { shot, u, t } = rc.pose;
    const car = carAt(t);
    const c = shot.cam({ u, t, p: car.p, v: car.v });
    const cam = spec.camera;
    const look = c.look, pos = c.pos;
    const dx = look[0] - pos[0], dy = look[1] - pos[1], dz = look[2] - pos[2];
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.quaternion.setFromEuler(new N.Euler(pitch, yaw, c.roll || 0, "YXZ"));
    const fov = c.fov || 70;
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  function step(t) {
    const v = rc.viewer, tl = N.timeline(v);
    const d = t - N.time(v);
    rc.inStep = true;
    try {
      if (d > 1e-6 && d < 0.5) { tl.isPaused = false; viewUpdate.call(v, d); }
      else { N.setTime(v, Math.max(0, Math.min(t, N.endTime(v)))); tl.isPaused = true; viewUpdate.call(v, 1 / 60); }
    } finally { rc.inStep = false; }
  }

  rc.loaded = () => {
    const tl = N.timeline(rc.viewer);
    return { loaded: tl.loadedTime?.time ?? 0, end: N.endTime(rc.viewer), finish: N.entry(rc.viewer).settings.time?.time ?? null };
  };

  rc.trace = (dt = 0.05) => {
    const end = N.entry(rc.viewer).settings.time.time, out = [];
    for (let t = 0; t <= end + 1e-9; t += dt) {
      const c = carAt(t);
      out.push([+t.toFixed(3), ...c.p.map((x) => +x.toFixed(2)), +c.kmh.toFixed(0), +c.v[1].toFixed(2)]);
    }
    return out;
  };

  rc.render = async (shot) => {
    const v = rc.viewer, canvas = N.renderer(v).canvas, spec = N.spectator(v);
    const W = canvas.width, H = canvas.height, FPS = 60;
    const chunks = [];
    let err = null;
    const enc = new VideoEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push(b); },
      error: (e) => (err = e),
    });
    enc.configure({ codec: "avc1.640033", width: W, height: H, bitrate: 24e6, framerate: FPS, avc: { format: "annexb" }, latencyMode: "quality" });
    const ui = N.ui(v), uiWas = ui.isVisible;
    rc.driving = true;
    ui.isVisible = false;
    const frames = Math.round(shot.dur * FPS);
    try {
      for (let f = 0; f < frames; f++) {
        const u = frames > 1 ? f / (frames - 1) : 0, t = shot.time(u);
        const free = !!shot.cam;
        if (spec.isEnabled !== free) spec.isEnabled = free;
        rc.pose = free ? { shot, u, t } : null;
        step(t);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        enc.encode(frame, { keyFrame: f % FPS === 0 });
        frame.close();
        if (f % 20 === 19) await enc.flush();
        if (err) throw err;
        rc.status = `${shot.name} ${f + 1}/${frames}`;
      }
      await enc.flush();
    } finally {
      enc.close();
      rc.pose = null;
      rc.driving = false;
      ui.isVisible = uiWas;
    }
    const size = chunks.reduce((s, c) => s + c.length, 0), data = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { data.set(c, at); at += c.length; }
    rc.clips[shot.name] = { w: W, h: H, frames, fps: FPS, data, track: shot.track, player: shot.player };
    rc.status = `done ${shot.name}`;
    return { name: shot.name, w: W, h: H, frames, mb: +(size / 1e6).toFixed(2) };
  };

  // Runs render() in the background so a tool call does not have to wait for it.
  rc.queue = [];
  rc.start = (shots) => {
    rc.queue.push(...shots);
    if (rc.running) return "queued";
    rc.running = (async () => {
      while (rc.queue.length) {
        const s = rc.queue.shift();
        try { rc.last = await rc.render(s); } catch (e) { rc.lastError = String(e?.stack || e); rc.status = "error " + s.name; }
      }
      rc.running = null;
    })();
    return "started";
  };

  rc.snapshot = (w = 270) => {
    const c = N.renderer(rc.viewer).canvas, h = Math.round((w * c.height) / c.width);
    const o = document.createElement("canvas");
    o.width = w; o.height = h;
    o.getContext("2d").drawImage(c, 0, 0, w, h);
    return o.toDataURL("image/jpeg", 0.8);
  };

  rc.bundle = () => {
    const names = Object.keys(rc.clips), header = { clips: [] };
    let offset = 0;
    for (const n of names) {
      const c = rc.clips[n];
      header.clips.push({ name: n, w: c.w, h: c.h, frames: c.frames, fps: c.fps, track: c.track, player: c.player, offset, size: c.data.length });
      offset += c.data.length;
    }
    const hb = new TextEncoder().encode(JSON.stringify(header));
    const pre = new Uint8Array(8);
    pre.set([82, 67, 66, 49]); // RCB1
    new DataView(pre.buffer).setUint32(4, hb.length, true);
    return new Blob([pre, hb, ...names.map((n) => rc.clips[n].data)], { type: "application/octet-stream" });
  };
  return "ready";
})();
