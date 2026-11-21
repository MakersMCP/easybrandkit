"use strict";

// The proxy every request of a run's browser goes through: a small HTTP
// proxy of the kit's own on 127.0.0.1, started before the browser, which is
// started with it as its proxy for every address, this machine's own among
// them, and with its own DNS over HTTPS off (see chrome.js launch). So the
// browser looks no name up and connects nowhere itself, unless a Chrome
// policy turns its DNS over HTTPS on again: whatever asks for an address, a
// page, a frame, a picture,
// a script, the data a page fetches, a WebSocket, a service worker, a
// prefetch, the fetch of a site certificate's issuer or a page's WebAuthn
// check, the request comes here. It takes plain http requests, which the
// browser sends with the whole address, and CONNECT tunnels, which it opens
// for https and for WebSockets, and nothing else. Each is judged by the
// run's rule (see address.js guardFor, route), which looks each name up once
// a run, and is connected only to an address that rule took for it,
// without asking the DNS again. What the rule refuses gets a 403 and no
// connection, and is kept with its address and why for the kit's notes
// (see chrome.js proxyNotes).
//
// It listens on 127.0.0.1 alone, on a port the system picks, for as long as
// its browser runs. A request it gets that is not one of these, as one
// that names no host, gets a 400.

const net = require("net");
const http = require("http");
const crypto = require("crypto");

// How the proxy connects to an address the rule took: net.connect with the
// host as the rule judged it and a lookup that hands back only the
// addresses the rule took for it, so that a name is never looked up again
// and a connection tries those alone, one after another, as Node's own
// connection with more than one address does. Tests put their own servers
// in place of the addresses here.
const wire = { dial: (options) => net.connect(options) };

