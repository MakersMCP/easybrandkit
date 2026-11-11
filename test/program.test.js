"use strict";

// A browser that cannot be started: told before any work by what is certain
// of its path, and, once started, by what it printed and how it ended. Each
// case runs the real CLI, which must stop before it reads anything, exit 1,
// leave no folder for the kit and nothing in the temp folder.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { wrongWith, lookOnPath, noexecMount, firstLine, browserPlace, ownSandbox } = require("../skills/easybrandkit/scripts/lib/program");

const CLI = path.resolve(__dirname, "../skills/easybrandkit/scripts/easybrandkit.js");
const linux = process.platform === "linux";
const root = process.getuid && process.getuid() === 0;
const skip = (!linux && "the cases are built for Linux") || (root && "root may run and read any file");

// A folder of the test's own, and a temp folder in it for the run, short
// enough for Chrome's socket.
function place(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ebk-start-"));
  t.after(() => {
    for (const at of [parent, ...walk(parent)]) {
      try {
        if (!fs.lstatSync(at).isSymbolicLink()) fs.chmodSync(at, 0o700);
      } catch {
        // Gone, or a link.
      }
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(parent, "temp"));
  return parent;
}

function walk(dir) {
  const found = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      found.push(at);
      if (entry.isDirectory()) found.push(...walk(at));
    }
  } catch {
    // Locked.
  }
  return found;
}

// The CLI run with a browser that cannot be started: what it said, and what
// it left. env adds to the test's own environment.
function run(parent, env) {
  const out = path.join(parent, "kit");
  const cli = spawnSync(process.execPath, [CLI, "http://127.0.0.1:9/", "--no-stores", "--out", out], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: path.join(parent, "temp"), ...env } });
  return { status: cli.status, stderr: cli.stderr, stdout: cli.stdout, out: fs.existsSync(out), temp: fs.readdirSync(path.join(parent, "temp")) };
}

// What every case has in common: the run stops at once with one line that
// starts with what makersmcp's playbooks know, having made nothing.
function stoppedBeforeAnyWork(result, line) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, `easybrandkit: ${line}\n`);
  assert.equal(result.stdout, "");
  assert.equal(result.out, false, "no folder for the kit");
  assert.deepEqual(result.temp, [], "nothing in the temp folder");
}

// Text as a regular expression that matches it as it is.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SET = "Point CHROME_PATH at the program of a Chrome, Chromium, Edge or Brave that runs, or unset it.";
const FOUND = "Install Chrome, Chromium, Edge or Brave, or point CHROME_PATH at one that runs.";

test("a CHROME_PATH the system cannot start is told by what is certain of its path, before any work", { skip }, (t) => {
  const parent = place(t);
  const at = (...names) => path.join(parent, ...names);
  const write = (name, body, mode = 0o755) => {
    fs.writeFileSync(at(name), body);
    fs.chmodSync(at(name), mode);
    return at(name);
  };
  // Nothing there, a folder, a link to a folder, a link to nothing, a loop
  // of links and a path through a file.
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("nothing") }), `No Chrome, Chromium, Edge or Brave found: CHROME_PATH is ${at("nothing")}, and there is nothing there. ${SET}`);
  fs.mkdirSync(at("Chrome.app"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("Chrome.app") }), `Chrome.app did not start: CHROME_PATH is ${at("Chrome.app")}, a folder, not a program. ${SET}`);
  fs.symlinkSync(at("Chrome.app"), at("to-folder"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("to-folder") }), `to-folder did not start: CHROME_PATH is ${at("to-folder")}, a folder, not a program. ${SET}`);
  fs.symlinkSync(at("gone", "chrome"), at("dangling"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("dangling") }), `dangling did not start: CHROME_PATH is ${at("dangling")}, a link to ${at("gone", "chrome")}, which is not there. ${SET}`);
  fs.symlinkSync(at("loop-b"), at("loop-a"));
  fs.symlinkSync(at("loop-a"), at("loop-b"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("loop-a") }), `loop-a did not start: CHROME_PATH is ${at("loop-a")}, a link that leads round in a loop. ${SET}`);
  write("afile", "x");
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("afile", "chrome") }), `chrome did not start: CHROME_PATH is ${at("afile", "chrome")}, a path through ${at("afile")}, which is a file, not a folder. ${SET}`);
  // A file without the execute bit, one whose execute bits are not this
  // user's, and one inside a folder this user may not enter.
  write("plain", "#!/bin/sh\nexit 0\n", 0o644);
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("plain") }), `plain did not start: CHROME_PATH is ${at("plain")}, a file this user may not run. ${SET}`);
  write("others", "#!/bin/sh\nexit 0\n", 0o055);
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("others") }), `others did not start: CHROME_PATH is ${at("others")}, a file this user may not run. ${SET}`);
  fs.mkdirSync(at("locked"));
  write(path.join("locked", "chrome"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(at("locked"), 0o000);
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: at("locked", "chrome") }), `chrome did not start: CHROME_PATH is ${at("locked", "chrome")}, inside ${at("locked")}, which this user may not enter. ${SET}`);
  fs.chmodSync(at("locked"), 0o700);
  // A name that is not on PATH, and one whose only match there is a folder.
  fs.mkdirSync(at("bin", "no-such-browser"), { recursive: true });
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: "no-such-browser-at-all" }), `No Chrome, Chromium, Edge or Brave found: CHROME_PATH is no-such-browser-at-all, which is not on your PATH. ${SET}`);
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: "no-such-browser", PATH: `${at("bin")}:${process.env.PATH}` }), `no-such-browser did not start: CHROME_PATH is no-such-browser, found on your PATH at ${at("bin", "no-such-browser")}, a folder, not a program. ${SET}`);
});

