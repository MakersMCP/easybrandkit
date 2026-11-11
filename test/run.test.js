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
const { startRun, discardRun, discardRuns, saveRun, toldPlainly, SaveError, STALE, LOCK, LOCK_STALE } = require("../skills/easybrandkit/scripts/lib/run");
const { checkDir } = require("../skills/easybrandkit/scripts/lib/folder");

const CLI = path.resolve(__dirname, "../skills/easybrandkit/scripts/easybrandkit.js");

const hash = (body) => crypto.createHash("sha1").update(body).digest("hex").slice(0, 8);

// Every file, folder and link in dir, hidden ones too, each file with a hash.
function filesOf(dir) {
  const found = [];
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        found.push(`${name} -> ${fs.readlinkSync(path.join(at, entry.name))}`);
      } else if (entry.isDirectory()) {
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

const earlierOf = (dir) => () => checkDir(dir, { saving: true }) || [];

// The pid of a process that has ended, and a process that runs until the
// test ends.
const endedPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
function livePid(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  return child.pid;
}

const posixOnly = process.platform === "win32" && "POSIX modes and signals";

test("a new folder: the part folder sits next to it and becomes it when the run ends well", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "new", "acme");
  const run = startRun(dir, checkDir(dir));
  assert.equal(path.dirname(run.work), path.join(parent, "new"));
  assert.match(path.basename(run.work), /^\.easybrandkit-part-\d+-[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(dir), false, "nothing at the kit's folder while the run works");
  writeFiles(run.work, FRESH);
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(fs.readdirSync(path.join(parent, "new")), ["acme"]);
  assert.deepEqual(filesOf(dir).map((line) => line.split(" ")[0]), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png"]);
});

test("a part folder gets the mode any folder made there gets, so a default ACL is not masked", { skip: posixOnly }, async (t) => {
  const parent = tempParent(t);
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const mode = (at) => fs.statSync(at).mode & 0o7777;
  fs.mkdirSync(path.join(parent, "plain"));
  const want = mode(path.join(parent, "plain"));
  assert.equal(want, 0o755);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const inside = startRun(dir, checkDir(dir));
  assert.equal(mode(inside.work), want, "inside a kit's folder that is there");
  discardRun(inside);
  const fresh = path.join(parent, "fresh");
  const run = startRun(fresh, checkDir(fresh));
  assert.equal(mode(run.work), want, "next to the folder a run makes");
  writeFiles(run.work, FRESH);
  await saveRun(run, earlierOf(fresh));
  assert.equal(mode(fresh), want, "the kit's folder it becomes");
});

test("a disk that fills up while a run makes the folders above its kit leaves none of them", (t) => {
  const parent = tempParent(t);
  const out = path.join(parent, "a", "b", "c", "kit");
  const mkdir = fs.mkdirSync;
  let theirs = false;
  const failing = t.mock.method(fs, "mkdirSync", function (at, options) {
    if (!options || !options.recursive || at !== path.dirname(out)) return mkdir.call(this, at, options);
    // Made one level at a time, the kernel refuses the last one.
    mkdir(path.join(parent, "a", "b"), { recursive: true });
    if (theirs) fs.writeFileSync(path.join(parent, "a", "b", "theirs.txt"), "theirs");
    throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${at}'`), { code: "ENOSPC", syscall: "mkdir", path: at });
  });
  const said = `The disk that holds ${parent} is full (ENOSPC), so ${out} cannot be made there. Pick a folder you can write in with --out.`;
  assert.throws(() => startRun(out, checkDir(out)), (err) => err.message === said);
  assert.deepEqual(fs.readdirSync(parent), []);
  // A folder that something else has put a file in stays.
  theirs = true;
  assert.throws(() => startRun(out, checkDir(out)));
  failing.mock.restore();
  assert.deepEqual(filesOf(parent), ["a/", "a/b/", `a/b/theirs.txt ${hash("theirs")}`]);
});

test("the earlier kit goes as .replaced, so a part folder that could not be removed is no earlier kit left in pieces", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, FRESH);
  // A file in it is held open, as can happen on Windows.
  const rm = fs.rmSync;
  const held = t.mock.method(fs, "rmSync", function (at, ...rest) {
    if (at === run.work) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return rm.call(this, at, ...rest);
  });
  await saveRun(run, earlierOf(dir));
  held.mock.restore();
  discardRun(run);
  assert.deepEqual(fs.readdirSync(run.work).sort(), [".coming", ".replaced"]);
  // Once its process has gone and it is old, the next run removes it.
  const left = path.join(dir, `.easybrandkit-part-${endedPid()}-0a1b2c3d`);
  fs.renameSync(run.work, left);
  const old = new Date(Date.now() - STALE - 60_000);
  const age = (at, depth) => {
    if (depth > 0 && fs.lstatSync(at).isDirectory()) for (const name of fs.readdirSync(at)) age(path.join(at, name), depth - 1);
    fs.lutimesSync(at, old, old);
  };
  age(left, 3);
  const next = startRun(dir, checkDir(dir));
  writeFiles(next.work, FRESH);
  await saveRun(next, earlierOf(dir));
  discardRun(next);
  assert.equal(fs.existsSync(left), false);
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
  const second = startRun(dir, checkDir(dir));
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
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new", "FACTS.md": "new", "pages/pricing.md": "new" });
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(dir), [
    `BRAND.md ${hash("new")}`, `FACTS.md ${hash("new")}`, `_brand.yml ${hash("new")}`, `brand.json ${hash(FRESH["brand.json"])}`, `card.png ${hash("new")}`,
    `logo-01.png ${hash("new")}`, `notes.txt ${hash("mine")}`, "pages/", `pages/mine.txt ${hash("mine")}`, `pages/pricing.md ${hash("new")}`, `screen-01.png ${hash("new")}`,
  ]);
  // A pages/ the earlier facts leave empty goes; one with the user's files stays.
  const again = startRun(dir, checkDir(dir));
  writeFiles(again.work, FRESH);
  fs.rmSync(path.join(dir, "pages", "mine.txt"));
  await saveRun(again, earlierOf(dir));
  discardRun(again);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "notes.txt", "screen-01.png"]);
});

