// "Check for updates" for an installed Job Board.
//
// Safety rules (the whole point of this file):
//  * The person's DATA folder (leads, choices, chat history, key, profile) is never overwritten by an update.
//    It is copied to a backup folder before every update anyway.
//  * New program files are downloaded and checked (SHA-256) first, then the new version is started on a spare
//    port with a COPY of the data and must answer correctly before anything is replaced.
//  * The old program files are backed up. If the new version fails to start, the launcher puts the old ones back.
//
// Remote layout (a public GitHub repo): manifest.json + app/<files>. See publisher.js.
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

function ctxPaths(ctx) {
  const APP = ctx.APP;
  const PROGRAM = path.resolve(APP, "..");
  return { APP, PROGRAM, DATA: ctx.DATA, ROOT: ctx.ROOT, pending: path.join(PROGRAM, "update-pending.json"), last: path.join(ctx.DATA, "update-last.json") };
}

function baseUrl(APP) {
  if (process.env.JB_UPDATE_URL) return process.env.JB_UPDATE_URL.replace(/\/?$/, "/");
  try {
    const c = JSON.parse(fs.readFileSync(path.join(APP, "update-config.json"), "utf8"));
    if (c.baseUrl) return String(c.baseUrl).replace(/\/?$/, "/");
  } catch {}
  return "";
}

function getBuf(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "JobBoardUpdater", "Cache-Control": "no-cache" }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getBuf(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode + " for " + url)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("Timed out reaching " + url)));
    req.on("error", reject);
  });
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
  return 0;
}

function localVersion(APP) {
  try { return JSON.parse(fs.readFileSync(path.join(APP, "version.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
}

async function fetchManifest(APP) {
  const base = baseUrl(APP);
  if (!base) throw new Error("This board is not set up for updates (no update address).");
  const buf = await getBuf(base + "manifest.json?t=" + Date.now());
  const m = JSON.parse(buf.toString("utf8"));
  if (!m.version || !Array.isArray(m.files)) throw new Error("The update information looks wrong.");
  return { base, manifest: m };
}

async function checkForUpdate(ctx) {
  const { APP } = ctxPaths(ctx);
  const current = localVersion(APP);
  const { manifest } = await fetchManifest(APP);
  const newer = cmpVersion(manifest.version, current) > 0;
  return { current, latest: manifest.version, updateAvailable: newer, notes: manifest.notes || "", publishedAt: manifest.publishedAt || "" };
}

function walk(dir, skip = () => false, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (skip(rel, e)) continue;
    if (e.isDirectory()) walk(full, skip, base, out);
    else out.push(rel);
  }
  return out;
}

function copyDir(src, dst, skip = () => false) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const rel of walk(src, skip)) {
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
    n++;
  }
  return n;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

function sameDeps(APP, newPkg) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).dependencies || {};
    const b = (newPkg && newPkg.dependencies) || {};
    return JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
  } catch { return true; }
}

// Start the staged version on a spare port with a COPY of the data, and make sure it answers.
function selfTest(stageApp, ctx, report) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jb-update-test-"));
    const tData = path.join(tmp, "data");
    fs.mkdirSync(tData, { recursive: true });
    for (const f of ["leads.json", "state.json", "config.json", "search-profile.json"]) {
      try { fs.copyFileSync(path.join(ctx.DATA, f), path.join(tData, f)); } catch {}
    }
    const port = 8800 + Math.floor(Math.random() * 150);
    const child = spawn(process.execPath, [path.join(stageApp, "server.js")], {
      env: { ...process.env, JB_ROOT: path.join(tmp, "root"), JB_DATA: tData, PORT: String(port), CURSOR_API_KEY: "", JB_TEST_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    let done = false;
    const finish = (ok, msg) => {
      if (done) return; done = true;
      try { child.kill(); } catch {}
      setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500);
      resolve({ ok, msg });
    };
    child.on("exit", (code) => finish(false, "The new version stopped on startup (code " + code + "). " + err.split("\n").slice(0, 3).join(" ")));
    const get = (p) => new Promise((ok, no) => { http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => ok({ status: r.statusCode, body: d })); }).on("error", no); });
    let tries = 0;
    const poll = async () => {
      if (done) return;
      tries++;
      try {
        const v = await get("/api/version"); const c = await get("/api/config"); const l = await get("/api/leads"); const h = await get("/");
        if (v.status === 200 && c.status === 200 && l.status === 200 && h.status === 200 && /<html/i.test(h.body)) {
          JSON.parse(v.body); JSON.parse(c.body);
          const leads = JSON.parse(l.body).leads || [];
          let before = 0; try { before = (JSON.parse(fs.readFileSync(path.join(ctx.DATA, "leads.json"), "utf8").replace(/^\uFEFF/, "")).leads || []).length; } catch {}
          if (leads.length !== before) return finish(false, "The new version showed a different number of job leads (" + leads.length + " vs " + before + ").");
          return finish(true, "ok");
        }
      } catch {}
      if (tries > 40) return finish(false, "The new version did not start in time.");
      setTimeout(poll, 500);
    };
    setTimeout(poll, 800);
  });
}