test("a browser looked up on PATH is the first one this user may run, as the system finds it, and one that cannot be is named", { skip }, (t) => {
  const parent = place(t);
  const at = (...names) => path.join(parent, ...names);
  // A folder by a browser's name first on PATH is passed over, as the
  // system passes over it, and the program after it is the one started.
  fs.mkdirSync(at("first", "google-chrome"), { recursive: true });
  fs.mkdirSync(at("second"));
  fs.writeFileSync(at("second", "google-chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { file, seen } = lookOnPath("google-chrome", `${at("first")}:${at("second")}`);
  assert.equal(file, at("second", "google-chrome"));
  assert.deepEqual(seen, [{ file: at("first", "google-chrome"), what: "a folder, not a program" }]);
  // With no CHROME_PATH and no browser this user may run, the first match
  // that cannot be run is named; with none at all, the words of before.
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: "", PATH: at("first") }), `google-chrome did not start: the google-chrome on your PATH, ${at("first", "google-chrome")}, is a folder, not a program. ${FOUND}`);
  fs.mkdirSync(at("empty"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: "", PATH: at("empty") }), "No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
});

test("a CHROME_PATH that the system starts and that ends before it answers is told by its first line and how it ended", { skip }, (t) => {
  const parent = place(t);
  const at = (...names) => path.join(parent, ...names);
  const write = (name, body, mode = 0o755) => {
    fs.writeFileSync(at(name), body);
    fs.chmodSync(at(name), mode);
    return at(name);
  };
  const said = (file, what) => `${path.basename(file)} did not start: CHROME_PATH is ${file}, which ended before it answered: ${what}. ${SET}`;
  // A script that says why it stops, its first line quoted as it printed it,
  // a blank line before it skipped, and its control characters written out.
  const script = write("wrapper", `#!/bin/sh\necho\necho "  the wrapper could not find \\033[1mchrome\\033[0m  " >&2\necho "second line"\nexit 3\n`);
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: script }), said(script, `it printed "the wrapper could not find \\x1b[1mchrome\\x1b[0m" and exited with 3`));
  // An empty file, which the system runs with /bin/sh, does nothing and
  // exits 0, and a text file with no #! line, which the shell reads.
  const empty = write("empty", "");
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: empty }), said(empty, "it printed nothing and exited with 0"));
  // The shell's own words for it, dash's or bash's.
  const text = write("text", "not a program\n");
  const read = run(parent, { CHROME_PATH: text });
  const [before, after] = said(text, "WORDS").split("WORDS");
  assert.match(read.stderr, new RegExp(`^easybrandkit: ${escape(before)}it printed "${escape(text)}: (line )?1: not: (command )?not found" and exited with 127${escape(after)}\n$`));
  stoppedBeforeAnyWork(read, read.stderr.slice("easybrandkit: ".length, -1));
  // One stopped by a signal, with nothing printed.
  const killed = write("killed", "#!/bin/sh\nkill -SEGV $$\n");
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: killed }), said(killed, "it was stopped by SIGSEGV"));
  // A script whose #! line names a program that is not there: the system
  // cannot start it at all, and says so in its own words.
  const missing = write("missing-interpreter", "#!/no/such/shell\nexit 0\n");
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: missing }), `missing-interpreter did not start: CHROME_PATH is ${missing}, which could not be started: no such file or directory (ENOENT). ${SET}`);
  // A long first line is cut.
  const long = write("long", `#!/bin/sh\necho ${"x".repeat(300)}\nexit 1\n`);
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: long }), said(long, `it printed "${"x".repeat(200)}..." and exited with 1`));
});

