"use strict";

// Where a run makes its files, and how they take the place of an earlier
// kit. A run writes into a part folder of its own, named
// .easybrandkit-part-<pid>-<8 hex>: inside the kit's folder when that is
// there already, and next to it when the run makes it. So the files are made
// on the same disk and get the mode, the group and the default ACL they would
// get in place. Only a run that ends well puts them there: the part folder
// becomes the kit's folder, or the earlier kit's files are moved aside into
// it, the new ones moved in, and the part folder removed with the earlier
// kit in it. A run that fails, is refused or is stopped leaves the folder as
// it was and adds nothing.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PART = /^\.easybrandkit-part-(\d+)-[0-9a-f]{8}$/;
// A run killed outright (kill -9, a power cut) cannot remove its part
// folder. A later run that ends well next to it removes it once its process
// is gone and nothing in it has changed for this long.
const STALE = 15 * 60 * 1000;
const BUSY = ["EPERM", "EACCES", "EBUSY"];

// An error of saveRun, whose message says what the kit's folder holds.
class SaveError extends Error {}

// A path that is not there gives undefined, also when a part of it is a file.
function lstat(at) {
  try {
    return fs.lstatSync(at, { throwIfNoEntry: false });
  } catch (err) {
    if (err.code === "ENOTDIR") return undefined;
    throw err;
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows can refuse a rename for a moment while a virus scanner or the
// search indexer reads a file just written, so there it is tried again for
// up to two seconds, unless something is in the way.
function rename(from, to) {
  for (let waited = 0; ; waited += 50) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (process.platform !== "win32" || !BUSY.includes(err.code) || waited >= 2_000 || lstat(to)) throw err;
      pause(50);
    }
  }
}