test("a move that cannot finish puts back what it moved, and its error says why once", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  // A folder of the user's under a name the new kit writes.
  fs.mkdirSync(path.join(dir, "screen-01.png"));
  const before = filesOf(dir);
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, { ...FRESH, "screen-01.png": "new" });
  await assert.rejects(
    saveRun(run, earlierOf(dir)),
    (err) => err instanceof SaveError && err.message === `The new kit could not be put in ${dir}: screen-01.png is a folder there, where the new kit has a file. The kit already there is as it was.`,
  );
  discardRun(run);
  assert.deepEqual(filesOf(dir), before);

  // A file the system will not let go of. Only Windows refuses to move a file
  // that another program holds open, so only there is that the reason given.
  fs.rmdirSync(path.join(dir, "screen-01.png"));
  const kept = filesOf(dir);
  const second = startRun(dir, checkDir(dir));
  writeFiles(second.work, FRESH);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (from, to) {
    if (from === path.join(second.work, "card.png")) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM", syscall: "rename" });
    }
    return rename.call(this, from, to);
  });
  const reason = process.platform === "win32" ? "a file there is open in another program, or may not be moved (EPERM)" : "a file there may not be moved, or the folder may not be changed (EPERM)";
  await assert.rejects(saveRun(second, earlierOf(dir)), (err) => err.message === `The new kit could not be put in ${dir}: ${reason}. The kit already there is as it was.`);
  discardRun(second);
  assert.deepEqual(filesOf(dir), kept);
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
  const run = startRun(dir, checkDir(dir));
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
  const second = startRun(dir, checkDir(dir));
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
  const third = startRun(other, checkDir(other));
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
    return err.message.startsWith(`The new kit could not be put in ${other}: brand.json could not be moved (EIO). Some files of the earlier kit could not be put back;`);
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
  const fourth = startRun(fourthDir, checkDir(fourthDir));
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

  // The folder is named as the user gave the kit's folder: given as "."
  // from inside it, from there.
  t.mock.restoreAll();
  t.mock.method(fs, "renameSync", function (from, to) {
    if (String(from).endsWith(`${path.sep}.earlier${path.sep}BRAND.md`)) {
      throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: "EIO", syscall: "rename" });
    }
    return rename.call(this, from, to);
  });
  const fifthDir = path.join(parent, "fifth");
  writeFiles(fifthDir, EARLIER);
  fs.mkdirSync(path.join(fifthDir, "screen-01.png"));
  const cwd = process.cwd();
  process.chdir(fifthDir);
  try {
    const fifth = startRun(".", checkDir("."));
    writeFiles(fifth.work, { ...FRESH, "screen-01.png": "new" });
    let keptFifth = "";
    await assert.rejects(saveRun(fifth, earlierOf(".")), (err) => {
      keptFifth = (/ they are in (.+)\.$/.exec(err.message) || [])[1];
      return err.message.startsWith("The new kit could not be put in .: screen-01.png is a folder there, where the new kit has a file. Some files of the earlier kit could not be put back;");
    });
    discardRun(fifth);
    assert.match(keptFifth, /^easybrandkit-kept-\d+-[0-9a-f]{8}$/);
    assert.equal(fs.readFileSync(path.join(keptFifth, "BRAND.md"), "utf8"), "old", "the folder the error names, from where the run was");
  } finally {
    process.chdir(cwd);
  }
});

test("a folder made while the run worked: a kit there is read again and replaced, other files are refused", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "acme");
  const run = startRun(dir, checkDir(dir));
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
  const second = startRun(elsewhere, checkDir(elsewhere));
  writeFiles(second.work, FRESH);
  writeFiles(elsewhere, { "notes.txt": "mine" });
  await assert.rejects(saveRun(second, earlierOf(elsewhere)), (err) => err instanceof SaveError && /other is not empty and holds no earlier brand kit/.test(err.message));
  discardRun(second);
  assert.deepEqual(filesOf(elsewhere), [`notes.txt ${hash("mine")}`]);
  // Made between the look and the move, which then finds it there (EPERM on
  // Windows, ENOTEMPTY elsewhere).
  const late = path.join(parent, "late");
  const third = startRun(late, checkDir(late));
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
  // An empty folder made there meanwhile, by hand, and a move into it that
  // fails: the run removes its part folder and the folder it made above, but
  // not the one it did not make.
  t.mock.restoreAll();
  const byHand = path.join(parent, "new", "hand");
  const fourth = startRun(byHand, checkDir(byHand));
  writeFiles(fourth.work, FRESH);
  fs.mkdirSync(byHand);
  t.mock.method(fs, "renameSync", function (from, to) {
    if (path.basename(String(from)) === "brand.json") throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: "EIO", syscall: "rename" });
    return rename.call(this, from, to);
  });
  await assert.rejects(saveRun(fourth, earlierOf(byHand)), (err) => err.message === `The new kit could not be put in ${byHand}: brand.json could not be moved (EIO). Nothing there was changed.`);
  discardRun(fourth);
  assert.deepEqual(filesOf(path.join(parent, "new")), ["hand/"]);
});

test("two runs that put their kits in one folder at the same moment take turns", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, { ...kitOf("earlier", ["logo-01.png", "logo-02.png"]), "notes.txt": "mine" });
  const a = startRun(dir, checkDir(dir));
  const b = startRun(dir, checkDir(dir));
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
        seen = checkDir(dir);
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
  assert.throws(() => checkDir(dir), /kit is not empty and holds no earlier brand kit/);
  // While a run that is alive holds the lock, the same folder is a kit
  // being put in place, and its names are read again when the run saves.
  fs.writeFileSync(lock, lockOf(livePid(t)));
  assert.ok(checkDir(dir).includes("brand.json"));
  fs.renameSync(path.join(parent, "brand.json"), path.join(dir, "brand.json"));
  // The live lock is waited for until it goes.
  const run = startRun(dir, checkDir(dir));
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
    const next = startRun(dir, checkDir(dir));
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
  const run = startRun(dir, checkDir(dir));
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

test("of two runs that find a lock left by a run that has ended, one removes it and the other takes its turn", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const lock = path.join(dir, LOCK);
  fs.writeFileSync(lock, JSON.stringify({ pid: endedPid(), host: os.hostname(), token: "0a1b2c3d" }));
  const a = startRun(dir, checkDir(dir));
  const b = startRun(dir, checkDir(dir));
  writeFiles(a.work, kitOf("A", ["logo-01.png"]));
  writeFiles(b.work, kitOf("B", ["logo-01.png"]));
  const unlink = fs.unlinkSync;
  let second = null;
  t.mock.method(fs, "unlinkSync", function (at, ...rest) {
    // A has read the lock again and is about to remove it: B looks at it now.
    if (at === lock && !second) second = saveRun(b, earlierOf(dir));
    return unlink.call(this, at, ...rest);
  });
  await saveRun(a, earlierOf(dir));
  await second;
  discardRun(a);
  discardRun(b);
  // B waited first and went first; A's kit, put in after it, is the one left, whole.
  assert.deepEqual(filesOf(dir), [`BRAND.md ${hash("A")}`, `_brand.yml ${hash("A")}`, `brand.json ${hash(kitOf("A", ["logo-01.png"])["brand.json"])}`, `card.png ${hash("A")}`, `logo-01.png ${hash("A")}`]);
});

test("a lock taken since a run found the one left by a run that has ended is not removed, and is waited for", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const lock = path.join(dir, LOCK);
  fs.writeFileSync(lock, JSON.stringify({ pid: endedPid(), host: os.hostname(), token: "0a1b2c3d" }));
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, kitOf("new", ["logo-01.png"]));
  // Another run has taken the lock since this one read it, as this one makes
  // the marker it takes over with.
  const theirs = JSON.stringify({ pid: livePid(t), host: os.hostname(), token: "c0ffee00" });
  const open = fs.openSync;
  let changed = false;
  t.mock.method(fs, "openSync", function (at, ...rest) {
    const fd = open.call(this, at, ...rest);
    if (!changed && String(at).endsWith("-takeover")) {
      changed = true;
      fs.writeFileSync(lock, theirs);
    }
    return fd;
  });
  const saving = saveRun(run, earlierOf(dir));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(changed, true, "the marker was made");
  assert.equal(fs.existsSync(lock) && fs.readFileSync(lock, "utf8"), theirs, "the other run's lock is still there");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")).tag, "earlier", "the run waits for it");
  fs.unlinkSync(lock);
  await saving;
  discardRun(run);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")).tag, "new");
});