test("a program for another machine, or one whose loader or library is missing, is told by what the system and the program said", { skip }, (t) => {
  const parent = place(t);
  const at = (...names) => path.join(parent, ...names);
  const real = fs.readFileSync(fs.realpathSync("/bin/true"));
  const swap = (from, to) => {
    const i = real.indexOf(from);
    if (i < 0 || from.length !== to.length) return null;
    const out = Buffer.from(real);
    out.write(to, i, "latin1");
    return out;
  };
  const put = (name, bytes) => {
    fs.writeFileSync(at(name), bytes, { mode: 0o755 });
    return at(name);
  };
  const said = (file, what) => `${path.basename(file)} did not start: CHROME_PATH is ${file}, which ended before it answered: ${what}. ${SET}`;
  // An ARM program on this machine, which the system hands to /bin/sh.
  const arm = Buffer.from(real);
  arm.writeUInt16LE(arm.readUInt16LE(0x12) === 0xb7 ? 0x3e : 0xb7, 0x12);
  const foreign = run(parent, { CHROME_PATH: put("arm", arm) });
  assert.match(foreign.stderr, new RegExp(`^easybrandkit: arm did not start: CHROME_PATH is ${escape(at("arm"))}, which ended before it answered: it printed "${escape(at("arm"))}: (line )?\\d+: .+" and exited with \\d+\\. `));
  stoppedBeforeAnyWork(foreign, foreign.stderr.slice("easybrandkit: ".length, -1));
  // A program whose loader is not there: the system cannot start it.
  const loader = swap("/lib64/ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.9") || swap("/lib/ld-linux-aarch64.so.1", "/lib/ld-linux-aarch64.so.9");
  if (loader) stoppedBeforeAnyWork(run(parent, { CHROME_PATH: put("noloader", loader) }), `noloader did not start: CHROME_PATH is ${at("noloader")}, which could not be started: no such file or directory (ENOENT). ${SET}`);
  // One that needs a library that is not there: the loader says which.
  const library = swap("libc.so.6", "libq.so.6");
  if (library) {
    const file = put("nolibrary", library);
    stoppedBeforeAnyWork(run(parent, { CHROME_PATH: file }), said(file, `it printed "${file}: error while loading shared libraries: libq.so.6: cannot open shared object file: No such file or directory" and exited with 127`));
  }
});

test("a run with no file left to open to start the browser says so, and to raise the limit", { skip }, (t) => {
  const parent = place(t);
  // Each limit low enough for the browser's start, and not for Node's own:
  // one of them leaves the kit's start short of files, and none ends in a
  // crash or leaves anything.
  const said = "true did not start: easybrandkit could not start /bin/true, as this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.";
  let told = 0;
  for (let limit = 16; limit <= 40; limit++) {
    const cli = spawnSync("sh", ["-c", `ulimit -n ${limit} && exec "$0" "$1" http://127.0.0.1:9/ --no-stores --out "$2"`, process.execPath, CLI, path.join(parent, "kit")], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: path.join(parent, "temp"), CHROME_PATH: "/bin/true" } });
    assert.doesNotMatch(cli.stderr, /Unhandled|TypeError|at .*\.js:\d+/, `limit ${limit}`);
    assert.deepEqual(fs.readdirSync(path.join(parent, "temp")), [], `limit ${limit}`);
    assert.equal(fs.existsSync(path.join(parent, "kit")), false, `limit ${limit}`);
    if (cli.stderr === `easybrandkit: ${said}\n`) told++;
  }
  assert.ok(told > 0, "no limit left the browser's start short of files");
});

