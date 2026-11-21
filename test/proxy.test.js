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
    const req = http.request({ host: "127.0.0.1", port: proxy.port, method, path: url, headers: { host: new URL(url).host, ...headers }, agent: false, maxHeaderSize: 256 * 1024 }, (res) => {
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

// A server of the test's own that reads each request a connection carries,
// up to its blank line, and answers it with what answers gives for its
// number on that connection and its number in all, written as it is.
// Resolves to { port, connections, heard }: heard keeps each request's
// first lines.
async function rawServer(t, answers) {
  const heard = [];
  let all = 0;
  const server = net.createServer((socket) => {
    server.connections++;
    server.open++;
    socket.on("close", () => server.open--);
    let held = "";
    let on = 0;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      held += chunk.toString("latin1");
      for (let end = held.indexOf("\r\n\r\n"); end !== -1; end = held.indexOf("\r\n\r\n")) {
        heard.push(held.slice(0, end));
        held = held.slice(end + 4);
        answers(socket, ++on, ++all);
      }
    });
  });
  server.connections = 0;
  server.open = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { port: server.address().port, heard, get connections() { return server.connections; }, get open() { return server.open; } };
}

test("an answer the browser reads though Node's strict reading does not is passed on, framed afresh, and one not HTTP even so is kept as that and gets no answer", async (t) => {
  const shapes = {
    "lines ended by a line feed alone": "HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 5\n\nhello",
    "a folded header": "HTTP/1.1 200 OK\r\nX-Folded: a\r\n b\r\nContent-Length: 5\r\n\r\nhello",
    "a length and chunks both": "HTTP/1.1 200 OK\r\nContent-Length: 50\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    "a control character in a header": "HTTP/1.1 200 OK\r\nX-Odd: a\u0001b\r\nX-Kept: yes\r\nContent-Length: 5\r\n\r\nhello",
    "a status with no reason": "HTTP/1.1 200\r\nContent-Length: 5\r\n\r\nhello",
    "HTTP/1.0 with no length": "HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhello",
  };
  const hostOf = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.test`;
  const ports = {};
  for (const [name, raw] of Object.entries(shapes)) {
    const site = await rawServer(t, (socket) => (raw.startsWith("HTTP/1.0") ? socket.end(raw, "latin1") : socket.write(raw, "latin1")));
    ports[`${hostOf(name)}:80`] = site.port;
  }
  const bad = await rawServer(t, (socket) => socket.write("HTTP/1.1 200 OK\r\nX-Bad : v\r\nContent-Length: 5\r\n\r\nhello", "latin1"));
  ports["bad.test:80"] = bad.port;
  dialHere(t, ports);
  const proxy = await startProxy(ruleOf(() => ["93.184.216.34"]));
  t.after(() => proxy.close());
  for (const name of Object.keys(shapes)) {
    const answer = await viaProxy(proxy, `http://${hostOf(name)}/`);
    assert.equal(answer.status, 200, name);
    assert.equal(answer.body, "hello", name);
    assert.equal(answer.headers["content-length"], undefined, `${name}: the proxy frames the answer itself`);
    if (name === "a control character in a header") {
      assert.equal(answer.headers["x-odd"], undefined, "a header Node does not write is left out");
      assert.equal(answer.headers["x-kept"], "yes");
    }
  }
  assert.deepEqual(proxy.failed, []);
  // A header name with a space in it, which the browser takes, is not HTTP
  // to Node even so: the connection ends unanswered, and that is kept.
  await assert.rejects(viaProxy(proxy, "http://bad.test/"), (err) => err.code === "ECONNRESET" || /socket hang up/.test(err.message));
  assert.equal(proxy.failed.length, 1);
  assert.equal(proxy.failed[0].key, "bad.test:80");
  assert.match(proxy.failed[0].code, /^HPE_/);
});

