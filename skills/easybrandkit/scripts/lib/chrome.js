"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol through a pipe of its own. It opens no port, so no other program
// on the machine, another user's run among them, can reach it. Nothing is
// downloaded.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, outOfTime, sleep, LONGEST_TIMER } = require("./time");

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS = [
  ["PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"],
];

function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not in this directory.
    }
  }
  return "";
}

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : "";
  if (process.platform === "darwin") return MAC.find((file) => fs.existsSync(file)) || "";
  if (process.platform === "win32") {
    for (const [root, rest] of WINDOWS) {
      const file = process.env[root] ? path.join(process.env[root], rest) : "";
      if (file && fs.existsSync(file)) return file;
    }
    return "";
  }
  for (const name of LINUX) {
    const file = onPath(name);
    if (file) return file;
  }
  return "";
}

// The browsers this process has open, so that a run that is stopped can end
// them at once instead of leaving them running.
const open = new Set();

// How long a wait on the browser may last: what the run has left, at least a
// second, and no more than cap where one is given. A busy machine can keep a
// browser from answering for many seconds, so the run's own limit, and not a
// fixed one, says how long its start, its tab and the connection to it are
// waited for.
const browserWait = (cap = Infinity) => Math.max(1_000, Math.min(cap, LONGEST_TIMER, timeLeft()));

// What the browser did, as an error whose words can start a sentence or
// follow "The card could not be drawn:", marked browserSaid. A run that ends
// on one adds what to do (noKit).
const browserSaid = (words, more = {}) => Object.assign(new Error(words), { browserSaid: true, outOfTime: false, ...more });

// A wait on the browser that ran out: what did not answer, and for how long.
// Its outOfTime says the run has used up its own time.
function noAnswer(what, ms) {
  const spent = outOfTime();
  return browserSaid(`${what} ${spent ? "before the run's time ran out" : `in ${Math.round(ms / 1_000)} s`}`, { noAnswer: true, outOfTime: spent });
}

const noKit = (err) => Object.assign(new Error(`${err.message}, so no kit was made. ${err.outOfTime ? "Try again, or give it more time with --timeout." : "Try again."}`), { outOfTime: err.outOfTime });

// The folders browsers of Chrome's kind make in the temp folder, by the
// name each one gives them: the one that holds the socket that makes a
// browser one per profile, and those its component updater downloads and
// unpacks into in the browser's first seconds. A browser that ends then
// leaves those, empty or with what it was fetching.
const TEMP_NAME = /^\.?(com\.google\.Chrome|org\.chromium\.Chromium|com\.microsoft\.Edge|com\.brave\.Browser)\./;
const FETCHING = /(url_fetcher_|Unpacker_BeginUnzipping)\./;

function tempNames(temp) {
  try {
    return new Set(fs.readdirSync(temp).filter((name) => TEMP_NAME.test(name)));
  } catch {
    return new Set();
  }
}

// Once a browser has ended: the folders of this user's that came in the
// temp folder while it ran. A browser that ends while its component updater
// fetches or unpacks something leaves those folders with what is in them,
// whether it was killed or quit when asked, so they go with their files.
// Any other folder goes only when it is empty, so one that another browser
// is using, like the one that holds its socket, keeps its files. Another
// browser that fetched a component at that moment loses only that
// download; its pages are not touched.
function removeTemps({ temp, before }) {
  const uid = process.getuid ? process.getuid() : null;
  for (const name of tempNames(temp)) {
    if (before.has(name)) continue;
    const at = path.join(temp, name);
    try {
      const stat = fs.lstatSync(at);
      if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) continue;
      if (FETCHING.test(name)) fs.rmSync(at, { recursive: true, force: true });
      else fs.rmdirSync(at);
    } catch {
      // Not empty, or gone.
    }
  }
}

// When a process started, on Linux, from /proc/<pid>/stat, so that a pid
// that has come round again on another process is not taken for it: null
// once it has ended (a zombie has ended too).
function startOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? null : fields[19];
  } catch {
    return null;
  }
}

