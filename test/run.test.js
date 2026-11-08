"use strict";

// Where a run makes its files and how they take the place of an earlier
// kit, with no browser: the part folder, the move into place, the lock two
// runs take turns with, what a run that does not end well leaves, the part
// folders of runs killed outright, and what the CLI says.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { startRun, discardRun, discardRuns, saveRun, SaveError, STALE, LOCK } = require("../skills/easybrandkit/scripts/lib/run");
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

// A kit whose every file says which run made it.
const kitOf = (tag, logos) => ({
  "brand.json": JSON.stringify({ version: 1, tag, logos: logos.map((file) => ({ file })), card: { file: "card.png" } }),
  "BRAND.md": tag,
  "_brand.yml": tag,
  "card.png": tag,
  ...Object.fromEntries(logos.map((file) => [file, tag])),
});

const tempParent = (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-run-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
};

const earlierOf = (dir) => () => prepareDir(dir, { saving: true }) || [];

// The pid of a process that has ended, and a process that runs until the
// test ends.
const endedPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
function livePid(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  return child.pid;
}

test("a new folder: the part folder sits next to it and becomes it when the run ends well", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "new", "acme");
  const run = startRun(dir, prepareDir(dir));
  assert.equal(path.dirname(run.work), path.join(parent, "new"));
  assert.match(path.basename(run.work), /^\.easybrandkit-part-\d+-[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(dir), false, "nothing at the kit's folder while the run works");
  writeFiles(run.work, FRESH);
  await saveRun(run, earlierOf(dir));
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

test("ended well over an earlier kit: its files go, the new ones come, the user's files stay", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  // A file of the user's under a name the new kit writes is replaced.
  writeFiles(dir, { ...EARLIER, "screen-01.png": "mine" });
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new", "FACTS.md": "new", "pages/pricing.md": "new" });
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(dir), [
    `BRAND.md ${hash("new")}`, `FACTS.md ${hash("new")}`, `_brand.yml ${hash("new")}`, `brand.json ${hash(FRESH["brand.json"])}`, `card.png ${hash("new")}`,
    `logo-01.png ${hash("new")}`, `notes.txt ${hash("mine")}`, "pages/", `pages/mine.txt ${hash("mine")}`, `pages/pricing.md ${hash("new")}`, `screen-01.png ${hash("new")}`,
  ]);
  // A pages/ the earlier facts leave empty goes; one with the user's files stays.
  const again = startRun(dir, prepareDir(dir));
  writeFiles(again.work, FRESH);
  fs.rmSync(path.join(dir, "pages", "mine.txt"));
  await saveRun(again, earlierOf(dir));
  discardRun(again);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "notes.txt", "screen-01.png"]);
});

test("a move that cannot finish puts back what it moved, and its error says so once", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  // A folder of the user's under a name the new kit writes.
  fs.mkdirSync(path.join(dir, "screen-01.png"));
  const before = filesOf(dir);
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new" });
  await assert.rejects(
    saveRun(run, earlierOf(dir)),
    (err) => err instanceof SaveError && err.message === `The new kit could not be put in ${dir}: screen-01.png is a folder there, where the new kit has a file. The kit already there is as it was.`,
  );
  discardRun(run);
  assert.deepEqual(filesOf(dir), before);

});

