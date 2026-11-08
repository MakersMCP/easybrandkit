"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol with the WebSocket built into Node 22. Nothing is downloaded.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, sleep } = require("./time");

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

// The folders browsers of Chrome's kind make in the temp folder, by the
// name each one gives them: the one that holds the socket that makes a
// browser one per profile, and those of its URL fetcher, which a browser
// that ends while it fetches leaves empty.
const TEMP_NAME = /^\.?(com\.google\.Chrome|org\.chromium\.Chromium|com\.microsoft\.Edge|com\.brave\.Browser)\./;

function tempNames(temp) {
  try {
    return new Set(fs.readdirSync(temp).filter((name) => TEMP_NAME.test(name)));
  } catch {
    return new Set();
  }
}

// Once a browser has ended: the empty folders of this user's that came in
// the temp folder while it ran. rmdir removes only an empty folder, so one
// that another browser is using keeps its files.
function removeTemps({ temp, before }) {
  const uid = process.getuid ? process.getuid() : null;
  for (const name of tempNames(temp)) {
    if (before.has(name)) continue;
    try {
      const stat = fs.lstatSync(path.join(temp, name));
      if (stat.isDirectory() && (uid === null || stat.uid === uid)) fs.rmdirSync(path.join(temp, name));
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

// A browser's processes on Linux, the browser first: those that descend
// from it, and those whose command line names its profile, as Chrome's
// helpers do, which are found that way also once the browser has ended and
// they belong to no one. Chrome's network service writes into the profile
// as it ends, so the profile can be removed for good only once they are all
// gone. Other systems give none.
function processesOf(child, profile) {
  if (process.platform !== "linux" || !child.pid) return [];
  const tag = path.basename(profile);
  const parentOf = new Map();
  const named = [];
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    const pid = Number(name);
    if (!/^\d+$/.test(name) || pid === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state === "Z" || state === "X") continue;
      parentOf.set(pid, Number(ppid));
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(tag)) named.push(pid);
    } catch {
      // Gone already.
    }
  }
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
  for (const pid of named) found.add(pid);
  return [...found].map((pid) => ({ pid, start: startOf(pid) })).filter(({ start }) => start !== null);
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

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder; the user's own home and browser are untouched.
async function launch({ width, height }) {
  const binary = findChrome();
  if (!binary) {
    throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  }
  const temp = os.tmpdir();
  const before = tempNames(temp);
  const profile = fs.mkdtempSync(path.join(temp, "easybrandkit-chrome-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
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
    { stdio: "ignore" },
  );
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  const entry = { child, profile, temp, before };
  open.add(entry);
  let base = "";
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while. Those still there once it has
  // quit are killed, and the profile is removed once they are gone. A
  // profile that still cannot be removed is left in the temp folder; the
  // kit is not lost over it.
  const close = async () => {
    // Its helpers name the profile, so they are found even when the browser
    // itself has ended, as one that could not start has.
    const processes = processesOf(child, profile);
    if (base && !exited) {
      let asked = false;
      try {
        const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) })).json();
        const browser = await connect(webSocketDebuggerUrl);
        asked = true;
        await browser.send("Browser.close", {}, 3_000).catch(() => {});
      } catch {
        // Not answering: it is killed below.
      }
      for (let i = 0; i < 50 && asked && !exited; i++) await sleep(100);
    }
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    killAll(processes);
    for (let i = 0; i < 50 && !allGone(processes); i++) await sleep(20);
    open.delete(entry);
    removeSingleton(profile);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Left for the system's temp clean-up.
    }
    removeTemps(entry);
  };
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let waited = 0; waited < 20_000 && !exited; waited += 100) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) {
        base = `http://127.0.0.1:${port}`;
        return { base, close };
      }
    } catch {
      // Not written yet.
    }
    await sleep(100);
  }
  await close();
  throw new Error(`${path.basename(binary)} did not start. Try again, or point CHROME_PATH at another browser.`);
}

// Chrome keeps the socket that makes it one browser per profile in a folder
// of its own in the temp folder, linked from the profile, and removes it
// only when it quits. Killed, it leaves it: removed here, those two names
// only.
function removeSingleton(profile) {
  try {
    const folder = path.dirname(fs.readlinkSync(path.join(profile, "SingletonSocket")));
    for (const name of ["SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(folder, name), { force: true });
    fs.rmdirSync(folder);
  } catch {
    // None, or Chrome removed it as it quit.
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Every browser still open, killed at once with its helpers, and its
// profile and temp folders removed: for a process that is being stopped
// and has no time to ask them to quit. It never throws.
function killBrowsers() {
  const ending = [...open];
  open.clear();
  for (const entry of ending) {
    entry.processes = processesOf(entry.child, entry.profile);
    try {
      entry.child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
    killAll(entry.processes);
  }
  // Until they are gone, a second at most.
  for (let waited = 0; waited < 1_000 && !ending.every(({ processes }) => allGone(processes)); waited += 20) pause(20);
  for (const { profile } of ending) removeSingleton(profile);
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

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg && msg.method) {
        for (const listener of listeners.get(msg.method) || []) listener(msg.params || {});
        return;
      }
      const waiter = msg && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || "DevTools protocol error"));
      else waiter.resolve(msg.result || {});
    };
    ws.onerror = () => reject(new Error("The browser connection failed."));
    ws.onclose = () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("The browser connection closed."));
      }
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 30_000) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timed out`));
            }, Math.max(1_000, Math.min(timeoutMs, timeLeft())));
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, listener) {
          listeners.set(method, [...(listeners.get(method) || []), listener]);
        },
        close() {
          ws.close();
        },
      });
  });
}

// A new tab, set to a desktop screen of the given size. Headless Chrome says
// "HeadlessChrome" in its user agent, and some sites answer that with a
// stripped page; the tab says "Chrome", as the same browser with a window
// would.
async function openPage(base, { width, height }) {
  const res = await fetch(`${base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(10_000) });
  const target = await res.json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const { userAgent = "" } = await cdp.send("Browser.getVersion").catch(() => ({}));
  if (userAgent.includes("HeadlessChrome")) {
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: userAgent.replace("HeadlessChrome", "Chrome") });
  }
  return cdp;
}

// Opens the address and waits for its load event, at most 30 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// Returns the address the tab ended on, after any redirects.
async function navigate(cdp, url) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  const { errorText } = await cdp.send("Page.navigate", { url });
  if (errorText) throw new Error(`Could not open ${url}: ${errorText}`);
  // The timer goes once the page has loaded, so it does not keep the
  // process up after the kit is done.
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, Math.max(1_000, Math.min(30_000, timeLeft() - 60_000)))));
  await Promise.race([loaded, late]);
  clearTimeout(timer);
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    return (entries[currentIndex] || {}).url || url;
  } catch {
    return url;
  }
}

module.exports = { findChrome, launch, killBrowsers, connect, openPage, navigate };