// The processes that run on Linux, but this one: the parent of each, and,
// given a tag, those whose command line holds it.
function scan(tag = "") {
  const parentOf = new Map();
  const named = [];
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return { parentOf, named };
  }
  for (const name of names) {
    const pid = Number(name);
    if (!/^\d+$/.test(name) || pid === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state === "Z" || state === "X") continue;
      parentOf.set(pid, Number(ppid));
      if (tag && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(tag)) named.push(pid);
    } catch {
      // Gone already.
    }
  }
  return { parentOf, named };
}

// A browser's processes on Linux: the browser and those that descend from
// it. Other systems give none, and so does a browser that has ended, whose
// pid can be another process's by now: its helpers are found by the profile
// they name (see endAll).
function processesOf(child) {
  if (process.platform !== "linux" || !child.pid || child.exitCode !== null || child.signalCode !== null) return [];
  const { parentOf } = scan();
  const found = new Set([child.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of parentOf) {
      if (!found.has(pid) && found.has(ppid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found].map((pid) => ({ pid, start: startOf(pid) })).filter(({ start }) => start !== null);
}

// The crash handler a browser's processes name, on Linux, which Chrome starts
// apart from them: it is no child of theirs, so it is found by the pid
// their --crashpad-handler-pid gives. Since its reports go into the profile,
// its --database names the profile too, and so endAll, which looks for the
// processes that name the profile, also finds it and the process that
// watches it. Ctrl-\ reaches the browser's helpers too, each of them asks
// it for a crash report, and it takes hold of each one to write it. A
// helper killed while it is held stays until the handler lets go of it,
// which it can fail to do for good. So it goes with them: the one named,
// only when it is a crash handler by the name /proc gives it (the first 15
// characters of its program's name, chrome_crashpad or msedge_crashpad)
// and it started with them or after them. Chrome rewrites a helper's
// command line with spaces between its arguments. null when none is named.
function crashHandlerOf(processes) {
  if (process.platform !== "linux" || !processes.length) return null;
  const oldest = Math.min(...processes.map(({ start }) => Number(start)));
  for (const { pid } of processes) {
    let line = "";
    try {
      line = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const named = /(?:^|[\0 ])--crashpad-handler-pid=(\d+)(?=[\0 ]|$)/.exec(line);
    if (!named) continue;
    // 0 where Chrome runs without one.
    const handler = Number(named[1]);
    if (handler <= 1 || handler === process.pid) return null;
    try {
      if (!/crashpad/.test(fs.readFileSync(`/proc/${handler}/comm`, "utf8"))) return null;
    } catch {
      return null;
    }
    const start = startOf(handler);
    return start === null || Number(start) < oldest ? null : { pid: handler, start };
  }
  return null;
}

// A browser's processes and its crash handler, known from its launch or
// named by them now.
function withCrashHandler(entry, processes) {
  const handler = entry.crashHandler || crashHandlerOf(processes);
  return handler && !processes.some(({ pid }) => pid === handler.pid) ? [...processes, handler] : processes;
}

// Each of them that still runs, killed.
function killAll(processes) {
  for (const { pid, start } of processes) {
    if (startOf(pid) !== start) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}
const allGone = (processes) => processes.every(({ pid, start }) => startOf(pid) !== start);

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Each of a browser's processes that still runs, killed, and then each
// process whose command line names its profile, as Chrome's helpers do:
// they are found that way also once the browser has ended and they belong
// to no one, and one of them can start another a moment before it is
// killed, which would write into the profile after it was removed. Looked
// for again until a look finds none and all have ended, a second at most.
// Chrome's network service writes into the profile as it ends, so the
// profile can be removed for good only once they are all gone. Gives back
// every process it killed.
function endAll(processes, profile) {
  const ended = [...processes];
  killAll(ended);
  if (process.platform !== "linux") return ended;
  const tag = path.basename(profile);
  for (let waited = 0; waited < 1_000; waited += 20) {
    const late = scan(tag)
      .named.map((pid) => ({ pid, start: startOf(pid) }))
      .filter(({ pid, start }) => start !== null && !ended.some((known) => known.pid === pid && known.start === start));
    if (!late.length && allGone(ended)) break;
    killAll(late);
    ended.push(...late);
    pause(20);
  }
  return ended;
}

// What fs says of a write that found no room: a full disk, or a user's quota
// used up.
const NO_ROOM = new Set(["ENOSPC", "EDQUOT"]);
// A disk with less room than this left has none for a browser's profile.
const ROOM = 64 * 1024;

// Whether the disk that holds the profile takes ROOM more bytes, asked by
// writing them: the error of a write that found no room, with the path
// written, or null. A full disk and a quota used up look the same to the
// browser, and only a write tells them apart.
function noRoomIn(profile) {
  const probe = path.join(profile, "easybrandkit-room");
  try {
    fs.writeFileSync(probe, Buffer.alloc(ROOM));
    return null;
  } catch (err) {
    return NO_ROOM.has(err.code) ? Object.assign(err, { path: err.path || probe }) : null;
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // Removed with the profile.
    }
  }
}

// Whether the disk that holds the temp folder shows next to no room.
function lowOnRoom(temp) {
  try {
    const { bavail, bsize } = fs.statfsSync(temp);
    return bavail * bsize < ROOM;
  } catch {
    return false;
  }
}

// How long a browser is given to quit when asked, its answers included,
// while the run still has time.
const QUIT_WAIT = 9_000;
// How long a browser asked to quit has to say that it heard: one that does
// not is killed then.
const HEARD_WAIT = 2_000;
// A disk that shows next to no room this long has none for a profile.
const LOW_WAIT = 3_000;

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder; the user's own home and browser are untouched.
async function launch({ width, height }) {
  const binary = findChrome();
  if (!binary) {
    throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  }
  const name = path.basename(binary);
  const temp = os.tmpdir();
  const before = tempNames(temp);
  const profile = fs.mkdtempSync(path.join(temp, "easybrandkit-chrome-"));
  // A download that starts while the browser takes no refusal (see below)
  // goes into the throwaway profile and is removed with it, not into the
  // Downloads folder of the user the browser runs as.
  const preferences = path.join(profile, "Default", "Preferences");
  try {
    fs.mkdirSync(path.join(profile, "Default"));
    fs.writeFileSync(preferences, JSON.stringify({ download: { default_directory: path.join(profile, "Downloads"), prompt_for_download: false } }));
  } catch (err) {
    // A disk with no room for this has none for the browser's own files
    // either, and the browser would wait for the run's whole time. For
    // anything else, the refusal still holds.
    if (NO_ROOM.has(err.code)) {
      fs.rmSync(profile, { recursive: true, force: true });
      throw Object.assign(err, { path: err.path || preferences });
    }
  }
  // Chrome on Linux has its crash handler write the reports of its processes
  // into the user's own browser's folder (~/.config/google-chrome/Crash
  // Reports), where nothing removes them; Ctrl-\ asks for one from each of
  // its helpers. BREAKPAD_DUMP_LOCATION puts them in the throwaway profile.
  const env = { ...process.env, BREAKPAD_DUMP_LOCATION: path.join(profile, "Crash Reports") };
  // --remote-debugging-pipe: the browser takes the DevTools protocol on its
  // file descriptors 3 and 4, which only this process holds, and opens no
  // port for it.
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
      // Chrome refuses to start as root without it (a container, a CI box).
      ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env },
  );
  const pipe = pipeOf(child.stdio[3], child.stdio[4]);
  let exited = false;
  const ended = () => {
    exited = true;
    pipe.end();
  };
  child.on("exit", ended);
  child.on("error", ended);
  const entry = { child, profile, temp, before };
  open.add(entry);
  // Whether the browser has answered on its pipe: one that never has is not
  // asked to quit.
  let answered = false;
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while. Those still there once it has
  // quit are killed, and the profile is removed once they are gone. A
  // profile that still cannot be removed is left in the temp folder; the
  // kit is not lost over it. A browser that does not say that it heard
  // within 2 s is killed then. Asking it and waiting for it to end take a
  // second in all once the run's time is up, or when the browser has just
  // not answered (hurry), so that one that does not quit is killed then and
  // does not keep the run going past its limit.
  const close = async ({ hurry = false } = {}) => {
    // The browser's processes as they are now, with its crash handler; its
    // helpers, which name the profile, are found also once it has ended, as
    // one that could not start has.
    const processes = withCrashHandler(entry, processesOf(child));
    if (answered && !exited && !pipe.ended()) {
      const until = Date.now() + (hurry || outOfTime() ? 1_000 : QUIT_WAIT);
      let heard = null;
      pipe.send("Browser.close", {}, Math.max(1, Math.min(HEARD_WAIT, until - Date.now()))).then(
        () => (heard = true),
        () => (heard = false),
      );
      while (!exited && heard !== false && Date.now() < until) await sleep(50);
    }
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    pipe.end();
    endAll(processes, profile);
    open.delete(entry);
    removeSingleton(profile, entry.singleton);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Left for the system's temp clean-up.
    }
    removeTemps(entry);
  };
  // Whether the browser still runs: one that was killed or crashed has
  // ended, and its pipe with it. One that is slow to answer, on a busy
  // machine, still runs, and so does one that has not ended when it is not
  // asked (ms 0).
  const alive = async (ms = 5_000) => {
    if (exited || pipe.ended()) return false;
    if (!ms) return true;
    try {
      await pipe.send("Browser.getVersion", {}, ms);
      return !exited;
    } catch (err) {
      return !exited && Boolean(err.timedOut);
    }
  };
  // A new tab, waited for ms at most: its id.
  const newTab = async (ms) => {
    try {
      const { targetId } = await pipe.send("Target.createTarget", { url: "about:blank" }, ms);
      return targetId;
    } catch (err) {
      if (err.timedOut) throw noAnswer("The browser did not open a tab", ms);
      if (err.closed) throw err;
      throw browserSaid("The browser refused to open a tab");
    }
  };
  // A tab closed, waited for ms at most; the browser goes on.
  const closeTab = (targetId, ms = 5_000) => pipe.send("Target.closeTarget", { targetId }, ms).then(
    () => {},
    () => {},
  );
  // The browser answers on its pipe once it has started, which a busy
  // machine can keep it from doing for a while: that is waited for as long
  // as the run has left, also when CHROME_PATH names a program that takes
  // long before it starts the browser. Looked at once a second, a browser
  // that never will is told before then: one with no room for its profile
  // in the temp folder.
  const wait = browserWait();
  let said = null;
  pipe.send("Browser.getVersion", {}, wait).then(
    (version) => (said = { version }),
    (err) => (said = { err }),
  );
  let lowSince = 0;
  for (let looked = Date.now(); !said && !exited; ) {
    await sleep(100);
    if (Date.now() - looked < 1_000) continue;
    looked = Date.now();
    lowSince = lowOnRoom(temp) ? lowSince || looked : 0;
    if (lowSince && looked - lowSince >= LOW_WAIT) {
      const full = noRoomIn(profile);
      if (full) {
        await close();
        throw full;
      }
      lowSince = 0;
    }
  }
  if (said && !said.err) {
    answered = true;
    // Known from the start: by the time the browser is stopped, its
    // helpers can have ended, and its link to the folder of its socket
    // can be gone.
    entry.crashHandler = crashHandlerOf(processesOf(child));
    entry.singleton = singletonOf(profile, temp);
    // A site can make a browser save a file, into the Downloads folder of
    // the user it runs as, where nothing removes it. This browser saves none:
    // said once to the whole browser over its pipe, the refusal holds for as
    // long as the browser runs, for every tab, and before any page is
    // opened. A browser too busy to answer it in the time the run has left
    // ends the run, as one that does not start does: let go on, it would read
    // the site with nothing refused. One that answers that it does not take
    // it goes on: a download then lands in the throwaway profile.
    const refusal = browserWait();
    try {
      await pipe.send("Browser.setDownloadBehavior", { behavior: "deny" }, refusal);
    } catch (err) {
      if (err.timedOut) {
        await close({ hurry: true });
        throw noKit(noAnswer("The browser did not answer the kit's request to refuse downloads", refusal));
      }
    }
    return { close, alive, newTab, closeTab, attach: (targetId, ms) => pipe.attach(targetId, ms) };
  }
  const running = !exited;
  // Told before close, which removes the folder the browser made and the
  // profile: a browser that ended at once can have found no room either.
  const tooLong = exited ? socketTooLong(temp, before) : 0;
  const full = exited && !tooLong ? noRoomIn(profile) : null;
  await close();
  if (tooLong) {
    throw new Error(`${name} did not start: the path of the temp folder, ${temp}, is too long for the socket the browser makes in it, whose path would be ${tooLong} bytes where Linux allows ${SOCKET_MAX}. Set TMPDIR to a folder whose path is at least ${tooLong - SOCKET_MAX} ${tooLong - SOCKET_MAX === 1 ? "byte" : "bytes"} shorter.`);
  }
  if (full) throw full;
  if (running) {
    const late = noKit(noAnswer(`${name} was started but did not answer`, wait));
    throw Object.assign(late, { message: `${late.message} If it happens again, point CHROME_PATH at another browser.` });
  }
  throw new Error(`${name} did not start. Try again, or point CHROME_PATH at another browser.`);
}

// A socket's path on Linux holds 108 bytes, the last of them a zero.
const SOCKET_MAX = 107;

// Chrome on Linux makes the folder that holds its socket in the temp folder
// as it starts, and ends at once when the socket's path in it is longer
// than a socket's path can be. The length of that path, for a folder of
// Chrome's kind that came while the browser started, when it is too long;
// 0 when it is not, or when no such folder came.
function socketTooLong(temp, before) {
  if (process.platform !== "linux") return 0;
  const made = [...tempNames(temp)].filter((name) => !before.has(name) && !FETCHING.test(name));
  const longest = Math.max(0, ...made.map((name) => Buffer.byteLength(path.join(temp, name, "SingletonSocket"))));
  return longest > SOCKET_MAX ? longest : 0;
}

// Chrome keeps the socket that makes it one browser per profile in a folder
// of its own in the temp folder, linked from the profile, and removes it
// only when it quits. Killed, it leaves it: removed here, those two names
// only. As it quits, as Ctrl-C makes it do, it removes the profile's links
// first and the folder a moment later, so a browser killed in between
// leaves the folder with nothing that leads to it: the folder named as the
// browser started is used then.
function removeSingleton(profile, known = "") {
  let folder = known;
  try {
    folder = path.dirname(fs.readlinkSync(path.join(profile, "SingletonSocket")));
  } catch {
    // No link any more.
  }
  if (!folder) return;
  try {
    for (const name of ["SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(folder, name), { force: true });
    fs.rmdirSync(folder);
  } catch {
    // Gone already, as Chrome removed it as it quit.
  }
}

// The folder of a browser's socket, as the profile's link names it while
// the browser runs: "" when there is none, or when it is not a folder of
// Chrome's kind right in the temp folder.
function singletonOf(profile, temp) {
  try {
    const folder = path.dirname(fs.readlinkSync(path.join(profile, "SingletonSocket")));
    return path.isAbsolute(folder) && TEMP_NAME.test(path.basename(folder)) && fs.realpathSync(path.dirname(folder)) === fs.realpathSync(temp) ? folder : "";
  } catch {
    return "";
  }
}

// Every browser still open, killed at once with its helpers and its crash
// handler, and its profile and temp folders removed: for a process that is
// being stopped and has no time to ask them to quit. It never throws.
function killBrowsers() {
  const ending = [...open];
  open.clear();
  for (const entry of ending) {
    entry.processes = withCrashHandler(entry, processesOf(entry.child));
    try {
      entry.child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
    killAll(entry.processes);
  }
  // Until they are gone, with any they started, a second at most each.
  for (const entry of ending) entry.processes = endAll(entry.processes, entry.profile);
  for (const { profile, singleton } of ending) removeSingleton(profile, singleton);
  // Once its processes are gone, nothing writes into a profile again. Where
  // they cannot be told, helpers can still write into it for a moment as
  // they end: it is removed until it stays gone, half a second at most.
  for (let round = 0; round < 5; round++) {
    for (const { profile } of ending) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
      } catch {
        // Tried again in the next round.
      }
    }
    if (ending.every(({ processes }) => processes.length && allGone(processes))) break;
    pause(100);
    if (!ending.some(({ profile }) => fs.existsSync(profile))) break;
  }
  for (const entry of ending) removeTemps(entry);
}

// An error about a page and not about the run. Its pageFailed holds what the
// page did, in words that can follow its address or "it", for a run that goes
// on without a page it chose to read. Its outOfTime says the page got no more
// of the run's time, where more of it can help: such a run does not go on.
const pageFailed = (message, what, spent = false) => Object.assign(new Error(message), { pageFailed: what, outOfTime: spent });

// A call on a connection that has closed, marked closed: a tab that has
// closed while the browser runs, or a browser that has ended.
const connectionClosed = () => Object.assign(new Error("The browser connection closed."), { closed: true });

// The largest message taken from the browser. The snapshot of a very large
// page can be bigger, and read whole it would take more memory than a run
// has on the hosted worker: Node 22.23's WebSocket, which the kit used
// before the pipe, took none larger either.
const MESSAGE_MOST = 128 * 1024 * 1024;

// The answer to a call that was larger than the kit takes, marked tooLarge.
// The connection goes on: only that call fails.
const tooLargeAnswer = () => Object.assign(new Error("The browser's answer was too large to take."), { tooLarge: true });

// The DevTools protocol over a browser's pipe: each message is JSON ended by
// a zero byte, the kit's written to input and the browser's read from output.
// The browser's own calls go without a session. Each tab the kit uses is a
// session of its own on the pipe (attach), with send, on and closed as a
// connection of its own had. A message over most bytes is not kept: its
// first bytes name the call it answers (an answer starts {"id":<n>,), and
// that call fails as too large; anything else that large is dropped.
function pipeOf(input, output, most = MESSAGE_MOST) {
  const pending = new Map();
  const listeners = new Map();
  const sessions = new Map();
  let nextId = 0;
  let over = false;
  let markOver;
  const closed = new Promise((done) => (markOver = done));
  const settle = (id, err, result) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve(result);
  };
  // A tab's session that has ended, as when its tab closed: its calls fail as
  // on a closed connection.
  const endSession = (session) => {
    const mark = sessions.get(session);
    if (!mark) return;
    sessions.delete(session);
    for (const [id, waiter] of [...pending]) if (waiter.session === session) settle(id, connectionClosed());
    mark();
  };
  // The pipe closed, as when the browser ends: every call fails at once.
  const end = () => {
    if (over) return;
    over = true;
    for (const id of [...pending.keys()]) settle(id, connectionClosed());
    for (const session of [...sessions.keys()]) endSession(session);
    markOver();
    input.destroy();
    output.destroy();
  };
  const take = (bytes) => {
    let msg;
    try {
      msg = JSON.parse(bytes.toString("utf8"));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method === "string") {
      if (msg.method === "Target.detachedFromTarget" && msg.params) endSession(msg.params.sessionId);
      for (const listener of listeners.get(`${msg.sessionId || ""} ${msg.method}`) || []) listener(msg.params || {});
      return;
    }
    if (msg.error) settle(msg.id, new Error(msg.error.message || "DevTools protocol error"));
    else settle(msg.id, null, msg.result || {});
  };
  // The first bytes of a message, from its parts.
  const startOf = (list) => {
    const head = [];
    let size = 0;
    for (const part of list) {
      head.push(part);
      size += part.length;
      if (size >= 64) break;
    }
    return Buffer.concat(head).subarray(0, 64).toString("latin1");
  };
  let parts = [];
  let size = 0;
  // The start of a message too large to keep, while the rest of it goes by.
  let dropping = null;
  output.on("data", (chunk) => {
    for (let at = 0; at < chunk.length; ) {
      const zero = chunk.indexOf(0, at);
      const piece = chunk.subarray(at, zero === -1 ? chunk.length : zero);
      at = zero === -1 ? chunk.length : zero + 1;
      if (dropping === null && size + piece.length > most) {
        dropping = startOf([...parts, piece]);
        parts = [];
        size = 0;
      }
      if (dropping !== null) {
        if (zero === -1) continue;
        const id = /^\{"id":(\d+)[,}]/.exec(dropping);
        if (id) settle(Number(id[1]), tooLargeAnswer());
        dropping = null;
        continue;
      }
      parts.push(piece);
      size += piece.length;
      if (zero === -1) continue;
      const whole = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
      parts = [];
      size = 0;
      take(whole);
    }
  });
  output.on("end", end);
  output.on("close", end);
  output.on("error", end);
  input.on("error", end);
  // A call, waited for timeoutMs at most and no longer than the run has left,
  // a second at least.
  const send = (method, params = {}, timeoutMs = 30_000, session = "") => {
    if (over || (session && !sessions.has(session))) return Promise.reject(connectionClosed());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
      }, Math.max(1_000, Math.min(timeoutMs, timeLeft())));
      pending.set(id, { resolve, reject, timer, session });
      input.write(`${JSON.stringify(session ? { id, method, params, sessionId: session } : { id, method, params })}\0`);
    });
  };
  // The kit's connection to a tab, waited for ms at most.
  const attach = async (targetId, ms) => {
    let session;
    try {
      ({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }, ms));
    } catch (err) {
      if (err.timedOut) throw noAnswer("The browser did not answer the kit's connection to its tab", ms);
      if (err.closed) throw err;
      throw browserSaid("The browser refused the kit's connection to its tab");
    }
    if (over) throw connectionClosed();
    let mark;
    const tabClosed = new Promise((done) => (mark = done));
    sessions.set(session, mark);
    return {
      // Settles once the tab has closed, or the browser has ended.
      closed: tabClosed,
      send: (method, params = {}, timeoutMs = 30_000) => send(method, params, timeoutMs, session),
      on(method, listener) {
        const key = `${session} ${method}`;
        listeners.set(key, [...(listeners.get(key) || []), listener]);
      },
      // The tab closed, not waited for; the browser goes on.
      close() {
        if (sessions.has(session)) send("Target.closeTarget", { targetId }, 5_000).catch(() => {});
      },
    };
  };
  return { send, attach, closed, end, ended: () => over };
}