function remove(at) {
  try {
    fs.rmSync(at, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Held open on Windows: a later run's sweep removes it.
  }
}

// The runs of this process that have not ended.
const runs = new Set();

// dir is the kit's folder as given, a folder or nothing (prepareDir in
// kit.js has refused anything else); earlier says whether it holds an
// earlier kit, for what a stopped run says.
function startRun(dir, earlier) {
  const target = path.resolve(dir);
  // A link to a folder counts as that folder.
  const there = fs.statSync(target, { throwIfNoEntry: false });
  const home = there ? target : path.dirname(target);
  // The folders made for the part folder, removed again when the run does
  // not end well.
  const made = there ? undefined : fs.mkdirSync(home, { recursive: true });
  const run = { dir, target, home, made: made && path.resolve(made), work: "", earlier: Boolean(earlier && earlier.length) };
  try {
    for (;;) {
      // mkdirSync, not mkdtempSync: its mode 0700 would mask a default ACL.
      run.work = path.join(home, `.easybrandkit-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.mkdirSync(run.work);
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
  } catch (err) {
    removeMade(run);
    throw err;
  }
  runs.add(run);
  return run;
}

function removeMade(run) {
  if (!run.made) return;
  for (let at = run.home; ; at = path.dirname(at)) {
    try {
      fs.rmdirSync(at);
    } catch {
      return;
    }
    if (at === run.made) return;
  }
}

// A run that did not end well: its part folder goes, and so do the folders
// it made while nothing else came into them. It never throws, so the run's
// own error is the one that is told.
function discardRun(run) {
  if (!runs.delete(run)) return;
  remove(run.work);
  removeMade(run);
}

// Every run of this process that has not ended, discarded, for a process
// that is being stopped: each one's folder, and whether it holds an earlier
// kit, which is as it was.
function discardRuns() {
  const stopped = [...runs].map((run) => ({ dir: run.dir, earlier: run.earlier }));
  for (const run of [...runs]) discardRun(run);
  return stopped;
}

// A folder that holds a file, two levels down at most.
function holdsFiles(at, depth = 2) {
  let entries = [];
  try {
    entries = fs.readdirSync(at, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => !entry.isDirectory() || (depth > 0 && holdsFiles(path.join(at, entry.name), depth - 1)));
}

// Puts the run's files in place. It is synchronous, so a stop signal is
// handled before it or after it, never in the middle. earlierOf gives the
// earlier kit's file names as the folder holds them at that moment, or
// throws when the folder now holds something else. A rename that fails puts
// back what had moved, and the error says what the folder holds.
function saveRun(run, earlierOf) {
  const { dir, target, work } = run;
  // How a path in or next to the kit's folder is shown: from dir as given.
  const shown = (at) => path.join(path.dirname(dir), path.relative(path.dirname(target), at));
  const why = (err) => (err.syscall && BUSY.includes(err.code) ? `another program holds a file open, or the folder may not be changed (${err.code})` : err.message);
  if (!lstat(target)) {
    try {
      rename(work, target);
      runs.delete(run);
      sweep(path.dirname(target));
      return;
    } catch (err) {
      // Made meanwhile, by another run or by hand: the files go in one by one.
      if (!lstat(target)) throw new SaveError(`The new kit could not be put in ${dir}: ${why(err)}.`);
    }
  }
  let earlierNow;
  try {
    earlierNow = earlierOf();
  } catch (err) {
    throw new SaveError(err.message);
  }
  const aside = path.join(work, ".earlier");
  // Each move as [from, to, name, whether it moved a new file in].
  const moved = [];
  const move = (from, to, name, coming) => {
    // rename(2) would replace a file without a word: a file is replaced only
    // by moveIn, which moves it aside first.
    if (lstat(to)) throw new Error(`${name} came there while the new kit was put in`);
    rename(from, to);
    moved.push([from, to, name, coming]);
  };
  // brand.json goes aside first and comes in last, so the folder never
  // holds a brand.json that does not match the files next to it.
  const last = (names) => [...names.filter((name) => name !== "brand.json"), ...names.filter((name) => name === "brand.json")];
  try {
    fs.mkdirSync(path.join(aside, "pages"), { recursive: true });
    for (const name of last(earlierNow).reverse()) {
      const at = lstat(path.join(target, name));
      // A folder under a kit file's name is not the kit's.
      if (at && !at.isDirectory()) move(path.join(target, name), path.join(aside, name), name, false);
    }
    const moveIn = (name) => {
      const at = lstat(path.join(target, name));
      if (at && at.isDirectory()) throw new Error(`${name} is a folder there, where the new kit has a file`);
      // A file of the user's under a name the new kit writes is replaced, as
      // writing the new one in place would.
      if (at) move(path.join(target, name), path.join(aside, name), name, false);
      move(path.join(work, name), path.join(target, name), name, true);
    };
    for (const name of last(fs.readdirSync(work).filter((name) => name !== ".earlier"))) {
      if (name !== "pages") moveIn(name);
      else if (!lstat(path.join(target, "pages"))) move(path.join(work, "pages"), path.join(target, "pages"), "pages", true);
      else if (!fs.statSync(path.join(target, "pages")).isDirectory()) throw new Error("pages is a file there, where the new kit has a folder");
      // A pages/ that is there keeps the files of the user's in it.
      else for (const page of fs.readdirSync(path.join(work, "pages"))) moveIn(`pages/${page}`);
    }
  } catch (err) {
    const leftEarlier = [];
    const stuckNew = [];
    const back = new Set();
    for (const [from, to, name, coming] of moved.reverse()) {
      try {
        rename(to, from);
        if (!coming) back.add(name);
      } catch {
        if (coming) {
          // A new file that will not go back is removed where it is.
          remove(to);
          if (lstat(to)) stuckNew.push(name);
        } else {
          leftEarlier.push(name);
        }
      }
    }
    // A file put back under the same name has replaced the new one.
    const leftNew = stuckNew.filter((name) => !back.has(name));
    const said = [`The new kit could not be put in ${dir}: ${why(err)}.`];
    if (!leftEarlier.length && !leftNew.length) said.push(earlierNow.length ? "The kit already there is as it was." : "Nothing there was changed.");
    if (leftEarlier.length) {
      // What could not be put back stays, in a folder no run removes, or
      // else in this part folder, which the sweep then keeps.
      const kept = path.join(run.home, path.basename(work).replace(/^\.easybrandkit-part-/, "easybrandkit-kept-"));
      let keptAt = kept;
      try {
        rename(aside, kept);
      } catch {
        keptAt = aside;
        runs.delete(run);
      }
      said.push(`Some files of the earlier kit could not be put back; they are in ${shown(keptAt)}.`);
    }
    if (leftNew.length) said.push(`${leftNew.join(", ")} of the new kit could not be taken out of it again.`);
    throw new SaveError(said.join(" "));
  }
  runs.delete(run);
  // pages/ with nothing left in it, from an earlier run with --facts.
  try {
    fs.rmdirSync(path.join(target, "pages"));
  } catch {
    // Not there, or holding files.
  }
  // The earlier kit is to go now: under another name first, since the sweep
  // keeps a part folder whose .earlier holds files, and this one can be left
  // when a file in it is held open.
  try {
    fs.renameSync(aside, path.join(work, ".replaced"));
  } catch {
    // Removed below all the same.
  }
  remove(work);
  sweep(target);
  sweep(path.dirname(target));
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The newest change in a folder, two levels down.
function touched(folder) {
  let newest = 0;
  const look = (at, depth) => {
    const s = lstat(at);
    if (!s) return;
    newest = Math.max(newest, s.mtimeMs);
    if (depth > 0 && s.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(at);
      } catch {
        return;
      }
      for (const name of names) look(path.join(at, name), depth - 1);
    }
  };
  look(folder, 2);
  return newest;
}

// The part folders of runs killed outright, in folder. One whose .earlier
// holds files is kept: those are an earlier kit that was not put back.
function sweep(folder) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const part = PART.exec(name);
    if (!part) continue;
    const at = path.join(folder, name);
    if ([...runs].some((run) => run.work === at)) continue;
    if (running(Number(part[1])) || Date.now() - touched(at) < STALE || holdsFiles(path.join(at, ".earlier"))) continue;
    remove(at);
  }
}

module.exports = { PART, STALE, SaveError, startRun, discardRun, discardRuns, saveRun, sweep };
