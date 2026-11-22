"use strict";

// Runs code in a process of its own and holds the work it did to a bound:
// the CPU time the process took, its threads together (process.cpuUsage, as
// it ends), so that a busy machine, which only gives the process its turns
// later, fails no test (kit lesson 8.17). A pattern stuck on a long run of
// one character cannot be interrupted from here and would hold up every
// test, so a process that has not ended after far longer than the bound,
// by the clock, is killed and fails.

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LIB = path.resolve(__dirname, "../skills/easybrandkit/scripts/lib");

// What the process says of its CPU time as it ends, on stderr, after
// anything else it printed there.
const REPORT = `process.on("exit", () => { const { user, system } = process.cpuUsage(); require("fs").writeSync(2, "\\ncpu " + Math.round((user + system) / 1_000) + " ms\\n"); });`;

// The clock's bound, past which a process is taken for one that never ends.
const WALL = 6;

function endsInTime(code, ms = 20_000) {
  const done = spawnSync(process.execPath, ["-e", `${REPORT}\nconst lib = ${JSON.stringify(LIB)};\n${code}`], { encoding: "utf8", timeout: ms * WALL, killSignal: "SIGKILL" });
  assert.equal(done.signal, null, `still running after ${ms * WALL} ms by the clock: ${code}`);
  assert.equal(done.status, 0, done.stderr);
  const cpu = /\ncpu (\d+) ms\n$/.exec(done.stderr);
  assert.ok(cpu, `no CPU time said: ${done.stderr}`);
  assert.ok(Number(cpu[1]) <= ms, `took ${cpu[1]} ms of CPU time, more than ${ms} ms: ${code}`);
  return done.stdout;
}

module.exports = { endsInTime };