// A new tab, set to a desktop screen of the given size. Headless Chrome says
// "HeadlessChrome" in its user agent, and some sites answer that with a
// stripped page; the tab says "Chrome", as the same browser with a window
// would. The tab and the kit's connection to it have what the run has left.
async function openPage(chrome, { width, height }) {
  const cdp = await chrome.attach(await chrome.newTab(browserWait()), browserWait());
  await cdp.send("Page.enable");
  cdp.answer = await watchAnswer(cdp);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const { userAgent = "" } = await cdp.send("Browser.getVersion").catch(() => ({}));
  if (userAgent.includes("HeadlessChrome")) {
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: userAgent.replace("HeadlessChrome", "Chrome") });
  }
  return cdp;
}

// What the tab's own page came from, kept up to date as the page moves on:
// the status the server last answered its document with and that address,
// after any redirect, the address of a page the browser could not open and
// shows its own error page for, and whether the page has moved on to
// about:blank, as scripts that guard against DevTools make it do. Frames
// inside the page do not count. The bodies of the responses are not wanted,
// so little of them is kept.
async function watchAnswer(cdp) {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const answer = { status: 0, url: "", unreachable: "", blank: false };
  cdp.on("Network.responseReceived", ({ type, frameId, response }) => {
    if (type === "Document" && frameId === frameTree.frame.id && response) Object.assign(answer, { status: response.status, url: response.url });
  });
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.parentId) return;
    answer.unreachable = /^chrome-error:/.test(frame.url) ? frame.unreachableUrl || frame.url : "";
    answer.blank = frame.url === "about:blank";
  });
  await cdp.send("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 100_000 });
  return answer;
}

