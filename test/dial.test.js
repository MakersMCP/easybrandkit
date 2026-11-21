"use strict";

// How the kit's proxy connects (see lib/dial.js): to the addresses the rule
// took for a host, as the browser connects to a name's addresses, the
// attempts left to go on, the first to connect taken.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const dialLib = require("../skills/easybrandkit/scripts/lib/dial");
const { dialFirst, ATTEMPT_DELAY } = dialLib;
const { startProxy } = require("../skills/easybrandkit/scripts/lib/proxy");
const { guardFor } = require("../skills/easybrandkit/scripts/lib/address");

const LIB = path.resolve(__dirname, "../skills/easybrandkit/scripts/lib");

// A server of the test's own on 127.0.0.1 that answers every request with
// the address it was asked for, and counts its connections.
async function site(t) {
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(req.url === "/robots.txt" ? "User-agent: *\nDisallow: /private\n" : `the page ${req.url}`));
  server.connections = 0;
  server.on("connection", () => server.connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server;
}

// A port of this machine where nothing listens.
async function closedPort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A request through the proxy, as a browser sends one: the whole address in
// its first line. Resolves to { status, body } or { error }.
function viaProxy(proxy, url) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: url, headers: { host: new URL(url).host }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (err) => resolve({ error: err.code || err.message }));
    req.end();
  });
}

// Holds this process's thread, as a busy machine or a long piece of work
// does.
const holdThread = (ms) => {
  for (const end = Date.now() + ms; Date.now() < end; );
};

test("the addresses are tried with the families in turn, the next 250 ms after the one before, and the first to connect is taken, the others ended", { timeout: 30_000 }, async (t) => {
  const server = await site(t);
  const port = server.address().port;
  // A clock of the test's own, which moves only as the test moves it, so a
  // busy machine moves no turn.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  // The first address connects after 700 ms, as a site far away does; the
  // others never do.
  t.mock.method(dialLib.wire, "dial", (address, at, name) => {
    const socket = new net.Socket();
    attempts.push({ address, at, name, when: Date.now(), socket });
    if (attempts.length === 1) setTimeout(() => socket.destroyed || socket.connect(port, "127.0.0.1"), 700);
    return socket;
  });
  const started = Date.now();
  const dialing = dialFirst(["93.184.216.34", "93.184.216.35", "2606:2800:220:1::1"], 443, { name: "acme.test" });
  // 700 ms, 10 ms at a time, as a clock moves.
  for (let ms = 0; ms < 700; ms += 10) t.mock.timers.tick(10);
  const socket = await dialing;
  t.after(() => socket.destroy());
  assert.deepEqual(attempts.map(({ address, at, name }) => [address, at, name]), [["93.184.216.34", 443, "acme.test"], ["2606:2800:220:1::1", 443, "acme.test"], ["93.184.216.35", 443, "acme.test"]]);
  assert.equal(socket, attempts[0].socket, "the first address, which connected, slow as it was");
  // Each attempt but the first started a turn after the one before it.
  assert.deepEqual(attempts.map(({ when }) => when - started), [0, ATTEMPT_DELAY, 2 * ATTEMPT_DELAY]);
  assert.ok(attempts.slice(1).every((one) => one.socket.destroyed), "the other attempts were ended");
});

test("an attempt that fails starts the next at once, and a connection whose every attempt failed fails as its first address does", { timeout: 30_000 }, async (t) => {
  const server = await site(t);
  const closed = await closedPort();
  // The first two addresses refuse the connection; the third answers.
  const order = [];
  const dial = t.mock.method(dialLib.wire, "dial", (address) => {
    order.push(address);
    return net.connect({ host: "127.0.0.1", port: address === "93.184.216.36" ? server.address().port : closed });
  });
  // The test's clock stands still, so no turn comes however long the
  // attempts take on a busy machine: only a failed attempt starts the next.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = await dialFirst(["93.184.216.34", "93.184.216.35", "93.184.216.36"], 80, { name: "acme.test" });
  socket.destroy();
  assert.deepEqual(order, ["93.184.216.34", "93.184.216.35", "93.184.216.36"]);
  // None answers: the first address's error.
  dial.mock.mockImplementation((address) => {
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error(`connect ${address === "93.184.216.34" ? "ECONNREFUSED" : "ENETUNREACH"} ${address}:80`), { code: address === "93.184.216.34" ? "ECONNREFUSED" : "ENETUNREACH" })));
    return socket;
  });
  await assert.rejects(dialFirst(["93.184.216.34", "2606:2800:220:1::1"], 80, { name: "acme.test" }), (err) => err.code === "ECONNREFUSED" && err.message === "connect ECONNREFUSED 93.184.216.34:80");
  await assert.rejects(dialFirst([], 80, { name: "gone.test" }), (err) => err.code === "ENOTFOUND");
  // An attempt closed before it connects, as one the proxy ends with
  // itself, fails too.
  dial.mock.mockImplementation(() => {
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy());
    return socket;
  });
  await assert.rejects(dialFirst(["93.184.216.34"], 80), (err) => err.code === "ECONNABORTED");
});

