"use strict";

// The kit end to end in a real headless browser (skipped when none is
// installed), against pages served from this process, plus the address and
// folder rules that need no browser.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { makeKit, normalizeUrl, homePageOf, siteOfListing, prepareDir, brandName } = require("../skills/easybrandkit/scripts/lib/kit");
const { checkDir } = require("../skills/easybrandkit/scripts/lib/folder");
const { findChrome, launch, killBrowsers, removeTemps } = require("../skills/easybrandkit/scripts/lib/chrome");
const { groundOf } = require("../skills/easybrandkit/scripts/lib/logos");
const { startRun, discardRun } = require("../skills/easybrandkit/scripts/lib/run");

const CLI = path.resolve(__dirname, "../skills/easybrandkit/scripts/easybrandkit.js");
const noBrowser = !findChrome() && "no Chrome, Chromium, Edge or Brave installed";

// Minimal PNG reader for 8-bit RGB/RGBA, non-interlaced (what Chrome writes).
function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let p = v;
      if (filter === 1) p = v + a;
      else if (filter === 2) p = v + b;
      else if (filter === 3) p = v + ((a + b) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      pixels[y * stride + x] = p & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + 3)] };
}

// Minimal PNG writer: 8-bit RGB, each row unfiltered.
function pngOf(width, height, color) {
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) Buffer.from(color(x, y)).copy(raw, y * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function serve(handler) {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const svg = (fill, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;

// Every file and folder in dir, hidden ones too, each file with a hash of its
// bytes: what a run left there.
function filesOf(dir) {
  const found = [];
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        found.push(`${name}/`);
        walk(path.join(at, entry.name), name);
      } else {
        found.push(`${name} ${crypto.createHash("sha1").update(fs.readFileSync(path.join(at, entry.name))).digest("hex")}`);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return found;
}

function writeFiles(dir, files) {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
}

// A temp folder of the test's own, for what the browser leaves there, short
// enough for the socket Chrome keeps in it (a socket path holds 108 bytes on
// Linux and 104 elsewhere): null, and the temp files not checked, when the
// system's temp folder is too deep for one.
function ownTemp(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  if (path.join(temp, "com.google.Chrome.XXXXXX", "SingletonSocket").length > (process.platform === "linux" ? 107 : 103)) {
    t.diagnostic(`${temp} is too deep for Chrome's socket, so what the browser leaves in the temp folder is not checked`);
    return null;
  }
  return temp;
}

// The CLI's answer, and how long its process went on after it printed it.
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let printedAt = 0;
    child.stdout.on("data", (chunk) => {
      printedAt = Date.now();
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr, lingered: Date.now() - printedAt }));
  });
}

// An earlier kit as a run leaves it, with facts and two files of the user's own.
const EARLIER = {
  "brand.json": JSON.stringify({ version: 1, logos: [{ file: "logo-01.png", svg: "logo-01.svg" }, { file: "logo-02.png" }], screenshots: [{ file: "screen-01.png" }], card: { file: "card.png" } }),
  "BRAND.md": "# Acme brand kit\n",
  "_brand.yml": "meta:\n  name: Acme\n",
  "logo-01.png": "png",
  "logo-01.svg": "<svg/>",
  "logo-02.png": "png",
  "screen-01.png": "png",
  "card.png": "png",
  "FACTS.md": "# Acme facts\n",
  "facts.json": "{}",
  "pages/home.md": "home",
  "pages/mine.txt": "mine",
  "notes.txt": "mine",
};

test("addresses: bare domains get https, sub-pages point to the home page", () => {
  assert.equal(normalizeUrl("acme.com"), "https://acme.com/");
  assert.equal(normalizeUrl("http://acme.com/tr"), "http://acme.com/tr");
  assert.throws(() => normalizeUrl("ftp://acme.com"), /Not a web address/);
  assert.throws(() => normalizeUrl(""), /Give a website address/);
  assert.equal(homePageOf("https://acme.com/"), null);
  assert.equal(homePageOf("https://acme.com/tr"), null);
  assert.equal(homePageOf("https://acme.com/en-us/"), null);
  assert.equal(homePageOf("https://acme.com/pricing"), "https://acme.com/");
  assert.equal(homePageOf("https://blog.acme.com/"), "https://acme.com/");
  assert.equal(brandName("Acme", "Whatever", "https://acme.com/"), "Acme");
  assert.equal(brandName("", "Acme | Payments for teams", "https://acme.com/"), "Acme");
  assert.equal(brandName("", "", "https://www.acme.com/"), "Acme");
});

test("stores and social networks: a listing leads to its website, a profile is refused before anything runs", async () => {
  assert.equal(siteOfListing("https://culturedcode.com/things"), "https://culturedcode.com/things");
  assert.equal(siteOfListing("https://www.acme.com/help/support-request"), "https://www.acme.com/");
  assert.equal(siteOfListing("https://www.facebook.com/acme"), "");
  assert.equal(siteOfListing("not a url"), "");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  try {
    for (const profile of ["x.com/acme", "https://www.instagram.com/acme/", "https://www.linkedin.com/company/acme", "apps.apple.com"]) {
      await assert.rejects(makeKit(profile, { dir }), /not the brand's own site/, profile);
    }
    assert.equal(fs.existsSync(dir), false, "nothing was written");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("never writes into a folder that holds someone else's files, and reads an earlier kit without changing it", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-dir-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, "kit");
  assert.equal(checkDir(dir), null, "not there");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
  assert.throws(() => checkDir(dir), /kit is not empty and holds no earlier brand kit/);
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "mine");
  // An earlier kit's files, by file name only, are what a new kit takes the
  // place of; reading them changes nothing.
  fs.rmSync(path.join(dir, "notes.txt"));
  fs.writeFileSync(path.join(dir, "logo-01.png"), "old");
  fs.writeFileSync(path.join(dir, "_brand.yml"), "meta:\n  name: Old\n");
  fs.writeFileSync(path.join(dir, "brand.json"), JSON.stringify({ version: 1, logos: [{ file: "../../escape.png" }, { file: "logo-01.png" }, { file: ".git" }, { file: ".." }] }));
  const files = checkDir(dir);
  assert.deepEqual(files.slice(0, 5), ["escape.png", "logo-01.png", "brand.json", "BRAND.md", "_brand.yml"]);
  assert.ok(files.includes("FACTS.md") && files.includes("pages/home.md") && !files.includes(".git") && !files.includes(".."), files.join(" "));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["_brand.yml", "brand.json", "logo-01.png"]);
  // A link to the kit's folder is that folder, and the run works inside it.
  fs.symlinkSync(dir, path.join(parent, "link"), "junction");
  assert.deepEqual(checkDir(path.join(parent, "link")), files);
  const run = startRun(path.join(parent, "link"), files);
  assert.equal(path.dirname(fs.realpathSync(run.work)), fs.realpathSync(dir));
  discardRun(run);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["_brand.yml", "brand.json", "logo-01.png"]);
  // A file, or a link to nothing, is no folder.
  assert.throws(() => checkDir(path.join(dir, "logo-01.png")), /logo-01\.png is a file, not a folder\. Pick a folder with --out\.$/);
  fs.symlinkSync(path.join(parent, "gone"), path.join(parent, "dangling"), "junction");
  assert.throws(() => checkDir(path.join(parent, "dangling")), /dangling is a link to .*gone, which is not there\. Pick a folder with --out\.$/);
  // The part folder of a run that was killed outright counts for nothing.
  const empty = path.join(parent, "empty");
  fs.mkdirSync(path.join(empty, ".easybrandkit-part-1-0a1b2c3d"), { recursive: true });
  assert.equal(checkDir(empty), null);
});

