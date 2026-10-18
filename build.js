// Builds dist/ (the folder the mod loader imports): node build.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const VERSION = "1.0.0";
const GAME = "0.6.3";
const root = __dirname;
const out = path.join(root, "dist", VERSION);
fs.mkdirSync(out, { recursive: true });

fs.copyFileSync(path.join(root, "src", "main.js"), path.join(out, "main.mod.js"));

const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
json(path.join(root, "dist", "manifest.json"), {
  name: "Replay Cam",
  author: "Hiksi",
  id: "ptreplaycam",
  latest: { [GAME]: VERSION },
});
json(path.join(out, "version.json"), { main: "main.mod.js", targets: [GAME], dependencies: [] });

// icon.png: a film camera, drawn here so the repo needs no binary source
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(pixel(x / size, y / size), y * (size * 4 + 1) + 1 + x * 4);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    const head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const inBox = (x, y, cx, cy, w, h) => Math.abs(x - cx) < w / 2 && Math.abs(y - cy) < h / 2;
const inCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) < r;
fs.writeFileSync(
  path.join(out, "icon.png"),
  png(128, (x, y) => {
    if (inCircle(x, y, 0.33, 0.3, 0.13) || inCircle(x, y, 0.6, 0.3, 0.13)) return [255, 176, 32, 255]; // reels
    if (inBox(x, y, 0.45, 0.62, 0.5, 0.34)) return [255, 255, 255, 255]; // body
    if (Math.abs(y - 0.62) < (x - 0.7) * 0.9 && x < 0.9) return [255, 255, 255, 255]; // lens
    return [33, 43, 88, 255];
  }),
);
console.log("built", path.relative(root, out));
