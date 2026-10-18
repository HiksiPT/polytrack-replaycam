// Checks the camera-path maths: node test/path.test.mjs
import { readFileSync } from "fs";

// main.js imports PolyTypes.js from the page; give it a stand-in.
const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8")
  .replace(/const \{ PolyMod \} = await import\([^;]+;/, "class PolyMod {}");
const { __test } = await import("data:text/javascript," + encodeURIComponent(src));
const { plan, sample, aimAngles } = __test;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failed++;
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const key = (t, x, extra = {}) => ({ t, pos: [x, 10, 0], yaw: 0, pitch: 0, roll: 0, fov: 70, speed: 1, aim: 0, hold: 2, ...extra });

// Normal speed: video time equals replay time, and the path passes through every keyframe.
{
  const p = plan([key(1, 0), key(3, 20), key(4, 25)]);
  check("length at 1x", near(p.total, 3));
  check("ends hit", near(sample(p, 0).t, 1) && near(sample(p, 3).t, 4));
  check("passes keyframe 2", near(sample(p, 2).pos[0], 20) && near(sample(p, 2).t, 3));
  let maxStep = 0, prev = sample(p, 0).pos[0];
  for (let vt = 0.01; vt <= 3; vt += 0.01) {
    const x = sample(p, vt).pos[0];
    maxStep = Math.max(maxStep, x - prev);
    if (x < prev - 1e-9) maxStep = Infinity;
    prev = x;
  }
  check("moves forward smoothly", maxStep < 0.2, "largest step " + maxStep.toFixed(3));
}

// Slow motion: 0.25x over one replay second lasts four video seconds.
{
  const p = plan([key(2, 0, { speed: 0.25 }), key(3, 10, { speed: 0.25 })]);
  check("0.25x lasts 4 s", near(p.total, 4));
  check("0.25x halfway", near(sample(p, 2).t, 2.5));
}

// Speed ramp 1x -> 0.25x: mean speed 0.625, and replay time never goes back.
{
  const p = plan([key(0, 0, { speed: 1 }), key(1, 10, { speed: 0.25 })]);
  check("ramp length", near(p.total, 1 / 0.625));
  let ok = true, prev = -1;
  for (let vt = 0; vt <= p.total; vt += 0.005) {
    const t = sample(p, vt).t;
    if (t < prev - 1e-9) ok = false;
    prev = t;
  }
  check("ramp is monotonic and ends right", ok && near(sample(p, p.total).t, 1));
  check("ramp starts faster than it ends", sample(p, 0.1).t - sample(p, 0).t > sample(p, p.total).t - sample(p, p.total - 0.1).t);
}

// Freeze: two keyframes at the same moment hold the time while the camera moves.
{
  const p = plan([key(5, 0), key(5, 10, { hold: 3 }), key(6, 20)]);
  check("freeze length", near(p.total, 4));
  check("time held during freeze", near(sample(p, 1.5).t, 5) && sample(p, 1.5).pos[0] > 1 && sample(p, 1.5).pos[0] < 9);
}

// Yaw takes the short way round (170 deg -> -170 deg is 20 deg, not 340).
{
  const deg = Math.PI / 180;
  const p = plan([key(0, 0, { yaw: 170 * deg }), key(1, 0, { yaw: -170 * deg })]);
  const mid = sample(p, 0.5).yaw / deg;
  check("yaw short way", near(Math.abs(mid), 180, 1), mid.toFixed(1) + " deg");
}

// Aim: a camera east of the car turns west (+90 deg yaw looks down -X).
{
  const [yaw, pitch] = aimAngles([10, 0, 0], { x: 0, y: 0, z: 0 });
  check("aim yaw", near(yaw, Math.PI / 2), String(yaw));
  check("aim level", near(pitch, 0));
  const [, down] = aimAngles([0, 10, 10], { x: 0, y: 0, z: 0 });
  check("aim pitch down", near(down, -Math.PI / 4));
}

console.log(failed ? `${failed} failed` : "all passed");
process.exitCode = failed ? 1 : 0;