test("prepareDir still readies a folder for a kit written straight into it, as runs did up to 0.4.0", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-dir-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // Made when it is not there, with the folders above it.
  const fresh = path.join(parent, "new", "acme");
  prepareDir(fresh);
  assert.deepEqual(fs.readdirSync(fresh), []);
  // An earlier kit's own files go, those its brand.json lists and the fixed
  // names, and the user's files stay.
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  prepareDir(dir);
  assert.deepEqual(filesOf(dir).map((line) => line.split(" ")[0]), ["notes.txt", "pages/", "pages/mine.txt"]);
  const listed = path.join(parent, "listed");
  writeFiles(listed, {
    "brand.json": JSON.stringify({ version: 1, logos: [{ file: "logo-01.png", svg: "logo-01.svg" }], screenshots: [{ file: "screen-01.png" }], card: { file: "card.png" }, stores: [{ type: "appstore", assets: [{ file: "appstore-icon.png" }, { file: "appstore-shot-01.jpg" }] }] }),
    ...Object.fromEntries(["BRAND.md", "_brand.yml", "logo-01.png", "logo-01.svg", "screen-01.png", "card.png", "appstore-icon.png", "appstore-shot-01.jpg", "our-notes.md"].map((name) => [name, "x"])),
  });
  prepareDir(listed);
  assert.deepEqual(fs.readdirSync(listed), ["our-notes.md"]);
  // A folder under a kit file's name is not the kit's, and a pages that is a
  // link is not looked into.
  const mine = path.join(parent, "mine");
  writeFiles(mine, { "home.md": "mine" });
  const odd = path.join(parent, "odd");
  writeFiles(odd, { "brand.json": JSON.stringify({ version: 1, card: { file: "card.png" } }), "BRAND.md": "old", "card.png/keep.txt": "mine" });
  fs.symlinkSync(mine, path.join(odd, "pages"), "junction");
  prepareDir(odd);
  assert.deepEqual(fs.readdirSync(odd).sort(), ["card.png", "pages"]);
  assert.deepEqual(fs.readdirSync(mine), ["home.md"]);
  assert.equal(fs.readFileSync(path.join(odd, "card.png", "keep.txt"), "utf8"), "mine");
  // A folder that holds someone else's files is refused as it is.
  const theirs = path.join(parent, "theirs");
  writeFiles(theirs, { "notes.txt": "mine" });
  assert.throws(() => prepareDir(theirs), /theirs is not empty and holds no earlier brand kit/);
  assert.deepEqual(fs.readdirSync(theirs), ["notes.txt"]);
});