test("a folder read between two other runs' saves is not taken for one a killed run left in pieces", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("seed", ["logo-01.png"]));
  // The part folder of a run at work, with the earlier kit's brand.json aside.
  writeFiles(path.join(dir, `.easybrandkit-part-${livePid(t)}-0a1b2c3d`), { ".earlier/brand.json": kitOf("earlier", ["logo-01.png"])["brand.json"] });
  const brand = path.join(dir, "brand.json");
  const lock = path.join(dir, LOCK);
  const live = JSON.stringify({ pid: livePid(t), host: os.hostname(), token: "c0ffee00" });
  const read = fs.readFileSync;
  const reading = (answer) => {
    let reads = 0;
    return t.mock.method(fs, "readFileSync", function (file, ...rest) {
      if (file === brand && answer(++reads)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", syscall: "open", path: file });
      return read.call(this, file, ...rest);
    });
  };
  // Away on the first read, and back on the next: that run has finished.
  let mock = reading((reads) => reads === 1);
  assert.ok(checkDir(dir).includes("logo-01.png"));
  mock.mock.restore();
  // A lock comes as brand.json is found away, on any of the reads: a run is
  // at work, and this run reads the folder again when it saves.
  for (const nth of [1, 2, 3]) {
    mock = reading((reads) => {
      if (reads === nth) fs.writeFileSync(lock, live);
      return true;
    });
    const names = checkDir(dir);
    mock.mock.restore();
    fs.unlinkSync(lock);
    assert.ok(names.includes("brand.json"), `read ${nth}`);
    assert.equal(names.includes("logo-01.png"), false, `read ${nth}: told without reading a brand.json`);
  }
  // With no lock around any read, the folder is one a killed run left.
  mock = reading(() => true);
  assert.throws(() => checkDir(dir), /holds no brand\.json: a run that did not finish putting its kit in place/);
  mock.mock.restore();
});

test("a run lets go of its own lock only: one that took its place stays", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const lock = path.join(dir, LOCK);
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, kitOf("new", ["logo-01.png"]));
  // Another run's lock comes in its place as the last file moves in.
  const theirs = JSON.stringify({ pid: livePid(t), host: os.hostname(), token: "c0ffee00" });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (from, to) {
    rename.call(this, from, to);
    if (to === path.join(dir, "brand.json")) fs.writeFileSync(lock, theirs);
  });
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.equal(fs.readFileSync(lock, "utf8"), theirs);
});

test("a lock is live while its process runs or, from another machine, for two minutes", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const lock = path.join(dir, LOCK);
  // brand.json is aside, as while a run puts its kit in: under a live lock
  // the folder is a kit, under one a run that has ended left it is refused.
  fs.renameSync(path.join(dir, "brand.json"), path.join(parent, "brand.json"));
  const aged = (ms) => {
    const at = new Date(Date.now() - ms);
    fs.utimesSync(lock, at, at);
  };
  const pid = livePid(t);
  for (const [holder, which] of [[{ pid: 4242, host: "another-machine.example" }, "another machine's"], [{ pid, host: os.hostname() }, "a running process's"]]) {
    fs.writeFileSync(lock, JSON.stringify({ ...holder, token: "0a1b2c3d" }));
    aged(60_000);
    assert.ok(checkDir(dir).includes("brand.json"), `${which} lock, a minute old`);
    aged(LOCK_STALE + 60_000);
    assert.throws(() => checkDir(dir), /kit is not empty and holds no earlier brand kit/, `${which} lock, older than two minutes`);
  }
});

test("a lock left by a run that has ended that cannot be removed ends the wait at once, and its error names it", { skip: posixOnly || (process.getuid && process.getuid() === 0 && "root may write anywhere") }, async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  const lock = path.join(dir, LOCK);
  const old = new Date(Date.now() - 10 * 60_000);
  // A lock that is a folder, and a lock in a kit's folder that has become
  // read-only since the run started.
  for (const [how, code] of [["a folder", /EISDIR|EPERM/], ["read-only", /EACCES/]]) {
    fs.rmSync(dir, { recursive: true, force: true });
    writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
    if (how === "a folder") fs.mkdirSync(lock);
    else fs.writeFileSync(lock, JSON.stringify({ pid: endedPid(), host: os.hostname(), token: "0a1b2c3d" }));
    fs.utimesSync(lock, old, old);
    const before = filesOf(dir);
    const run = startRun(dir, checkDir(dir));
    writeFiles(run.work, kitOf("new", ["logo-01.png"]));
    if (how === "read-only") fs.chmodSync(dir, 0o555);
    const started = Date.now();
    let timer;
    // On the code before, the wait went on for good.
    const guard = new Promise((resolve) => (timer = setTimeout(() => resolve(new Error(`still waiting after ${Date.now() - started} ms`)), 15_000)));
    let outcome;
    try {
      outcome = await Promise.race([saveRun(run, earlierOf(dir)).then(() => new Error("saved"), (err) => err), guard]);
    } finally {
      clearTimeout(timer);
      fs.chmodSync(dir, 0o755);
      discardRun(run);
    }
    assert.ok(outcome instanceof SaveError, `${how}: ${outcome.message}`);
    const said = /^The new kit was not put in (.+): (.+) is a lock left by a run that has ended, and it could not be removed \((\w+)\)\. Remove it and run again\. The kit already there is as it was\.$/.exec(outcome.message);
    assert.ok(said && said[1] === dir && said[2] === lock && code.test(said[3]), `${how}: ${outcome.message}`);
    assert.ok(Date.now() - started < 2_000, `${how}: refused after ${Date.now() - started} ms`);
    assert.deepEqual(filesOf(dir), before, how);
  }
});

test("a pages that is a link is never read or written through", async (t) => {
  const parent = tempParent(t);
  const mine = path.join(parent, "site-content", "pages");
  writeFiles(mine, { "home.md": "mine", "about.md": "mine", "blog.md": "mine" });
  const dir = path.join(parent, "kit");
  writeFiles(dir, { "brand.json": JSON.stringify({ version: 1 }), "BRAND.md": "old", "FACTS.md": "old", "facts.json": "old" });
  fs.symlinkSync(mine, path.join(dir, "pages"), "junction");
  const theirs = filesOf(mine);
  // A run without --facts: the earlier kit's facts go, the files behind the
  // link stay, and so does the link.
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, FRESH);
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(mine), theirs);
  assert.equal(fs.lstatSync(path.join(dir, "pages")).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["BRAND.md", "_brand.yml", "brand.json", "card.png", "logo-01.png", "pages"]);
  // With --facts the folder is refused before the site is read, and a kit
  // with page texts is not put in through the link.
  assert.throws(
    () => checkDir(dir, { facts: true }),
    (err) => err.message === `${path.join(dir, "pages")} is a link, and --facts saves the text of each page it reads in a folder by that name. Move it away, or pick another folder with --out.` && err.earlierKit === dir,
  );
  const before = filesOf(dir);
  const second = startRun(dir, checkDir(dir));
  writeFiles(second.work, { ...FRESH, "FACTS.md": "new", "pages/home.md": "page text" });
  await assert.rejects(saveRun(second, earlierOf(dir)), (err) => err.message === `The new kit could not be put in ${dir}: pages there is a link, where the new kit has a folder of page texts. The kit already there is as it was.`);
  discardRun(second);
  assert.deepEqual(filesOf(dir), before);
  assert.deepEqual(filesOf(mine), theirs);
});

