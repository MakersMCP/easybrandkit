"use strict";

// Where a run makes its files and how they take the place of an earlier
// kit, with no browser: the part folder, the move into place, what a run
// that does not end well leaves, the part folders of runs killed outright,
// and what the CLI says.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { startRun, discardRun, saveRun, SaveError, STALE } = require("../skills/easybrandkit/scripts/lib/run");
const { prepareDir } = require("../skills/easybrandkit/scripts/lib/kit");

const CLI = path.resolve(__dirname, "../skills/easybrandkit/scripts/easybrandkit.js");

const hash = (body) => crypto.createHash("sha1").update(body).digest("hex").slice(0, 8);

// Every file and folder in dir, hidden ones too, each file with a hash.
function filesOf(dir) {
  const found = [];
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        found.push(`${name}/`);
        walk(path.join(at, entry.name), name);
      } else {
        found.push(`${name} ${hash(fs.readFileSync(path.join(at, entry.name)))}`);
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

// An earlier kit with facts, and two files of the user's own.
const EARLIER = {
  "brand.json": JSON.stringify({ version: 1, logos: [{ file: "logo-01.png", svg: "logo-01.svg" }, { file: "logo-02.png" }], card: { file: "card.png" } }),
  "BRAND.md": "old",
  "_brand.yml": "old",
  "logo-01.png": "old",
  "logo-01.svg": "old",
  "logo-02.png": "old",
  "card.png": "old",
  "FACTS.md": "old",
  "facts.json": "old",
  "pages/home.md": "old",
  "pages/mine.txt": "mine",
  "notes.txt": "mine",
};
const FRESH = { "brand.json": JSON.stringify({ version: 1, logos: [{ file: "logo-01.png" }] }), "BRAND.md": "new", "_brand.yml": "new", "logo-01.png": "new", "card.png": "new" };

const tempParent = (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-run-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
};

const earlierOf = (dir) => () => prepareDir(dir) || [];

test("a new folder: the part folder sits next to it and becomes it when the run ends well", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "new", "acme");
  const run = startRun(dir, prepareDir(dir));
  assert.equal(path.dirname(run.work), path.join(parent, "new"));
  assert.match(path.basename(run.work), /^\.easybrandkit-part-\d+-[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(dir), false, "nothing at the kit's folder while the run works");
  writeFiles(run.work, FRESH);
  saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(fs.readdirSync(path.join(parent, "new")), ["acme"]);
  assert.deepEqual(filesOf(dir).map((line) => line.split(" ")[0]), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png"]);
});

test("a run that does not end well removes its part folder and the folders it made", (t) => {
  const parent = tempParent(t);
  const run = startRun(path.join(parent, "new", "brand", "acme"), null);
  writeFiles(run.work, FRESH);
  discardRun(run);
  assert.deepEqual(fs.readdirSync(parent), []);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const second = startRun(dir, prepareDir(dir));
  assert.equal(path.dirname(second.work), dir, "inside a folder that is there");
  writeFiles(second.work, FRESH);
  discardRun(second);
  assert.deepEqual(filesOf(dir), before);
});

test("ended well over an earlier kit: its files go, the new ones come, the user's files stay", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  // A file of the user's under a name the new kit writes is replaced.
  writeFiles(dir, { ...EARLIER, "screen-01.png": "mine" });
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new", "FACTS.md": "new", "pages/pricing.md": "new" });
  saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(dir), [
    `BRAND.md ${hash("new")}`, `FACTS.md ${hash("new")}`, `_brand.yml ${hash("new")}`, `brand.json ${hash(FRESH["brand.json"])}`, `card.png ${hash("new")}`,
    `logo-01.png ${hash("new")}`, `notes.txt ${hash("mine")}`, "pages/", `pages/mine.txt ${hash("mine")}`, `pages/pricing.md ${hash("new")}`, `screen-01.png ${hash("new")}`,
  ]);
  // A pages/ the earlier facts leave empty goes; one with the user's files stays.
  const again = startRun(dir, prepareDir(dir));
  writeFiles(again.work, FRESH);
  fs.rmSync(path.join(dir, "pages", "mine.txt"));
  saveRun(again, earlierOf(dir));
  discardRun(again);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "notes.txt", "screen-01.png"]);
});

