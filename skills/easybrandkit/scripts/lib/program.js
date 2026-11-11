"use strict";

// The browser's program, found and looked at before it is started. The
// checks here are only those whose answer is certain: nothing there, a
// folder, a link that leads to nothing or round a loop, a path through a
// file, a folder on the way this user may not enter, and a file this user
// may not run, as on a disk mounted noexec. What a program that passes them
// does once it is started is told by what it printed and how it ended (see
// launch in chrome.js), never guessed from its file.

const fs = require("fs");
const path = require("path");
const util = require("util");

const WINDOWS = process.platform === "win32";

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS_PLACES = [
  ["PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"],
];

// The words makersmcp's playbooks know these by: none found, and one found
// that did not start.
const NONE = "No Chrome, Chromium, Edge or Brave found";
const FIX_SET = "Point CHROME_PATH at the program of a Chrome, Chromium, Edge or Brave that runs, or unset it.";
const FIX_FOUND = "Install Chrome, Chromium, Edge or Brave, or point CHROME_PATH at one that runs.";

// A name with no folder in it, which the system looks up on PATH.
const bare = (value) => !(value.includes("/") || (WINDOWS && value.includes("\\")));

// The mount point of the disk mounted noexec that the file at `at`, a real
// path, is on: "" when it is on none, or off Linux, from the kernel's own
// list of this process's mounts.
function noexecMount(at) {
  if (process.platform !== "linux") return "";
  let lines;
  try {
    lines = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  } catch {
    return "";
  }
  let found = null;
  for (const line of lines) {
    const fields = line.split(" ");
    if (fields.length < 6) continue;
    const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const within = at === point || at.startsWith(point === "/" ? "/" : `${point}/`);
    // A later mount on the same point hides the earlier one.
    if (within && (!found || point.length >= found.point.length)) found = { point, options: fields[5].split(",") };
  }
  return found && found.options.includes("noexec") ? found.point : "";
}

// The first folder on the way to `at` that this user may not enter, or "".
function lockedOnTheWay(at) {
  const parts = path.resolve(at).split(path.sep);
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      fs.accessSync(dir, fs.constants.X_OK);
    } catch {
      return dir;
    }
  }
  return "";
}

// The first part of the way to `at` that is a file and not a folder, or "".
function fileOnTheWay(at) {
  const parts = path.resolve(at).split(path.sep);
  for (let i = 2; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join(path.sep);
    try {
      if (!fs.statSync(prefix).isDirectory()) return prefix;
    } catch {
      return "";
    }
  }
  return "";
}

// Where a link at `at` that leads to nothing leads: the path, after any
// links on the way, where nothing is. "" when `at` is no link.
function leadsTo(at) {
  let link = at;
  for (let hops = 0; hops < 40; hops++) {
    let target;
    try {
      target = fs.readlinkSync(link);
    } catch {
      return hops ? link : "";
    }
    let base;
    try {
      base = fs.realpathSync(path.dirname(link));
    } catch {
      return "";
    }
    const next = path.resolve(base, target);
    if (!fs.lstatSync(next, { throwIfNoEntry: false })) return next;
    link = next;
  }
  return "";
}

// What is wrong with the file at `at` as a program to start, in words that
// follow it after a comma: "" when nothing is, that is when it is a file
// this user may run. Off Linux and macOS, a file is all a program has to be.
function wrongWith(at) {
  let stat;
  try {
    stat = fs.statSync(at);
  } catch (err) {
    if (err.code === "ELOOP") return "a link that leads round in a loop";
    if (err.code === "ENOTDIR") {
      const file = fileOnTheWay(at);
      return file ? `a path through ${file}, which is a file, not a folder` : "a path through a file, not a folder";
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      const dir = lockedOnTheWay(at);
      return dir ? `inside ${dir}, which this user may not enter` : "a path this user may not follow";
    }
    if (err.code === "ENOENT") {
      const end = leadsTo(at);
      return end ? `a link to ${end}, which is not there` : "and there is nothing there";
    }
    return `a path the system cannot look at (${err.code || err.message})`;
  }
  if (stat.isDirectory()) return "a folder, not a program";
  if (!stat.isFile()) return "not a file, so not a program";
  if (WINDOWS) return "";
  try {
    fs.accessSync(at, fs.constants.X_OK);
    return "";
  } catch {
    // Not this user's to run.
  }
  let real = at;
  try {
    real = fs.realpathSync(at);
  } catch {
    // Looked at as given.
  }
  const mount = noexecMount(real);
  return mount ? `a file on ${mount}, a disk mounted noexec, from which no program may be run` : "a file this user may not run";
}