test("a file on a disk mounted noexec is told as that", { skip: skip || (spawnSync("unshare", ["-rm", "true"]).status !== 0 && "no user and mount namespace here") }, (t) => {
  const parent = place(t);
  const disk = path.join(parent, "disk");
  fs.mkdirSync(disk);
  // In a mount namespace of its own, a tmpfs mounted noexec, with a program
  // on it that would run anywhere else.
  const script = `mount -t tmpfs -o noexec tmpfs "$1" && printf '#!/bin/sh\\nexit 0\\n' > "$1/chrome" && chmod 755 "$1/chrome" && CHROME_PATH="$1/chrome" exec "$2" "$3" http://127.0.0.1:9/ --no-stores --out "$4"`;
  const cli = spawnSync("unshare", ["-rm", "sh", "-c", script, "sh", disk, process.execPath, CLI, path.join(parent, "kit")], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: path.join(parent, "temp") } });
  stoppedBeforeAnyWork({ status: cli.status, stderr: cli.stderr, stdout: cli.stdout, out: fs.existsSync(path.join(parent, "kit")), temp: fs.readdirSync(path.join(parent, "temp")) }, `chrome did not start: CHROME_PATH is ${path.join(disk, "chrome")}, a file on ${disk}, a disk mounted noexec, from which no program may be run. ${SET}`);
});

test("a browser that cannot be started stops a run before anything is fetched, a store listing too", async (t) => {
  const { makeKit } = require("../skills/easybrandkit/scripts/lib/kit");
  const parent = place(t);
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = path.join(parent, "nothing");
  t.after(() => {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  });
  // The listing would be read first if the browser were started only once a
  // page needs it: nothing at all is asked of the network.
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    fetched.push(String(url));
    throw new Error("no network in this test");
  });
  const kit = path.join(parent, "kit");
  await assert.rejects(makeKit("https://apps.apple.com/us/app/acme/id1234567890", { dir: kit }), (err) => err.message === `No Chrome, Chromium, Edge or Brave found: CHROME_PATH is ${path.join(parent, "nothing")}, and there is nothing there. ${SET}`);
  assert.deepEqual(fetched, []);
  assert.equal(fs.existsSync(kit), false);
  assert.deepEqual(fs.readdirSync(parent).sort(), ["temp"]);
});

test("the certain checks, and the first line, by themselves", { skip: !linux && "Linux paths" }, () => {
  assert.equal(wrongWith(process.execPath), "");
  assert.equal(wrongWith("/"), "a folder, not a program");
  assert.equal(wrongWith("/dev/null"), "not a file, so not a program");
  assert.equal(noexecMount("/proc/self/status"), "/proc");
  assert.equal(noexecMount(fs.realpathSync(process.execPath)), "");
  assert.equal(firstLine("\n\n  \t first  \n second"), "first");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("a\x00b\x7fc\x9b"), "a\\x00b\\x7fc\\x9b");
  const saved = process.env.CHROME_PATH;
  try {
    process.env.CHROME_PATH = process.execPath;
    assert.deepEqual(browserPlace(), { file: process.execPath, name: path.basename(process.execPath), value: process.execPath, subject: `CHROME_PATH is ${process.execPath}, which` });
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  }
});

test("a browser installed as a snap or a Flatpak is told from its path", () => {
  assert.equal(ownSandbox("/snap/bin/chromium"), true);
  assert.equal(ownSandbox("/snap/chromium/3235/usr/lib/chromium-browser/chrome"), true);
  assert.equal(ownSandbox("/usr/bin/snap"), true);
  assert.equal(ownSandbox("/var/lib/flatpak/exports/bin/org.chromium.Chromium"), true);
  assert.equal(ownSandbox("/home/someone/.local/share/flatpak/exports/bin/com.google.Chrome"), true);
  assert.equal(ownSandbox("/usr/bin/google-chrome-stable-not-there"), false);
  assert.equal(ownSandbox(process.execPath), false);
});