test("a file named pages is the user's: a run without --facts keeps it, and one with --facts is refused before it reads the site", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, { ...Object.fromEntries(Object.entries(EARLIER).filter(([name]) => !name.startsWith("pages/"))), pages: "mine" });
  // The earlier kit's names hold pages/home.md and the other page texts,
  // which are looked for below a file.
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, FRESH);
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.deepEqual(filesOf(dir), [
    `BRAND.md ${hash("new")}`, `_brand.yml ${hash("new")}`, `brand.json ${hash(FRESH["brand.json"])}`, `card.png ${hash("new")}`, `logo-01.png ${hash("new")}`, `notes.txt ${hash("mine")}`, `pages ${hash("mine")}`,
  ]);
  assert.throws(
    () => checkDir(dir, { facts: true }),
    (err) => err.message === `${path.join(dir, "pages")} is a file, and --facts saves the text of each page it reads in a folder by that name. Move it away, or pick another folder with --out.` && err.earlierKit === dir,
  );
  // One that came there while the site was read stops the move, and the
  // kit there stays as it was.
  const before = filesOf(dir);
  const second = startRun(dir, checkDir(dir));
  writeFiles(second.work, { ...FRESH, "FACTS.md": "new", "pages/home.md": "page text" });
  await assert.rejects(saveRun(second, earlierOf(dir)), (err) => err.message === `The new kit could not be put in ${dir}: pages there is a file, where the new kit has a folder of page texts. The kit already there is as it was.`);
  discardRun(second);
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
  assert.ok(checkDir(dir).includes("brand.json"), "part folders do not count");
  const run = startRun(dir, checkDir(dir));
  writeFiles(run.work, FRESH);
  await saveRun(run, earlierOf(dir));
  discardRun(run);
  assert.equal(fs.existsSync(dead), false, "stale: its process is gone and nothing changed in it for long");
  assert.equal(fs.existsSync(beside), false, "stale, next to the kit's folder");
  assert.equal(fs.existsSync(fresh), true, "changed a moment ago");
  assert.equal(fs.existsSync(live), true, "its process runs");
  assert.equal(fs.existsSync(path.join(swapping, ".earlier", "brand.json")), true, "it holds an earlier kit");

  // Next to a folder that a run makes, once its part folder has become it.
  const elsewhere = path.join(parent, "elsewhere");
  const besideNew = path.join(elsewhere, `.easybrandkit-part-${gone}-0a1b2c42`);
  writeFiles(besideNew, { "logo-01.png": "half" });
  for (const file of ["logo-01.png", ""]) fs.utimesSync(path.join(besideNew, file), old, old);
  const made = startRun(path.join(elsewhere, "acme"), checkDir(path.join(elsewhere, "acme")));
  writeFiles(made.work, FRESH);
  await saveRun(made, earlierOf(path.join(elsewhere, "acme")));
  discardRun(made);
  assert.deepEqual(fs.readdirSync(elsewhere), ["acme"], "stale, next to a folder a run made");
});

test("a folder that a run killed while its files moved left without brand.json is refused with where the earlier kit's brand.json is", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  // As kill -9 at the third move leaves it: the earlier brand.json,
  // _brand.yml and BRAND.md aside in the part folder's .earlier, the new
  // kit still in the part folder, and the lock.
  const gone = endedPid();
  const part = path.join(dir, `.easybrandkit-part-${gone}-0a1b2c3d`);
  const aside = path.join(part, ".earlier");
  writeFiles(part, FRESH);
  fs.mkdirSync(path.join(aside, "pages"), { recursive: true });
  for (const name of ["brand.json", "_brand.yml", "BRAND.md"]) fs.renameSync(path.join(dir, name), path.join(aside, name));
  fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({ pid: gone, host: os.hostname(), token: "0a1b2c3d" }));
  const before = filesOf(dir);
  const said = (shown, at, pages = false) =>
    `${shown} holds no brand.json: a run that did not finish putting its kit in place left the earlier kit's brand.json in ${at}, with the files it had moved aside. ${pages ? `Move the files in ${path.join(at, "pages")} back into ${path.join(shown, "pages")}, and the other files in ${at} back into ${shown}` : `Move them back into ${shown}`}, replacing any files of the same name there, which are that run's, and run again.`;
  assert.throws(() => checkDir(dir), (err) => err.message === said(dir, aside));
  // Named from where the run is, when the folder was given so.
  const cwd = process.cwd();
  process.chdir(parent);
  try {
    assert.throws(() => checkDir("kit"), (err) => err.message === said("kit", path.join("kit", path.basename(part), ".earlier")));
  } finally {
    process.chdir(cwd);
  }
  // The CLI says so before it starts a browser, and changes nothing.
  const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
  const cli = spawnSync(process.execPath, [CLI, "acme.example", "--out", dir], { encoding: "utf8", env });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, `easybrandkit: ${said(dir, aside)}\n`);
  assert.deepEqual(filesOf(dir), before);
  // Moved back, they make the folder a kit again.
  for (const name of ["brand.json", "_brand.yml", "BRAND.md"]) fs.renameSync(path.join(aside, name), path.join(dir, name));
  assert.ok(checkDir(dir).includes("brand.json"));

  // Killed once every file of the earlier kit had gone aside, before the
  // first of its own came in: the folder holds nothing but the part folder
  // and the lock, and is refused all the same.
  const bare = path.join(parent, "bare");
  const barePart = path.join(bare, `.easybrandkit-part-${gone}-0a1b2c3d`);
  const kitOnly = Object.fromEntries(Object.entries(EARLIER).filter(([name]) => name !== "notes.txt" && name !== "pages/mine.txt"));
  writeFiles(path.join(barePart, ".earlier"), kitOnly);
  writeFiles(barePart, FRESH);
  fs.writeFileSync(path.join(bare, LOCK), JSON.stringify({ pid: gone, host: os.hostname(), token: "0a1b2c3d" }));
  const bareBefore = filesOf(bare);
  // Its page text, aside in .earlier/pages, goes back into the kit's pages.
  assert.throws(() => checkDir(bare), (err) => err.message === said(bare, path.join(barePart, ".earlier"), true));
  const bareCli = spawnSync(process.execPath, [CLI, "acme.example", "--out", bare], { encoding: "utf8", env });
  assert.equal(bareCli.status, 1);
  assert.equal(bareCli.stderr, `easybrandkit: ${said(bare, path.join(barePart, ".earlier"), true)}\n`);
  assert.deepEqual(filesOf(bare), bareBefore);
  // While a run that is alive holds the lock, that is a kit being put in.
  fs.writeFileSync(path.join(bare, LOCK), JSON.stringify({ pid: livePid(t), host: os.hostname(), token: "0a1b2c3d" }));
  assert.ok(checkDir(bare).includes("brand.json"));
  // A folder that holds a part folder without an earlier kit is empty.
  fs.rmSync(path.join(bare, LOCK));
  fs.rmSync(path.join(barePart, ".earlier"), { recursive: true });
  assert.equal(checkDir(bare), null);

  // The folder a move that could not be undone named in its error.
  const kept = path.join(parent, "kept");
  const keptFolder = path.join(kept, `easybrandkit-kept-${gone}-0a1b2c3d`);
  writeFiles(kept, { "logo-01.png": "old", [`${path.basename(keptFolder)}/brand.json`]: EARLIER["brand.json"], [`${path.basename(keptFolder)}/BRAND.md`]: "old" });
  assert.throws(() => checkDir(kept), (err) => err.message === said(kept, keptFolder));
  // A part folder whose .earlier holds no kit, or a kit's brand.json in a
  // folder that is no run's, does not count.
  const other = path.join(parent, "other");
  writeFiles(other, { "notes.txt": "mine", [`.easybrandkit-part-${gone}-0a1b2c3d/.earlier/notes.txt`]: "half", "backup/brand.json": EARLIER["brand.json"] });
  assert.throws(() => checkDir(other), (err) => err.message === `${other} is not empty and holds no earlier brand kit. Pick another folder with --out.`);
});