// The program called `name` on PATH, the way the system looks it up: the
// first one this user may run, past those it may not. { file } for that
// one, and { seen }, each match before it that it may not run, with what is
// wrong with it.
function lookOnPath(name, folders = process.env.PATH) {
  const seen = [];
  for (const dir of String(folders || "").split(path.delimiter)) {
    if (!dir) continue;
    const at = path.resolve(dir, name);
    if (!fs.lstatSync(at, { throwIfNoEntry: false })) continue;
    const what = wrongWith(at);
    if (!what) return { file: at, seen };
    seen.push({ file: at, what });
  }
  return { file: "", seen };
}

// The browser a run starts: { file, name, value, subject } (value is
// CHROME_PATH as given, when it is set, and subject names the program in a
// message, as in "<subject> ended before it answered"), or an error that
// says what is wrong, before the browser is started. CHROME_PATH names it by
// a path, or by a name on PATH; else it is the first one this user may run
// of those looked for.
function browserPlace() {
  const value = process.env.CHROME_PATH;
  if (value) {
    if (bare(value)) {
      const { file, seen } = lookOnPath(value);
      if (file) return { file, name: value, value, subject: `CHROME_PATH is ${value}, found on your PATH at ${file}, which` };
      if (!seen.length) throw new Error(`${NONE}: CHROME_PATH is ${value}, which is not on your PATH. ${FIX_SET}`);
      throw new Error(`${value} did not start: CHROME_PATH is ${value}, found on your PATH at ${seen[0].file}, ${seen[0].what}. ${FIX_SET}`);
    }
    const file = path.resolve(value);
    const what = wrongWith(file);
    if (!what) return { file, name: path.basename(file), value, subject: `CHROME_PATH is ${value}, which` };
    if (what === "and there is nothing there") throw new Error(`${NONE}: CHROME_PATH is ${value}, ${what}. ${FIX_SET}`);
    throw new Error(`${path.basename(file)} did not start: CHROME_PATH is ${value}, ${what}. ${FIX_SET}`);
  }
  const seen = [];
  if (process.platform === "darwin" || WINDOWS) {
    const places = WINDOWS ? WINDOWS_PLACES.filter(([root]) => process.env[root]).map(([root, rest]) => path.join(process.env[root], rest)) : MAC;
    for (const file of places) {
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
      const subject = `the browser at ${file}`;
      const what = wrongWith(file);
      if (!what) return { file, name: path.basename(file), subject };
      seen.push({ file, what, subject });
    }
  } else {
    for (const name of LINUX) {
      const found = lookOnPath(name);
      if (found.file) return { file: found.file, name, subject: `the ${name} on your PATH, ${found.file},` };
      seen.push(...found.seen.map((one) => ({ ...one, subject: `the ${name} on your PATH, ${one.file},` })));
    }
  }
  // In the words makersmcp's playbooks quote whole.
  if (!seen.length) throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  // A file that was found is there, so what is wrong with it follows "is".
  const [{ file, what, subject }] = seen;
  throw new Error(`${path.basename(file)} did not start: ${subject} is ${what}. ${FIX_FOUND}`);
}

// The system's own words for an error it gave as it was asked to start a
// program, by its code: "no such file or directory (ENOENT)".
function systemWords(err) {
  const known = typeof err.errno === "number" ? util.getSystemErrorMap().get(err.errno) : null;
  const code = err.code || (known && known[0]) || "";
  const words = known ? known[1] : String(err.message || err).replace(/^spawn\s+\S+\s+/, "");
  return code && words !== code ? `${words} (${code})` : words || code;
}

// The errors that say the system is short of something to start a program
// with, which another browser would not help with: what it is short of, and
// what to do instead.
const SHORT = {
  EMFILE: "this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again",
  ENFILE: "the system has as many files open as it may (file table overflow). Close some programs and run it again",
  EAGAIN: "the system would not start another process for this user now (resource temporarily unavailable). Let some programs end and run it again",
  ENOMEM: "the system had no memory left to start it (not enough memory). Close some programs and run it again",
};

