"use strict";

// How a run connects (see lib/dial.js): to the addresses the rule took for
// a host, as the browser connects to a name's addresses, the attempts left
// to go on, the first to connect taken; and the kit's own requests through
// no proxy the environment names.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
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

test("an attempt that fails while an earlier one is still under way starts no other at once: the next waits for its turn", { timeout: 30_000 }, async (t) => {
  const server = await site(t);
  const port = server.address().port;
  // A clock of the test's own, which moves only as the test moves it.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  // The first address never answers; the second is refused as soon as it
  // is tried, while the first is still under way; the third connects.
  t.mock.method(dialLib.wire, "dial", (address) => {
    const socket = new net.Socket();
    attempts.push({ address, when: Date.now(), socket });
    if (attempts.length === 2) process.nextTick(() => socket.destroy(Object.assign(new Error(`connect ECONNREFUSED ${address}:80`), { code: "ECONNREFUSED" })));
    if (attempts.length === 3) socket.connect(port, "127.0.0.1");
    return socket;
  });
  const started = Date.now();
  const dialing = dialFirst(["93.184.216.34", "93.184.216.35", "93.184.216.36"], 80, { name: "acme.test" });
  // 10 ms at a time, the refusal and what follows it let through after
  // each move of the clock.
  for (let ms = 0; ms < 2 * ATTEMPT_DELAY && attempts.length < 3; ms += 10) {
    t.mock.timers.tick(10);
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  }
  const socket = await dialing;
  t.after(() => socket.destroy());
  assert.deepEqual(attempts.map(({ address }) => address), ["93.184.216.34", "93.184.216.35", "93.184.216.36"]);
  // The third started a turn after the second, not when the second failed,
  // as the first was still under way.
  assert.deepEqual(attempts.map(({ when }) => when - started), [0, ATTEMPT_DELAY, 2 * ATTEMPT_DELAY]);
  assert.equal(socket, attempts[2].socket);
  assert.ok(attempts[0].socket.destroyed, "the first attempt was ended");
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

test("with 200 ms on each way of this machine's loopback, a site given as localhost, on 127.0.0.1 alone, answers through the kit's proxy, and its robots.txt is read", { skip: delayed }, (t) => {
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
      `const { readRobots } = require(${JSON.stringify(path.join(LIB, "facts.js"))});`,
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
      `  const robots = await readRobots("http://localhost:" + port, guard);`,
      `  console.log(JSON.stringify({ asked, robots, failed: proxy.failed.map(({ key, code }) => key.replace(/:\\d+$/, "") + " " + code) }));`,
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
  assert.deepEqual(said.robots, { rules: [{ allow: false, path: "/private" }], delay: 0 }, cli.stdout);
  assert.deepEqual(said.failed, []);
});

const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

test("the kit's own requests over https start TLS for their host: robots.txt with --facts, its redirect, and a store's lookup are read from a server whose certificate names that host, which is told it as the name the request is for, and nothing is asked of one whose certificate this machine does not trust or names another host", { skip: !openssl && "no openssl to make the test server's certificate" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-tls-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // A certificate of the test's own for the three hosts, which the program
  // below trusts (NODE_EXTRA_CA_CERTS) and no other program does.
  // A second certificate for the same hosts that nothing trusts, and a
  // third that the program trusts but that names another host alone, as a
  // network between this machine and a site can hand the kit.
  const certificates = [
    ["key.pem", "cert.pem", "subjectAltName=DNS:site.test,DNS:hop.test,DNS:itunes.apple.com"],
    ["untrusted-key.pem", "untrusted-cert.pem", "subjectAltName=DNS:site.test,DNS:hop.test,DNS:itunes.apple.com"],
    ["other-key.pem", "other-cert.pem", "subjectAltName=DNS:other.test"],
  ];
  for (const [key, cert, names] of certificates) {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=site.test", "-addext", names], { cwd: parent, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
  }
  fs.writeFileSync(path.join(parent, "trusted.pem"), ["cert.pem", "other-cert.pem"].map((cert) => fs.readFileSync(path.join(parent, cert), "utf8")).join(""));
  const start = path.join(parent, "start.js");
  // In a program of its own, as Node.js reads NODE_EXTRA_CA_CERTS as it
  // starts: an https server of its own for each certificate stands in for
  // each host in turn, every connection to the addresses the rule took
  // going to it, and keeps the name each TLS connection was started for.
  fs.writeFileSync(
    start,
    [
      `const https = require("https");`,
      `const net = require("net");`,
      `const dns = require("dns");`,
      `const fs = require("fs");`,
      `const os = require("os");`,
      `const path = require("path");`,
      `const dialLib = require(${JSON.stringify(path.join(LIB, "dial.js"))});`,
      `const { guardFor } = require(${JSON.stringify(path.join(LIB, "address.js"))});`,
      `const { readRobots } = require(${JSON.stringify(path.join(LIB, "facts.js"))});`,
      `const stores = require(${JSON.stringify(path.join(LIB, "stores.js"))});`,
      `const serve = (key, cert) => {`,
      `  const asked = [];`,
      `  const server = https.createServer({ key: fs.readFileSync(path.join(${JSON.stringify(parent)}, key)), cert: fs.readFileSync(path.join(${JSON.stringify(parent)}, cert)) }, (req, res) => {`,
      `    asked.push(req.socket.servername + " " + req.headers.host + " " + req.url.split("?")[0]);`,
      `    if (req.url === "/robots.txt") return res.writeHead(302, { location: "https://hop.test/robots-hop" }).end();`,
      `    if (req.url === "/robots-hop") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\\nDisallow: /private\\n");`,
      `    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resultCount: 1, results: [{ wrapperType: "software", trackName: "Acme", sellerName: "Acme Inc." }] }));`,
      `  });`,
      `  return { server, asked };`,
      `};`,
      `dns.promises.lookup = async (host) => [{ address: host === "itunes.apple.com" ? "17.253.144.10" : "93.184.216.34", family: 4 }];`,
      `(async () => {`,
      `  const said = {};`,
      `  for (const [name, key, cert] of [["trusted", "key.pem", "cert.pem"], ["untrusted", "untrusted-key.pem", "untrusted-cert.pem"], ["other", "other-key.pem", "other-cert.pem"]]) {`,
      `    const { server, asked } = serve(key, cert);`,
      `    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));`,
      `    dialLib.wire.dial = () => net.connect({ host: "127.0.0.1", port: server.address().port });`,
      `    const robots = await readRobots("https://site.test", guardFor("https://site.test/"));`,
      `    const listing = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), os.tmpdir());`,
      `    said[name] = { robots, listing: { ok: listing.ok, name: listing.name, error: listing.error || "" }, asked };`,
      `    server.close();`,
      `  }`,
      `  console.log(JSON.stringify(said));`,
      `})();`,
      ``,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [start], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(parent, "trusted.pem"), TMPDIR: parent }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 0, err);
  const said = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(said.trusted.robots, { rules: [{ allow: false, path: "/private" }], delay: 0 });
  assert.deepEqual(said.trusted.listing, { ok: true, name: "Acme", error: "" });
  assert.deepEqual(said.trusted.asked, ["site.test site.test /robots.txt", "hop.test hop.test /robots-hop", "itunes.apple.com itunes.apple.com /lookup"]);
  // A certificate this machine does not trust, or one for another host:
  // robots.txt is not read, the listing fails with the certificate's error,
  // and the server is asked nothing. Node.js 24 adds advice of its own after
  // the first error.
  for (const [name, error] of [["untrusted", /^self[- ]signed certificate\b/], ["other", /^Hostname\/IP does not match certificate's altnames: Host: itunes\.apple\.com\. is not in the cert's altnames: DNS:other\.test\b/]]) {
    assert.deepEqual(said[name].robots, { error: "its robots.txt could not be read" }, name);
    assert.equal(said[name].listing.ok, false, name);
    assert.match(said[name].listing.error, error, name);
    assert.deepEqual(said[name].asked, [], name);
  }
});

// The environment of a program run with a proxy named the ways Node.js
// takes one from it, and none of the others: Node.js sends a request on
// its global agent through the proxy HTTP_PROXY or HTTPS_PROXY names once
// NODE_USE_ENV_PROXY or --use-env-proxy is set.
function proxied(env, way, proxy) {
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(name)));
  Object.assign(out, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy });
  if (way === "NODE_USE_ENV_PROXY") out.NODE_USE_ENV_PROXY = "1";
  else out.NODE_OPTIONS = "--use-env-proxy";
  return out;
}