// A run in a process of its own that kills itself (SIGKILL) in the middle of
// its moves: right after the count-th file has gone aside into .earlier, or
// has come into the kit's folder, page texts too. With earlier, the kit's
// folder is not there as the run starts, so its part folder is made next to
// it, and that kit comes into the folder while the run works, as another
// run's would.
function killedRun(parent, dir, files, { stage, count, earlier = null }) {
  const script = path.join(parent, "killed.js");
  fs.writeFileSync(
    script,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      `const { startRun, saveRun } = require(${JSON.stringify(require.resolve("../skills/easybrandkit/scripts/lib/run"))});`,
      `const { checkDir } = require(${JSON.stringify(require.resolve("../skills/easybrandkit/scripts/lib/folder"))});`,
      "const [dir, files, stage, count, earlier] = process.argv.slice(2);",
      "const run = startRun(dir, checkDir(dir));",
      "const write = (at, files) => {",
      "  for (const [name, body] of Object.entries(files)) {",
      "    fs.mkdirSync(path.dirname(path.join(at, name)), { recursive: true });",
      "    fs.writeFileSync(path.join(at, name), body);",
      "  }",
      "};",
      "write(run.work, JSON.parse(files));",
      "const theirs = JSON.parse(earlier);",
      "if (theirs) write(dir, theirs);",
      "const rename = fs.renameSync;",
      "let left = Number(count);",
      "fs.renameSync = function (from, to) {",
      "  rename.call(this, from, to);",
      '  const part = /[\\\\/]\\.easybrandkit-part-[^\\\\/]+[\\\\/]/;',
      '  const aside = /[\\\\/]\\.earlier[\\\\/]/.test(String(to));',
      '  const coming = part.test(String(from)) && !/[\\\\/]\\.earlier[\\\\/]/.test(String(from)) && !part.test(String(to));',
      '  if ((stage === "aside" ? aside : coming) && --left === 0) process.kill(process.pid, "SIGKILL");',
      "};",
      "saveRun(run, () => checkDir(dir, { saving: true }) || []);",
      "",
    ].join("\n"),
  );
  const killed = spawnSync(process.execPath, [script, dir, JSON.stringify(files), stage, String(count), JSON.stringify(earlier)], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
}

// What the next run says of a folder such a run left: refused before the
// site is read, with nothing changed, the earlier kit's brand.json named
// where it waits, where its page texts go when it has some aside, and the
// files the killed run brought in that moving those back would leave.
function refusedAfterKill(dir, broughtIn = "", { pages = false } = {}) {
  const part = fs.readdirSync(dir).find((name) => name.startsWith(".easybrandkit-part-"));
  assert.ok(part, `a part folder in ${dir}: ${fs.readdirSync(dir).join(" ")}`);
  const aside = path.join(dir, part, ".earlier");
  const remove = broughtIn ? `remove ${broughtIn}, which that run brought in too, ` : "";
  const back = pages ? `Move the files in ${path.join(aside, "pages")} back into ${path.join(dir, "pages")}, and the other files in ${aside} back into ${dir}` : `Move them back into ${dir}`;
  const said = `${dir} holds no brand.json: a run that did not finish putting its kit in place left the earlier kit's brand.json in ${aside}, with the files it had moved aside. ${back}, replacing any files of the same name there, which are that run's, ${remove}and run again.`;
  const before = filesOf(dir);
  const cli = spawnSync(process.execPath, [CLI, "acme.example", "--out", dir], { encoding: "utf8", env: { ...process.env, CHROME_PATH: path.join(path.dirname(dir), "no-chrome") } });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stderr, `easybrandkit: ${said}\n`);
  assert.deepEqual(filesOf(dir), before);
  return aside;
}

// The earlier kit's files moved back as the refusal says, replacing those of
// the same name: its page texts into the kit's pages, then everything else
// in .earlier, as mv <.earlier>/* <kit> moves it, which works only when
// nothing else is left there but files. Then the files it names removed.
function moveBack(dir, aside, remove = []) {
  const pages = path.join(aside, "pages");
  if (fs.existsSync(pages)) {
    for (const name of fs.readdirSync(pages)) fs.renameSync(path.join(pages, name), path.join(dir, "pages", name));
    fs.rmdirSync(pages);
  }
  for (const name of fs.readdirSync(aside)) {
    assert.ok(fs.lstatSync(path.join(aside, name)).isFile(), `${name} in .earlier is a file`);
    fs.renameSync(path.join(aside, name), path.join(dir, name));
  }
  for (const name of remove) fs.rmSync(path.join(dir, name), { recursive: name.endsWith("/") });
}

const visible = (dir) => filesOf(dir).filter((line) => !line.startsWith("."));
const asFiles = (files) => Object.keys(files).sort().map((name) => `${name} ${hash(files[name])}`);

test("a run killed outright once the earlier kit is aside leaves a folder the next run refuses, and the files moved back make it that kit again", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  const earlier = kitOf("earlier", ["logo-01.png"]);
  writeFiles(dir, earlier);
  // Killed right after the last of the earlier kit's files has gone aside.
  killedRun(parent, dir, kitOf("new", ["logo-01.png"]), { stage: "aside", count: Object.keys(earlier).length });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.startsWith(".")), [], "nothing of a kit in sight");
  // A run that went on would have left that kit hidden for good.
  const aside = refusedAfterKill(dir);
  // Moved back as the error says, they are the earlier kit, which the next
  // run replaces.
  moveBack(dir, aside);
  assert.deepEqual(visible(dir), asFiles(earlier));
  const next = startRun(dir, checkDir(dir));
  writeFiles(next.work, kitOf("next", ["logo-01.png"]));
  await saveRun(next, earlierOf(dir));
  discardRun(next);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")).tag, "next");

  // Killed once every file of its own but brand.json has come in: the
  // refusal also names the pictures it brought in under names the earlier
  // kit has not, which moving the earlier files back would leave, and with
  // those removed the folder is the earlier kit again.
  const more = path.join(parent, "more");
  writeFiles(more, { ...earlier, "notes.txt": "mine" });
  const coming = kitOf("killed", ["logo-01.png", "logo-02.png", "logo-03.png"]);
  killedRun(parent, more, coming, { stage: "in", count: Object.keys(coming).length - 1 });
  const moreAside = refusedAfterKill(more, "logo-02.png and logo-03.png");
  // Moved back in two goes, the pictures first: the earlier kit's own
  // logo-01.png and card.png, back in the folder, are not that run's.
  for (const name of ["logo-01.png", "card.png"]) fs.renameSync(path.join(moreAside, name), path.join(more, name));
  refusedAfterKill(more, "logo-02.png and logo-03.png");
  moveBack(more, moreAside, ["logo-02.png", "logo-03.png"]);
  assert.deepEqual(visible(more), asFiles({ ...earlier, "notes.txt": "mine" }));
});