// The headers that belong to one connection and not to the request or the
// answer it carries, which the proxy does not pass on, with those a
// Connection header names.
const HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function passedOn(raw) {
  const named = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    if (/^(proxy-)?connection$/i.test(raw[i])) for (const name of String(raw[i + 1]).split(",")) named.add(name.trim().toLowerCase());
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    if (!HOP.has(name) && !named.has(name)) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

// The largest headers taken, of a request and of an answer: Node's own 16
// KB would refuse a site's large cookies or policies that the browser takes.
const HEADER_MOST = 256 * 1024;

// How many refused addresses are kept, each once, and how many failed
// connections.
const KEEP_REFUSED = 50;
const KEEP_FAILED = 100;

// What a request the proxy got stands for: the address it judges, as a URL,
// and how it is told in the kit's notes, the whole address of a plain http
// request and the host and port of a tunnel.
function tunnelUrl(authority) {
  const form = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~!$&'()*+,;=-]+):(\d{1,5})$/.exec(authority);
  if (!form || Number(form[2]) < 1 || Number(form[2]) > 65535) return null;
  try {
    const url = new URL(`https://${authority}/`);
    const port = url.port || "443";
    return port === String(Number(form[2])) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

// The port of a web address, the scheme's own when it names none.
const portOf = (url) => url.port || (url.protocol === "https:" ? "443" : "80");

// A host as net.connect takes it: an IPv6 address without its brackets.
const plainHost = (url) => url.hostname.replace(/^\[|\]$/g, "");

// Where a failed connection is kept: its host and port.
const keyOf = (url) => `${plainHost(url).toLowerCase()}:${portOf(url)}`;

// The proxy's own name, under .invalid, which no DNS answers: the browser
// is asked for it to show that its requests come here (see chrome.js
// throughProxy), and its own push channel is pointed at it (see chrome.js
// launch). A request for it, or for this machine on the proxy's own port,
// is the proxy's own: answered here, and kept nowhere but as a probe.
const OWN_NAME = "easybrandkit-proxy.invalid";

// Why a request is refused when the browser was started with no rule.
const NO_RULE = "is not opened by a browser the kit gave no rule for the addresses it opens";
// Why one is refused when the rule itself failed.
const NOT_JUDGED = "could not be judged";
// What a tunnel or a request whose address cannot be read is.
const UNREADABLE = "is not an address easybrandkit can read";

// Starts the proxy for a run's rule (guard, see address.js guardFor; null
// for a browser that is to open no web page) and resolves to it, once it
// listens:
//   port         the port it listens on, on 127.0.0.1
//   token        a word of its own, which the probes of chrome.js put in
//                their paths: a request for /<token>/<n> that comes to it
//                as a proxy request it answers itself, and keeps n in
//                through
//   reading      the page the kit reads, which the kit sets as it opens one
//   refused      what it refused: { what, why, page }, each address once,
//                the first 50, refusedMore saying that there were more
//   failed       the connections it could not make to addresses the rule
//                took, and those a server reset before it answered:
//                { n, key, code }, the last 100, key being host:port and n
//                counting them from 1, failedCount being the last n
//   close()      stops it and every connection it holds
function startProxy(guard) {
  const token = crypto.randomBytes(12).toString("hex");
  const sockets = new Set();
  const proxy = { port: 0, token, through: new Set(), reading: "", refused: [], refusedMore: false, failed: [], failedCount: 0, closed: false };
  const hold = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (proxy.closed) socket.destroy();
    return socket;
  };
  const route = async (raw) => {
    if (!guard) return { why: NO_RULE, addresses: [] };
    try {
      return await guard.route(raw);
    } catch {
      return { why: NOT_JUDGED, addresses: [] };
    }
  };
  const refuse = (what, why) => {
    if (proxy.refused.some((one) => one.what === what)) return;
    if (proxy.refused.length < KEEP_REFUSED) proxy.refused.push({ what, why, page: proxy.reading });
    else proxy.refusedMore = true;
  };
  const failed = (url, err) => {
    proxy.failed.push({ n: ++proxy.failedCount, key: keyOf(url), code: String((err && err.code) || "") });
    if (proxy.failed.length > KEEP_FAILED) proxy.failed.shift();
  };
  // A connection to url's host and port at one of addresses, the ones the
  // rule took for it: the socket, once connected.
  const connect = (url, addresses) =>
    new Promise((resolve, reject) => {
      if (!addresses.length) return reject(Object.assign(new Error(`${url.hostname} was not found`), { code: "ENOTFOUND" }));
      const list = addresses.map((address) => ({ address, family: net.isIP(address) }));
      const lookup = (hostname, options, callback) => {
        const family = options && options.family;
        const some = list.filter((one) => !family || one.family === family);
        if (!some.length) return callback(Object.assign(new Error(`${hostname} has no address of the family asked for`), { code: "ENOTFOUND", hostname }));
        if (options && options.all) callback(null, some);
        else callback(null, some[0].address, some[0].family);
      };
      let socket;
      try {
        // An IP address is connected to as it is, the one address the rule
        // took for it; a name through the lookup above.
        const host = plainHost(url);
        socket = hold(wire.dial(net.isIP(host) ? { host: list[0].address, port: Number(portOf(url)) } : { host, port: Number(portOf(url)), lookup }));
      } catch (err) {
        return reject(err);
      }
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  // Whether an address is the proxy's own.
  const ownAddress = (url) => url.hostname === OWN_NAME || (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && portOf(url) === String(proxy.port));
  // The probes of chrome.js: /<token>/<n>, answered here.
  const probe = (path) => {
    const n = new RegExp(`^/${token}/(\\d)$`).exec(path);
    if (!n) return false;
    proxy.through.add(Number(n[1]));
    return true;
  };

  // A plain http request, the whole address in its first line.
  const answer = async (req, res) => {
    res.sendDate = false;
    const target = String(req.url || "");
    // A request with no whole address came to this port as an address of
    // its own, past the proxy, and is answered with nothing.
    if (!/^http:\/\//i.test(target)) return res.writeHead(400, { "content-length": "0", connection: "close" }).end();
    let url;
    try {
      url = new URL(target);
    } catch {
      refuse(target.slice(0, 300), UNREADABLE);
      return res.writeHead(403, { "content-length": "0" }).end();
    }
    if (ownAddress(url)) {
      if (probe(url.pathname)) return res.writeHead(200, { "content-type": "text/plain", "content-length": "0" }).end();
      return res.writeHead(404, { "content-length": "0" }).end();
    }
    const { why, addresses } = await route(url.href);
    if (why) {
      refuse(url.href.slice(0, 300), why);
      return res.writeHead(403, { "content-length": "0" }).end();
    }
    let upstream;
    try {
      upstream = await connect(url, addresses);
    } catch (err) {
      // As a server that gave no answer: the browser tells that as an
      // empty answer, and the kit tells it by the failure kept here (see
      // chrome.js navigate).
      failed(url, err);
      return req.socket.destroy();
    }
    if (req.socket.destroyed) return upstream.destroy();
    // The request as the browser sent it, for the address's own host, which
    // the connection already reaches.
    const headers = ["Host", url.host];
    const kept = passedOn(req.rawHeaders);
    for (let i = 0; i < kept.length; i += 2) if (!/^host$/i.test(kept[i])) headers.push(kept[i], kept[i + 1]);
    const asked = http.request({ createConnection: () => upstream, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false, maxHeaderSize: HEADER_MOST });
    let answered = false;
    let gone = false;
    asked.on("response", (answer) => {
      answered = true;
      try {
        res.writeHead(answer.statusCode, answer.statusMessage, passedOn(answer.rawHeaders));
      } catch {
        upstream.destroy();
        return res.destroy();
      }
      answer.pipe(res);
      answer.on("error", () => res.destroy());
    });
    // A server that closes the connection before it answers is told by
    // the browser as an empty answer, as it would be told without the
    // proxy; one that resets it, a system error, is kept as that.
    asked.on("error", (err) => {
      if (answered || gone) return res.destroy();
      if (err && err.syscall) failed(url, err);
      req.socket.destroy();
    });
    // The browser that gives the request up ends its connection too.
    res.on("close", () => {
      gone = true;
      upstream.destroy();
    });
    req.pipe(asked);
  };
  // A CONNECT tunnel to the host and port it names.
  const tunnel = async (req, socket, head) => {
    const authority = String(req.url || "");
    const url = tunnelUrl(authority);
    if (!url) {
      refuse(authority.slice(0, 300), UNREADABLE);
      return socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    }
    if (ownAddress(url)) return socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    const what = `${url.hostname}:${portOf(url)}`;
    // A tunnel carries https, or a WebSocket, to the host and port it
    // names: it is judged as an https address there.
    const { why, addresses } = await route(url.href);
    if (why) {
      refuse(what, why);
      return socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    }
    let upstream;
    try {
      upstream = await connect(url, addresses);
    } catch (err) {
      failed(url, err);
      return socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    }
    if (socket.destroyed) return upstream.destroy();
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  };

  const server = http.createServer({ maxHeaderSize: HEADER_MOST });
  server.on("connection", hold);
  server.on("clientError", (err, socket) => socket.destroy());
  // What fails on the way ends that connection, and nothing else.
  server.on("request", (req, res) => answer(req, res).catch(() => req.socket.destroy()));
  server.on("connect", (req, socket, head) => tunnel(req, socket, head).catch(() => socket.destroy()));
  // A request that asks for another protocol on its own connection is no
  // request the browser sends a proxy: it sends a WebSocket through a
  // tunnel.
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\n\r\n"));

  proxy.close = () => {
    if (proxy.closed) return;
    proxy.closed = true;
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", () => {});
      proxy.port = server.address().port;
      resolve(proxy);
    });
  });
}

module.exports = { startProxy, wire, keyOf, OWN_NAME, UNREADABLE };