test("an answer framed in two ways is framed afresh for the browser, so the next answer on the browser's connection is its own", async (t) => {
  const site = await rawServer(t, (socket, on) => socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nanswer\r\n1\r\n${on}\r\n0\r\n\r\n`, "latin1"));
  dialHere(t, { "acme.test:80": site.port });
  const proxy = await startProxy(ruleOf(() => ["93.184.216.34"]));
  t.after(() => proxy.close());
  // One connection to the proxy for both, as the browser keeps one.
  const kept = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => kept.destroy());
  const get = (at) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: proxy.port, path: at, headers: { host: new URL(at).host }, agent: kept }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  assert.equal(await get("http://acme.test/a"), "answer1");
  assert.equal(await get("http://acme.test/b"), "answer2");
});

test("an answer's headers of 40 KB, and a request's, pass the proxy, as the browser takes such headers", async (t) => {
  let cookie = "";
  // A server that takes such a request itself, past Node's own 16 KB.
  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
    cookie = req.headers.cookie || "";
    res.writeHead(200, { "set-cookie": Array.from({ length: 10 }, (_, i) => `c${i}=${"x".repeat(4_000)}`) }).end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  dialHere(t, { "acme.test:80": port });
  const proxy = await startProxy(ruleOf(() => ["93.184.216.34"]));
  t.after(() => proxy.close());
  const answer = await viaProxy(proxy, "http://acme.test/", { headers: { cookie: `big=${"y".repeat(40_000)}` } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "ok");
  assert.equal(answer.headers["set-cookie"].length, 10);
  assert.equal(cookie.length, 40_004);
});

test("a server that resets the connection before it answers is kept as that, as the browser would tell it", async (t) => {
  const site = await rawServer(t, (socket) => socket.resetAndDestroy());
  dialHere(t, { "acme.test:80": site.port });
  const proxy = await startProxy(ruleOf(() => ["93.184.216.34"]));
  t.after(() => proxy.close());
  await assert.rejects(viaProxy(proxy, "http://acme.test/"), (err) => err.code === "ECONNRESET" || /socket hang up/.test(err.message));
  assert.deepEqual(proxy.failed.map(({ key, code }) => [key, code]), [["acme.test:80", "ECONNRESET"]]);
});

test("requests with no body to one host and port go on one connection the proxy keeps open, one with a body on a connection of its own, and one on a kept connection the site has closed is sent again", async (t) => {
  const site = await rawServer(t, (socket, on, all) => {
    // The fifth request in all is the first on a connection the site has
    // given up: it closes that connection unanswered.
    if (all === 5) return socket.destroy();
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${String(all).length}\r\n\r\n${all}`, "latin1");
  });
  const dials = dialHere(t, { "acme.test:80": site.port });
  const proxy = await startProxy(ruleOf(() => ["93.184.216.34"]));
  t.after(() => proxy.close());
  for (let i = 1; i <= 4; i++) assert.equal((await viaProxy(proxy, `http://acme.test/${i}`)).body, String(i));
  assert.equal(site.connections, 1, "four requests on one connection");
  assert.equal((await viaProxy(proxy, "http://acme.test/again")).body, "6", "sent again on a connection of its own");
  assert.equal(site.connections, 2);
  const posted = await viaProxy(proxy, "http://acme.test/form", { method: "POST", headers: { "content-length": "0" } });
  assert.equal(posted.body, "7");
  assert.equal(site.connections, 3, "a request with a body on a connection of its own");
  assert.match(site.heard[site.heard.length - 1], /\r\nConnection: close(\r\n|$)/i);
  assert.ok(dials.every((one) => one.host === "acme.test" && one.port === 80 && one.handed.join() === "93.184.216.34"), JSON.stringify(dials));
  assert.deepEqual(proxy.failed, []);
  // A connection kept open goes with the proxy, once those closed after
  // their request have gone.
  assert.equal((await viaProxy(proxy, "http://acme.test/last")).body, "8");
  const settled = async (count) => {
    for (let waited = 0; site.open !== count && waited < 2_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    return site.open;
  };
  assert.equal(await settled(1), 1);
  proxy.close();
  assert.equal(await settled(0), 0);
});