test("a run with --facts killed outright as its files move in: the refusal says where the earlier page texts go, and names the page texts and facts it brought in", (t) => {
  const parent = tempParent(t);
  const facts = (tag, pages) => ({ "FACTS.md": tag, "facts.json": JSON.stringify({ tag }), ...Object.fromEntries(pages.map((page) => [`pages/${page}.md`, `${tag} ${page}`])) });
  const coming = { ...kitOf("killed", ["logo-01.png", "logo-03.png"]), ...facts("killed", ["home", "about"]) };
  // Killed once every file of its own but brand.json has come in: its page
  // texts one by one into a pages folder that is there, or in one move.
  const count = Object.keys(coming).length - 1;
  // Over an earlier kit with facts, whose pages folder holds a file of the
  // user's: the earlier page texts wait in .earlier/pages, and go back into
  // the kit's pages, which holds that run's page texts by then.
  const withFacts = path.join(parent, "with-facts");
  const earlier = { ...kitOf("earlier", ["logo-01.png", "logo-02.png"]), ...facts("earlier", ["home", "pricing"]), "pages/mine.txt": "mine", "notes.txt": "mine" };
  writeFiles(withFacts, earlier);
  killedRun(parent, withFacts, coming, { stage: "in", count });
  const aside = refusedAfterKill(withFacts, "logo-03.png and pages/about.md", { pages: true });
  moveBack(withFacts, aside, ["logo-03.png", "pages/about.md"]);
  assert.deepEqual(visible(withFacts), [...asFiles(earlier), "pages/"].sort());

  // Over a kit without facts: that run's FACTS.md, facts.json and whole
  // pages folder are named, and .earlier holds files only, so they all go
  // back in one move.
  const without = path.join(parent, "without");
  const plain = { ...kitOf("earlier", ["logo-01.png", "logo-02.png"]), "notes.txt": "mine" };
  writeFiles(without, plain);
  killedRun(parent, without, coming, { stage: "in", count: count - 1 });
  const plainAside = refusedAfterKill(without, "FACTS.md, facts.json, logo-03.png and pages/");
  assert.equal(fs.existsSync(path.join(plainAside, "pages")), false, "no pages folder in .earlier");
  moveBack(without, plainAside, ["FACTS.md", "facts.json", "logo-03.png", "pages/"]);
  assert.deepEqual(visible(without), asFiles(plain));
});