test("a move that cannot finish puts back what it moved, and its error says so once", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  // A folder of the user's under a name the new kit writes.
  fs.mkdirSync(path.join(dir, "screen-01.png"));
  const before = filesOf(dir);
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new" });
  assert.throws(
    () => saveRun(run, earlierOf(dir)),
    (err) => err instanceof SaveError && err.message === `The new kit could not be put in ${dir}: screen-01.png is a folder there, where the new kit has a file. The kit already there is as it was.`,
  );
  discardRun(run);
  assert.deepEqual(filesOf(dir), before);
});

test("an earlier file that cannot be put back stays where the error says", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  fs.mkdirSync(path.join(dir, "screen-01.png"));
  const rename = fs.renameSync;
  // The earlier BRAND.md will not go back; the second time, the folder it
  // waits in will not move either.
  let folderMoves = true;
  t.mock.method(fs, "renameSync", function (from, to) {
    if (String(from).endsWith(`${path.sep}.earlier${path.sep}BRAND.md`) || (!folderMoves && String(from).endsWith(`${path.sep}.earlier`))) {
      throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: "EIO", syscall: "rename" });
    }
    return rename.call(this, from, to);
  });
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new" });
  let kept = "";
  assert.throws(
    () => saveRun(run, earlierOf(dir)),
    (err) => {
      kept = (/ Some files of the earlier kit could not be put back; they are in (.+)\.$/.exec(err.message) || [])[1];
      return err instanceof SaveError && err.message.startsWith(`The new kit could not be put in ${dir}: screen-01.png is a folder there, where the new kit has a file.`) && !err.message.includes("as it was");
    },
  );
  discardRun(run);
  assert.match(path.basename(kept), /^easybrandkit-kept-\d+-[0-9a-f]{8}$/);
  assert.equal(path.dirname(kept), dir);
  assert.equal(fs.readFileSync(path.join(kept, "BRAND.md"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(dir, "BRAND.md")), false);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".")), [], "the part folder is gone");

  // When that folder will not move either, the files stay in the part
  // folder, which discardRun then leaves.
  rename(path.join(kept, "BRAND.md"), path.join(dir, "BRAND.md"));
  fs.rmSync(kept, { recursive: true });
  folderMoves = false;
  const second = startRun(dir, prepareDir(dir));
  writeFiles(second.work, { ...FRESH, "screen-01.png": "new" });
  const aside = path.join(dir, path.basename(second.work), ".earlier");
  assert.throws(() => saveRun(second, earlierOf(dir)), (err) => err.message.endsWith(` Some files of the earlier kit could not be put back; they are in ${aside}.`));
  discardRun(second);
  assert.equal(fs.readFileSync(path.join(aside, "BRAND.md"), "utf8"), "old");
});

test("a folder made while the run worked: a kit there is read again and replaced, other files are refused", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "acme");
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, FRESH);
  // Another run saves a kit there meanwhile, with a logo this one does not have.
  const other = { version: 1, logos: [{ file: "logo-01.png" }, { file: "logo-02.png" }] };
  writeFiles(dir, { "brand.json": JSON.stringify(other), "BRAND.md": "other", "_brand.yml": "other", "logo-01.png": "other", "logo-02.png": "other", "notes.txt": "mine" });
  saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(dir), [
    `BRAND.md ${hash("new")}`, `_brand.yml ${hash("new")}`, `brand.json ${hash(FRESH["brand.json"])}`, `card.png ${hash("new")}`, `logo-01.png ${hash("new")}`, `notes.txt ${hash("mine")}`,
  ]);
  const elsewhere = path.join(parent, "other");
  const second = startRun(elsewhere, prepareDir(elsewhere));
  writeFiles(second.work, FRESH);
  writeFiles(elsewhere, { "notes.txt": "mine" });
  assert.throws(() => saveRun(second, earlierOf(elsewhere)), (err) => err instanceof SaveError && /other is not empty and holds no earlier brand kit/.test(err.message));
  discardRun(second);
  assert.deepEqual(filesOf(elsewhere), [`notes.txt ${hash("mine")}`]);
  // Made between the look and the move, which then finds it there (EPERM on
  // Windows, ENOTEMPTY elsewhere).
  const late = path.join(parent, "late");
  const third = startRun(late, prepareDir(late));
  writeFiles(third.work, FRESH);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (from, to) {
    if (to === late && !fs.existsSync(late)) {
      writeFiles(late, { "brand.json": JSON.stringify(other), "logo-02.png": "other", "notes.txt": "mine" });
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM", syscall: "rename" });
    }
    return rename.call(this, from, to);
  });
  saveRun(third, earlierOf(late));
  discardRun(third);
  assert.deepEqual(fs.readdirSync(late).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "notes.txt"]);
  assert.deepEqual(fs.readdirSync(parent).sort(), ["acme", "late", "other"]);
});

