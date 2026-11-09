"use strict";

// The kit end to end in a real headless browser (skipped when none is
// installed), against pages served from this process, plus the address and
// folder rules that need no browser.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const { makeKit, normalizeUrl, homePageOf, siteOfListing, prepareDir, brandName } = require("../skills/easybrandkit/scripts/lib/kit");
const { checkDir } = require("../skills/easybrandkit/scripts/lib/folder");
const { findChrome, launch, openPage, killBrowsers, removeTemps } = require("../skills/easybrandkit/scripts/lib/chrome");
const { groundOf } = require("../skills/easybrandkit/scripts/lib/logos");
const { waitForContent } = require("../skills/easybrandkit/scripts/lib/page");
const { startRun, discardRun } = require("../skills/easybrandkit/scripts/lib/run");
const { noControls, plainText } = require("../skills/easybrandkit/scripts/lib/text");
const { setTimeLimit } = require("../skills/easybrandkit/scripts/lib/time");

const CLI = path.resolve(__dirname, "../skills/easybrandkit/scripts/easybrandkit.js");
const LIB = path.resolve(__dirname, "../skills/easybrandkit/scripts/lib");
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
  // Such a first label makes a side site only when a site is left after it.
  assert.equal(homePageOf("https://docs.python.org/3/"), "https://python.org/");
  assert.equal(homePageOf("https://news.bbc.co.uk/"), "https://bbc.co.uk/");
  assert.equal(homePageOf("https://news.com/"), null);
  assert.equal(homePageOf("https://support.co.uk/"), null);
  assert.equal(homePageOf("https://help.com.tr/"), null);
  assert.equal(homePageOf("https://news.com/world"), "https://news.com/");
  assert.equal(brandName("Acme", "Whatever", "https://acme.com/"), "Acme");
  assert.equal(brandName("", "Acme | Payments for teams", "https://acme.com/"), "Acme");
  assert.equal(brandName("", "Acme\n\t-  Payments", "https://acme.com/"), "Acme");
  assert.equal(brandName("", "", "https://www.acme.com/"), "Acme");
});

test("text a site wrote: control characters out, line breaks kept only where asked, cut to its length", () => {
  const raw = "A\x1b]0;title\x07 \x1b[31mRED\u009b2J\n\tEnd";
  assert.equal(plainText(raw), "A ]0;title [31mRED 2J End");
  assert.equal(noControls("one\x1b[2J\ntwo\x07"), "one [2J\ntwo ");
  assert.equal(plainText("a   b", 2), "a");
  assert.equal(plainText(undefined), "");
  assert.equal(noControls(null), "");
});

// Runs code in a process of its own, and fails when it has not ended in time:
// a pattern stuck on a long run of one character cannot be interrupted from
// here, and would hold up every test.
function endsInTime(code, ms = 20_000) {
  const done = spawnSync(process.execPath, ["-e", `const lib = ${JSON.stringify(LIB)};\n${code}`], { encoding: "utf8", timeout: ms, killSignal: "SIGKILL" });
  assert.equal(done.signal, null, `still running after ${ms} ms: ${code}`);
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

// findLogos on a page that is one DOM snapshot, built from the elements given.
const HOSTILE_PAGE = String.raw`
const { findLogos } = require(lib + "/logos.js");
const read = async (elements) => {
  const strings = [""];
  const id = (text) => strings.push(text) - 1;
  const nodes = { nodeName: [], parentIndex: [], attributes: [], nodeValue: [], backendNodeId: [] };
  const layout = { nodeIndex: [], bounds: [], styles: [] };
  const style = ["visible", "1", "rgba(0, 0, 0, 0)", "visible", "visible", "rgb(0, 0, 0)", "Arial"].map(id);
  [{ name: "HTML", parent: -1 }, { name: "HEAD", parent: 0 }, { name: "BODY", parent: 0 }, ...elements].forEach((el, i) => {
    nodes.nodeName.push(id(el.name));
    nodes.parentIndex.push(el.parent);
    nodes.attributes.push(Object.entries(el.attrs || {}).flatMap(([key, value]) => [id(key), id(value)]));
    nodes.nodeValue.push(id(el.text || ""));
    nodes.backendNodeId.push(i + 1);
    layout.nodeIndex.push(i);
    layout.bounds.push([0, 0, 100, 40]);
    layout.styles.push(style);
  });
  const snap = { documents: [{ baseURL: id("https://acme.test/"), documentURL: id("https://acme.test/"), nodes, layout }], strings };
  return findLogos({ send: async () => snap }, "https://acme.test/", 1600, 900);
};
`;

test("a page's text cannot hold the thread that answers Ctrl-C and the run's own time limit", () => {
  // A long run of spaces between two words of a title.
  endsInTime(`
    const { brandName } = require(lib + "/kit.js");
    const name = brandName("", "Acme" + " ".repeat(300000) + "Pay", "https://acme.test/");
    if (name !== "Acme Pay") throw new Error(name);
  `);
  for (const [what, elements, check] of [
    ["a title of spaces", `[{ name: "TITLE", parent: 1 }, { name: "#text", parent: 3, text: "a" + " ".repeat(300000) + "b" }]`, `if (page.title.length > 300) throw new Error("long");`],
    ["a class that is one long word", `[{ name: "DIV", parent: 2, attrs: { class: "logo-".repeat(100000) + "!" } }]`, ""],
    ["an app id of dots", `[{ name: "META", parent: 1, attrs: { name: "al:android:package", content: ".".repeat(300000) + "!" } }]`, ""],
    ["a link of slashes", `[{ name: "A", parent: 2, attrs: { href: "https://x.com/" + "/".repeat(300000) + "a" } }]`, ""],
    ["a site name of many words", `[{ name: "META", parent: 1, attrs: { property: "og:site_name", content: Array.from({ length: 100000 }, (_, i) => "w" + i).join(" ") } }, ...Array.from({ length: 3000 }, (_, i) => ({ name: "IMG", parent: 2, attrs: { alt: "x".repeat(200) + i, src: "/a" + i + ".png" } }))]`, `if (page.siteName.length > 200) throw new Error("long");`],
    ["many links", `Array.from({ length: 100000 }, (_, i) => ({ name: "A", parent: 2, attrs: { href: "https://x.com/u" + i } }))`, `if (page.links.length !== 100000) throw new Error(String(page.links.length));`],
  ]) {
    assert.doesNotThrow(() => endsInTime(`${HOSTILE_PAGE}\nread(${elements}).then((page) => { ${check} });`), what);
  }
});

test("a logo's alt text and an icon's sizes come in without control characters", () => {
  endsInTime(`${HOSTILE_PAGE}
    read([{ name: "LINK", parent: 1, attrs: { rel: "icon", sizes: "16x16\\u001b[2J", href: "/i.png" } }, { name: "HEADER", parent: 2 }, { name: "IMG", parent: 4, attrs: { alt: "Acme logo\\u001b[2J", src: "/logo.png" } }]).then((page) => {
      if (page.icons[0].sizes !== "16x16 [2J") throw new Error(JSON.stringify(page.icons));
      if (page.marks[0].alt !== "Acme logo [2J") throw new Error(JSON.stringify(page.marks));
    });
  `);
});

test("the first look at a page comes whatever time the run has left, and what the wait says is what it did", async (t) => {
  const tab = (height, name) => ({
    looks: 0,
    send: async function (method) {
      if (method === "Page.getLayoutMetrics") {
        this.looks++;
        return { cssLayoutViewport: { clientWidth: 1600, clientHeight: 900 }, cssContentSize: { height } };
      }
      return { documents: [{ nodes: { nodeName: [0] } }], strings: [name] };
    },
  });
  t.after(() => setTimeLimit(120_000));
  setTimeLimit(40_000);
  for (const [height, name, said, what] of [[2000, "P", "content", "taller than the screen"], [900, "A", "content", "a link"], [900, "IMG", "content", "an image"], [900, "P", "no time", "a bare page, with no time left to wait"]]) {
    const cdp = tab(height, name);
    assert.equal(await waitForContent(cdp), said, what);
    assert.equal(cdp.looks, 1, what);
  }
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
  // A handler that has ended since the browser started, whose pid another
  // process has by now: /proc gives that pid another start time.
  process.env.HANDLER_BIN = handlerBin;
  delete process.env.HANDLER_GIVEN;
  await launch({ width: 800, height: 600 });
  const handler = Number(fs.readFileSync(process.env.HANDLER_PID, "utf8"));
  started.push(handler, helperOf());
  const read = fs.readFileSync;
  const another = t.mock.method(fs, "readFileSync", function (file, ...rest) {
    const text = read.call(this, file, ...rest);
    if (file !== `/proc/${handler}/stat`) return text;
    const at = text.lastIndexOf(")") + 2;
    const fields = text.slice(at).split(" ");
    fields[19] = String(Number(fields[19]) + 1);
    return text.slice(0, at) + fields.join(" ");
  });
  killBrowsers();
  another.mock.restore();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ended(handler), false, "a pid that has come round again on another process");
});