let working = false;
let progress = { step: "idle", message: "", pct: 0 };
const setP = (step, message, pct) => { progress = { step, message, pct }; };
const getProgress = () => ({ ...progress, working });

async function applyUpdate(ctx) {
  if (working) throw new Error("An update is already running.");
  const P = ctxPaths(ctx);
  working = true;
  try {
    setP("checking", "Looking for the new version…", 5);
    const { base, manifest } = await fetchManifest(P.APP);
    const current = localVersion(P.APP);
    if (cmpVersion(manifest.version, current) <= 0) { setP("idle", "You already have the latest version.", 100); return { ok: true, upToDate: true, version: current }; }
    if (!sameDeps(P.APP, manifest.package)) throw new Error("This update needs a new full install (it changes the helper libraries). Ask the person who set up your board for the newest zip. Nothing was changed.");

    const stageRoot = path.join(P.PROGRAM, "_update", manifest.version);
    const stageApp = path.join(stageRoot, "app");
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.mkdirSync(stageApp, { recursive: true });

    // 1) download + verify
    let i = 0;
    for (const f of manifest.files) {
      i++;
      setP("downloading", `Downloading ${i} of ${manifest.files.length}…`, 10 + Math.round((i / manifest.files.length) * 35));
      const buf = await getBuf(base + "app/" + f.path.replace(/\\/g, "/") + "?t=" + Date.now());
      if (sha256(buf) !== f.sha256) throw new Error("A downloaded file did not match (" + f.path + "). Nothing was changed. Try again in a few minutes.");
      const to = path.join(stageApp, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, buf);
    }
    // anything the manifest doesn't replace is carried over so the staged copy is a complete program
    const manifestSet = new Set(manifest.files.map((f) => path.normalize(f.path)));
    copyDir(P.APP, stageApp, (rel) => manifestSet.has(path.normalize(rel)) || rel.split(path.sep)[0] === "node_modules");

    // 2) test the new version on a spare port with a copy of the data
    setP("testing", "Testing the new version before installing it…", 55);
    const t = await selfTest(stageApp, ctx);
    if (!t.ok) throw new Error("The new version did not pass its test, so it was NOT installed. Your board is unchanged. (" + t.msg + ")");

    // 3) back up data and old program
    setP("backup", "Backing up your data…", 70);
    const tag = stamp();
    const backupDir = path.join(P.ROOT, "OLD", "Backups", `${tag}_before-${manifest.version}`);
    copyDir(P.DATA, path.join(backupDir, "board-data"), (rel) => rel.endsWith(".tmp"));
    const appBackup = path.join(P.PROGRAM, "_backup", `app-${current}-${tag}`);
    copyDir(P.APP, appBackup, (rel) => rel.split(path.sep)[0] === "node_modules");

    // 4) install: copy new files over, set aside files the new version no longer has
    setP("installing", "Installing…", 82);
    fs.writeFileSync(P.pending, JSON.stringify({ from: current, to: manifest.version, appBackup, backupDir, at: new Date().toISOString() }, null, 2));
    for (const f of manifest.files) {
      const to = path.join(P.APP, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(stageApp, f.path), to);
    }
    let oldList = [];
    try { oldList = JSON.parse(fs.readFileSync(path.join(P.APP, "installed-files.json"), "utf8")); } catch {}
    for (const rel of oldList) {
      if (!manifestSet.has(path.normalize(rel)) && fs.existsSync(path.join(P.APP, rel))) {
        const dst = path.join(P.PROGRAM, "_backup", `removed-${tag}`, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.renameSync(path.join(P.APP, rel), dst); } catch {}
      }
    }
    fs.writeFileSync(path.join(P.APP, "installed-files.json"), JSON.stringify(manifest.files.map((f) => f.path), null, 2));
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(P.last, JSON.stringify({ ok: true, pending: true, from: current, to: manifest.version, at: new Date().toISOString(), backupDir }, null, 2));
    setP("restarting", "Restarting the board with the new version…", 95);
    return { ok: true, restart: true, from: current, to: manifest.version, backupDir };
  } catch (e) {
    setP("failed", String((e && e.message) || e), 100);
    try { fs.writeFileSync(P.last, JSON.stringify({ ok: false, error: String((e && e.message) || e), at: new Date().toISOString() }, null, 2)); } catch {}
    throw e;
  } finally {
    working = false;
  }
}

// Called by the server shortly after every start: if an update was just installed and the server is healthy, confirm it.
function confirmPendingUpdate(ctx) {
  const P = ctxPaths(ctx);
  try {
    if (!fs.existsSync(P.pending)) return;
    const pend = JSON.parse(fs.readFileSync(P.pending, "utf8"));
    fs.unlinkSync(P.pending);
    fs.writeFileSync(P.last, JSON.stringify({ ok: true, from: pend.from, to: pend.to, at: new Date().toISOString(), backupDir: pend.backupDir, confirmed: true }, null, 2));
  } catch {}
}

function lastResult(ctx) {
  try { return JSON.parse(fs.readFileSync(ctxPaths(ctx).last, "utf8")); } catch { return null; }
}

module.exports = { checkForUpdate, applyUpdate, getProgress, confirmPendingUpdate, lastResult, localVersion, cmpVersion, sha256, walk };