test("the kit's own requests take no proxy the environment names, NODE_USE_ENV_PROXY or --use-env-proxy set: robots.txt and its redirect, and a store's request, go to the addresses the rule judged, and the proxy is asked nothing", async (t) => {
  const parent = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-envproxy-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const start = path.join(parent, "start.js");
  // In a program of its own, as Node.js reads these settings as it starts:
  // a site on this machine whose robots.txt leads to another site, which a
  // lookup puts on the public internet, and a store's host, where every
  // connection to the addresses the rule took goes to a server of its own
  // there. A request on Node's global agent shows whether this Node.js
  // takes a proxy from the environment at all.
  fs.writeFileSync(
    start,
    [
      `const http = require("http");`,
      `const net = require("net");`,
      `const dns = require("dns");`,
      `const os = require("os");`,
      `const dialLib = require(${JSON.stringify(path.join(LIB, "dial.js"))});`,
      `const { guardFor } = require(${JSON.stringify(path.join(LIB, "address.js"))});`,
      `const { readRobots } = require(${JSON.stringify(path.join(LIB, "facts.js"))});`,
      `const stores = require(${JSON.stringify(path.join(LIB, "stores.js"))});`,
      `const siteAsked = [];`,
      `const site = http.createServer((req, res) => {`,
      `  siteAsked.push(req.headers.host.replace(/:\\d+$/, "") + " " + req.url);`,
      `  if (req.url === "/robots.txt") return res.writeHead(302, { location: "http://hop.test/robots-hop" }).end();`,
      `  res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\\nDisallow: /private\\n");`,
      `});`,
      `const storeAsked = [];`,
      `const store = net.createServer((socket) => { storeAsked.push("connection"); socket.destroy(); });`,
      `const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));`,
      `dns.promises.lookup = async (host) => [{ address: host === "itunes.apple.com" ? "17.253.144.10" : "93.184.216.34", family: 4 }];`,
      `const dials = [];`,
      `(async () => {`,
      `  await Promise.all([listen(site), listen(store)]);`,
      `  const real = dialLib.wire.dial;`,
      `  dialLib.wire.dial = (address, port, name) => {`,
      `    dials.push(name + " " + address + ":" + port);`,
      `    if (address === "127.0.0.1") return real(address, port, name);`,
      `    return net.connect({ host: "127.0.0.1", port: port === 443 ? store.address().port : site.address().port });`,
      `  };`,
      `  const takes = await new Promise((resolve) => http.get("http://control.test/", () => resolve(true)).on("error", () => resolve(false)));`,
      `  const given = "http://localhost:" + site.address().port;`,
      `  const robots = await readRobots(given, guardFor(given + "/"));`,
      `  const listing = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), os.tmpdir());`,
      `  console.log(JSON.stringify({ takes, robots, listing: listing.ok, dials, siteAsked, storeAsked }));`,
      `  for (const server of [site, store]) server.close();`,
      `})();`,
      ``,
    ].join("\n"),
  );
  // The proxy the settings name: a server of the test's that keeps the
  // first line of each request it gets and answers 502.
  const relay = net.createServer();
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => relay.close());
  const ways = ["NODE_USE_ENV_PROXY"];
  if (process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) ways.push("--use-env-proxy");
  for (const way of ways) {
    const seen = [];
    relay.removeAllListeners("connection");
    relay.on("connection", (socket) => {
      socket.once("data", (chunk) => seen.push(chunk.toString("latin1").split("\r\n")[0]));
      socket.on("error", () => {});
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    });
    const child = spawn(process.execPath, [start], { env: { ...proxied(process.env, way, `http://127.0.0.1:${relay.address().port}`), TMPDIR: parent }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0, err);
    const said = JSON.parse(out.trim().split("\n").pop());
    if (!said.takes && !seen.length) {
      t.diagnostic(`${way}: this Node.js sends no request through a proxy the environment names`);
      continue;
    }
    // Node's own agent went through the proxy; the kit's requests did not.
    assert.deepEqual(seen, ["GET http://control.test/ HTTP/1.1"], `${way}: only the program's own request on Node's agent reached the proxy`);
    assert.deepEqual(said.robots, { rules: [{ allow: false, path: "/private" }], delay: 0 }, way);
    assert.deepEqual(said.siteAsked, ["localhost /robots.txt", "hop.test /robots-hop"], way);
    assert.equal(said.listing, false, `${way}: the store stand-in takes no TLS`);
    assert.deepEqual(said.storeAsked, ["connection"], way);
    const port = said.dials[0].split(":").pop();
    assert.deepEqual(said.dials, [`localhost 127.0.0.1:${port}`, "hop.test 93.184.216.34:80", "itunes.apple.com 17.253.144.10:443"], way);
  }
});