test("a run that fails leaves its folder as it was: an earlier kit stays whole, and a folder it would have made is not left", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  // No browser: the run gets past the folder and fails as it starts one.
  const chrome = process.env.CHROME_PATH;
  process.env.CHROME_PATH = path.join(parent, "no-chrome");
  t.after(() => {
    if (chrome === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = chrome;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  await assert.rejects(makeKit("https://acme.example/", { dir, stores: false }), (err) => /No Chrome, Chromium, Edge or Brave found/.test(err.message) && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before);
  await assert.rejects(makeKit("https://acme.example/", { dir: path.join(parent, "new", "acme") }), (err) => /No Chrome/.test(err.message) && err.earlierKit === undefined);
  assert.deepEqual(fs.readdirSync(parent), ["kit"]);
});

test("a temp folder with no room left for the browser's profile is told as the temp folder's, not the kit's", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  // A browser is found, any file will do, and its profile cannot be made.
  const chrome = process.env.CHROME_PATH;
  process.env.CHROME_PATH = process.execPath;
  t.after(() => {
    if (chrome === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = chrome;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", function (prefix, ...rest) {
    if (path.basename(String(prefix)) === "easybrandkit-chrome-") {
      throw Object.assign(new Error(`ENOSPC: no space left on device, mkdtemp '${prefix}XXXXXX'`), { code: "ENOSPC", errno: -28, syscall: "mkdtemp", path: `${prefix}XXXXXX` });
    }
    return mkdtemp.call(this, prefix, ...rest);
  });
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const said = `The disk that holds the temp folder, ${path.resolve(os.tmpdir())}, is full (ENOSPC). Free some space on it, or set ${process.platform === "win32" ? "TEMP" : "TMPDIR"} to a folder on another disk.`;
  await assert.rejects(makeKit("https://acme.example/", { dir, stores: false }), (err) => err.message === said && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before);
});

test("the skill folder carries its own version, the same as the package's", () => {
  assert.equal(require("../skills/easybrandkit/scripts/lib/version"), require("../package.json").version);
});

test("code that requires the package gets the functions 0.4.0 gave it, and no others", () => {
  assert.deepEqual(Object.keys(require("..")), ["makeKit", "normalizeUrl", "homePageOf", "siteOfListing", "prepareDir", "brandName"]);
});

test("a cut's ground comes from its pixels: one color, or a picture", () => {
  const navy = [29, 36, 62];
  const solid = pngOf(60, 40, (x, y) => (x > 20 && x < 40 && y > 12 && y < 28 ? [255, 0, 0] : navy));
  assert.deepEqual(groundOf(solid, 4), { hex: "#1d243e", solid: true });
  const stripes = pngOf(60, 40, (x) => (x % 8 < 4 ? [10, 4, 32] : [122, 44, 255]));
  assert.equal(groundOf(stripes, 4).solid, false);
  // A mark at the page's left edge has no margin there: that side is not read.
  const edge = pngOf(60, 40, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
  assert.equal(groundOf(edge, 4).solid, false);
  assert.deepEqual(groundOf(edge, 4, { top: true, right: true, bottom: true, left: false }), { hex: "#ffffff", solid: true });
  assert.equal(groundOf(Buffer.from("not a png"), 4), null);
});

// Whether a process has ended, a zombie too.
function ended(pid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return /^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// Stands in for Chrome: it makes the folders Chrome's component updater
// downloads and unpacks into in its first seconds, each with a file in it,
// as a browser killed then leaves them, and a folder of another kind that
// holds a file, as another browser's could. On Linux it also starts a
// helper that goes on writing into the profile for five seconds, as
// Chrome's network service does as it ends: each write a process of its own
// that names the profile and writes a moment after it starts, so that one
// started as the helper is killed writes after the profile is removed
// unless it is found too. Elsewhere a browser's helpers cannot be told.
const STAND_IN = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
mkdir "$TMPDIR/com.google.Chrome.chrome_chrome_url_fetcher_.$$" && echo x > "$TMPDIR/com.google.Chrome.chrome_chrome_url_fetcher_.$$/download"
mkdir "$TMPDIR/com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.$$" && echo x > "$TMPDIR/com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.$$/config.binarypb"
mkdir "$TMPDIR/com.google.Chrome.busy$$" && echo x > "$TMPDIR/com.google.Chrome.busy$$/file"
if [ -n "$HELPER_PID" ]; then
  ( i=0; while [ $i -lt 100 ]; do sh -c 'sleep 0.05; mkdir -p "$1/Default"' write "$profile"; i=$((i + 1)); done ) &
  echo $! > "$HELPER_PID"
fi
printf '1\\n/devtools/browser/x\\n' > "$profile/DevToolsActivePort"
exec sleep 30
`;

test("a browser that ends takes its helpers with it and leaves nothing of its own in the temp folder", { skip: process.platform === "win32" && "a shell script stands in for the browser" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const env = { CHROME_PATH: process.env.CHROME_PATH, TMPDIR: process.env.TMPDIR, HELPER_PID: process.env.HELPER_PID };
  t.after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, STAND_IN, { mode: 0o755 });
  process.env.CHROME_PATH = chrome;
  process.env.TMPDIR = temp;
  // A folder of the same kind that was there before stays with its files,
  // and so does one of another kind that holds a file.
  writeFiles(temp, { "com.google.Chrome.chrome_chrome_url_fetcher_.before/download": "theirs" });
  const linux = process.platform === "linux";
  for (const end of ["closed", "killed"]) {
    const pidFile = path.join(parent, `${end}.pid`);
    if (linux) process.env.HELPER_PID = pidFile;
    const browser = await launch({ width: 800, height: 600 });
    if (end === "closed") {
      // It does not answer on the port it wrote, so it cannot be asked to
      // quit: it is killed at once, not waited for.
      const started = Date.now();
      await browser.close();
      assert.ok(Date.now() - started < 3_000, `closed in ${Date.now() - started} ms`);
    } else {
      killBrowsers();
    }
    if (linux) {
      const helper = Number(fs.readFileSync(pidFile, "utf8"));
      t.after(() => {
        if (!ended(helper)) process.kill(helper, "SIGKILL");
      });
      assert.ok(ended(helper), `the helper of a browser ${end}`);
    }
    const left = fs.readdirSync(temp).filter((name) => !name.startsWith("com.google.Chrome.busy"));
    assert.deepEqual(left, ["com.google.Chrome.chrome_chrome_url_fetcher_.before"], `a browser ${end}`);
  }
  assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith("com.google.Chrome.busy")).length, 2);
  assert.equal(fs.readFileSync(path.join(temp, "com.google.Chrome.chrome_chrome_url_fetcher_.before", "download"), "utf8"), "theirs");

  // A browser that ends at once and leaves a helper running, which belongs
  // to no one by then: only its command line, which names the profile, ties
  // it to the browser.
  if (linux) {
    const quick = path.join(parent, "quick");
    const pidFile = path.join(parent, "quick.pid");
    fs.writeFileSync(quick, `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac\ndone\n'${process.execPath}' -e 'setTimeout(() => {}, 30000)' "$profile" &\necho $! > "${pidFile}"\n`, { mode: 0o755 });
    process.env.CHROME_PATH = quick;
    await assert.rejects(launch({ width: 800, height: 600 }), /^Error: quick did not start\./);
    const helper = Number(fs.readFileSync(pidFile, "utf8"));
    t.after(() => {
      if (!ended(helper)) process.kill(helper, "SIGKILL");
    });
    assert.ok(ended(helper), "the helper of a browser that ended at once");
    assert.deepEqual(fs.readdirSync(temp).filter((name) => !name.startsWith("com.google.Chrome.busy")), ["com.google.Chrome.chrome_chrome_url_fetcher_.before"]);
  }
});

// Stands in for Chrome and the crash handler it starts apart from itself:
// the handler is no child of the browser's and its command line does not
// name the profile, and a helper names it as Chrome's helpers do, in a
// command line rewritten with its arguments apart by spaces. A handler
// already running can be named instead of a new one.
const WITH_CRASH_HANDLER = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
if [ -z "$HANDLER_GIVEN" ]; then
  ( "$HANDLER_BIN" -e 'setTimeout(() => {}, 30000)' & echo $! > "$HANDLER_PID" )
else
  echo "$HANDLER_GIVEN" > "$HANDLER_PID"
fi
"$NODE_BIN" -e 'process.title = process.argv.join(" "); require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)' -- "$profile/helper.pid" "--crashpad-handler-pid=$(cat "$HANDLER_PID")" "--user-data-dir=$profile" &
while [ ! -s "$profile/helper.pid" ]; do sleep 0.01; done
printf '1\\n/devtools/browser/x\\n' > "$profile/DevToolsActivePort"
exec sleep 30
`;

test("a browser's crash handler goes with it, also once its helpers have ended, and no other process it names does", { skip: process.platform !== "linux" && "a browser's processes are told on Linux only" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "NODE_BIN", "HANDLER_BIN", "HANDLER_PID", "HANDLER_GIVEN"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const started = [];
  t.after(() => {
    for (const pid of started) if (!ended(pid)) process.kill(pid, "SIGKILL");
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, WITH_CRASH_HANDLER, { mode: 0o755 });
  const handlerBin = path.join(parent, "chrome_crashpad_handler");
  fs.symlinkSync(process.execPath, handlerBin);
  fs.symlinkSync(process.execPath, path.join(parent, "something_else"));
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: temp, NODE_BIN: process.execPath, HANDLER_PID: path.join(parent, "handler.pid") });
  const wait = async (pid) => {
    for (let waited = 0; waited < 2_000 && !ended(pid); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    return ended(pid);
  };
  const helperOf = () => {
    const profile = fs.readdirSync(temp).find((name) => name.startsWith("easybrandkit-chrome-"));
    return Number(fs.readFileSync(path.join(temp, profile, "helper.pid"), "utf8"));
  };
  // A browser asked to quit, one stopped, and one stopped once its helpers
  // have ended, as a crash or Ctrl-\ can end them: its handler is the one it
  // started.
  for (const end of ["closed", "killed", "killed after its helpers"]) {
    process.env.HANDLER_BIN = handlerBin;
    delete process.env.HANDLER_GIVEN;
    const browser = await launch({ width: 800, height: 600 });
    const handler = Number(fs.readFileSync(process.env.HANDLER_PID, "utf8"));
    const helper = helperOf();
    started.push(handler, helper);
    assert.equal(ended(handler), false);
    if (end === "closed") await browser.close();
    else {
      if (end !== "killed") {
        process.kill(helper, "SIGKILL");
        assert.ok(await wait(helper));
      }
      killBrowsers();
    }
    assert.ok(await wait(handler), `the crash handler of a browser ${end}`);
  }
  // A process that is no crash handler, or one that ran before the browser,
  // as the user's own browser's handler does, is not the browser's to end.
  const before = spawn(handlerBin, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  started.push(before.pid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [bin, given] of [[path.join(parent, "something_else"), ""], [handlerBin, String(before.pid)]]) {
    process.env.HANDLER_BIN = bin;
    if (given) process.env.HANDLER_GIVEN = given;
    await launch({ width: 800, height: 600 });
    const named = Number(fs.readFileSync(process.env.HANDLER_PID, "utf8"));
    started.push(named, helperOf());
    killBrowsers();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ended(named), false, given ? "a handler that ran before the browser" : "a process that is no crash handler");
  }
});

// Stands in for Chrome on Linux and macOS, which keeps the socket that makes
// it one browser per profile in a folder of its own in the temp folder,
// linked from the profile. Ctrl-C reaches the browser too, and Chrome's own
// shutdown then removes the profile's links first and that folder a moment
// later: this one removes the links and goes on running, as a browser that
// the kit kills in that moment leaves them. It also says where it was told
// to write its crash reports.
const WITH_SOCKET = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
echo $$ > "$STAND_IN_PID"
printf '%s' "$BREAKPAD_DUMP_LOCATION" > "$STAND_IN_DUMPS"
socket=$(mktemp -d "$TMPDIR/com.google.Chrome.XXXXXX")
echo x > "$socket/SingletonSocket"
ln -s 1234567890 "$socket/SingletonCookie"
ln -s "$socket/SingletonSocket" "$profile/SingletonSocket"
ln -s "$socket/SingletonCookie" "$profile/SingletonCookie"
trap 'rm -f "$profile/SingletonSocket" "$profile/SingletonCookie"' INT
printf '1\\n/devtools/browser/x\\n' > "$profile/DevToolsActivePort"
while :; do sleep 0.05; done
`;

// The stand-in above, as the browser, in a temp folder of the test's own.
function withSocket(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "STAND_IN_PID", "STAND_IN_DUMPS"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const started = [];
  t.after(() => {
    for (const pid of started) if (!ended(pid)) process.kill(pid, "SIGKILL");
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, WITH_SOCKET, { mode: 0o755 });
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: temp, STAND_IN_PID: path.join(parent, "chrome.pid"), STAND_IN_DUMPS: path.join(parent, "dumps") });
  return {
    temp,
    // The profile of the browser that runs, and the browser's pid.
    started() {
      const pid = Number(fs.readFileSync(process.env.STAND_IN_PID, "utf8"));
      started.push(pid);
      return { pid, profile: path.join(temp, fs.readdirSync(temp).find((name) => name.startsWith("easybrandkit-chrome-"))) };
    },
  };
}

test("a browser killed as it begins to quit on Ctrl-C leaves no folder of its own in the temp folder", { skip: process.platform === "win32" && "a shell script stands in for the browser" }, async (t) => {
  const { temp, started } = withSocket(t);
  // Ended by a stop, as the CLI's handler of Ctrl-C ends it, and by close,
  // as a run that fails then ends it.
  for (const end of ["stopped", "closed"]) {
    const browser = await launch({ width: 800, height: 600 });
    const { pid, profile } = started();
    process.kill(pid, "SIGINT");
    const link = () => fs.lstatSync(path.join(profile, "SingletonSocket"), { throwIfNoEntry: false });
    for (let waited = 0; waited < 2_000 && link(); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(link(), undefined, "the browser has begun to quit");
    if (end === "stopped") killBrowsers();
    else await browser.close();
    assert.ok(ended(pid), `the browser ${end}`);
    assert.deepEqual(fs.readdirSync(temp), [], `a browser ${end}`);
  }
});

test("a browser's crash reports go into its throwaway profile, not into the user's own browser's folder", { skip: process.platform === "win32" && "a shell script stands in for the browser" }, async (t) => {
  const { temp, started } = withSocket(t);
  await launch({ width: 800, height: 600 });
  const { profile } = started();
  assert.equal(fs.readFileSync(process.env.STAND_IN_DUMPS, "utf8"), path.join(profile, "Crash Reports"));
  killBrowsers();
  assert.deepEqual(fs.readdirSync(temp), []);
});

test("what Chrome's component updater was fetching goes once a browser has ended, and only what came while it ran", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-temp-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fetched = ["com.google.Chrome.chrome_chrome_url_fetcher_.a1b2c3", "com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.d4e5f6"];
  writeFiles(temp, {
    [`${fetched[0]}/download`]: "x",
    [`${fetched[1]}/config.binarypb`]: "x",
    "com.google.Chrome.chrome_chrome_url_fetcher_.before/download": "theirs",
    // The socket of another browser that is running.
    "com.google.Chrome.g7h8i9/SingletonSocket": "x",
  });
  fs.mkdirSync(path.join(temp, "com.google.Chrome.chrome_chrome_url_fetcher_.empty"));
  const before = new Set(["com.google.Chrome.chrome_chrome_url_fetcher_.before"]);
  removeTemps({ temp, before });
  assert.deepEqual(fs.readdirSync(temp).sort(), ["com.google.Chrome.chrome_chrome_url_fetcher_.before", "com.google.Chrome.g7h8i9"]);
  assert.equal(fs.readFileSync(path.join(temp, "com.google.Chrome.chrome_chrome_url_fetcher_.before", "download"), "utf8"), "theirs");
  assert.deepEqual(fs.readdirSync(path.join(temp, "com.google.Chrome.g7h8i9")), ["SingletonSocket"]);
});

test("a browser that quits when asked leaves nothing of its component updater's in the temp folder", { skip: noBrowser }, async (t) => {
  const temp = ownTemp(t);
  if (!temp) return;
  const system = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => {
    if (system === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = system;
  });
  const browser = await launch({ width: 800, height: 600 });
  // What the component updater leaves when the browser quits in the middle
  // of a download, as Chrome does now and then.
  writeFiles(temp, { "com.google.Chrome.chrome_chrome_url_fetcher_.k1l2m3/decoded_xz": "x" });
  assert.equal(await browser.alive(), true);
  await browser.close();
  assert.deepEqual(fs.readdirSync(temp), []);
});

test("a browser that is slow to answer still runs; one that refuses its port or has ended does not", { skip: process.platform === "win32" && "a shell script stands in for the browser" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  // A port that takes a connection and never answers, as a busy browser's.
  const slow = http.createServer(() => {});
  slow.listen(0, "127.0.0.1");
  await once(slow, "listening");
  const chrome = process.env.CHROME_PATH;
  t.after(() => {
    if (chrome === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = chrome;
    slow.closeAllConnections();
    slow.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const stand = path.join(parent, "chrome");
  fs.writeFileSync(stand, `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac\ndone\nprintf '${slow.address().port}\\n/devtools/browser/x\\n' > "$profile/DevToolsActivePort"\nexec sleep 30\n`, { mode: 0o755 });
  process.env.CHROME_PATH = stand;
  const browser = await launch({ width: 800, height: 600 });
  const started = Date.now();
  assert.equal(await browser.alive(), true, "slow to answer");
  assert.ok(Date.now() - started >= 4_000, `answered after ${Date.now() - started} ms`);
  slow.closeAllConnections();
  await new Promise((resolve) => slow.close(resolve));
  assert.equal(await browser.alive(), false, "its port refuses");
  await browser.close();
  assert.equal(await browser.alive(), false, "ended");
});

test("a browser that cannot start because the temp folder's path is too long for its socket says so", { skip: process.platform !== "linux" && "told on Linux only" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const env = { CHROME_PATH: process.env.CHROME_PATH, TMPDIR: process.env.TMPDIR };
  t.after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  // Stands in for Chrome, which makes the folder of its socket in the temp
  // folder as it starts and ends at once when the socket's path is too long.
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\nmktemp -d "$TMPDIR/com.google.Chrome.XXXXXX" > /dev/null\nexit 134\n`, { mode: 0o755 });
  process.env.CHROME_PATH = chrome;
  const deep = path.join(parent, "t".repeat(80));
  fs.mkdirSync(deep);
  process.env.TMPDIR = deep;
  const length = Buffer.byteLength(path.join(deep, "com.google.Chrome.XXXXXX", "SingletonSocket"));
  const said = `chrome did not start: the path of the temp folder, ${deep}, is too long for the socket the browser makes in it, whose path would be ${length} bytes where Linux allows 107. Set TMPDIR to a folder whose path is at least ${length - 107} bytes shorter.`;
  await assert.rejects(launch({ width: 800, height: 600 }), (err) => err.message === said);
  assert.deepEqual(fs.readdirSync(deep), [], "nothing is left in the temp folder");
  // In a temp folder short enough for the socket, the browser ended for
  // another reason.
  if (env.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = env.TMPDIR;
  const temp = ownTemp(t);
  if (!temp) return;
  process.env.TMPDIR = temp;
  await assert.rejects(launch({ width: 800, height: 600 }), (err) => err.message === "chrome did not start. Try again, or point CHROME_PATH at another browser.");
  assert.deepEqual(fs.readdirSync(temp), []);
});

test("the CLI explains itself and refuses a missing address", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: easybrandkit <url>/);
  const none = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Give one website address/);
});