test("a run killed as its files move into a folder that held no kit is refused by the files it left, and with those removed the folder is free", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  fs.mkdirSync(dir);
  const coming = kitOf("killed", ["logo-01.png", "logo-02.png"]);
  // Killed after its first two moves: no earlier kit waits anywhere, so
  // there is none to name.
  killedRun(parent, dir, coming, { stage: "in", count: 2 });
  const left = fs.readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
  assert.equal(left.length, 2, left.join(" "));
  assert.ok(!left.includes("brand.json"), "brand.json comes in last");
  const said = `${dir} holds no earlier brand kit, only what a run that did not finish putting its kit in place left there: ${left.join(" and ")}. Remove them and run again, or pick another folder with --out.`;
  const before = filesOf(dir);
  const cli = spawnSync(process.execPath, [CLI, "acme.example", "--out", dir], { encoding: "utf8", env: { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") } });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stderr, `easybrandkit: ${said}\n`);
  assert.deepEqual(filesOf(dir), before);
  // One file left to name.
  fs.rmSync(path.join(dir, left[1]));
  assert.throws(() => checkDir(dir), (err) => err.message.endsWith(`left there: ${left[0]}. Remove it and run again, or pick another folder with --out.`));
  fs.rmSync(path.join(dir, left[0]));
  assert.equal(checkDir(dir), null, "only the killed run's part folder and lock are left");
  // A file of someone else's is told as before, also next to a part folder.
  writeFiles(dir, { "notes.txt": "mine" });
  assert.throws(() => checkDir(dir), (err) => err.message === `${dir} is not empty and holds no earlier brand kit. Pick another folder with --out.`);
});

test("a run that started before its kit's folder was there and is killed as its files move in leaves the earlier kit in that folder, where the next run finds it", (t) => {
  const parent = tempParent(t);
  // Its part folder is made next to the kit's folder, and another run's kit
  // comes into that folder while the site is read.
  const earlier = kitOf("earlier", ["logo-01.png"]);
  const coming = kitOf("killed", ["logo-01.png", "logo-02.png"]);
  const out = path.join(parent, "out");
  fs.mkdirSync(out);
  const dir = path.join(out, "kit");
  for (const [stage, count, broughtIn] of [["aside", Object.keys(earlier).length, ""], ["in", Object.keys(coming).length - 1, "logo-02.png"]]) {
    fs.rmSync(dir, { recursive: true, force: true });
    killedRun(parent, dir, coming, { stage, count, earlier });
    assert.deepEqual(fs.readdirSync(out), ["kit"], `${stage}: nothing of the run's next to the kit's folder`);
    const aside = refusedAfterKill(dir, broughtIn);
    moveBack(dir, aside, broughtIn ? [broughtIn] : []);
    assert.deepEqual(visible(dir), asFiles(earlier), stage);
  }
});

test("the list of files a killed run brought in names nothing outside the kit's folder", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  const part = path.join(dir, `.easybrandkit-part-${endedPid()}-0a1b2c3d`);
  writeFiles(part, { ".earlier/brand.json": kitOf("earlier", ["logo-01.png"])["brand.json"], ".coming": JSON.stringify(["../outside.txt", "pages/../../outside.txt", ".hidden", 7, "logo-02.png"]) });
  writeFiles(dir, { "logo-02.png": "theirs", ".hidden": "x" });
  writeFiles(parent, { "outside.txt": "mine" });
  assert.throws(() => checkDir(dir), (err) => {
    assert.match(err.message, /, remove logo-02\.png, which that run brought in too, and run again\.$/);
    return true;
  });
});

test("a part folder this user may list but not look into stays, and does not fail a run whose kit is in place", { skip: posixOnly || (process.getuid && process.getuid() === 0 && "root may look anywhere") }, async (t) => {
  const parent = tempParent(t);
  const gone = endedPid();
  const old = new Date(Date.now() - STALE - 60_000);
  // Left by a run killed outright, by another user whose umask lets this one
  // list it but not open it, or made so since.
  const shut = [];
  const leave = (folder) => {
    const at = path.join(folder, `.easybrandkit-part-${gone}-0a1b2c3d`);
    writeFiles(at, { "logo-01.png": "half" });
    for (const file of [path.join(at, "logo-01.png"), at]) fs.utimesSync(file, old, old);
    fs.chmodSync(at, 0o644);
    shut.push(at);
    return at;
  };
  // Inside a kit's folder, and next to a folder a run makes.
  const dir = path.join(parent, "kit");
  writeFiles(dir, kitOf("earlier", ["logo-01.png"]));
  const fresh = path.join(parent, "fresh", "acme");
  const cases = [[dir, leave(dir)], [fresh, leave(path.dirname(fresh))]];
  try {
    for (const [at, kept] of cases) {
      const run = startRun(at, checkDir(at));
      writeFiles(run.work, kitOf("new", ["logo-01.png"]));
      await saveRun(run, earlierOf(at));
      discardRun(run);
      assert.equal(JSON.parse(fs.readFileSync(path.join(at, "brand.json"), "utf8")).tag, "new", at);
      assert.ok(fs.existsSync(kept), `${kept} stays`);
    }
  } finally {
    for (const at of shut) fs.chmodSync(at, 0o755);
  }
});

test("an error never names the part folder, and a full disk is told as the kit's or as the temp folder's", (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const run = startRun(dir, checkDir(dir));
  t.after(() => discardRun(run));
  const failed = (code, at) => Object.assign(new Error(`${code}: it failed, open '${at}'`), { code, syscall: "open", path: at });
  // A file the run could not write in its part folder is named in the kit's.
  assert.equal(toldPlainly(failed("EIO", path.join(run.work, "BRAND.md")), run).message, `EIO: it failed, open '${path.join(dir, "BRAND.md")}'`);
  const temp = path.resolve(os.tmpdir());
  const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  for (const code of ["ENOSPC", "EDQUOT"]) {
    // A write, which names no path, and a file in the part folder: the kit's disk.
    const kitDisk = `The disk has no room left for the new kit (${code}).`;
    assert.equal(toldPlainly(Object.assign(new Error(`${code}: no space left on device, write`), { code, syscall: "write" }), run).message, kitDisk);
    assert.equal(toldPlainly(failed(code, path.join(run.work, "logo-01.png")), run).message, kitDisk);
    // The browser's profile in the temp folder, which here holds the kit's
    // folder too.
    const full = code === "ENOSPC" ? `The disk that holds the temp folder, ${temp}, is full (ENOSPC).` : `This user has no room left on the disk that holds the temp folder, ${temp} (EDQUOT).`;
    assert.equal(toldPlainly(failed(code, path.join(os.tmpdir(), "easybrandkit-chrome-XXXXXX")), run).message, `${full} Free some space on it, or set ${variable} to a folder on another disk.`);
  }
  // Anywhere else, the error is told as it is.
  const other = failed("ENOSPC", path.join(path.parse(temp).root, "easybrandkit-elsewhere", "file"));
  assert.equal(toldPlainly(other, run), other);
});

test("a disk that fills up as the new kit goes in is told as full, not as a file that could not be moved", async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  const full = (code, syscall, at) => Object.assign(new Error(`${code}: no space left on device, ${syscall} '${at}'`), { code, syscall, path: at });
  const said = { ENOSPC: "the disk is full (ENOSPC)", EDQUOT: "this user has no room left on the disk (EDQUOT)" };
  for (const code of ["ENOSPC", "EDQUOT"]) {
    // No room for the lock, or for the folder the earlier kit's files go
    // aside into: nothing has moved yet.
    for (const [method, syscall, name] of [["openSync", "open", LOCK], ["mkdirSync", "mkdir", ".earlier"]]) {
      const real = fs[method];
      const mock = t.mock.method(fs, method, function (at, ...rest) {
        if (path.basename(String(at)) === name) throw full(code, syscall, at);
        return real.call(this, at, ...rest);
      });
      const run = startRun(dir, checkDir(dir));
      writeFiles(run.work, FRESH);
      await assert.rejects(saveRun(run, earlierOf(dir)), (err) => err instanceof SaveError && err.message === `The new kit could not be put in ${dir}: ${said[code]}. The kit already there is as it was.`);
      mock.mock.restore();
      discardRun(run);
      assert.deepEqual(filesOf(dir), before, `${code}: ${name}`);
    }
    // No room for a new folder's name in the folder above it.
    const fresh = path.join(parent, `new-${code}`);
    const run = startRun(fresh, checkDir(fresh));
    writeFiles(run.work, FRESH);
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", function (from, to) {
      if (to === fresh) throw full(code, "rename", from);
      return rename.call(this, from, to);
    });
    await assert.rejects(saveRun(run, earlierOf(fresh)), (err) => err instanceof SaveError && err.message === `The new kit could not be put in ${fresh}: ${said[code]}. Nothing there was changed.`);
    mock.mock.restore();
    discardRun(run);
  }
  assert.deepEqual(fs.readdirSync(parent), ["kit"]);
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
  const none = `No Chrome, Chromium, Edge or Brave found: CHROME_PATH is ${path.join(parent, "no-chrome")}, and there is nothing there. Point CHROME_PATH at the program of a Chrome, Chromium, Edge or Brave that runs, or unset it.`;
  const said = `${none} The kit already in ${dir} is as it was.`;
  assert.equal(failed.stderr, `easybrandkit: ${said}\n`);
  assert.deepEqual(filesOf(dir), before);
  const json = cli("--out", dir, "--json");
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, error: said });
  const fresh = cli("--out", path.join(parent, "new", "acme"));
  assert.equal(fresh.status, 1);
  assert.equal(fresh.stderr, `easybrandkit: ${none}\n`);
  assert.deepEqual(fs.readdirSync(parent), ["kit"]);
  // A file, a folder below a file, and a link to nothing, also written with
  // a slash at its end, are no folders.
  const notes = path.join(dir, "notes.txt");
  for (const out of [notes, path.join(notes, "kit"), path.join(notes, "kit", "deeper")]) {
    const file = cli("--out", out);
    assert.equal(file.status, 1);
    assert.equal(file.stderr, `easybrandkit: ${notes} is a file, not a folder. Pick a folder with --out.\n`);
  }
  fs.symlinkSync(path.join(parent, "nowhere", "real"), path.join(parent, "dangling"), "junction");
  for (const out of [path.join(parent, "dangling"), `${path.join(parent, "dangling")}${path.sep}`]) {
    const link = cli("--out", out);
    assert.equal(link.status, 1);
    assert.equal(link.stderr, `easybrandkit: ${out} is a link to ${path.join(parent, "nowhere", "real")}, which is not there. Pick a folder with --out.\n`);
  }
  // Two links that lead to each other.
  if (process.platform !== "win32") {
    fs.symlinkSync("loop-b", path.join(parent, "loop-a"));
    fs.symlinkSync("loop-a", path.join(parent, "loop-b"));
    // At the folder itself, or on the way to it.
    for (const out of [path.join(parent, "loop-a"), path.join(parent, "loop-a", "x"), path.join(parent, "loop-a", "x", "y")]) {
      const loop = cli("--out", out);
      assert.equal(loop.status, 1);
      assert.equal(loop.stderr, `easybrandkit: ${path.join(parent, "loop-a")} is a link that does not lead to a folder. Pick a folder with --out.\n`);
    }
  }
  assert.deepEqual(filesOf(dir), before);
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /\nAn address that answers with an HTTP error \(400 or above\), also after a\nredirect, or that moves on to a page that cannot be opened or to a blank\npage, gets no kit: the run fails and says which address answered what\. When\nthe page that fails is one the kit chose to read, the home page of a deeper\naddress or the website a store listing names, the run goes on with what it\nhas and says so in the kit's notes\. It fails instead when it has used up its\n--timeout on that page, or when none of a listing's pictures could be\ndownloaded either\.\n/);
  assert.match(help.stdout, /\nThe new kit takes the place of an earlier one in the folder only once the\nrun has ended well\. A run that fails, is refused, or is stopped with Ctrl-C\nor a kill leaves the folder as it was, and a folder it would have made is\nnot made\. A run killed outright, as kill -9, taskkill \/F or a power cut do,\ncan leave a hidden \.easybrandkit-part- folder in the folder or next to it,\nand the browser's profile and its own folders in the temp folder; the\nREADME says what is left and what removes it\.\n/);
  // The browser ends once the kit's process is gone, as its pipe closes.
  assert.doesNotMatch(help.stdout, /browser running/);
  // A page the kit would choose that only the browser finds on such a
  // network is opened, and a site's mailto: is held where it can be.
  assert.match(help.stdout, /\nhost\. One a site leads to there is not read\. One the kit would choose there\nis not opened when the kit's own lookup finds it there; when only the\nbrowser finds it there, it is opened, and not read\.\n/);
  assert.match(help.stdout, /\nA page's own move to an address that is not a web address, such as mailto:,\nis cancelled before the browser hands it to a program of this machine, and\non Linux the browser starts with no display, a session bus where nothing\nlistens and stand-ins for the programs it hands one to\. The README says what\nholds on macOS and Windows\.\n/);
  assert.match(help.stdout, /\nto pick the browser, by its path or a name on PATH\. One that cannot be\nstarted stops the run before any work and says why\.\n/);
});

test("output that cannot be written makes the CLI exit 1 and say so, while a reader that has gone does not", { skip: !fs.existsSync("/dev/full") && "no /dev/full" }, async (t) => {
  const full = fs.openSync("/dev/full", "w");
  t.after(() => fs.closeSync(full));
  for (const [arg, what] of [["--version", "The version"], ["--help", "The help"]]) {
    const run = spawnSync(process.execPath, [CLI, arg], { encoding: "utf8", stdio: ["ignore", full, "pipe"] });
    assert.equal(run.status, 1, arg);
    assert.equal(run.stderr, `easybrandkit: ${what} could not be printed (ENOSPC).\n`);
  }
  const child = spawn(process.execPath, [CLI, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.destroy();
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 0, said);
  assert.equal(said, "");
});

test("a folder this user may not write in is told plainly, without the part folder's name", { skip: posixOnly || (process.getuid && process.getuid() === 0 && "root may write anywhere") }, (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  const shut = path.join(parent, "shut");
  writeFiles(dir, EARLIER);
  fs.mkdirSync(shut);
  const before = filesOf(dir);
  fs.chmodSync(dir, 0o555);
  fs.chmodSync(shut, 0o555);
  try {
    const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
    const cli = (out) => spawnSync(process.execPath, [CLI, "acme.example", "--out", out], { encoding: "utf8", env });
    const kit = cli(dir);
    assert.equal(kit.status, 1);
    assert.equal(kit.stderr, `easybrandkit: This user may not write in ${dir} (EACCES). Pick a folder you can write in with --out. The kit already in ${dir} is as it was.\n`);
    const made = cli(path.join(shut, "a", "kit"));
    assert.equal(made.status, 1);
    assert.equal(made.stderr, `easybrandkit: This user may not write in ${shut} (EACCES), so ${path.join(shut, "a", "kit")} cannot be made there. Pick a folder you can write in with --out.\n`);
    assert.deepEqual(filesOf(dir), before);
    assert.deepEqual(fs.readdirSync(shut), []);
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(shut, 0o755);
  }
});

test("a folder this user may not open or read is told plainly, and so is one below it", { skip: posixOnly || (process.getuid && process.getuid() === 0 && "root may read anywhere") }, (t) => {
  const parent = tempParent(t);
  // A kit's folder this user may list but not open, one it may open but not
  // list, and one with a folder below it.
  const kit = path.join(parent, "kit");
  const unread = path.join(parent, "unread");
  const shut = path.join(parent, "shut");
  writeFiles(kit, EARLIER);
  writeFiles(unread, EARLIER);
  writeFiles(shut, { "inner/notes.txt": "mine" });
  const before = [kit, unread, shut].map((dir) => filesOf(dir));
  const modes = [[kit, 0o600], [unread, 0o300], [shut, 0o600]];
  for (const [dir, mode] of modes) fs.chmodSync(dir, mode);
  try {
    const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
    const cli = (out) => spawnSync(process.execPath, [CLI, "acme.example", "--out", out], { encoding: "utf8", env });
    const pick = "Pick a folder you can write in with --out.";
    for (const [out, said] of [
      [kit, `This user may not open ${kit} (EACCES). ${pick}`],
      [unread, `This user may not read ${unread} (EACCES). ${pick}`],
      [path.join(shut, "inner", "kit"), `This user may not open ${shut} (EACCES). ${pick}`],
    ]) {
      const run = cli(out);
      assert.equal(run.status, 1, out);
      assert.equal(run.stderr, `easybrandkit: ${said}\n`);
    }
  } finally {
    for (const [dir] of modes) fs.chmodSync(dir, 0o755);
  }
  assert.deepEqual([kit, unread, shut].map((dir) => filesOf(dir)), before);
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

test("an error that nothing catches still leaves the folder as it was and ends the browser", { skip: posixOnly }, async (t) => {
  const parent = tempParent(t);
  const dir = path.join(parent, "kit");
  writeFiles(dir, EARLIER);
  const before = filesOf(dir);
  // A browser that never answers, and an error thrown from a timer once the
  // run's part folder is there.
  const chrome = path.join(parent, "chrome");
  const pidFile = path.join(parent, "chrome.pid");
  fs.writeFileSync(chrome, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const boom = path.join(parent, "boom.js");
  fs.writeFileSync(
    boom,
    [
      'const fs = require("fs");',
      "const mkdir = fs.mkdirSync;",
      "fs.mkdirSync = function (at, ...rest) {",
      "  const made = mkdir.call(this, at, ...rest);",
      '  if (/\\.easybrandkit-part-/.test(String(at))) setTimeout(() => { throw new Error("thrown from a timer"); }, 500);',
      "  return made;",
      "};",
      "",
    ].join("\n"),
  );
  const child = spawn(process.execPath, ["--require", boom, CLI, "acme.example", "--out", dir], { env: { ...process.env, CHROME_PATH: chrome }, stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 1, said);
  assert.match(said, /Error: thrown from a timer/);
  assert.deepEqual(filesOf(dir), before);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let waited = 0; waited < 2_000 && !ended(pid); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(ended(pid), "the browser was ended");
});