test("a browser that ends before it answers is told by the line that says why, past the lines Chrome prints on every start", { skip }, (t) => {
  const parent = place(t);
  const at = (...names) => path.join(parent, ...names);
  const write = (name, body) => {
    fs.writeFileSync(at(name), body, { mode: 0o755 });
    return at(name);
  };
  const said = (file, what, fix = SET) => `${path.basename(file)} did not start: CHROME_PATH is ${file}, which ended before it answered: ${what}. ${fix}`;
  // Where it finds no session bus, as the kit starts it on Linux, Chrome
  // prints its D-Bus lines first, its crash handler and its version their
  // own: none of them says why it ended.
  const bus = `[1:2:1111/071329.445107:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")`;
  // Older versions name the file a line comes from by its name alone.
  const noise = [
    bus,
    "[1:1:1111/071329.445200:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ",
    "[1111/071329.411681:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq: No such file or directory (2)",
    "[1:1:1111/071329.400000:WARNING:chrome/app/chrome_main_linux.cc:84] Read channel stable from /opt/google/chrome/CHROME_VERSION_EXTRA",
    "[1:2:0101/000000.000000:ERROR:bus.cc(407)] Failed to connect to the bus: Failed to connect to socket /run/dbus/system_bus_socket: No such file or directory",
    "[0101/000000.000000:ERROR:file_io_posix.cc(144)] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq: No such file or directory (2)",
  ];
  const printing = (lines, end) => `#!/bin/sh\ncat >&2 <<'LINES'\n${lines.join("\n")}\nLINES\n${end}\n`;
  const cause = "[1:3:1111/071329.445300:ERROR:components/viz/service/main/viz_main_impl.cc:189] Exiting GPU process due to errors during initialization";
  const plain = write("plain-cause", printing([...noise, cause], "exit 4"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: plain }), said(plain, `it printed "${cause}" and exited with 4`));
  // A browser with as many files open as it may says so, and so does the
  // run, with what to do instead of another browser.
  const files = "[1:4:1111/071357.377137:ERROR:base/memory/platform_shared_memory_region_posix.cc:335] Creating shared memory in /dev/shm/.com.google.Chrome.gBBtMi failed: Too many open files (24)";
  const short = write("short-of-files", printing([...noise, "[1:5:1111/071357.377777:ERROR:device/udev_linux/udev_watcher.cc:51] Failed to initialize a udev monitor.", files], "kill -ABRT $$"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: short }), said(short, `it printed "${files}" and was stopped by SIGABRT`, "The browser had as many files open as it may: raise that limit, as ulimit -n does, and run it again."));
  const table = "[1:4:1111/071357.377137:ERROR:base/files/file_util_posix.cc:12] open /proc/self/status: Too many open files in system (23)";
  const full = write("system-full", printing([bus, table], "exit 1"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: full }), said(full, `it printed "${table}" and exited with 1`, "The system had as many files open as it may: close some programs and run it again."));
  // One whose sandbox could not start, as in a container that does not let
  // it: another browser would not start either.
  const sandbox = "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted";
  const boxed = write("no-sandbox", printing([bus, sandbox, "[1:1:1111/044331.800000:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:202] Check failed: . : Invalid argument (22)"], "kill -TRAP $$"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: boxed }), said(boxed, `it printed "${sandbox}" and was stopped by SIGTRAP`, "Its sandbox could not start: on Linux a browser's own package sets the sandbox up, and a container has to let it start, as Docker does with --security-opt seccomp=unconfined."));
  // Nothing but those lines: the first is quoted.
  const only = write("only-noise", printing([bus], "exit 5"));
  stoppedBeforeAnyWork(run(parent, { CHROME_PATH: only }), said(only, `it printed "${bus}" and exited with 5`));
  // As the lines come by themselves.
  assert.equal(firstLine(`${noise.join("\n")}\n  the cause  \nlater`), "the cause");
  assert.equal(firstLine(noise.slice(2).join("\n")), noise[2]);
});

test("a name in CHROME_PATH is looked for on Windows with .com and .exe after it, as Windows looks for it", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ebk-names-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const bin = path.join(parent, "bin");
  fs.mkdirSync(bin);
  for (const name of ["chrome.exe", "msedge.com", "msedge.exe", "brave"]) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
  const folders = `${path.join(parent, "none")};${bin}`;
  assert.equal(lookOnPath("chrome", folders, true).file, path.join(bin, "chrome.exe"));
  assert.equal(lookOnPath("chrome.exe", folders, true).file, path.join(bin, "chrome.exe"));
  assert.equal(lookOnPath("msedge", folders, true).file, path.join(bin, "msedge.com"));
  // A name with no extension is not taken as it is there, as Windows does
  // not start such a file by that name.
  assert.equal(lookOnPath("brave", folders, true).file, "");
  // Elsewhere a name is looked for as it is.
  if (linux) {
    assert.equal(lookOnPath("chrome", bin, false).file, "");
    assert.equal(lookOnPath("brave", bin, false).file, path.join(bin, "brave"));
  }
});