test("a browser that has ended is not looked up by its pid, which can be another process's by now", { skip: process.platform !== "linux" && "a browser's processes are told on Linux only" }, async (t) => {
  // The browser's start, stood in for only to choose the pid of a browser
  // that has ended: the process below has it now.
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));
  const childProcess = require("node:child_process");
  t.mock.method(childProcess, "spawn", () => {
    const browser = new EventEmitter();
    Object.assign(browser, { pid: other.pid, exitCode: null, signalCode: null, kill: () => assert.fail("the browser has ended") });
    setTimeout(() => {
      browser.exitCode = 1;
      browser.emit("exit", 1, null);
    }, 20);
    return browser;
  });
  const file = require.resolve("../skills/easybrandkit/scripts/lib/chrome");
  const loaded = require.cache[file];
  delete require.cache[file];
  const given = process.env.CHROME_PATH;
  process.env.CHROME_PATH = process.execPath;
  t.after(() => {
    require.cache[file] = loaded;
    if (given === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = given;
  });
  await assert.rejects(require(file).launch({ width: 800, height: 600 }), /did not start/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ended(other.pid), false);
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
  // One byte too long.
  const socket = Buffer.byteLength(path.join(parent, "", "com.google.Chrome.XXXXXX", "SingletonSocket"));
  if (socket < 107) {
    const near = path.join(parent, "n".repeat(108 - socket - 1));
    fs.mkdirSync(near);
    process.env.TMPDIR = near;
    await assert.rejects(launch({ width: 800, height: 600 }), (err) => err.message.endsWith("whose path would be 108 bytes where Linux allows 107. Set TMPDIR to a folder whose path is at least 1 byte shorter."));
  }
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
  // An empty value, as a shell variable with nothing in it gives, is no
  // folder, in either form: the kit would go to the default folder.
  for (const out of [["--out"], ["--out="]]) {
    const empty = spawnSync(process.execPath, [CLI, "acme.example", ...out], { encoding: "utf8" });
    assert.equal(empty.status, 2, out[0]);
    assert.match(empty.stderr, /^easybrandkit: --out needs a value\n/, out[0]);
  }
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

test("a home page that ends on an HTTP error, on a page that cannot be opened or on a blank page fails the run, says which, and the earlier kit stays", { skip: noBrowser }, async (t) => {
  const closed = await serve(() => {});
  closed.server.close();
  const page = brandPage("rgb(255,0,0)", "rgb(255,255,255)");
  const answer = (status, body = page, headers = {}) => (req, res) => res.writeHead(status, { "content-type": "text/html", ...headers }).end(body);
  // A picture and frames that fail do not count, whether a frame answers
  // 404, is on a closed port or may not be shown in a frame: the first kit
  // is made from a page that has them all.
  let home = answer(200, page.replace("</body>", `<img src="/missing.png" width="10" height="10"><iframe src="/missing"></iframe><iframe src="${closed.origin}/"></iframe><iframe src="/denied"></iframe></body>`));
  const when = held();
  const site = await serve((req, res) => {
    if (req.url === "/") return home(req, res);
    if (req.url === "/gone") return answer(410)(req, res);
    if (req.url === "/denied") return answer(200, "<h1>Denied</h1>", { "x-frame-options": "DENY" })(req, res);
    if (req.url === "/when") return when.ask(res);
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
  const lastStep = (steps) => steps[steps.length - 1];
  const opening = `Opening ${url}`;
  // With the step each one gets to, for those that are told at one look.
  const cases = [
    ["404", answer(404), `${url} answered 404, so no kit was made.`, opening],
    ["500", answer(500), `${url} answered 500, so no kit was made.`, opening],
    ["an error with no page of its own", answer(404, ""), `${url} answered 404, so no kit was made.`, opening],
    ["a redirect to a 410", answer(302, "", { location: "/gone" }), `${url} led to ${site.origin}/gone, which answered 410, so no kit was made.`, opening],
    ["a script that moves on to a closed port", answer(200, `<!doctype html><title>x</title><script>location.replace("${closed.origin}/")</script>`), `${url} led to ${closed.origin}/, which could not be opened, so no kit was made.`],
    ["a script that moves on to a 410 while the page is read", moved(`setTimeout(() => location.replace("/gone"), 1000)`), `${url} led to ${site.origin}/gone, which answered 410, so no kit was made.`, "Reading the page"],
    ["a script that moves on to a blank page while the page is read", moved(`setTimeout(() => location.replace("about:blank"), 1000)`), `${url} moved on to a blank page, so no kit was made.`, "Reading the page"],
    ["a script that moves on to a blank page at once", answer(200, `<!doctype html><title>x</title><script>location.replace("about:blank")</script>`), `${url} moved on to a blank page, so no kit was made.`, opening],
    ["a bot check with an error status", answer(403, BOT_CHECK.replace("</body>", `<a href="/why">Why?</a></body>`)), `${url} answered with a bot check ("Human Verification") instead of its page, so no kit was made. Get the logo and colors from the site in a normal browser.`],
  ];
  for (const [what, handler, said, last] of cases) {
    home = handler;
    const steps = [];
    await assert.rejects(makeKit(site.origin, { dir, stores: false, log: (line) => steps.push(line) }), (err) => {
      assert.equal(err.message, said, what);
      assert.equal(err.earlierKit, dir, what);
      return true;
    });
    if (last) assert.equal(lastStep(steps), last, what);
    assert.deepEqual(filesOf(dir), good, what);
  }
  // A page that moves on only once the run has got to a step: as the page is
  // walked, it is told before its logos are cut, and as they are cut, after
  // the first screen.
  home = moved(`fetch("/when").then(() => location.replace("/gone"))`);
  for (const [step, last] of [["Reading the page", "Reading the page"], ["Cutting out 2 logos", "Taking the first screen"]]) {
    when.reset();
    const steps = [];
    const log = (line) => {
      steps.push(line);
      if (line === step) when.release();
    };
    await assert.rejects(makeKit(site.origin, { dir, stores: false, log }), (err) => {
      assert.equal(err.message, `${url} led to ${site.origin}/gone, which answered 410, so no kit was made.`, step);
      return true;
    });
    assert.equal(lastStep(steps), last, step);
    assert.deepEqual(filesOf(dir), good, step);
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

// An address a page asks for that is answered when the test says so, for a
// page that moves on at a step of the run the test picks: whichever comes
// first, the page's request or the test's word.
function held() {
  let waiting = null;
  let released = false;
  return {
    ask(res) {
      if (released) res.writeHead(200).end();
      else waiting = res;
    },
    release() {
      released = true;
      if (waiting) waiting.writeHead(200).end();
      waiting = null;
    },
    reset() {
      released = false;
      waiting = null;
    },
  };
}

test("a deeper address whose home page fails is read as given and says so, and if it fails too the error names it", { skip: noBrowser }, async (t) => {
  const answer = (status, body = brandPage("rgb(255,0,0)", "rgb(255,255,255)")) => (req, res) => res.writeHead(status, { "content-type": "text/html" }).end(body);
  let home;
  let deep = answer(200, brandPage("rgb(0,0,255)"));
  const when = held();
  const site = await serve((req, res) => {
    if (req.url === "/") return home(req, res);
    if (req.url === "/project/") return deep(req, res);
    if (req.url === "/gone") return answer(410)(req, res);
    if (req.url === "/when") return when.ask(res);
    return res.writeHead(404).end();
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const url = `${site.origin}/`;
  const asked = `${url}project/`;
  const noteOf = (what) => `The home page, ${url}, could not be read: it ${what}. ${asked} was read as given, and its header and colors can differ from the home page's.`;
  const kitNames = ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "logo-01.svg", "screen-01.png"];
  const cases = [
    ["a 404", answer(404, ""), "answered 404"],
    ["a 500 with a page of its own", answer(500), "answered 500"],
    ["a bot check", answer(403, BOT_CHECK.replace("</body>", `<a href="/why">Why?</a></body>`)), `answered with a bot check ("Human Verification")`],
    ["a connection dropped", (req) => req.socket.destroy(), "could not be opened (net::ERR_EMPTY_RESPONSE)"],
    ["a move to a blank page", answer(200, `${brandPage("rgb(255,0,0)", "rgb(255,255,255)")}<script>setTimeout(() => location.replace("about:blank"), 300)</script>`), "moved on to a blank page"],
  ];
  for (const [what, handler, told] of cases) {
    home = handler;
    const dir = path.join(parent, what.replace(/\W+/g, "-"));
    const { kit } = await makeKit(asked, { dir, stores: false });
    assert.equal(kit.url, asked, what);
    assert.deepEqual(kit.notes, [noteOf(told)], what);
    assert.deepEqual(kit.logos.map((logo) => logo.file), ["logo-01.png"], what);
    assert.deepEqual(fs.readdirSync(dir).sort(), kitNames, what);
  }
  // A home page that fails only once its two logos are cut leaves none of
  // what it wrote: the page given has one logo.
  home = answer(200, `${brandPage("rgb(255,0,0)", "rgb(255,255,255)")}<script>fetch("/when").then(() => location.replace("/gone"))</script>`);
  const late = path.join(parent, "late");
  const { kit } = await makeKit(asked, { dir: late, stores: false, log: (line) => line === "Taking the first screen" && when.release() });
  assert.deepEqual(kit.notes, [noteOf(`led to ${site.origin}/gone, which answered 410`)]);
  assert.deepEqual(fs.readdirSync(late).sort(), kitNames);

  // The home page that works is read, as ever, and the page given is not.
  home = answer(200);
  const read = await makeKit(asked, { dir: path.join(parent, "home"), stores: false });
  assert.equal(read.kit.url, url);
  assert.deepEqual(read.kit.notes, [`${asked} is not the home page, so ${url} was read instead: the home page carries the brand's own header and colors.`]);

  // Both fail: the error names the address given, and the earlier kit stays.
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  home = answer(404, "");
  deep = answer(503, "<!doctype html><title>Down</title><h1>Down</h1>");
  await assert.rejects(makeKit(asked, { dir, stores: false }), (err) => err.message === `${asked} answered 503, so no kit was made.` && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before);
  // An address that is itself the home page is not read twice.
  const asks = [];
  home = (req, res) => {
    asks.push(req.url);
    return answer(404, "")(req, res);
  };
  await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => err.message === `${url} answered 404, so no kit was made.`);
  assert.deepEqual(asks, ["/"]);
  assert.deepEqual(filesOf(dir), before);
});

test("a store listing whose website fails keeps what the listing gave and says so", { skip: noBrowser }, async (t) => {
  const closed = await serve(() => {});
  closed.server.close();
  // The website the listing names, and a listing from a store that is not
  // asked: what easybrandkit fetches from it itself is answered here.
  let answers = (req, res) => res.writeHead(403, { "content-type": "text/html" }).end("<!doctype html><title>Forbidden</title><h1>Forbidden</h1>");
  const site = await serve((req, res) => answers(req, res));
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1024, 20);
  const art = "https://is1-ssl.mzstatic.com/image/thumb";
  let seller = `${site.origin}/app`;
  // A picture whose address holds this does not come.
  let missing = "";
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, ...rest) => {
    const { hostname } = new URL(url);
    if (hostname === "itunes.apple.com") return new Response(JSON.stringify({ results: [{ trackName: "Acme", artworkUrl512: `${art}/a/AppIcon.png/512x512bb.jpg`, sellerUrl: seller, screenshotUrls: [`${art}/1.png/392x696bb.jpg`] }] }));
    if (hostname.endsWith("mzstatic.com")) {
      if (missing && String(url).includes(missing)) throw new TypeError("fetch failed");
      return new Response(png);
    }
    return realFetch(url, ...rest);
  });
  t.mock.method(dns.promises, "lookup", async () => [{ address: "17.253.144.10", family: 4 }]);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const listing = "https://apps.apple.com/us/app/acme/id1234567890";
  const noteOf = (what) => `${listing} is a store listing, and the website it names, ${seller}, ${what}, so only the listing was read: the kit has the app icon and a screenshot but no logos, colors or fonts. For those, give an address of the product's site that opens.`;
  const fromListing = ["BRAND.md", "_brand.yml", "appstore-icon.png", "appstore-shot-01.png", "brand.json"];
  const bot = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end(BOT_CHECK);
  const blank = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`${brandPage("rgb(255,0,0)")}<script>setTimeout(() => location.replace("about:blank"), 300)</script>`);
  const cases = [
    ["a 403", answers, `${site.origin}/app`, "answered 403"],
    ["a closed port", answers, `${closed.origin}/`, "could not be opened (net::ERR_CONNECTION_REFUSED)"],
    ["a bot check", bot, `${site.origin}/`, `answered with a bot check ("Human Verification")`],
    ["a blank page", blank, `${site.origin}/`, "moved on to a blank page"],
  ];
  for (const [what, handler, website, told] of cases) {
    answers = handler;
    seller = website;
    const dir = path.join(parent, what.replace(/\W+/g, "-"));
    const { kit, facts } = await makeKit(listing, { dir, stores: false, facts: what === "a 403" });
    assert.equal(kit.url, listing, what);
    assert.equal(kit.name, "Acme", what);
    assert.deepEqual(kit.stores[0].assets.map((asset) => asset.file), ["appstore-icon.png", "appstore-shot-01.png"], what);
    assert.deepEqual(kit.logos, [], what);
    assert.deepEqual(kit.notes, [noteOf(told), ...(what === "a 403" ? ["No facts were read: the website it names could not be read."] : [])], what);
    assert.equal(facts, null, what);
    assert.deepEqual(fs.readdirSync(dir).sort(), fromListing, what);
    assert.ok(fs.readFileSync(path.join(dir, "BRAND.md"), "utf8").includes(`- ${noteOf(told)}\n`), what);
  }
  // A page that shows nothing after the whole wait costs the website, not
  // the listing. The wait is told to have passed.
  answers = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Loading</title>");
  seller = `${site.origin}/`;
  const pageLib = require("../skills/easybrandkit/scripts/lib/page");
  t.mock.method(pageLib, "waitForContent", async () => "loader");
  const bare = await reloadedKit().makeKit(listing, { dir: path.join(parent, "bare"), stores: false });
  pageLib.waitForContent.mock.restore();
  assert.deepEqual(bare.kit.notes, [noteOf("still shows no content after 30 s")]);
  assert.deepEqual(fs.readdirSync(path.join(parent, "bare")).sort(), fromListing);

  // A run with no time left to wait, or that used up its time on the page,
  // gave up: that says nothing about the website, and it does not cost the
  // kit already in the folder.
  const earlier = path.join(parent, "earlier");
  writeFiles(earlier, EARLIER);
  const kept = filesOf(earlier);
  await assert.rejects(makeKit(listing, { dir: earlier, stores: false, timeLimit: 45_000 }), (err) => err.message === `${seller} shows no content yet and the run has no time left to wait for it, so nothing was read. Try again, or give it more time with --timeout.` && err.earlierKit === earlier);
  assert.deepEqual(filesOf(earlier), kept, "no time left to wait");
  answers = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)").replace("</body>", "<script>alert(1)</script></body>"));
  await assert.rejects(makeKit(listing, { dir: earlier, stores: false, timeLimit: 12_000 }), (err) => err.message === `The browser tab stopped answering while it read ${seller}, so no kit was made. Try again, or give it more time with --timeout.` && err.earlierKit === earlier);
  assert.deepEqual(filesOf(earlier), kept, "a tab that stops answering at the end of the run's time");

  // The note says what came of the listing.
  answers = (req, res) => res.writeHead(403, { "content-type": "text/html" }).end("<!doctype html><title>Forbidden</title><h1>Forbidden</h1>");
  const partly = async (blocked, gave, files) => {
    missing = blocked;
    const dir = path.join(parent, `partly-${blocked}`);
    const { kit } = await makeKit(listing, { dir, stores: false });
    assert.deepEqual(kit.notes, [`${listing} is a store listing, and the website it names, ${seller}, answered 403, so only the listing was read: the kit has ${gave} but no logos, colors or fonts. For those, give an address of the product's site that opens.`]);
    assert.deepEqual(fs.readdirSync(dir).sort(), files);
  };
  await partly("1.png", "the app icon", ["BRAND.md", "_brand.yml", "appstore-icon.png", "brand.json"]);
  await partly("AppIcon", "a screenshot", ["BRAND.md", "_brand.yml", "appstore-shot-01.png", "brand.json"]);

  // None of its pictures came, and the website failed or there is none: a
  // name alone is no kit to put in the place of an earlier one.
  missing = "mzstatic";
  await assert.rejects(makeKit(listing, { dir: earlier, stores: false }), (err) => err.message === `${listing}: no picture of the listing could be downloaded, and the website it names, ${seller}, answered 403, so no kit was made.` && err.earlierKit === earlier);
  assert.deepEqual(filesOf(earlier), kept, "no picture, and a website that fails");
  seller = "";
  await assert.rejects(makeKit(listing, { dir: earlier, stores: false }), (err) => err.message === `${listing}: no picture of the listing could be downloaded, and it names no website, so no kit was made.` && err.earlierKit === earlier);
  assert.deepEqual(filesOf(earlier), kept, "no picture, and no website");
  // A website that opens makes the kit without them.
  missing = "mzstatic";
  seller = `${site.origin}/`;
  answers = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)"));
  const noPictures = await makeKit(listing, { dir: path.join(parent, "no-pictures"), stores: false });
  assert.deepEqual(noPictures.kit.logos.map((logo) => logo.file), ["logo-01.png"]);
  assert.deepEqual(noPictures.kit.stores[0].assets, []);
  assert.deepEqual(noPictures.kit.notes, [`${listing} is a store listing none of whose pictures could be downloaded, so the kit comes from the website it names, ${seller}.`]);
  // And the note says which ones came.
  missing = "1.png";
  const iconOnly = await makeKit(listing, { dir: path.join(parent, "icon-only"), stores: false });
  assert.deepEqual(iconOnly.kit.notes, [`${listing} is a store listing: its icon comes from the listing, the rest from the website it names, ${seller}.`]);
  missing = "AppIcon";
  const shotOnly = await makeKit(listing, { dir: path.join(parent, "shot-only"), stores: false });
  assert.deepEqual(shotOnly.kit.notes, [`${listing} is a store listing: its screenshot comes from the listing, the rest from the website it names, ${seller}.`]);
  missing = "";

  // A website that opens gives the rest of the kit.
  answers = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)"));
  const whole = await makeKit(listing, { dir: path.join(parent, "whole"), stores: false });
  assert.deepEqual(whole.kit.notes, [`${listing} is a store listing: its icon and screenshot come from the listing, the rest from the website it names, ${seller}.`]);
  assert.deepEqual(whole.kit.logos.map((logo) => logo.file), ["logo-01.png"]);
  assert.ok(fs.existsSync(path.join(parent, "whole", "appstore-icon.png")));
  // A listing that names no website.
  seller = "";
  const alone = await makeKit(listing, { dir: path.join(parent, "alone"), stores: false, facts: true });
  assert.deepEqual(alone.kit.notes, [`${listing} is a store listing that names no website, so only the listing was read: the kit has the app icon and a screenshot but no logos, colors or fonts. Give the product's website for those.`, "No facts were read: the listing names no website."]);

  // A browser that ends on the way, or that is not there, is no failure of
  // the website's, and ends the run.
  seller = `${site.origin}/`;
  const gone = path.join(parent, "gone");
  await assert.rejects(makeKit(listing, { dir: gone, stores: false, log: (line) => line === "Reading the page" && killBrowsers() }), (err) => err.message === "The browser was closed or crashed before the kit was done, so no kit was made. Try again.");
  assert.equal(fs.existsSync(gone), false);
  const chrome = process.env.CHROME_PATH;
  process.env.CHROME_PATH = path.join(parent, "no-chrome");
  t.after(() => {
    if (chrome === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = chrome;
  });
  await assert.rejects(makeKit(listing, { dir: gone, stores: false }), /^Error: No Chrome, Chromium, Edge or Brave found/);
  assert.equal(fs.existsSync(gone), false);
});

