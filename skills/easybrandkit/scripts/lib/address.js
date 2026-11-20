"use strict";

// Which addresses a run opens. The address the user gives is opened whatever
// its host and port, and so are the pages on its scheme, host and port: a
// site on this machine, as http://localhost:3000, is the user's own choice.
// Any other address a run opens is one it was not given: a page it chose
// (the home page of a deeper address, the website a store listing names, a
// site another source named, a menu page with --facts), each hop of a
// redirect, a page's own move, a frame or a window a page opens, and
// robots.txt with each of its redirects. Such an address is opened only on
// port 80 or 443 and only on the public internet, so no site, listing or
// redirect leads the kit to another program of this machine or of a private
// network, to another port of a public host, or to a router's page or a
// cloud server's metadata.
//
// MAKERSMCP_REFUSE_ADDRESSES, a comma list of IP addresses and CIDR ranges,
// names more addresses that the host the kit runs on refuses, as a server's
// own public addresses, which lead back inside its network. They are refused
// for every address a run opens, the one given included.
//
// A host name is judged by every address it is found at here, looked up once
// a run. The browser looks the name up again as it opens the page; where it
// says which address it reached, that is judged too (see guardFor).

const net = require("net");
const dns = require("dns");

// The ranges that are not on the public internet: this machine, private and
// shared networks, link-local, and the ranges kept for documentation,
// benchmarks, multicast and later use, as MakersMCP's worker counts them. In
// IPv6 also Teredo (2001::/32), whose addresses hold the IPv4 addresses of a
// server and of a client, either of which can be this machine or its
// network, NAT64's local use prefix (64:ff9b:1::/48) and the site local
// range (fec0::/10). The test cases are in test/address-cases.json.
const V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6 = [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];
const blocked4 = new net.BlockList();
for (const [address, prefix] of V4) blocked4.addSubnet(address, prefix, "ipv4");
const blocked6 = new net.BlockList();
for (const [address, prefix] of V6) blocked6.addSubnet(address, prefix, "ipv6");

// An IP address as written, without the brackets of one in an address and
// without a zone (%eth0), which is no part of it.
const plainIp = (raw) => String(raw || "").replace(/^\[|\]$/g, "").replace(/%.*$/, "");

// An IPv6 address as its eight 16 bit groups, or null: a dotted IPv4 tail
// is two groups.
function groupsOf(address) {
  let text = plainIp(address).toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (half) => (half ? half.split(":") : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

// The IPv4 address an IPv6 address holds, dotted, or "": mapped
// (::ffff:a.b.c.d), compatible (::a.b.c.d, past :: and ::1), translated
// (::ffff:0:a.b.c.d), 6to4 (2002:aabb:ccdd::/48) and NAT64's well known
// prefix (64:ff9b::/96), as a network with IPv6 only gives a name that has
// only IPv4. Each reaches that IPv4 address wherever it is routed, so it is
// judged as that address: ::7f00:1, 2002:7f00:1:: and ::ffff:0:7f00:1 are
// 127.0.0.1, and a NAT64 address of a public site is as public as the site.
function heldIpv4(raw) {
  const address = plainIp(raw);
  if (net.isIP(address) !== 6) return "";
  const groups = groupsOf(address);
  if (!groups) return "";
  const v4 = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join(".");
  const zero = (from, to) => groups.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (zero(0, 6) && (groups[6] !== 0 || groups[7] > 1)) return v4(groups[6], groups[7]);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6], groups[7]);
  return "";
}

// Whether an IP address is on the public internet. Anything that is no IP
// address is not.
function isPublicAddress(raw) {
  const address = plainIp(raw);
  const family = net.isIP(address);
  if (family === 4) return !blocked4.check(address, "ipv4");
  if (family !== 6) return false;
  const held = heldIpv4(address);
  if (held && !isPublicAddress(held)) return false;
  return !blocked6.check(address, "ipv6");
}

// The names a browser takes for this machine without asking the DNS:
// localhost, and any name under it.
const localName = (host) => /(^|\.)localhost$/i.test(host);

// An address's host as it is judged: in small letters, without the brackets
// of an IPv6 address and without its last dots, as 127.0.0.1.. is still
// 127.0.0.1 to the browser.
const bare = (url) => url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");