test("logos: the site's own marks on their real background, plus colors, fonts, icons, images and links", { skip: noBrowser }, async () => {
  // A red inline-svg logo in the header link to "/", a white logo image in a
  // navy footer; around them what must NOT come back: a flag in the nav, a
  // brand image inside a closed (opacity 0) menu panel, a brand image in a
  // hero <header> lower on the page, a customer strip, a payment badge. A
  // cookie bar floats over the first screen.
  const files = {
    "/acme-logo-light.svg": svg("rgb(255,255,255)", 140, 36),
    "/acme-logo-menu.svg": svg("rgb(0,0,255)", 80, 30),
    "/acme-shape.svg": svg("rgb(0,128,0)", 300, 200),
    "/flag.svg": svg("rgb(200,200,0)", 20, 14),
    "/logo/client-one.svg": svg("rgb(120,0,120)", 100, 40),
    "/logo/visa-logo.svg": svg("rgb(0,90,200)", 60, 20),
  };
  const html = `<!doctype html><html><head>
    <title>Acme | Tools for teams</title>
    <meta name="description" content="Tools for teams
      that ship.">
    <meta property="og:site_name" content="Acme">
    <meta property="og:image" content="/og.png">
    <meta name="apple-itunes-app" content="app-id=1234567890">
    <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
    <link rel="manifest" href="/site.webmanifest">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","logo":"/brand/acme-logo.png","sameAs":["https://www.instagram.com/acme/","https://twitter.com/intent/tweet?text=hi"]}</script>
    <style>
      body{margin:0;background:#fff}
      header.top{height:60px;background:rgb(255,255,255);display:flex;align-items:center;padding-left:20px;position:relative}
      .menu{position:absolute;top:60px;left:300px;opacity:0}
      .hero{height:1500px;padding-top:300px;background:rgb(240,240,240)}
      footer{height:200px;background:rgb(29,36,62);display:flex;align-items:center;gap:20px;padding-left:20px}
      img{display:block}
      .cookies{position:fixed;left:0;right:0;bottom:0;height:120px;background:rgb(255,0,255)}
    </style></head><body>
    <header class="top"><a href="/" class="brand">${svg("rgb(255,0,0)", 120, 30)}</a>
      <nav><img src="/flag.svg" alt="English"><div class="menu"><img src="/acme-logo-menu.svg" alt="Acme"></div></nav></header>
    <section class="hero"><header class="hero-head"><img src="/acme-shape.svg" alt="Acme"></header>
      <h1 style="color:rgb(15,23,42);font-family:Georgia,serif">Acme for teams</h1>
      <a class="cta" href="/start" style="display:inline-block;width:160px;height:44px;background:rgb(63,86,200)">Start</a>
      <button style="width:120px;height:40px;background:rgb(255,255,255)">EN</button>
      <p style="font-family:Verdana,sans-serif">Read <a href="/guide" style="color:rgb(220,38,38)">the guide</a></p>
      <div class="clients"><img src="/logo/client-one.svg" alt="Client One"></div></section>
    <footer><img src="/acme-logo-light.svg" alt="Acme"><img src="/logo/visa-logo.svg" alt="Visa">
      <a href="https://play.google.com/store/apps/details?id=com.acme.app&hl=en">Play</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
      <a href="https://linkedin.com/company/acme/">LinkedIn</a></footer>
    <div class="cookies">We use cookies</div>
  </body></html>`;
  const { server, origin } = await serve((req, res) => {
    const body = files[req.url];
    if (body) res.writeHead(200, { "content-type": "image/svg+xml" }).end(body);
    else res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-")), "kit");
  try {
    // A blog post's address: the kit is read from the home page.
    const { kit } = await makeKit(`${origin}/blog/first-post`, { dir, stores: false });
    assert.equal(kit.url, `${origin}/`);
    assert.equal(kit.name, "Acme");
    assert.match(kit.notes[0], /is not the home page/);
    assert.deepEqual(kit.logos.map((l) => [l.file, l.where, l.kind]), [["logo-01.png", "header", "svg"], ["logo-02.png", "footer", "img"]], JSON.stringify(kit.logos));
    assert.equal(kit.logos[1].src, `${origin}/acme-logo-light.svg`);
    assert.equal(kit.logos[1].background, "#1d243e");
    // Both are drawn as SVG: the inline one is written out, the image is the
    // file as the browser loaded it.
    assert.deepEqual(kit.logos.map((l) => [l.svg, l.onPicture]), [["logo-01.svg", false], ["logo-02.svg", false]]);
    assert.match(fs.readFileSync(path.join(dir, "logo-01.svg"), "utf8"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg".*<rect [^>]*fill="#ff0000"/s);
    assert.equal(fs.readFileSync(path.join(dir, "logo-02.svg"), "utf8"), files["/acme-logo-light.svg"] + "\n");

    const header = readPng(path.join(dir, "logo-01.png"));
    const footer = readPng(path.join(dir, "logo-02.png"));
    for (const png of [header, footer]) {
      assert.ok(Math.min(png.width, png.height) >= 240, `${png.width}x${png.height}`);
    }
    assert.deepEqual(header.pixel(header.width >> 1, header.height >> 1), [255, 0, 0], "header logo");
    assert.deepEqual(header.pixel(2, 2), [255, 255, 255], "header background");
    assert.deepEqual(footer.pixel(footer.width >> 1, footer.height >> 1), [255, 255, 255], "footer logo");
    assert.deepEqual(footer.pixel(2, 2), [29, 36, 62], "footer background");
    assert.ok(fs.readFileSync(path.join(dir, "logo-01.png")).includes("Source\0easybrandkit logo"), "the cut is tagged");

    assert.deepEqual(kit.icons, [
      { rel: "icon", href: `${origin}/favicon.ico`, sizes: "" },
      { rel: "apple-touch-icon", href: `${origin}/apple.png`, sizes: "180x180" },
    ]);
    assert.deepEqual(kit.images, [
      { property: "og:image", url: `${origin}/og.png` },
      { property: "ld+json:logo", url: `${origin}/brand/acme-logo.png` },
    ]);
    assert.equal(kit.manifest, `${origin}/site.webmanifest`);
    assert.deepEqual(kit.links, [
      { type: "appstore", url: "https://apps.apple.com/app/id1234567890", from: "meta" },
      { type: "instagram", url: "https://instagram.com/acme", from: "ld+json" },
      { type: "googleplay", url: "https://play.google.com/store/apps/details?id=com.acme.app", from: "footer" },
      { type: "linkedin", url: "https://linkedin.com/company/acme", from: "footer" },
    ]);
    // The look: the coloured button (not the white one), the red the logo is
    // drawn in, the heading, the link in the text, the header and footer,
    // the large grey hero; fonts. The white footer logo adds no color.
    assert.deepEqual(kit.logos.map((l) => l.color), ["#ff0000", "#ffffff"]);
    assert.deepEqual(kit.colors, [
      { hex: "#3f56c8", role: "button" },
      { hex: "#ff0000", role: "logo" },
      { hex: "#0f172a", role: "heading" },
      { hex: "#dc2626", role: "link" },
      { hex: "#ffffff", role: "header" },
      { hex: "#1d243e", role: "footer" },
      { hex: "#f0f0f0", role: "surface" },
    ]);
    assert.deepEqual(kit.fonts, { heading: "Georgia", body: "Verdana" });
    // The words a no-brief film or page starts from: what the colored button
    // says, not the white language switch.
    assert.deepEqual(kit.text, {
      title: "Acme | Tools for teams",
      description: "Tools for teams that ship.",
      headings: [{ tag: "h1", text: "Acme for teams" }],
      ctas: ["Start"],
    });

    // The first screen at 2x, without the cookie bar.
    assert.deepEqual(kit.screenshots, [{ file: "screen-01.png", width: 3200, height: 1800 }]);
    const screen = readPng(path.join(dir, "screen-01.png"));
    assert.notDeepEqual(screen.pixel(1600, 1760), [255, 0, 255], "the cookie bar is hidden");
    // The card: the kit on one picture, the button color on a swatch.
    assert.deepEqual(kit.card, { file: "card.png", width: 2400, height: 1350 });
    const card = readPng(path.join(dir, "card.png"));
    let swatch = false;
    for (let y = 0; y < card.height && !swatch; y += 6) {
      for (let x = card.width >> 1; x < card.width && !swatch; x += 6) swatch = card.pixel(x, y).join() === "63,86,200";
    }
    assert.ok(swatch, "the button color is on the card");

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.logos, kit.logos);
    const markdown = fs.readFileSync(path.join(dir, "BRAND.md"), "utf8");
    assert.match(markdown, /^# Acme brand kit/);
    assert.match(markdown, /\| `#3f56c8` \| buttons \|/);
    assert.match(markdown, /\| logo-02\.png \| footer \| `#1d243e` \| \d+x\d+ \| logo-02\.svg \|/);
    // The same kit for Quarto and Shiny: the white page under everything is
    // its background even though the list files white under the header.
    const yml = fs.readFileSync(path.join(dir, "_brand.yml"), "utf8");
    assert.match(yml, /^meta:\n {2}name: Acme\n {2}link: "http:\/\/127\.0\.0\.1:\d+\/"\n$/m);
    assert.ok(yml.includes(["logo:", "  images:", "    logo-01: logo-01.svg", "    logo-02:", "      path: logo-02.svg", "      alt: Acme", "  medium: logo-01", ""].join("\n")), yml);
    assert.ok(yml.includes(['    header: "#ffffff"', '    footer: "#1d243e"', '    surface: "#f0f0f0"', '  foreground: "#0f172a"', '  background: "#ffffff"', '  primary: "#3f56c8"', ""].join("\n")), yml);
    assert.ok(yml.includes(["    - family: Georgia", "      source: system", "  base: Verdana", "  headings: Georgia", "  link:", '    color: "#dc2626"', ""].join("\n")), yml);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("a bot check served instead of the page fails with a reason and leaves nothing behind", { skip: noBrowser }, async () => {
  // Read as a site, a CAPTCHA page gave a kit named "Human Verification" in
  // the check provider's orange.
  const html = `<!doctype html><html><head><title>Human Verification</title><script src="/awswaf/challenge.js"></script></head>
    <body style="margin:0;font-family:Arial"><h1 style="color:rgb(221,107,16)">Confirm you are human</h1>
    <button style="width:200px;height:44px;background:rgb(255,153,2)">Begin</button></body></html>`;
  const { server, origin } = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  try {
    await assert.rejects(makeKit(origin, { dir, stores: false }), /answered with a bot check \("Human Verification"\)/);
    assert.equal(fs.existsSync(dir), false, "no folder left behind");
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("logos: the mark alone, as it stands once settled: no neighbour cut by the margin, no popup backdrop, its ground kept", { skip: noBrowser }, async () => {
  // A white header logo over a dark hero that lies behind a see-through
  // header (a sibling, not an ancestor: it must stay), a red line 4 px under
  // it, a popup's half-black backdrop over the page, and a 6 s fade-in on
  // the logo.
  const html = `<!doctype html><html><head><style>
      body{margin:0;background:#fff}
      .hero{position:absolute;left:0;top:0;width:100%;height:420px;background:rgb(10,60,40);z-index:0}
      header.top{position:relative;z-index:1;height:80px;display:flex;align-items:center;padding-left:40px}
      a.brand{display:block;animation:in 6s linear both}
      @keyframes in{from{opacity:0}to{opacity:1}}
      .tag{position:absolute;left:40px;top:59px;width:120px;height:10px;background:rgb(255,0,0)}
      main{position:relative;z-index:1;height:1400px;padding-top:500px}
      footer{height:200px;background:rgb(29,36,62);display:flex;align-items:center;padding-left:20px}
      .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100}
      .dialog{position:fixed;left:50%;top:50%;width:300px;height:200px;margin:-100px 0 0 -150px;background:#fff;z-index:101}
    </style></head><body>
    <div class="hero"></div>
    <header class="top"><a href="/" class="brand">${svg("rgb(255,255,255)", 120, 30)}</a><div class="tag"></div></header>
    <main><h1>Acme</h1></main>
    <footer><a href="/">${svg("rgb(255,255,255)", 140, 36)}</a></footer>
    <div class="backdrop"></div><div class="dialog">Sale</div>
  </body></html>`;
  const { server, origin } = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-")), "kit");
  try {
    const { kit } = await makeKit(origin, { dir, stores: false });
    assert.equal(kit.logos[0].where, "header", JSON.stringify(kit.logos));
    // The page's CSS has white under the logo; the cut shows the hero.
    assert.equal(kit.logos[0].background, "#0a3c28");
    assert.equal(kit.logos[0].onPicture, false);
    const header = readPng(path.join(dir, kit.logos[0].file));
    assert.deepEqual(header.pixel(header.width >> 1, header.height >> 1), [255, 255, 255], "the logo, whole and opaque");
    assert.deepEqual(header.pixel(2, 2), [10, 60, 40], "the hero behind it, not dimmed");
    for (let y = 0; y < header.height; y += 2) {
      for (let x = 0; x < header.width; x += 2) {
        const [r, g, b] = header.pixel(x, y);
        assert.ok(!(r > 150 && g < 80 && b < 80), `the red line under the logo at ${x},${y}`);
      }
    }
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("logos: a lockup on a picture is not the logo; the vector keeps the page's look and nothing that runs", { skip: noBrowser }, async () => {
  // A header logo over a striped header (kept, on a picture) whose parts are
  // colored by the page's stylesheet, with a part the page hides, a symbol it
  // takes from a sprite elsewhere in the page, a script and an event handler.
  // In the page body, the brand's event lockup over a striped banner (not
  // kept). A white logo in a solid navy footer.
  const html = `<!doctype html><html><head>
    <meta property="og:site_name" content="Acme">
    <style>
      body{margin:0;background:#fff}
      header.top{height:80px;display:flex;align-items:center;padding-left:40px;background:repeating-linear-gradient(90deg,rgb(30,30,30) 0 6px,rgb(220,220,220) 6px 12px)}
      .mark{fill:rgb(20,120,90)}
      .mark .ink{fill:rgb(83,58,253)}
      .mark .narrow{display:none}
      .promo{margin-top:300px;height:300px;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(90deg,rgb(10,4,32) 0 7px,rgb(122,44,255) 7px 14px)}
      main{height:1200px}
      footer{height:200px;background:rgb(29,36,62);display:flex;align-items:center;padding-left:20px}
    </style></head><body>
    <svg width="0" height="0" style="position:absolute"><symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></symbol></svg>
    <header class="top"><a href="/" aria-label="Acme home"><svg class="mark" width="160" height="40" viewBox="0 0 160 40" onload="window.loaded=1"><script>window.ran=1</script><rect class="ink" width="120" height="40"/><rect class="narrow" width="40" height="40" fill="rgb(0,255,0)"/><use href="#dot" x="130" y="10" width="20" height="20" fill="currentColor" style="color:rgb(255,0,0)"/><circle cx="150" cy="35" r="4"/></svg></a></header>
    <section class="promo"><a href="/sessions" aria-label="Acme Sessions"><svg class="sessions-logo" width="300" height="60"><rect width="300" height="60" fill="rgb(255,255,255)"/></svg></a></section>
    <main></main>
    <footer><a href="/">${svg("rgb(255,255,255)", 140, 36)}</a></footer>
  </body></html>`;
  const { server, origin } = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-")), "kit");
  try {
    const { kit } = await makeKit(origin, { dir, stores: false });
    assert.deepEqual(kit.logos.map((l) => [l.where, l.onPicture, l.svg]), [["header", true, "logo-01.svg"], ["footer", false, "logo-02.svg"]], JSON.stringify(kit.logos));
    assert.equal(kit.logos[0].color, "", "no logo color read off a picture");
    assert.equal(kit.logos[1].background, "#1d243e");

    const vector = fs.readFileSync(path.join(dir, "logo-01.svg"), "utf8");
    assert.match(vector, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(vector, /<rect class="ink"[^>]*fill="#533afd"/, "the stylesheet's fill, written onto the part");
    assert.match(vector, /<use [^>]*fill="#ff0000"/, "currentColor, resolved");
    assert.match(vector, /<circle [^>]*fill="#14785a"/, "a shape carries the fill the root passes down");
    assert.doesNotMatch(vector, /currentColor|style=/, "plain attributes only, nothing left to resolve");
    assert.match(vector, /<defs><symbol id="dot"/, "the symbol it uses, brought in");
    assert.doesNotMatch(vector, /narrow|0,255,0/, "the part the page hides");
    assert.doesNotMatch(vector, /<script|onload|window\./, "nothing that runs");

    const markdown = fs.readFileSync(path.join(dir, "BRAND.md"), "utf8");
    assert.match(markdown, /\| logo-01\.png \| header \| a picture, mostly `#[0-9a-f]{6}` \| \d+x\d+ \| logo-01\.svg \|/);
    assert.match(markdown, /A logo on a picture was cut with part of that picture around it\./);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

// A page with a header logo, and a footer logo when given its color.
const brandPage = (header, footer) => `<!doctype html><html><head><title>Acme</title><style>
    body{margin:0;background:#fff} header{height:60px;display:flex;align-items:center;padding-left:20px}
    main{height:1400px} footer{height:200px;background:rgb(29,36,62);display:flex;align-items:center;padding-left:20px}
  </style></head><body>
  <header><a href="/">${svg(header, 120, 30)}</a></header><main><h1>Acme</h1></main>
  ${footer ? `<footer><a href="/">${svg(footer, 140, 36)}</a></footer>` : ""}
  </body></html>`;
const BOT_CHECK = `<!doctype html><html><head><title>Human Verification</title><script src="/awswaf/challenge.js"></script></head><body><h1>Confirm you are human</h1></body></html>`;

test("a kit survives runs that fail, and one that ends well takes its place and keeps the user's files", { skip: noBrowser }, async (t) => {
  let html = brandPage("rgb(255,0,0)", "rgb(255,255,255)");
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  const bot = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(BOT_CHECK));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  // The browser's profile and the folders Chrome makes in the temp folder go
  // too, whether the run fails or ends well.
  const temp = ownTemp(t);
  const system = process.env.TMPDIR;
  if (temp) process.env.TMPDIR = temp;
  const tempLeft = () => (temp ? fs.readdirSync(temp) : []);
  t.after(() => {
    if (system === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = system;
    site.server.close();
    bot.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const first = await makeKit(site.origin, { dir, stores: false });
  assert.deepEqual(first.kit.logos.map((logo) => logo.file), ["logo-01.png", "logo-02.png"]);
  assert.deepEqual(tempLeft(), [], "a run that ends well");
  writeFiles(dir, { "notes.txt": "mine", "FACTS.md": "# Acme facts\n", "pages/home.md": "home", "pages/mine.txt": "mine" });
  const good = filesOf(dir);

  await assert.rejects(makeKit("http://127.0.0.1:9/", { dir, stores: false }), /ERR_UNSAFE_PORT/);
  assert.deepEqual(filesOf(dir), good, "a page that does not open");
  assert.deepEqual(tempLeft(), [], "a page that does not open");
  await assert.rejects(makeKit(bot.origin, { dir, stores: false }), /answered with a bot check/);
  assert.deepEqual(filesOf(dir), good, "a bot check");
  assert.deepEqual(tempLeft(), [], "a bot check");
  // A disk that fills up as the kit is written, after the page was read.
  const write = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", function (file, ...rest) {
    if (path.basename(String(file)) === "brand.json") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    return write.call(this, file, ...rest);
  });
  await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => err.message === "The disk has no room left for the new kit (ENOSPC)." && err.earlierKit === dir);
  full.mock.restore();
  assert.deepEqual(filesOf(dir), good, "a full disk");
  assert.deepEqual(tempLeft(), [], "a full disk");

  // Ended well: the new kit, with one logo now, in place of the earlier one;
  // the earlier facts go, the user's files stay, and no part folder is left.
  html = brandPage("rgb(0,0,255)");
  const { kit } = await makeKit(site.origin, { dir, stores: false });
  assert.deepEqual(kit.logos.map((logo) => logo.file), ["logo-01.png"]);
  const names = filesOf(dir).map((line) => line.split(" ")[0]);
  assert.deepEqual(names, ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "logo-01.svg", "notes.txt", "pages/", "pages/mine.txt", "screen-01.png"]);
  const logo = readPng(path.join(dir, "logo-01.png"));
  assert.deepEqual(logo.pixel(logo.width >> 1, logo.height >> 1), [0, 0, 255], "the new logo");

  // Through a link to the folder, the files go into the folder it points at.
  fs.symlinkSync(dir, path.join(parent, "link"), "junction");
  html = brandPage("rgb(0,128,0)");
  await makeKit(site.origin, { dir: path.join(parent, "link"), stores: false });
  assert.equal(fs.lstatSync(path.join(parent, "link")).isSymbolicLink(), true);
  assert.deepEqual(filesOf(dir).map((line) => line.split(" ")[0]), names);
  const green = readPng(path.join(dir, "logo-01.png"));
  assert.deepEqual(green.pixel(green.width >> 1, green.height >> 1), [0, 128, 0], "the logo read through the link");
  assert.deepEqual(tempLeft(), [], "runs that end well");
});

test("a home page that ends on an HTTP error or on a page that cannot be opened fails the run, says which, and the earlier kit stays", { skip: noBrowser }, async (t) => {
  const closed = await serve(() => {});
  closed.server.close();
  const page = brandPage("rgb(255,0,0)", "rgb(255,255,255)");
  const answer = (status, body = page, headers = {}) => (req, res) => res.writeHead(status, { "content-type": "text/html", ...headers }).end(body);
  // A picture and a frame that answer 404 do not count: the first kit is
  // made from a page that has both.
  let home = answer(200, page.replace("</body>", `<img src="/missing.png" width="10" height="10"><iframe src="/missing"></iframe></body>`));
  const site = await serve((req, res) => {
    if (req.url === "/") return home(req, res);
    if (req.url === "/gone") return answer(410)(req, res);
    return res.writeHead(404).end();
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const { kit } = await makeKit(site.origin, { dir, stores: false });
  assert.deepEqual(kit.logos.map((logo) => logo.file), ["logo-01.png", "logo-02.png"]);
  const good = filesOf(dir);
  const url = `${site.origin}/`;
  const moved = (script) => answer(200, `${page}<script>${script}</script>`);
  const cases = [
    ["404", answer(404), `${url} answered 404, so no kit was made.`],
    ["500", answer(500), `${url} answered 500, so no kit was made.`],
    ["an error with no page of its own", answer(404, ""), `${url} answered 404, so no kit was made.`],
    ["a redirect to a 410", answer(302, "", { location: "/gone" }), `${url} led to ${site.origin}/gone, which answered 410, so no kit was made.`],
    ["a script that moves on to a closed port", answer(200, `<!doctype html><title>x</title><script>location.replace("${closed.origin}/")</script>`), `${url} led to ${closed.origin}/, which could not be opened, so no kit was made.`],
    ["a script that moves on to a 410 while the page is read", moved(`setTimeout(() => location.replace("/gone"), 300)`), `${url} led to ${site.origin}/gone, which answered 410, so no kit was made.`],
    ["a bot check with an error status", answer(403, BOT_CHECK.replace("</body>", `<a href="/why">Why?</a></body>`)), `${url} answered with a bot check ("Human Verification") instead of its page, so no kit was made. Get the logo and colors from the site in a normal browser.`],
  ];
  for (const [what, handler, said] of cases) {
    home = handler;
    await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => {
      assert.equal(err.message, said, what);
      assert.equal(err.earlierKit, dir, what);
      return true;
    });
    assert.deepEqual(filesOf(dir), good, what);
  }
  // A bot check with an error status that lets the browser through is read
  // as the site it leads to.
  let solved = false;
  home = (req, res) => {
    if (solved) return answer(200)(req, res);
    solved = true;
    return answer(403, BOT_CHECK.replace("</body>", `<a href="/why">Why?</a><script>setTimeout(() => location.reload(), 300)</script></body>`))(req, res);
  };
  const through = await makeKit(site.origin, { dir, stores: false });
  assert.deepEqual(through.kit.logos.map((logo) => logo.file), ["logo-01.png", "logo-02.png"]);
});

test("a disk that fills up while the card or a vector is written fails the run, and no file cut off goes into the kit", { skip: noBrowser }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)")));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const write = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", function (file, data, ...rest) {
    if (path.basename(String(file)) !== "logo-01.svg") return write.call(this, file, data, ...rest);
    // As the write of a full disk ends: some of the file is there.
    write.call(this, file, data.slice(0, 8));
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
  });
  await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => err.message === "The disk has no room left for the new kit (ENOSPC)." && err.earlierKit === dir);
  full.mock.restore();
  assert.deepEqual(filesOf(dir), before, "the vector");

  // The whole CLI, with a card that does not fit.
  const hook = path.join(parent, "full.js");
  fs.writeFileSync(hook, `const fs = require("fs");
const write = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...rest) {
  if (!String(file).endsWith("card.png")) return write.call(this, file, data, ...rest);
  write.call(this, file, data.subarray(0, 4096));
  throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
};
`);
  // Not spawnSync: the page is served from this process.
  const child = spawn(process.execPath, ["--require", hook, CLI, site.origin, "--out", dir, "--no-stores"], { stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 1, said);
  assert.equal(said.trim().split("\n").pop(), `easybrandkit: The disk has no room left for the new kit (ENOSPC). The kit already in ${dir} is as it was.`);
  assert.deepEqual(filesOf(dir), before, "the card");
});

test("a browser killed while the card is drawn fails the run and keeps the earlier kit; a card that cannot be drawn otherwise is told in the notes", { skip: noBrowser }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)")));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  // The card puts the first screen on itself, read from the run's part folder.
  const read = fs.readFileSync;
  const drawing = (file) => /\.easybrandkit-part-/.test(String(file)) && path.basename(String(file)) === "screen-01.png";
  const killed = t.mock.method(fs, "readFileSync", function (file, ...rest) {
    if (drawing(file)) killBrowsers();
    return read.call(this, file, ...rest);
  });
  await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => err.message === "The browser was closed or crashed before the kit was done, so no kit was made. Try again." && err.earlierKit === dir);
  killed.mock.restore();
  assert.deepEqual(filesOf(dir), before);

  // While the browser runs, the kit is saved without its card, and says so.
  t.mock.method(fs, "readFileSync", function (file, ...rest) {
    if (drawing(file)) throw new Error("the first screen could not be read.");
    return read.call(this, file, ...rest);
  });
  const { kit } = await makeKit(site.origin, { dir, stores: false });
  assert.equal(kit.card, null);
  assert.deepEqual(kit.notes, ["The card could not be drawn: the first screen could not be read."]);
  assert.equal(fs.existsSync(path.join(dir, "card.png")), false);
  assert.match(fs.readFileSync(path.join(dir, "BRAND.md"), "utf8"), /\n## Notes\n\n- The card could not be drawn: the first screen could not be read\.\n$/);
});

test("the folder is read again as the new kit goes in: a kit put there while the site was read is the one replaced", { skip: noBrowser }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  writeFiles(dir, { "brand.json": JSON.stringify({ version: 1, logos: [{ file: "logo-01.png" }] }), "BRAND.md": "one", "_brand.yml": "one", "logo-01.png": "one" });
  // Another run's kit, with a second logo, takes the earlier one's place
  // while this run reads the site.
  let swapped = false;
  const site = await serve((req, res) => {
    if (!swapped) {
      swapped = true;
      writeFiles(dir, { "brand.json": JSON.stringify({ version: 1, logos: [{ file: "logo-01.png" }, { file: "logo-02.png" }] }), "logo-02.png": "two" });
    }
    res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)"));
  });
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await makeKit(site.origin, { dir, stores: false });
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "logo-01.svg", "screen-01.png"]);
});

test("the CLI says once that a new kit could not be put in place, and the kit there stays as it was", { skip: noBrowser }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)")));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  // A folder of the user's where the new kit has its card.
  fs.rmSync(path.join(dir, "card.png"));
  fs.mkdirSync(path.join(dir, "card.png"));
  const before = filesOf(dir);
  // Not spawnSync: the page is served from this process.
  const child = spawn(process.execPath, [CLI, site.origin, "--out", dir, "--no-stores"], { stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 1, said);
  const lines = said.trim().split("\n");
  assert.equal(lines.pop(), `easybrandkit: The new kit could not be put in ${dir}: card.png is a folder there, where the new kit has a file. The kit already there is as it was.`);
  assert.ok(lines.every((line) => line.endsWith("...")), said);
  assert.deepEqual(filesOf(dir), before);
});

test("a run that ends well exits 0 when nobody reads what it prints, and 1, saying the kit was saved, when its output cannot be written", { skip: noBrowser }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)")));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const brandJson = () => filesOf(dir).find((line) => line.startsWith("brand.json "));
  // As when its output goes into a pipe whose reader has ended: the
  // summary, and brand.json with --json, find the pipe closed once the kit
  // is in place, and the lines that say how far it got as it starts.
  for (const [json, gone] of [[false, "stdout"], [true, "stdout"], [false, "stderr"]]) {
    const earlier = brandJson();
    const child = spawn(process.execPath, [CLI, site.origin, "--out", dir, "--no-stores", ...(json ? ["--json"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    child[gone].destroy();
    let said = "";
    child[gone === "stdout" ? "stderr" : "stdout"].on("data", (chunk) => (said += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0, said);
    assert.doesNotMatch(said, /EPIPE/);
    assert.notEqual(brandJson(), earlier, `${gone} closed${json ? ", with --json" : ""}`);
  }
  // Into a file on a full disk: the kit is in place, and the run says so
  // and exits 1.
  if (fs.existsSync("/dev/full")) {
    const full = fs.openSync("/dev/full", "w");
    t.after(() => fs.closeSync(full));
    for (const [json, what] of [[false, "the summary"], [true, "brand.json"]]) {
      const earlier = brandJson();
      const child = spawn(process.execPath, [CLI, site.origin, "--out", dir, "--no-stores", ...(json ? ["--json"] : [])], { stdio: ["ignore", full, "pipe"] });
      let said = "";
      child.stderr.on("data", (chunk) => (said += chunk));
      const [code] = await once(child, "close");
      assert.equal(code, 1, said);
      assert.equal(said.trim().split("\n").pop(), `easybrandkit: Saved the kit to ${dir}, but ${what} could not be printed (ENOSPC).`);
      assert.notEqual(brandJson(), earlier, `the new kit, after ${what}`);
    }
  }
});

// The processes left in a process group, on Linux, zombies aside:
// /proc/<pid>/stat holds the state and the group after the command's name.
function processesIn(group) {
  if (process.platform !== "linux") return [];
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === group && state !== "Z") found.push(Number(pid));
    } catch {
      // Gone already.
    }
  }
  return found;
}

test("a run stopped by SIGINT, SIGQUIT, SIGTERM or SIGHUP leaves the earlier kit as it was, says so, and leaves no browser running and nothing in the temp folder", { skip: noBrowser || (process.platform === "win32" && "no POSIX signals") }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)", "rgb(255,255,255)")));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  const groups = [];
  t.after(() => {
    site.server.close();
    for (const group of groups) for (const pid of processesIn(group)) process.kill(pid, "SIGKILL");
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const temp = ownTemp(t);
  const env = { ...process.env, ...(temp ? { TMPDIR: temp } : {}) };
  const tempLeft = () => (temp ? fs.readdirSync(temp) : []);
  // The kit, made by the CLI, whose process ends once it has printed its
  // summary, not when a timer of the page's load runs out.
  const made = await runCli([site.origin, "--out", dir, "--no-stores"], env);
  assert.equal(made.code, 0, made.stderr);
  assert.ok(made.lingered < 5_000, `the process ended ${made.lingered} ms after its summary`);
  assert.deepEqual(tempLeft(), [], "a run that ends well");
  const good = filesOf(dir);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Ctrl-C and Ctrl-\ reach the whole process group, the browser too; a
  // kill or a closed terminal can reach the kit alone. With --json the run
  // says nothing as it works, so the signal comes once its part folder holds
  // a logo. The last run's output has nobody reading it any more, as when
  // the program that started it has gone: the stop still ends it by its
  // signal.
  const stops = [["SIGINT", true, false, false], ["SIGQUIT", true, false, false], ["SIGTERM", false, false, false], ["SIGTERM", true, true, false], ["SIGHUP", false, false, false], ["SIGTERM", false, true, true]];
  for (const [signal, group, json, gone] of stops) {
    // A group of its own, as a terminal gives a command, which the browser
    // joins. SIGQUIT ends a process with a core dump where the system writes
    // them, into the folder it runs in: the test's own.
    const child = spawn(process.execPath, [CLI, site.origin, "--out", dir, "--no-stores", ...(json ? ["--json"] : [])], { env, cwd: parent, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    groups.push(child.pid);
    let said = "";
    let out = "";
    child.stderr.on("data", (chunk) => (said += chunk));
    if (gone) child.stdout.destroy();
    else child.stdout.on("data", (chunk) => (out += chunk));
    const working = () => (json ? fs.readdirSync(dir).some((name) => name.startsWith(".easybrandkit-part-") && fs.existsSync(path.join(dir, name, "logo-01.png"))) : said.includes("Taking the first screen"));
    for (let waited = 0; waited < 60_000 && !working(); waited += 50) await wait(50);
    assert.ok(working(), `the run got as far as the logos: ${said}`);
    process.kill(group ? -child.pid : child.pid, signal);
    const [code, ended] = await closed;
    assert.equal(ended, signal, `exit ${code}`);
    assert.deepEqual(filesOf(dir), good, signal);
    const message = `stopped by ${signal}. The kit already in ${dir} is as it was.`;
    assert.equal(said.trim().split("\n").pop(), `easybrandkit: ${message}`);
    assert.equal(out, json && !gone ? `${JSON.stringify({ ok: false, error: message })}\n` : "");
    assert.deepEqual(tempLeft(), [], `nothing left in the temp folder after ${signal}`);
    await wait(1_000);
    assert.deepEqual(processesIn(child.pid), [], `no browser left running after ${signal}`);
  }

  // A stop that comes once the kit is saved, while the process is still up
  // (here a timer of the test's keeps it so), keeps the new kit and says so.
  const hold = path.join(parent, "hold.js");
  fs.writeFileSync(hold, "setTimeout(() => {}, 30000);\n");
  const child = spawn(process.execPath, ["--require", hold, CLI, site.origin, "--out", dir, "--no-stores"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  groups.push(child.pid);
  let said = "";
  let out = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  child.stdout.on("data", (chunk) => (out += chunk));
  for (let waited = 0; waited < 60_000 && !out.includes("Saved the"); waited += 50) await wait(50);
  assert.match(out, /^Saved the Acme brand kit to /);
  process.kill(child.pid, "SIGTERM");
  const [code, ended] = await closed;
  assert.equal(ended, "SIGTERM", `exit ${code}`);
  assert.equal(said.trim().split("\n").pop(), `easybrandkit: stopped by SIGTERM, after the new kit was saved in ${dir}.`);
  const now = filesOf(dir);
  assert.deepEqual(now.map((line) => line.split(" ")[0]), good.map((line) => line.split(" ")[0]));
  assert.notEqual(now.find((line) => line.startsWith("brand.json ")), good.find((line) => line.startsWith("brand.json ")), "the new kit");
  assert.deepEqual(tempLeft(), [], "nothing left in the temp folder after a late stop");
});
