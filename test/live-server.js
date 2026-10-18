// Tries the built mod in a real game without the mod loader:
//   node test/live-server.js [port] [game server]
// Starts the PolyTrack AI game server on port 8772 (its leaderboards hold the
// runs kept on this PC; PTAI_NO_ADOPT keeps it from reorganising data/) unless
// another game server is given, proxies it, and adds what the loader would:
// a way to evaluate code in the game's scope (window.__ptEval) and the mod,
// started with a stand-in for the loader.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8125;
const GAME = process.argv[3] || "http://127.0.0.1:8772";
if (!process.argv[3]) {
  const child = require("child_process").spawn(process.execPath, [path.join(__dirname, "..", "..", "polytrack-ai", "tools", "serve.js"), "8772"], {
    env: { ...process.env, PTAI_NO_ADOPT: "1" }, stdio: "inherit",
  });
  process.on("exit", () => child.kill());
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit());
}
const ROOT = path.join(__dirname, "..");
const TOKEN = "p.domAPI=r(),p.insertStyleElement=h();";

const HARNESS = `<script type="module">
  const { polyMod } = await import("/rc/main.mod.js?" + Date.now());
  const pml = { getFromPolyTrack: (s) => window.__ptEval(s), saveModsToLocalStorage() {} };
  polyMod.savedLatest = true;
  const start = () => {
    if (!window.__ptEval) return setTimeout(start, 50);
    polyMod.preInit(pml); polyMod.init(pml); polyMod.postInit(); polyMod.onGameLoad();
  };
  start();
</script>`;

function proxy(req, res, rewrite) {
  const up = http.request(GAME + req.url, { method: req.method, headers: { ...req.headers, host: new URL(GAME).host } }, (r) => {
    if (!rewrite || r.statusCode !== 200) {
      res.writeHead(r.statusCode, r.headers);
      return r.pipe(res);
    }
    const parts = [];
    r.on("data", (c) => parts.push(c));
    r.on("end", () => {
      const body = rewrite(Buffer.concat(parts).toString("utf8"));
      const headers = { ...r.headers, "cache-control": "no-store" };
      delete headers["content-length"];
      delete headers["content-encoding"];
      res.writeHead(200, headers);
      res.end(body);
    });
  });
  up.on("error", (e) => res.writeHead(502).end(String(e)));
  req.pipe(up);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/rc/")) {
      const version = Object.values(require("../dist/manifest.json").latest)[0];
      const file = path.join(ROOT, "dist", version, path.basename(url.pathname));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      return res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }).end(fs.readFileSync(file));
    }
    if (url.pathname === "/PolyTypes.js") {
      return res.writeHead(200, { "Content-Type": "text/javascript" }).end(fs.readFileSync(path.join(ROOT, "ref", "PolyTypes.js")));
    }
    if (url.pathname === "/main.bundle.js") {
      delete req.headers["accept-encoding"];
      return proxy(req, res, (text) => {
        if (text.split(TOKEN).length !== 2) throw new Error("hook token not found");
        return text.replace(TOKEN, TOKEN + "window.__ptEval=(__s)=>eval(__s);");
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      delete req.headers["accept-encoding"];
      return proxy(req, res, (text) => text.replace("</head>", HARNESS + "</head>"));
    }
    proxy(req, res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Replay Cam test game at http://localhost:${PORT}`));