test("an earlier file that cannot be put back stays where the error says, and nothing is put back over a file that took its place", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  fs.mkdirSync(path.join(dir, "screen-01.png"));
  const rename = fs.renameSync;
  // The earlier BRAND.md will not go back; the second time, the folder it
  // waits in will not move either.
  let folderMoves = true;
  const mock = t.mock.method(fs, "renameSync", function (from, to) {
    if (String(from).endsWith(`${path.sep}.earlier${path.sep}BRAND.md`) || (!folderMoves && String(from).endsWith(`${path.sep}.earlier`))) {
      throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: "EIO", syscall: "rename" });
    }
    return rename.call(this, from, to);
  });
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new" });
  let kept = "";
  await assert.rejects(saveRun(run, earlierOf(dir)), (err) => {
    kept = (/ Some files of the earlier kit could not be put back; they are in (.+)\.$/.exec(err.message) || [])[1];
    return err instanceof SaveError && err.message.startsWith(`The new kit could not be put in ${dir}: screen-01.png is a folder there, where the new kit has a file.`) && !err.message.includes("as it was");
  });
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
  await assert.rejects(saveRun(second, earlierOf(dir)), (err) => err.message.endsWith(` Some files of the earlier kit could not be put back; they are in ${aside}.`));
  discardRun(second);
  assert.equal(fs.readFileSync(path.join(aside, "BRAND.md"), "utf8"), "old");

  // A file that came where an earlier one was, while the moves were undone,
  // is not replaced: the earlier file waits in the kept folder instead.
  mock.mock.restore();
  const other = path.join(parent, "other");
  writeFiles(other, EARLIER);
  const third = startRun(other, prepareDir(other));
  writeFiles(third.work, FRESH);
  t.mock.method(fs, "renameSync", function (from, to) {
    if (from === path.join(third.work, "brand.json")) {
      fs.writeFileSync(path.join(other, "logo-02.png"), "theirs");
      throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: "EIO", syscall: "rename" });
    }
    return rename.call(this, from, to);
  });
  let keptThird = "";
  await assert.rejects(saveRun(third, earlierOf(other)), (err) => {
    keptThird = (/ they are in (.+)\.$/.exec(err.message) || [])[1];
    return err.message.startsWith(`The new kit could not be put in ${other}: EIO: i/o error`) && err.message.includes(" Some files of the earlier kit could not be put back;");
  });
  discardRun(third);
  assert.equal(fs.readFileSync(path.join(other, "logo-02.png"), "utf8"), "theirs");
  assert.equal(fs.readFileSync(path.join(keptThird, "logo-02.png"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(other, "brand.json"), "utf8"), EARLIER["brand.json"], "the rest is back");

  // A file that comes where the earlier BRAND.md was, once that has gone
  // aside, is not moved over it either: the moves stop and are undone, and
  // both files stay.
  const fourthDir = path.join(parent, "fourth");
  writeFiles(fourthDir, EARLIER);
  const fourth = startRun(fourthDir, prepareDir(fourthDir));
  writeFiles(fourth.work, FRESH);
  t.mock.method(fs, "renameSync", function (from, to) {
    rename.call(this, from, to);
    if (from === path.join(fourthDir, "BRAND.md")) fs.writeFileSync(path.join(fourthDir, "BRAND.md"), "theirs");
  });
  let keptFourth = "";
  await assert.rejects(saveRun(fourth, earlierOf(fourthDir)), (err) => {
    keptFourth = (/ they are in (.+)\.$/.exec(err.message) || [])[1];
    return err.message.startsWith(`The new kit could not be put in ${fourthDir}: BRAND.md came there while the new kit was put in. Some files of the earlier kit could not be put back;`);
  });
  discardRun(fourth);
  assert.equal(fs.readFileSync(path.join(fourthDir, "BRAND.md"), "utf8"), "theirs");
  assert.equal(fs.readFileSync(path.join(keptFourth, "BRAND.md"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(fourthDir, "brand.json"), "utf8"), EARLIER["brand.json"], "the rest is back");
});

test("a folder made while the run worked: a kit there is read again and replaced, other files are refused", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "acme");
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, FRESH);
  // Another run saves a kit there meanwhile, with a logo this one does not have.
  const other = { version: 1, logos: [{ file: "logo-01.png" }, { file: "logo-02.png" }] };
  writeFiles(dir, { "brand.json": JSON.stringify(other), "BRAND.md": "other", "_brand.yml": "other", "logo-01.png": "other", "logo-02.png": "other", "notes.txt": "mine" });
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(dir), [
    `BRAND.md ${hash("new")}`, `_brand.yml ${hash("new")}`, `brand.json ${hash(FRESH["brand.json"])}`, `card.png ${hash("new")}`, `logo-01.png ${hash("new")}`, `notes.txt ${hash("mine")}`,
  ]);
  const elsewhere = path.join(parent, "other");
  const second = startRun(elsewhere, prepareDir(elsewhere));
  writeFiles(second.work, FRESH);
  writeFiles(elsewhere, { "notes.txt": "mine" });
  await assert.rejects(saveRun(second, earlierOf(elsewhere)), (err) => err instanceof SaveError && /other is not empty and holds no earlier brand kit/.test(err.message));
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
  await saveRun(third, earlierOf(late));
  discardRun(third);
  assert.deepEqual(fs.readdirSync(late).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "notes.txt"]);
  assert.deepEqual(fs.readdirSync(parent).sort(), ["acme", "late", "other"]);
});

test("two runs that put their kits in one folder at the same moment take turns", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, { ...kitOf("earlier", ["logo-01.png", "logo-02.png"]), "notes.txt": "mine" });
  const a = startRun(dir, prepareDir(dir));
  const b = startRun(dir, prepareDir(dir));
  writeFiles(a.work, kitOf("A", ["logo-01.png", "logo-02.png", "logo-03.png"]));
  writeFiles(b.work, kitOf("B", ["logo-01.png"]));
  // B starts to save in the middle of A's moves, right after A has moved
  // the earlier brand.json aside. A run starting then finds a kit there, not
  // a folder to refuse. After every move, a brand.json in the folder goes
  // with the files next to it.
  const rename = fs.renameSync;
  let second = null;
  let seen = null;
  const mixed = [];
  t.mock.method(fs, "renameSync", function (from, to) {
    rename.call(this, from, to);
    if (fs.existsSync(path.join(dir, "brand.json"))) {
      const { tag, logos } = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"));
      const listed = ["BRAND.md", "_brand.yml", "card.png", ...logos.map((logo) => logo.file)];
      for (const name of listed) if (!fs.existsSync(path.join(dir, name))) mixed.push(`${name} missing beside the brand.json of ${tag}`);
      for (const name of fs.readdirSync(dir)) {
        if (/\.(md|yml|png)$/.test(name) && fs.readFileSync(path.join(dir, name), "utf8") !== tag) mixed.push(`${name} beside the brand.json of ${tag}`);
      }
    }
    if (!second && String(to).endsWith(`${path.sep}.earlier${path.sep}brand.json`)) {
      try {
        seen = prepareDir(dir);
      } catch (err) {
        seen = err;
      }
      second = saveRun(b, earlierOf(dir));
    }
  });
  await saveRun(a, earlierOf(dir));
  await second;
  discardRun(a);
  discardRun(b);
  assert.ok(Array.isArray(seen) && seen.includes("brand.json"), String(seen));
  assert.deepEqual(mixed, []);
  // B's kit, whole, after A's: nothing of A's or of the earlier kit is left.
  assert.deepEqual(filesOf(dir), [`BRAND.md ${hash("B")}`, `_brand.yml ${hash("B")}`, `brand.json ${hash(kitOf("B", ["logo-01.png"])["brand.json"])}`, `card.png ${hash("B")}`, `logo-01.png ${hash("B")}`, `notes.txt ${hash("mine")}`]);
});