test("the part folder of a run killed outright: left alone while it may be at work, removed once stale", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  // A process that has ended, and one that runs.
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const dead = path.join(dir, `.easybrandkit-part-${gone}-0a1b2c3d`);
  const fresh = path.join(dir, `.easybrandkit-part-${gone}-0a1b2c3e`);
  const live = path.join(dir, `.easybrandkit-part-${process.pid}-0a1b2c3f`);
  // Killed as its files were being swapped: the earlier kit is in its .earlier.
  const swapping = path.join(dir, `.easybrandkit-part-${gone}-0a1b2c40`);
  const beside = path.join(parent, `.easybrandkit-part-${gone}-0a1b2c41`);
  for (const at of [dead, fresh, live, beside]) writeFiles(at, { "logo-01.png": "half" });
  writeFiles(swapping, { "logo-01.png": "half", ".earlier/brand.json": "old" });
  const old = new Date(Date.now() - STALE - 60_000);
  for (const at of [dead, live, swapping, beside]) {
    for (const file of ["logo-01.png", ".earlier/brand.json", ".earlier", ""]) if (fs.existsSync(path.join(at, file))) fs.utimesSync(path.join(at, file), old, old);
  }
  assert.ok(prepareDir(dir).includes("brand.json"), "part folders do not count");
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, FRESH);
  saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.equal(fs.existsSync(dead), false, "stale: its process is gone and nothing changed in it for long");
  assert.equal(fs.existsSync(beside), false, "stale, next to the kit's folder");
  assert.equal(fs.existsSync(fresh), true, "changed a moment ago");
  assert.equal(fs.existsSync(live), true, "its process runs");
  assert.equal(fs.existsSync(path.join(swapping, ".earlier", "brand.json")), true, "it holds an earlier kit");
});

test("the CLI says what a failed run leaves, on the error's own line, and --help says it too", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
  const failed = spawnSync(process.execPath, [CLI, "acme.example", "--out", dir], { encoding: "utf8", env });
  assert.equal(failed.status, 1);
  const said = `No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary. The kit already in ${dir} is as it was.`;
  assert.equal(failed.stderr, `easybrandkit: ${said}\n`);
  assert.deepEqual(filesOf(dir), before);
  const json = spawnSync(process.execPath, [CLI, "acme.example", "--out", dir, "--json"], { encoding: "utf8", env });
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, error: said });
  const fresh = spawnSync(process.execPath, [CLI, "acme.example", "--out", path.join(parent, "new", "acme")], { encoding: "utf8", env });
  assert.equal(fresh.status, 1);
  assert.equal(fresh.stderr, "easybrandkit: No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.\n");
  assert.deepEqual(fs.readdirSync(parent), ["kit"]);
  const file = spawnSync(process.execPath, [CLI, "acme.example", "--out", path.join(dir, "notes.txt")], { encoding: "utf8", env });
  assert.equal(file.status, 1);
  assert.equal(file.stderr, `easybrandkit: ${path.join(dir, "notes.txt")} is a file, not a folder. Pick a folder with --out.\n`);
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /\nThe new kit takes the place of an earlier one in the folder only once the\nrun has ended well\. A run that fails or is stopped leaves the folder as it\nwas, and a folder it would have made is not made\.\n/);
});
