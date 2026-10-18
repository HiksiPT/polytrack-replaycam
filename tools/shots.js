// Camera moves for the edit, added to window.__rc after render-driver.js.
(() => {
  const rc = window.__rc;
  const E = (u) => u * u * (3 - 2 * u);
  const lerp = (a, b, u) => a + (b - a) * u;
  // Smoothed horizontal heading of the car around time t (unit [x, z]).
  const heading = (t) => {
    const a = rc.carAt(Math.max(0, t - 0.2)).p, b = rc.carAt(t + 0.2).p;
    let dx = b[0] - a[0], dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  // Replay time for video progress u with speed going s0 -> s1 (relative speeds; t1 is reached at u = 1).
  const ramp = (t0, t1, s0 = 1, s1 = 1) => (u) => t0 + ((t1 - t0) * (s0 * u + ((s1 - s0) * u * u) / 2)) / ((s0 + s1) / 2);
  const hold = (t) => () => t;

  const S = (rc.shots = {});
  // Time frozen at t, camera circles the car (angles in radians, relative to the car's heading).
  S.freezeOrbit = (name, t, dur, a0, a1, r = 8, h = 2.5, fov = 55) => {
    const [hx, hz] = heading(t);
    const base = Math.atan2(hz, hx);
    return { name, dur, time: hold(t), cam: ({ u, p }) => {
      const a = base + lerp(a0, a1, E(u));
      return { pos: [p[0] + r * Math.cos(a), p[1] + h, p[2] + r * Math.sin(a)], look: [p[0], p[1] + 0.4, p[2]], fov };
    } };
  };
  // Orbit around the moving car.
  S.orbit = (name, t0, t1, dur, a0, a1, r = 9, h = 3, fov = 60, s0 = 1, s1 = 1) => {
    return { name, dur, time: ramp(t0, t1, s0, s1), cam: ({ u, t, p }) => {
      const [hx, hz] = heading(t);
      const a = Math.atan2(hz, hx) + lerp(a0, a1, u);
      return { pos: [p[0] + r * Math.cos(a), p[1] + h, p[2] + r * Math.sin(a)], look: [p[0], p[1] + 0.4, p[2]], fov };
    } };
  };
  // Low chase: behind (back > 0) or in front (back < 0) of the car, looking at it.
  S.chase = (name, t0, t1, dur, back = 7, up = 1.6, side = 0, fov = 70, s0 = 1, s1 = 1) => ({
    name, dur, time: ramp(t0, t1, s0, s1), cam: ({ t, p }) => {
      const [hx, hz] = heading(t);
      const pos = [p[0] - hx * back - hz * side, p[1] + up, p[2] - hz * back + hx * side];
      return { pos, look: [p[0] + hx * 4, p[1] + 0.6, p[2] + hz * 4], fov };
    },
  });
  // Camera fixed beside the track where the car is at time tm; it pans as the car passes.
  S.flyby = (name, t0, t1, dur, tm, side = 7, up = 1.2, ahead = 0, fov = 60, s0 = 1, s1 = 1) => {
    const pm = rc.carAt(tm).p, [hx, hz] = heading(tm);
    const pos = [pm[0] + hz * side + hx * ahead, pm[1] + up, pm[2] - hx * side + hz * ahead];
    return { name, dur, time: ramp(t0, t1, s0, s1), cam: ({ p }) => ({ pos, look: [p[0], p[1] + 0.4, p[2]], fov }) };
  };
  // Wide side view of a jump: fixed camera far to the side of the jump's middle, slightly below its peak.
  S.jumpSide = (name, ta, tb, dur, side = 26, fov = 55, s0 = 1, s1 = 1, lead = 0.35, tail = 0.35) => {
    const tm = (ta + tb) / 2, pm = rc.carAt(tm).p, [hx, hz] = heading(tm);
    const pos = [pm[0] + hz * side, pm[1] + 1, pm[2] - hx * side];
    return { name, dur, time: ramp(ta - lead, tb + tail, s0, s1), cam: ({ p }) => ({ pos, look: [p[0], p[1], p[2]], fov }) };
  };
  // Straight down from above, slowly turning.
  S.top = (name, t0, t1, dur, height = 22, turn = 0.6, fov = 60) => ({
    name, dur, time: ramp(t0, t1), cam: ({ u, p }) => {
      const a = lerp(0, turn, u);
      return { pos: [p[0] + 0.01, p[1] + height, p[2]], look: [p[0], p[1], p[2]], fov, roll: a };
    },
  });
  // The game's own chase camera.
  S.game = (name, t0, t1, dur) => ({ name, dur, time: ramp(t0, t1), cam: null });

  // Where the car is airborne (all wheels off) for at least `min` s, top speed, finish time.
  rc.survey = (min = 0.3) => {
    const e = rc.N.entry(rc.viewer), fin = e.settings.time.time, air = [];
    let start = null, top = [0, 0];
    for (let ms = 0; ms <= fin * 1000; ms += 10) {
      const s = e.replay.getFrame(ms), off = s.wheelContact.every((c) => c === null);
      if (off && start === null) start = ms;
      if (!off && start !== null) {
        if (ms - start >= min * 1000) {
          let peak = -1e9;
          for (let k = start; k <= ms; k += 20) peak = Math.max(peak, e.replay.getFrame(k).position.y);
          const y0 = e.replay.getFrame(start).position.y;
          air.push({ a: start / 1000, b: ms / 1000, kmh: Math.round(e.replay.getFrame(start).speedKmh), rise: +(peak - y0).toFixed(1), drop: +(y0 - s.position.y).toFixed(1) });
        }
        start = null;
      }
      if (s.speedKmh > top[0]) top = [s.speedKmh, ms / 1000];
    }
    return { player: e.settings.nickname, fin, air, top: [Math.round(top[0]), top[1]] };
  };
  return Object.keys(S);
})();