test("a lock that a run killed outright left is taken over, and a live one is waited for", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const lock = path.join(dir, LOCK);
  const lockOf = (pid, token = "0a1b2c3d") => JSON.stringify({ pid, host: os.hostname(), token });
  // A run killed in the middle of its moves, with brand.json aside: the
  // folder is refused, as its earlier kit is not whole.
  fs.renameSync(path.join(dir, "brand.json"), path.join(parent, "brand.json"));
  fs.writeFileSync(lock, lockOf(endedPid()));
  assert.throws(() => prepareDir(dir), /kit is not empty and holds no earlier brand kit/);
  // While a run that is alive holds the lock, the same folder is a kit
  // being put in place, and its names are read again when the run saves.
  fs.writeFileSync(lock, lockOf(livePid(t)));
  assert.ok(prepareDir(dir).includes("brand.json"));
  fs.renameSync(path.join(parent, "brand.json"), path.join(dir, "brand.json"));
  // The live lock is waited for until it goes.
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, kitOf("new", ["logo-01.png"]));
  const started = Date.now();
  setTimeout(() => fs.unlinkSync(lock), 400);
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.ok(Date.now() - started >= 350, `waited ${Date.now() - started} ms`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")).tag, "new");
  // A lock whose process has ended is taken over, and so is one with this
  // process's pid that no run of this process holds.
  for (const pid of [endedPid(), process.pid]) {
    fs.writeFileSync(lock, lockOf(pid));
    const next = startRun(dir, prepareDir(dir));
    writeFiles(next.work, kitOf(`after ${pid}`, ["logo-01.png"]));
    await saveRun(next, earlierOf(dir));
    discardRun(next);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")).tag, `after ${pid}`);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".")), [], "no lock is left");
  }
});

test("a run stopped while it waits for the lock is not saved, and the wait gives the process back", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const before = filesOf(dir);
  // A lock that a run that is alive holds.
  fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({ pid: livePid(t), host: os.hostname(), token: "0a1b2c3d" }));
  const run = startRun(dir, prepareDir(dir));
  writeFiles(run.work, kitOf("new", ["logo-01.png"]));
  const started = Date.now();
  const saving = saveRun(run, earlierOf(dir));
  assert.ok(Date.now() - started < 1_000, `saveRun held the process for ${Date.now() - started} ms`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  // What a stop does first, then the lock goes.
  assert.deepEqual(discardRuns(), [{ dir, earlier: true }]);
  fs.unlinkSync(path.join(dir, LOCK));
  await assert.rejects(saving, (err) => err instanceof SaveError);
  assert.deepEqual(filesOf(dir), before);
});

test("the part folder of a run killed outright: left alone while it may be at work, removed once stale", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  // A process that has ended, and one that runs.
  const gone = endedPid();
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
  await saveRun(run, earlierOf(dir));
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
  const cli = (...args) => spawnSync(process.execPath, [CLI, "acme.example", ...args], { encoding: "utf8", env });
  const failed = cli("--out", dir);
  assert.equal(failed.status, 1);
  const said = `No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary. The kit already in ${dir} is as it was.`;
  assert.equal(failed.stderr, `easybrandkit: ${said}\n`);
  assert.deepEqual(filesOf(dir), before);
  const json = cli("--out", dir, "--json");
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, error: said });
  const fresh = cli("--out", path.join(parent, "new", "acme"));
  assert.equal(fresh.status, 1);
  assert.equal(fresh.stderr, "easybrandkit: No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.\n");
  assert.deepEqual(fs.readdirSync(parent), ["kit"]);
  const file = cli("--out", path.join(dir, "notes.txt"));
  assert.equal(file.status, 1);
  assert.equal(file.stderr, `easybrandkit: ${path.join(dir, "notes.txt")} is a file, not a folder. Pick a folder with --out.\n`);
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /\nThe new kit takes the place of an earlier one in the folder only once the\nrun has ended well\. A run that fails or is stopped leaves the folder as it\nwas, and a folder it would have made is not made\.\n/);
});