test("a connection given up ends every attempt under way", { timeout: 30_000 }, async (t) => {
  const attempts = [];
  t.mock.method(dialLib.wire, "dial", () => {
    const socket = new net.Socket();
    attempts.push(socket);
    return socket;
  });
  const giveUp = new AbortController();
  const dialing = dialFirst(["93.184.216.34", "93.184.216.35"], 443, { signal: giveUp.signal });
  await new Promise((resolve) => setTimeout(resolve, ATTEMPT_DELAY + 100));
  giveUp.abort();
  await assert.rejects(dialing, (err) => err.name === "AbortError");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((socket) => socket.destroyed));
});

test("a site of this machine given as localhost, on 127.0.0.1 alone, answers through the kit's proxy while this process is held a moment as it connects", { timeout: 30_000 }, async (t) => {
  const server = await site(t);
  const port = server.address().port;
  // Each connection this process starts holds its thread 300 ms right
  // after, as a busy machine or a long piece of work can.
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, "connect", function (...args) {
    const socket = connect.apply(this, args);
    holdThread(300);
    return socket;
  });
  const given = `http://localhost:${port}/`;
  const proxy = await startProxy(guardFor(given));
  t.after(() => proxy.close());
  for (let i = 0; i < 3; i++) assert.deepEqual(await viaProxy(proxy, `${given}page-${i}`), { status: 200, body: `the page /page-${i}` });
  assert.deepEqual(proxy.failed, []);
});

// Network namespaces of a test's own, as this user, whose loopback can be
// given a delay of its own (tc's netem).
const delayed =
  (process.platform !== "linux" && "the namespaces of Linux") ||
  (spawnSync("unshare", ["-rn", "sh", "-c", "ip link set lo up && tc qdisc add dev lo root netem delay 10ms"]).status !== 0 && "no user and network namespace here, or no tc with netem to give its loopback a delay");

test("with 200 ms on each way of this machine's loopback, a site given as localhost, on 127.0.0.1 alone, answers through the kit's proxy", { skip: delayed }, (t) => {
  // In a network namespace of its own, whose loopback takes 400 ms for a
  // connection to be made: past the 250 ms Node.js gives each address but
  // the last when it connects to more than one, as to localhost's 127.0.0.1
  // and ::1, where nothing listens on ::1.
  const parent = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-slow-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const start = path.join(parent, "start.js");
  fs.writeFileSync(
    start,
    [
      `const http = require("http");`,
      `const { startProxy } = require(${JSON.stringify(path.join(LIB, "proxy.js"))});`,
      `const { guardFor } = require(${JSON.stringify(path.join(LIB, "address.js"))});`,
      `(async () => {`,
      `  const site = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(req.url === "/robots.txt" ? "User-agent: *\\nDisallow: /private\\n" : "the page"));`,
      `  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));`,
      `  const port = site.address().port;`,
      `  const given = "http://localhost:" + port + "/";`,
      `  const guard = guardFor(given);`,
      `  const proxy = await startProxy(guard);`,
      `  const asked = await new Promise((resolve) => {`,
      `    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: given, headers: { host: "localhost:" + port }, agent: false }, (res) => {`,
      `      let body = "";`,
      `      res.on("data", (chunk) => (body += chunk));`,
      `      res.on("end", () => resolve({ status: res.statusCode, body }));`,
      `    });`,
      `    req.on("error", (err) => resolve({ error: err.code || err.message }));`,
      `    req.end();`,
      `  });`,
      `  console.log(JSON.stringify({ asked, failed: proxy.failed.map(({ key, code }) => key.replace(/:\\d+$/, "") + " " + code) }));`,
      `  proxy.close();`,
      `  site.close();`,
      `})();`,
      ``,
    ].join("\n"),
  );
  const cli = spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && tc qdisc add dev lo root netem delay 200ms && exec "$1" "$2"', "sh", process.execPath, start], { encoding: "utf8", timeout: 60_000 });
  assert.equal(cli.status, 0, cli.stderr);
  const said = JSON.parse(cli.stdout.trim().split("\n").pop());
  assert.deepEqual(said.asked, { status: 200, body: "the page" }, cli.stdout);
  assert.deepEqual(said.failed, []);
});