// Opens the address and waits for its load event, at most 30 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// Returns the address the tab ended on, after any redirects; cdp.answer says
// what the server answered. An error status with no page of its own makes
// Chrome give a net:: code, which says less than the status, so that is left
// to cdp.answer too.
async function navigate(cdp, url) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  Object.assign(cdp.answer, { status: 0, url: "", unreachable: "", blank: false });
  // A site gets 30 s to answer, or what the run has left: one the kit chose
  // to read that never answers leaves the run time to go on without it.
  const limit = Math.max(1_000, Math.min(30_000, timeLeft()));
  let errorText;
  try {
    ({ errorText } = await cdp.send("Page.navigate", { url }, limit));
  } catch (err) {
    if (!err.timedOut) throw err;
    if (outOfTime()) throw pageFailed(`${url} did not answer before the run's time ran out, so no kit was made. Try again, or give it more time with --timeout.`, "did not answer", true);
    throw pageFailed(`${url} did not answer in ${Math.round(limit / 1_000)} s, so no kit was made. The site may be down or slow: try again later.`, "did not answer");
  }
  if (errorText) {
    if (cdp.answer.status >= 400) return url;
    throw pageFailed(`Could not open ${url}: ${errorText}`, `could not be opened (${errorText})`);
  }
  // The timer goes once the page has loaded, so it does not keep the
  // process up after the kit is done.
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, Math.max(1_000, Math.min(30_000, timeLeft() - 60_000)))));
  // A browser that ends while the page loads sends no load event: the calls
  // that follow find the connection closed and say so at once.
  await Promise.race([loaded, late, cdp.closed]);
  clearTimeout(timer);
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    return (entries[currentIndex] || {}).url || url;
  } catch {
    return url;
  }
}

