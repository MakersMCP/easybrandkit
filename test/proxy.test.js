"use strict";

// The kit's own proxy (see lib/proxy.js), which every request of the run's
// browser goes through, without a browser: what it takes, what it refuses
// and keeps, and that it connects only to the addresses the rule took.

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const { once } = require("node:events");
const { startProxy, wire, OWN_NAME } = require("../skills/easybrandkit/scripts/lib/proxy");

// A rule that takes what take says, at the addresses it gives, and refuses
// the rest as not on the public internet; each address it was asked for is
// kept in asked.
function ruleOf(take) {
  const asked = [];
  return {
    asked,
    route: async (raw) => {
      asked.push(raw);
      const addresses = take(new URL(raw));
      return addresses ? { why: "", addresses } : { why: "is not on the public internet", addresses: [] };
    },
  };
}

// Every connection the proxy makes, kept with what it was given, and made
// to this machine's port that ports names for its host and port, or to the
// port asked: each address the rule took stands for a server of the test's
// own here.
function dialHere(t, ports = {}) {
  const dials = [];
  t.mock.method(wire, "dial", (options) => {
    const handed = [];
    if (options.lookup) options.lookup(options.host, { all: true }, (err, list) => handed.push(...(err ? [] : list.map((one) => one.address))));
    dials.push({ host: options.host, port: options.port, handed });
    return net.connect({ host: "127.0.0.1", port: ports[`${options.host}:${options.port}`] || options.port });
  });
  return dials;
}

// A request through the proxy, as a browser sends one: the whole address in
// its first line. Resolves to { status, headers, body }.
function viaProxy(proxy, url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, method, path: url, headers: { host: new URL(url).host, ...headers }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// A CONNECT through the proxy: resolves to the proxy's answer's first line
// and the socket, which carries the tunnel once that answer is 200, or to
// no line when the proxy closes the connection with no answer.
function tunnel(proxy, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.removeListener("data", onData);
      resolve({ line: head.slice(0, head.indexOf("\r\n")), socket });
    };
    socket.on("data", onData);
    socket.on("close", () => resolve({ line: "", socket }));
    socket.on("error", reject);
  });
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

test("the proxy listens on 127.0.0.1 alone, on a port the system picks, and stops with every connection it holds", async (t) => {
  const proxy = await startProxy(ruleOf(() => ["127.0.0.1"]));
  t.after(() => proxy.close());
  assert.ok(proxy.port > 0);
  const listening = await new Promise((resolve) => {
    const socket = net.connect(proxy.port, "127.0.0.1", () => resolve(socket));
  });
  proxy.close();
  await once(listening, "close");
  await assert.rejects(new Promise((resolve, reject) => net.connect(proxy.port, "127.0.0.1", resolve).on("error", reject)), (err) => err.code === "ECONNREFUSED");
});

test("a plain http request the rule takes is passed on to the address it took, for its own host, without the headers of the proxy's connection", async (t) => {
  let got = null;
  const port = await serve(t, (req, res) => {
    got = { url: req.url, headers: req.rawHeaders };
    res.writeHead(201, { "x-kept": "yes", "set-cookie": ["a=1", "b=2"], connection: "x-hop", "x-hop": "1", "keep-alive": "timeout=9" }).end("answer");
  });
  const rule = ruleOf(() => ["93.184.216.34"]);
  const dials = dialHere(t, { "acme.test:80": port });
  const proxy = await startProxy(rule);
  t.after(() => proxy.close());
  const answer = await viaProxy(proxy, "http://acme.test/a/b?c=1", { headers: { "proxy-connection": "keep-alive", "proxy-authorization": "Basic eDp5", "x-own": "1" } });
  assert.equal(answer.status, 201);
  assert.equal(answer.body, "answer");
  assert.equal(answer.headers["x-kept"], "yes");
  assert.deepEqual(answer.headers["set-cookie"], ["a=1", "b=2"]);
  assert.equal(answer.headers["x-hop"], undefined, "a header the answer's Connection names stays with that connection");
  assert.deepEqual(rule.asked, ["http://acme.test/a/b?c=1"]);
  assert.deepEqual(dials, [{ host: "acme.test", port: 80, handed: ["93.184.216.34"] }]);
  assert.equal(got.url, "/a/b?c=1");
  const sent = Object.fromEntries(got.headers.map((value, i, all) => (i % 2 ? null : [value.toLowerCase(), all[i + 1]])).filter(Boolean));
  assert.equal(sent.host, "acme.test");
  assert.equal(sent["x-own"], "1");
  assert.equal(sent["proxy-connection"], undefined);
  assert.equal(sent["proxy-authorization"], undefined);
  assert.deepEqual(proxy.refused, []);
});

test("a request or a tunnel the rule refuses gets a 403 and no connection, and is kept once with why and the page the kit reads", async (t) => {
  const dials = dialHere(t);
  const proxy = await startProxy(ruleOf(() => null));
  t.after(() => proxy.close());
  proxy.reading = "https://acme.com/";
  assert.equal((await viaProxy(proxy, "http://127.0.0.1:9222/json/list")).status, 403);
  assert.equal((await viaProxy(proxy, "http://127.0.0.1:9222/json/list")).status, 403);
  const { line, socket } = await tunnel(proxy, "10.0.0.5:443");
  socket.destroy();
  assert.equal(line, "HTTP/1.1 403 Forbidden");
  assert.deepEqual(proxy.refused, [
    { what: "http://127.0.0.1:9222/json/list", why: "is not on the public internet", page: "https://acme.com/" },
    { what: "10.0.0.5:443", why: "is not on the public internet", page: "https://acme.com/" },
  ]);
  assert.deepEqual(dials, []);
});