// Whether a host is this machine itself, by a name or an address of its
// own: localhost and the names under it, 127/8, ::1, and 0.0.0.0 and ::,
// which reach this machine too, 127/8 and 0.0.0.0 also mapped into IPv6
// (::ffff:127.0.0.1), as a URL writes such an address. The other IPv6 forms
// of 127.0.0.1 (::7f00:1, ::ffff:0:7f00:1, 2002:7f00:1::, 64:ff9b::7f00:1)
// are not this machine's own names, and are judged as any other address.
function loopback(host) {
  const groups = net.isIP(host) === 6 ? groupsOf(host) : null;
  const mapped = Boolean(groups) && groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const v4 = mapped ? heldIpv4(host) : host;
  if (net.isIP(v4) === 4) return v4.startsWith("127.") || v4 === "0.0.0.0";
  if (groups) return groups.slice(0, 7).every((group) => group === 0) && groups[7] <= 1;
  return localName(v4);
}

// Whether an address is not on the public internet by its form alone: an IP
// address that is not, or a name of this machine's own.
function notPublicByForm(url) {
  const host = bare(url);
  return net.isIP(host) ? !isPublicAddress(host) : localName(host);
}

// The port a web address is served on, the scheme's own when it names none.
const portOf = (url) => url.port || (url.protocol === "https:" ? "443" : "80");

// Whether an address is written with http: or https:, read as the URL
// parser reads a scheme: in any case, with tabs and line breaks taken out
// and the control characters and spaces before it left off.
const webScheme = (raw) => /^https?:/i.test(String(raw).replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+/, ""));

// The ports an address the run was not given may be on.
const WEB_PORTS = new Set(["80", "443"]);

// Whether two web addresses are on the same host and port. A local site can
// send its visitors from one name of this machine to another, as from
// 127.0.0.1:8080 to localhost:8080, so two hosts of this machine on the same
// port count as one.
function sameHost(a, b) {
  if (portOf(a) !== portOf(b)) return false;
  const [one, two] = [bare(a), bare(b)];
  return one === two || (loopback(one) && loopback(two));
}

// ---- MAKERSMCP_REFUSE_ADDRESSES ----

const SETTING = "MAKERSMCP_REFUSE_ADDRESSES";

// The addresses the setting refuses: a comma list of IP addresses and CIDR
// ranges, as 185.137.215.163,10.0.0.0/8,fd00::/8, spaces around each
// allowed. Missing or empty, it refuses nothing more. A value that does not
// parse stops the run before any work, in words that name the setting.
// match(address) gives the address that the list refuses for an IP address,
// the IPv4 address it holds or else it, or "".
function refusedAddresses(value = process.env[SETTING]) {
  const list = new net.BlockList();
  let size = 0;
  for (const item of String(value === undefined ? "" : value).split(",")) {
    const text = item.trim();
    if (!text) continue;
    const range = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(text);
    const family = range ? net.isIP(range[1]) : 0;
    const prefix = range && range[2] !== undefined ? Number(range[2]) : family === 6 ? 128 : 32;
    if (!family || range[1].includes("%") || prefix > (family === 6 ? 128 : 32)) {
      const shown = text.length > 60 ? `${text.slice(0, 60)}...` : text;
      throw new Error(`${SETTING} holds ${JSON.stringify(shown)}, which is neither an IP address nor a range such as 10.0.0.0/8, so nothing was read. Give IP addresses and ranges parted by commas, or leave it empty.`);
    }
    list.addSubnet(range[1], prefix, family === 6 ? "ipv6" : "ipv4");
    size++;
  }
  const one = (address) => {
    const family = net.isIP(address);
    return family !== 0 && list.check(address, family === 6 ? "ipv6" : "ipv4");
  };
  return {
    size,
    match(raw) {
      if (!size) return "";
      const address = plainIp(raw);
      const held = heldIpv4(address);
      if (held && one(held)) return held;
      return one(address) ? address : "";
    },
  };
}

// ---- The words ----

// What an address that is not opened is, as said after "it" or "which".
const NOT_PUBLIC = "is not on the public internet";
const UNRESOLVED = "is on a host whose name could not be looked up";
// An http or https address that the URL parser here cannot read, as one
// whose host has a label of broken punycode (xn--a), which the browser
// reads all the same: where it leads cannot be judged.
const UNREADABLE = "is not an address easybrandkit can read";
const onPort = (port) => `is on port ${port}, not 80 or 443`;
const atNotPublic = (address) => `is at ${address}, an address not on the public internet`;
const atRefused = (address) => `is at ${address}, an address ${SETTING} refuses`;

// ---- The rule for a run ----

// How long a name is looked up for: one that gives no answer in this time
// is not opened.
const LOOKUP_WAIT = 5_000;