// A JavaScript world of the kit's own in the tab's main frame. It sees the
// page's document but none of what the page's scripts have done to their own
// world, so what runs in it has the browser's own URL, String.prototype.replace
// and XMLSerializer. A navigation destroys it with its document. Each process
// of the browser numbers its worlds afresh, so the number of a world that has
// gone can come to name another one, the page's own among them: it is forgotten
// the moment the main frame has moved on.
async function ownWorld(cdp) {
  if (cdp.world) return cdp.world;
  if (!cdp.worldWatched) {
    cdp.worldWatched = true;
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) cdp.world = 0;
    });
  }
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "easybrandkit" });
  cdp.world = executionContextId;
  return cdp.world;
}

// What Chrome says when the world a call names has gone with its document,
// which the call can learn before the tab's event about the move arrives.
const WORLD_GONE = /Cannot find context|does not belong to the document|navigated or closed/;

// Calls use with the number of the kit's own world, in a new world when a
// navigation has destroyed the last one. What the page's scripts can change
// is never run instead: a world that cannot be made fails the call.
async function inOwnWorld(cdp, use) {
  for (let tries = 1; ; tries++) {
    try {
      return await use(await ownWorld(cdp));
    } catch (err) {
      if (tries === 3 || !WORLD_GONE.test(err.message)) throw err;
      cdp.world = 0;
    }
  }
}

module.exports = { findChrome, launch, killBrowsers, removeTemps, pipeOf, browserWait, openPage, navigate, inOwnWorld, pageFailed, noKit };