// The message for a browser the system could not start at all, as it gave
// `err` for it.
function couldNotStart(place, err) {
  if (SHORT[err.code]) return `${place.name} did not start: easybrandkit could not start ${place.file}, as ${SHORT[err.code]}.`;
  return `${place.name} did not start: ${place.subject} could not be started: ${systemWords(err)}. ${place.value ? FIX_SET : FIX_FOUND}`;
}

// Lines Chrome prints as it starts whatever ends it, which say nothing of
// why it ended: those of its D-Bus code, as on every start with no session
// bus to reach, the one the kit gives it on Linux (see launch in chrome.js)
// or none at all, as on a server; those of its crash handler; and the one
// that says which channel it read from CHROME_VERSION_EXTRA. Chrome names
// the file a line comes from by its folders and line (dbus/bus.cc:405), and
// older versions by its name alone (bus.cc(407)).
const NOISE = /^\[[^\]]*:(?:(?:dbus|components\/dbus|third_party\/crashpad)\/[^\]]*|(?:bus|object_proxy|file_io_posix)\.cc\(\d+\))\]|^\[[^\]]*\] Read channel \S+ from \S*CHROME_VERSION_EXTRA$/;

// Chrome's own words for what kept it from starting that another browser
// would not help with, and what to do then: its sandbox could not start, in
// each way it says so, or the system or this process had as many files
// open as they may.
const SAID = [
  [/No usable sandbox|SUID sandbox helper binary was found, but is not configured correctly|setuid sandbox: failed to move to new namespaces|^Failed to move to new namespace/, "Its sandbox could not start: on Linux a browser's own package sets the sandbox up, and a container has to let it start, as Docker does with --security-opt seccomp=unconfined."],
  [/Too many open files in system/, "The system had as many files open as it may: close some programs and run it again."],
  [/Too many open files/, "The browser had as many files open as it may: raise that limit, as ulimit -n does, and run it again."],
];

// The line of what a program printed that says the most of why it ended:
// the first that holds words of SAID, else the first that is not one of
// Chrome's NOISE, else the first, each trimmed; "" when it printed nothing.
function tellingLine(output) {
  const lines = String(output || "").split("\n").map((one) => one.trim()).filter(Boolean);
  const telling = lines.filter((one) => !NOISE.test(one));
  return telling.find((one) => SAID.some(([words]) => words.test(one))) || telling[0] || lines[0] || "";
}

// That line of what a program printed, quoted as it is: cut to about 200
// characters, and its control characters written out.
function firstLine(output) {
  const line = tellingLine(output);
  if (!line) return "";
  const cut = line.length > 200 ? `${line.slice(0, 200)}...` : line;
  return cut.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

// The message for a browser that ended before it answered on its pipe: the
// line it printed that says the most, its exit status or the signal that
// stopped it, and what to do, as that line says when it is one of SAID.
function endedEarly(place, { output = "", code = null, signal = null }) {
  const line = firstLine(output);
  const exited = code !== null && code !== undefined;
  const end = exited ? `exited with ${code}` : signal ? `was stopped by ${signal}` : "ended";
  const what = line ? `it printed "${line}" and ${end}` : exited ? `it printed nothing and ${end}` : `it ${end}`;
  const [, fix = place.value ? FIX_SET : FIX_FOUND] = SAID.find(([words]) => words.test(tellingLine(output))) || [];
  return `${place.name} did not start: ${place.subject} ended before it answered: ${what}. ${fix}`;
}

// Whether the browser at `file` is one installed as a snap or a Flatpak,
// which runs in a sandbox of its own: snap's own program, where the links in
// /snap/bin lead, or one under /snap/, or one in a Flatpak's folders, as the
// links in its exports/bin and the app folder they lead to are.
function ownSandbox(file) {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    // Looked at as given.
  }
  return [file, real].some((at) => at === "/usr/bin/snap" || at.startsWith("/snap/") || /\/flatpak\/(exports|app)\//.test(at));
}

module.exports = { browserPlace, wrongWith, lookOnPath, noexecMount, couldNotStart, endedEarly, firstLine, systemWords, ownSandbox, NONE };