// kit.js loaded afresh, for what the test has mocked of the modules it takes
// its functions from.
function reloadedKit() {
  const file = require.resolve("../skills/easybrandkit/scripts/lib/kit");
  const loaded = require.cache[file];
  delete require.cache[file];
  const reloaded = require(file);
  require.cache[file] = loaded;
  return reloaded;
}

// kit.js with a browser tab whose calls of method time out, for the first
// stalled tabs opened or for all: a real wait for one takes half a minute.
function withStalledTab(t, method, stalled = Infinity) {
  const chrome = require("../skills/easybrandkit/scripts/lib/chrome");
  const realOpen = chrome.openPage;
  let opened = 0;
  t.mock.method(chrome, "openPage", async (...args) => {
    const cdp = await realOpen(...args);
    if (++opened > stalled) return cdp;
    const send = cdp.send;
    cdp.send = (name, ...rest) => (name === method ? Promise.reject(Object.assign(new Error(`${name} timed out`), { timedOut: true })) : send(name, ...rest));
    return cdp;
  });
  return reloadedKit().makeKit;
}

test("a tab that stops answering is told in words, and more time is advised only to a run that used up its own", { skip: noBrowser }, async (t) => {
  const page = brandPage("rgb(255,0,0)");
  const dialog = page.replace("</body>", "<script>alert(1)</script></body>");
  let html = page;
  const site = await serve((req, res) => {
    if (req.url === "/deep") return res.writeHead(200, { "content-type": "text/html" }).end(page);
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const url = `${site.origin}/`;
  // One call's own limit passed, with time to spare.
  const stalledTab = withStalledTab(t, "Page.getLayoutMetrics");
  await assert.rejects(stalledTab(site.origin, { dir, stores: false }), (err) => err.message === `The browser tab stopped answering while it read ${url}, so no kit was made. Try again.` && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before, "a call's own limit");
  // A page that stops the tab with a dialog, in a run that has no time left
  // for the next call.
  html = dialog;
  await assert.rejects(makeKit(site.origin, { dir, stores: false, timeLimit: 12_000 }), (err) => err.message === `The browser tab stopped answering while it read ${url}, so no kit was made. Try again, or give it more time with --timeout.` && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before, "the run's own limit");

  // A home page that stalls the tab is a page that failed like any other.
  t.mock.restoreAll();
  html = page;
  const stalledOnce = withStalledTab(t, "Page.getLayoutMetrics", 1);
  const asked = `${url}deep`;
  const { kit } = await stalledOnce(asked, { dir: path.join(parent, "deep"), stores: false });
  assert.deepEqual(kit.notes, [`The home page, ${url}, could not be read: it stopped answering. ${asked} was read as given, and its header and colors can differ from the home page's.`]);
});

// A site whose page tries to save a file every 25 ms for as long as it is
// open, and a HOME of the test's own, whose Downloads folder a browser saves
// into on Linux.
async function savingSite(t) {
  const site = { asked: 0 };
  const served = await serve((req, res) => {
    if (req.url.startsWith("/report.bin")) {
      site.asked++;
      return res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=report.bin" }).end(Buffer.alloc(2048, 65));
    }
    res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)").replace("</body>", `<script>let n = 0; setInterval(() => { const a = document.createElement("a"); a.href = "/report.bin?" + ++n; a.download = "report-" + n + ".bin"; document.body.appendChild(a); a.click(); a.remove(); }, 25)</script></body>`));
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const env = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DOWNLOAD_DIR: process.env.XDG_DOWNLOAD_DIR };
  t.after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    served.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const home = path.join(parent, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DOWNLOAD_DIR;
  return Object.assign(site, { origin: served.origin, parent, downloads: () => filesOf(path.join(home, "Downloads")) });
}

const LINUX_HOME = noBrowser || (process.platform !== "linux" && "the Downloads folder follows HOME on Linux only");

test("a page that tries to save files for the whole run leaves nothing in the user's Downloads folder", { skip: LINUX_HOME }, async (t) => {
  const site = await savingSite(t);
  const { kit } = await makeKit(site.origin, { dir: path.join(site.parent, "kit"), stores: false });
  assert.deepEqual(kit.logos.map((logo) => logo.file), ["logo-01.png"], "the page stays where it is");
  assert.ok(site.asked >= 1, "the page asked for the file");
  assert.deepEqual(site.downloads(), []);
});

test("the browser is told to end before the tab's connection closes, since that connection is what refuses downloads", { skip: noBrowser }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)")));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const chrome = require("../skills/easybrandkit/scripts/lib/chrome");
  const realLaunch = chrome.launch;
  const realOpen = chrome.openPage;
  const order = [];
  t.mock.method(chrome, "launch", async (...args) => {
    const browser = await realLaunch(...args);
    const close = browser.close;
    browser.close = async () => {
      order.push("browser told to end");
      await close();
      order.push("browser ended");
    };
    return browser;
  });
  t.mock.method(chrome, "openPage", async (...args) => {
    const cdp = await realOpen(...args);
    const close = cdp.close;
    cdp.close = () => {
      order.push("connection closed");
      close();
    };
    return cdp;
  });
  await reloadedKit().makeKit(site.origin, { dir: path.join(parent, "kit"), stores: false });
  assert.deepEqual(order, ["browser told to end", "browser ended", "connection closed"]);
});

test("a download no connection refuses goes into the throwaway profile, not the user's Downloads folder", { skip: LINUX_HOME }, async (t) => {
  const site = await savingSite(t);
  const temp = ownTemp(t);
  if (!temp) return t.skip("the temp folder is too deep for a browser");
  const tmpdir = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => {
    if (tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpdir;
  });
  // The refusal taken back as soon as the tab is open.
  const chrome = require("../skills/easybrandkit/scripts/lib/chrome");
  const realOpen = chrome.openPage;
  t.mock.method(chrome, "openPage", async (...args) => {
    const cdp = await realOpen(...args);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    return cdp;
  });
  let inProfile = [];
  const look = () => {
    const profile = fs.readdirSync(temp).find((name) => name.startsWith("easybrandkit-chrome-"));
    inProfile = fs.readdirSync(path.join(temp, profile, "Downloads"));
  };
  await reloadedKit().makeKit(site.origin, { dir: path.join(site.parent, "kit"), stores: false, log: (line) => line === "Drawing the card" && look() });
  assert.ok(inProfile.length >= 1, "the page's files went into the profile");
  assert.deepEqual(site.downloads(), []);
  assert.deepEqual(fs.readdirSync(temp), [], "and went with it");
});

test("what a page says reaches no terminal with its control characters, and a note stays on one line", { skip: noBrowser }, async (t) => {
  const ESC = "\x1b";
  const bot = `<!doctype html><title>Just a moment ${ESC}[2J${ESC}[Hcleared\n\nby it</title><h1>x</h1><a href="/w">w</a>`;
  const named = brandPage("rgb(255,0,0)").replace("<title>Acme</title>", `<meta charset="utf-8"><title>Acme</title><meta property="og:site_name" content="A${ESC}]0;set-by-site${ESC}\\${ESC}[31mRED\u009b2J${ESC}[0m"><meta name="description" content="Words${ESC}[2Jhere">`).replace("<h1>Acme</h1>", `<h1>Hello${ESC}[2Jthere</h1>`);
  const site = await serve((req, res) => {
    const html = (status, body) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (req.url === "/tr") return html(200, named);
    if (req.url === "/project/") return html(200, brandPage("rgb(255,0,0)"));
    html(403, bot);
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  // A control character, raw or as JSON writes one.
  const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\\u00[0189][0-9a-f]/i;
  const run = (url, folder, ...rest) => runCli([url, "--out", path.join(parent, folder), "--no-stores", ...rest], process.env);

  // The site's own name, the words on its page. A language path counts as a
  // home page, so it is read as given.
  const made = await run(`${site.origin}/tr`, "named");
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /^Saved the A \]0;set-by-site \\ \[31mRED 2J \[0m brand kit to /);
  assert.doesNotMatch(made.stdout, CONTROL, "the summary");
  for (const file of ["BRAND.md", "brand.json", "_brand.yml"]) assert.doesNotMatch(fs.readFileSync(path.join(parent, "named", file), "utf8"), CONTROL, file);
  const json = await run(`${site.origin}/tr`, "named", "--json");
  assert.equal(json.code, 0, json.stderr);
  assert.doesNotMatch(json.stdout, CONTROL, "--json");

  // A bot check's title, in a note for a page the kit chose.
  const went = await run(`${site.origin}/project/`, "kit");
  assert.equal(went.code, 0, went.stderr);
  assert.doesNotMatch(went.stdout, CONTROL, "the note");
  const note = `The home page, ${site.origin}/, could not be read: it answered with a bot check ("Just a moment [2J [Hcleared by it"). ${site.origin}/project/ was read as given, and its header and colors can differ from the home page's.`;
  assert.ok(went.stdout.includes(`  Note    ${note}\n`), went.stdout);
  assert.ok(fs.readFileSync(path.join(parent, "kit", "BRAND.md"), "utf8").endsWith(`## Notes\n\n- ${note}\n`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(parent, "kit", "brand.json"), "utf8")).notes, [note]);

  // And in the error for the address given.
  const refused = await run(site.origin, "bot");
  assert.equal(refused.code, 1);
  assert.doesNotMatch(refused.stderr, CONTROL, "the error");
  assert.match(refused.stderr, /answered with a bot check \("Just a moment \[2J \[Hcleared by it"\)/);
});

test("a robots.txt rule built to keep a matcher busy cannot keep a run from being stopped", { skip: noBrowser || (process.platform === "win32" && "no POSIX signals") }, async (t) => {
  let robots = false;
  const stars = "*a".repeat(24);
  const site = await serve((req, res) => {
    if (req.url === "/robots.txt") {
      robots = true;
      return res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /${stars}b$\n`);
    }
    res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)").replace("</body>", `<nav><a href="/pricing?${"a".repeat(400)}">Pricing</a></nav></body>`));
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let child;
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Gone already.
    }
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  child = spawn(process.execPath, [CLI, site.origin, "--out", dir, "--no-stores", "--facts", "--timeout", "120"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const closed = once(child, "close");
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  for (let waited = 0; waited < 60_000 && !robots; waited += 50) await wait(50);
  assert.ok(robots, `the run got as far as the site's robots.txt: ${said}`);
  // By now the rule has been tried on the link, or the run is past it.
  await wait(300);
  process.kill(child.pid, "SIGTERM");
  const ended = await Promise.race([closed, wait(15_000).then(() => null)]);
  assert.ok(ended, `still running 15 s after SIGTERM: ${said}`);
  assert.equal(ended[1], "SIGTERM");
  assert.equal(said.trim().split("\n").pop(), `easybrandkit: stopped by SIGTERM. The kit already in ${dir} is as it was.`);
  assert.deepEqual(filesOf(dir), before);
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

test("a browser killed while the page is read fails the run at once and says so, and a server that never answers is told as that", { skip: noBrowser }, async (t) => {
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)", "rgb(255,255,255)")));
  // Takes the connection and never answers.
  const silent = await serve(() => {});
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.close();
    silent.server.closeAllConnections();
    silent.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const started = Date.now();
  await assert.rejects(makeKit(site.origin, { dir, stores: false, log: (line) => line === "Reading the page" && killBrowsers() }), (err) => err.message === "The browser was closed or crashed before the kit was done, so no kit was made. Try again." && err.earlierKit === dir);
  assert.ok(Date.now() - started < 15_000, `told after ${Date.now() - started} ms`);
  assert.deepEqual(filesOf(dir), before, "a browser killed");
  await assert.rejects(makeKit(silent.origin, { dir, stores: false, timeLimit: 12_000 }), (err) => err.message === `${silent.origin}/ did not answer before the run's time ran out, so no kit was made. Try again, or give it more time with --timeout.` && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before, "a server that never answers");
  // One call's own limit passed, with time to spare: more time would not help.
  const stalled = withStalledTab(t, "Page.navigate");
  await assert.rejects(stalled(silent.origin, { dir, stores: false }), (err) => err.message === `${silent.origin}/ did not answer` && err.earlierKit === dir);
  assert.deepEqual(filesOf(dir), before, "one call's own limit");
});

test("a home page the run used up its time on ends the run, with the advice to give it more time, and the address given is not read past the limit", { skip: noBrowser }, async (t) => {
  const asked = [];
  const site = await serve((req, res) => {
    asked.push(req.url);
    // Takes the connection and never answers, but for the deeper page.
    if (req.url === "/project/") res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)"));
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.closeAllConnections();
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const home = `${site.origin}/`;
  const deeper = `${home}project/`;
  await assert.rejects(makeKit(deeper, { dir, stores: false, timeLimit: 12_000 }), (err) => err.message === `${home} did not answer before the run's time ran out, so no kit was made. Try again, or give it more time with --timeout.` && err.earlierKit === dir);
  assert.deepEqual(asked.filter((url) => url !== "/favicon.ico"), ["/"]);
  assert.deepEqual(filesOf(dir), before);
  // With time to spare, a home page that does not answer is a page that failed.
  const stalledOnce = withStalledTab(t, "Page.navigate", 1);
  const { kit } = await stalledOnce(deeper, { dir: path.join(parent, "deeper"), stores: false });
  assert.deepEqual(kit.notes, [`The home page, ${home}, could not be read: it did not answer. ${deeper} was read as given, and its header and colors can differ from the home page's.`]);
});

test("a short time limit reads what a page shows, and says so when the page shows nothing and there is no time to wait", { skip: noBrowser }, async (t) => {
  const plain = "<!doctype html><meta charset=utf-8><title>No Logo Home</title><h1>A home page with plenty on it</h1><p><a href=/x>link</a></p><div style=height:2000px>text</div>";
  const site = await serve((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/deep" ? brandPage("rgb(255,0,0)") : req.url === "/tr" ? "<!doctype html><title>Loading</title><p>Loading</p>" : plain));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const home = `${site.origin}/`;
  // A home page with text and links and no logo is the home page.
  const { kit } = await makeKit(`${home}deep`, { dir: path.join(parent, "home"), stores: false, timeLimit: 45_000 });
  assert.equal(kit.url, home);
  assert.deepEqual(kit.notes, [`${home}deep is not the home page, so ${home} was read instead: the home page carries the brand's own header and colors.`, "No logo was found on the page itself."]);
  // A page that shows nothing is not told as one that was waited for.
  await assert.rejects(makeKit(`${home}tr`, { dir: path.join(parent, "bare"), stores: false, timeLimit: 45_000 }), (err) => err.message === `${home}tr shows no content yet and the run has no time left to wait for it, so nothing was read. Try again, or give it more time with --timeout.`);
  assert.equal(fs.existsSync(path.join(parent, "bare")), false);
});

test("a browser killed while the page loads is told at once, not after the wait for the page's load event", { skip: noBrowser }, async (t) => {
  let killedAt = 0;
  const site = await serve((req, res) => {
    // Never answered: the page's load event never comes. The browser is
    // killed once the kit has heard that the page was opened.
    if (req.url === "/slow.png") {
      setTimeout(() => {
        killBrowsers();
        killedAt = Date.now();
      }, 300);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)").replace("</body>", `<img src="/slow.png" width="10" height="10"></body>`));
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  t.after(() => {
    site.server.closeAllConnections();
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => err.message === "The browser was closed or crashed before the kit was done, so no kit was made. Try again." && err.earlierKit === dir);
  assert.ok(killedAt > 0, "the page asked for its picture");
  assert.ok(Date.now() - killedAt < 15_000, `told after ${Date.now() - killedAt} ms`);
  assert.deepEqual(filesOf(dir), before);
});

test("a call on the connection to a browser that has ended fails at once", { skip: noBrowser }, async () => {
  const browser = await launch({ width: 800, height: 600 });
  const cdp = await openPage(browser.base, { width: 800, height: 600 });
  killBrowsers();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const started = Date.now();
  await assert.rejects(cdp.send("Page.getLayoutMetrics"), /^Error: The browser connection closed\.$/);
  assert.ok(Date.now() - started < 500, `told after ${Date.now() - started} ms`);
});

test("files of someone's that come into a folder made during the run are refused, not taken for a kit", { skip: noBrowser }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-out-"));
  const dir = path.join(parent, "kit");
  let came = false;
  const site = await serve((req, res) => {
    if (!came) {
      came = true;
      writeFiles(dir, { "notes.txt": "mine" });
    }
    res.writeHead(200, { "content-type": "text/html" }).end(brandPage("rgb(255,0,0)"));
  });
  t.after(() => {
    site.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await assert.rejects(makeKit(site.origin, { dir, stores: false }), (err) => err.message === `${dir} is not empty and holds no earlier brand kit. Pick another folder with --out.`);
  assert.deepEqual(filesOf(dir).map((line) => line.split(" ")[0]), ["notes.txt"]);
  assert.deepEqual(fs.readdirSync(parent), ["kit"]);
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
  let drawn = new Error("the first screen could not be read.");
  t.mock.method(fs, "readFileSync", function (file, ...rest) {
    if (drawing(file)) throw drawn;
    return read.call(this, file, ...rest);
  });
  const { kit } = await makeKit(site.origin, { dir, stores: false });
  assert.equal(kit.card, null);
  assert.deepEqual(kit.notes, ["The card could not be drawn: the first screen could not be read."]);
  assert.equal(fs.existsSync(path.join(dir, "card.png")), false);
  assert.match(fs.readFileSync(path.join(dir, "BRAND.md"), "utf8"), /\n## Notes\n\n- The card could not be drawn: the first screen could not be read\.\n$/);
  // A tab that stops answering is told in words, not by a call's name in
  // the DevTools protocol.
  drawn = Object.assign(new Error("Page.captureScreenshot timed out"), { timedOut: true });
  const stalled = await makeKit(site.origin, { dir, stores: false });
  assert.deepEqual(stalled.kit.notes, ["The card could not be drawn: the browser tab stopped answering."]);
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