// The rule for the addresses a run opens, for the address given (given, a
// web address, whose scheme, host and port are the run's own; null for a
// run that has none, as one reading a site another source named, see
// makeKit), with the addresses refused (refused, from refusedAddresses).
// Each name is looked up once a run.
//
// judge(raw, seen) resolves to "" for an address the run may open, and else
// to why not, to follow "it" or "which". What is not a web address is not
// judged here: a page that leads to one fails or is cancelled on its own
// (see chrome.js). One written with http: or https: that the URL parser
// here cannot read is not opened: the browser can read it, and go where
// its host leads. seen is what the browser said of where it got the page,
// once it has: the IP address space Chrome gave the response (space) and
// the address it connected to (ip). Chrome gives a space of its own only
// when it reached the server itself, so then ip is the server's, and is
// judged as the lookup's addresses are; through a proxy it says Unknown and
// gives the proxy's address, which says nothing of the page.
//
// inside(url, seen): whether a host is not on the public internet, or
// cannot be told to be, by the same lookup.
//
// lookupFor(raw): the lookup a request the kit makes itself connects with,
// which hands back only addresses the rule takes, as the name is found when
// it connects, so it connects to no address the rule refuses; undefined for
// an address on the scheme, host and port given when nothing is refused,
// and one that hands back no address for one the URL parser cannot read.
function guardFor(givenRaw, { refused = refusedAddresses("") } = {}) {
  const given = givenRaw ? new URL(givenRaw) : null;
  const answers = new Map();
  const lookup = (host) => {
    if (!answers.has(host)) {
      let timer;
      const asked = Promise.race([
        dns.promises.lookup(host, { all: true, verbatim: true }).then((list) => ({ list: list.map((record) => record.address) })),
        new Promise((resolve) => (timer = setTimeout(resolve, LOOKUP_WAIT, { list: [] }))),
      ])
        .catch(() => ({ list: [] }))
        .finally(() => clearTimeout(timer));
      answers.set(host, asked);
    }
    return answers.get(host);
  };
  // The addresses a host is at: an IP address is at itself, and this
  // machine's own names are on its loopback. [] for a name not found.
  const addressesOf = async (host) => {
    if (net.isIP(host)) return [host];
    if (localName(host)) return ["127.0.0.1", "::1"];
    return (await lookup(host)).list;
  };
  // On the scheme, host and port of the address given: its own pages.
  const own = (url) => Boolean(given) && url.protocol === given.protocol && sameHost(url, given);
  const parse = (raw) => {
    try {
      return new URL(String(raw));
    } catch {
      return null;
    }
  };
  // What the browser says it reached, when it reached the server itself.
  const reached = ({ space = "", ip = "" } = {}) => (space && space !== "Unknown" && net.isIP(plainIp(ip)) ? plainIp(ip) : "");
  async function judge(raw, seen = {}) {
    const url = parse(raw);
    if (!url) return webScheme(raw) ? UNREADABLE : "";
    if (!/^https?:$/.test(url.protocol)) return "";
    const mine = own(url);
    if (!mine && !WEB_PORTS.has(portOf(url))) return onPort(portOf(url));
    const host = bare(url);
    if (!mine && (localName(host) || (net.isIP(host) && !isPublicAddress(host)))) return NOT_PUBLIC;
    if (!mine || refused.size) {
      const addresses = await addressesOf(host);
      if (!addresses.length) return UNRESOLVED;
      if (!mine) for (const address of addresses) if (!isPublicAddress(address)) return atNotPublic(plainIp(address));
      for (const address of addresses) if (refused.match(address)) return atRefused(refused.match(address));
    }
    const ip = reached(seen);
    if (ip && !mine && !isPublicAddress(ip)) return atNotPublic(ip);
    if (ip && refused.match(ip)) return atRefused(refused.match(ip));
    return "";
  }
  async function inside(url, seen = {}) {
    const host = bare(url);
    const ip = reached(seen);
    if (ip && !isPublicAddress(ip)) return true;
    const addresses = await addressesOf(host);
    return !addresses.length || addresses.some((address) => !isPublicAddress(address));
  }
  function lookupFor(raw) {
    const url = parse(raw);
    if (!url) return (hostname, options, callback) => callback(Object.assign(new Error(`${hostname} ${UNREADABLE}`), { code: "ENOTPUBLIC", hostname }));
    const mine = own(url);
    if (mine && !refused.size) return undefined;
    return (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, list) => {
        if (err) return callback(err);
        const bad = list.find(({ address }) => refused.match(address) || (!mine && !isPublicAddress(address)));
        if (bad || !list.length) return callback(Object.assign(new Error(`${hostname} ${bad ? (refused.match(bad.address) ? atRefused(refused.match(bad.address)) : atNotPublic(bad.address)) : UNRESOLVED}`), { code: "ENOTPUBLIC", hostname }));
        if (options && options.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      });
    };
  }
  return { given: given ? given.href : "", refused, judge, inside, lookupFor };
}

module.exports = { isPublicAddress, heldIpv4, notPublicByForm, sameHost, portOf, refusedAddresses, guardFor, atRefused };