test("a tunnel the rule takes carries its bytes both ways to the address it took, and one it cannot make is a 502, kept by its host and port", async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  t.after(() => echo.close());
  const rule = ruleOf((url) => (url.hostname === "closed.test" ? ["93.184.216.35"] : ["2606:4700::1111", "93.184.216.34"]));
  const dials = dialHere(t, { "acme.test:443": echo.address().port, "closed.test:443": 9 });
  const proxy = await startProxy(rule);
  t.after(() => proxy.close());
  const { line, socket } = await tunnel(proxy, "acme.test:443");
  assert.equal(line, "HTTP/1.1 200 Connection Established");
  socket.write("hello");
  const [echoed] = await once(socket, "data");
  assert.equal(echoed.toString(), "hello");
  socket.destroy();
  assert.deepEqual(rule.asked, ["https://acme.test/"]);
  assert.deepEqual(dials[0], { host: "acme.test", port: 443, handed: ["2606:4700::1111", "93.184.216.34"] });
  const closed = await tunnel(proxy, "closed.test:443");
  closed.socket.destroy();
  assert.equal(closed.line, "HTTP/1.1 502 Bad Gateway");
  assert.deepEqual(proxy.failed, [{ n: 1, key: "closed.test:443", code: "ECONNREFUSED" }]);
  assert.equal(proxy.failedCount, 1);
  assert.deepEqual(proxy.refused, []);
});

test("an address the rule took that is an IP address is connected to as it is, and a request it cannot make is ended unanswered and kept", async (t) => {
  const port = await serve(t, (req, res) => res.end("ok"));
  const dials = dialHere(t, { "93.184.216.34:80": port, "93.184.216.36:80": 9 });
  const proxy = await startProxy(ruleOf((url) => [url.hostname]));
  t.after(() => proxy.close());
  assert.equal((await viaProxy(proxy, "http://93.184.216.34/")).body, "ok");
  await assert.rejects(viaProxy(proxy, "http://93.184.216.36/"), (err) => err.code === "ECONNRESET" || err.code === "ECONNABORTED" || /socket hang up/.test(err.message));
  assert.deepEqual(dials.map(({ host, port: at, handed }) => [host, at, handed]), [["93.184.216.34", 80, []], ["93.184.216.36", 80, []]]);
  assert.deepEqual(proxy.failed.map(({ key, code }) => [key, code]), [["93.184.216.36:80", "ECONNREFUSED"]]);
});

test("the proxy takes only requests for a whole address and tunnels: one that came to its port as an address of its own gets a 400, a probe too, and its own name and port are answered by it, the probes kept", async (t) => {
  const dials = dialHere(t);
  const proxy = await startProxy(ruleOf(() => ["93.184.216.34"]));
  t.after(() => proxy.close());
  for (const at of ["/index.html", `/${proxy.token}/2`]) {
    const direct = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: proxy.port, path: at, agent: false }, (res) => resolve(res.statusCode)).on("error", reject));
    assert.equal(direct, 400, at);
  }
  assert.deepEqual([...proxy.through], []);
  assert.equal((await viaProxy(proxy, `http://${OWN_NAME}/${proxy.token}/1`)).status, 200);
  assert.equal((await viaProxy(proxy, `http://[::1]:${proxy.port}/${proxy.token}/4`)).status, 200);
  assert.equal((await viaProxy(proxy, `http://${OWN_NAME}/favicon.ico`)).status, 404);
  assert.equal((await viaProxy(proxy, `http://localhost:${proxy.port}/favicon.ico`)).status, 404);
  const own = await tunnel(proxy, `${OWN_NAME}:443`);
  own.socket.destroy();
  assert.equal(own.line, "HTTP/1.1 403 Forbidden");
  assert.deepEqual([...proxy.through].sort(), [1, 4]);
  // A request in no form a browser sends a proxy, and a tunnel to an
  // address that cannot be read, reach nothing.
  for (const authority of ["acme.test", "acme.test:0", "acme.test:99999", "user@acme.test:443", "acme.test:443/x", "[::1:443", "acme%2etest:443"]) {
    const { line, socket } = await tunnel(proxy, authority);
    socket.destroy();
    assert.equal(line, "HTTP/1.1 403 Forbidden", authority);
  }
  assert.deepEqual(dials, []);
  assert.deepEqual(proxy.refused.map(({ why }) => why), Array(7).fill("is not an address easybrandkit can read"));
});

test("a rule that fails refuses, and a browser started with no rule reaches nothing", async (t) => {
  const dials = dialHere(t);
  const failing = await startProxy({ route: async () => { throw new Error("no answer"); } });
  t.after(() => failing.close());
  assert.equal((await viaProxy(failing, "http://acme.test/")).status, 403);
  assert.deepEqual(failing.refused.map(({ why }) => why), ["could not be judged"]);
  const none = await startProxy(null);
  t.after(() => none.close());
  assert.equal((await viaProxy(none, "http://acme.test/")).status, 403);
  const { line, socket } = await tunnel(none, "acme.test:443");
  socket.destroy();
  assert.equal(line, "HTTP/1.1 403 Forbidden");
  assert.deepEqual(none.refused.map(({ why }) => why), Array(2).fill("is not opened by a browser the kit gave no rule for the addresses it opens"));
  assert.deepEqual(dials, []);
});

test("the proxy keeps 50 refused addresses, each once, and says there were more", async (t) => {
  dialHere(t);
  const proxy = await startProxy(ruleOf(() => null));
  t.after(() => proxy.close());
  for (let i = 0; i < 52; i++) await viaProxy(proxy, `http://10.0.0.${i}/`);
  assert.equal(proxy.refused.length, 50);
  assert.equal(proxy.refusedMore, true);
});
