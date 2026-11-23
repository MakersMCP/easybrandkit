"use strict";

// The rule for the addresses a run opens (address.js): which IP addresses
// are on the public internet, the ports and hosts a run opens that it was
// not given, MAKERSMCP_REFUSE_ADDRESSES, and the lookups.

const assert = require("node:assert/strict");
const dns = require("node:dns");
const os = require("node:os");
const test = require("node:test");
const { isPublicAddress, heldIpv4, ownIp, interfacesUnread, notPublicByForm, refusedAddresses, guardFor, sameHost } = require("../skills/easybrandkit/scripts/lib/address");
const CASES = require("./address-cases.json");

// This machine's network interfaces as a server's, whose interface holds a
// public IPv4 address in a range of other people's servers and global IPv6
// addresses in a /64, beside its loopback.
const LOOPBACK = { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }, { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", internal: true, cidr: "::1/128", scopeid: 0 }] };
const SERVER = {
  ...LOOPBACK,
  eth0: [
    { address: "81.2.69.160", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "81.2.69.160/24" },
    { address: "2a02:1205:5000::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2a02:1205:5000::1/64", scopeid: 0 },
    { address: "2a02:1205:5000:0:5c1b:2e:9a4f:11d0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2a02:1205:5000:0:5c1b:2e:9a4f:11d0/64", scopeid: 0 },
  ],
};

test("an IP address is on the public internet as the table shared with the other kits and MakersMCP-Api says", () => {
  for (const address of CASES.notPublic) assert.equal(isPublicAddress(address), false, address);
  for (const address of [...CASES.public, ...CASES.publicInKitsOnly]) assert.equal(isPublicAddress(address), true, address);
  // In brackets, as an address writes one.
  assert.equal(isPublicAddress("[::7f00:1]"), false);
  assert.equal(isPublicAddress("[2606:4700:4700::1111]"), true);
});

test("an IPv6 address that holds an IPv4 one gives it, in every form", () => {
  for (const [address, held] of [
    ["::ffff:127.0.0.1", "127.0.0.1"], ["::ffff:7f00:1", "127.0.0.1"], ["::7f00:1", "127.0.0.1"], ["::127.0.0.1", "127.0.0.1"],
    ["::ffff:0:7f00:1", "127.0.0.1"], ["2002:7f00:1::", "127.0.0.1"], ["2002:b989:d7a3::1", "185.137.215.163"], ["64:ff9b::a00:5", "10.0.0.5"],
    ["64:ff9b::5db8:d822", "93.184.216.34"], ["[::ffff:a9fe:a9fe]", "169.254.169.254"],
  ]) {
    assert.equal(heldIpv4(address), held, address);
  }
  // :: and ::1 are this machine's own, and the rest hold none.
  for (const address of ["::", "::1", "2001:0:7f00:1::1", "64:ff9b:1::7f00:1", "fe80::1", "2606:4700::1111", "127.0.0.1", "intranet"]) assert.equal(heldIpv4(address), "", address);
});

test("MAKERSMCP_REFUSE_ADDRESSES: IP addresses and ranges, an IPv6 form of a refused IPv4 address included; empty or missing refuses nothing", () => {
  const refused = refusedAddresses(" 185.137.215.163 , 10.0.0.0/8,fd00::/8,2a01:4f8::5 ,");
  assert.equal(refused.size, 4);
  for (const [address, said] of [["185.137.215.163", "185.137.215.163"], ["10.200.0.1", "10.200.0.1"], ["fd12::1", "fd12::1"], ["2a01:4f8::5", "2a01:4f8::5"], ["::ffff:185.137.215.163", "185.137.215.163"], ["::b989:d7a3", "185.137.215.163"], ["2002:b989:d7a3::1", "185.137.215.163"], ["64:ff9b::b989:d7a3", "185.137.215.163"], ["[::ffff:a00:1]", "10.0.0.1"]]) {
    assert.equal(refused.match(address), said, address);
  }
  for (const address of ["185.137.215.164", "11.0.0.1", "fe80::1", "2a01:4f8::6", "", "intranet"]) assert.equal(refused.match(address), "", address);
  // An entry written as an IPv6 form of an IPv4 address or range refuses
  // that IPv4 address or range too, and every form of it, as
  // easyscreenshotkit reads the setting.
  for (const entry of ["2002:b989:d7a3::/48", "2002:b989:d7a3::", "64:ff9b::185.137.215.163", "64:ff9b::b989:d7a3", "::185.137.215.163", "::ffff:0:185.137.215.163", "::ffff:185.137.215.163", "::ffff:185.137.215.0/120", "2002:b989:d700::/40"]) {
    const one = refusedAddresses(entry);
    for (const address of ["185.137.215.163", "::ffff:185.137.215.163", "2002:b989:d7a3::1", "64:ff9b::b989:d7a3"]) assert.equal(one.match(address), "185.137.215.163", `${entry} ${address}`);
    assert.equal(one.match("185.137.216.1"), "", entry);
  }
  assert.equal(refusedAddresses("::ffff:185.137.215.0/120").match("185.137.215.9"), "185.137.215.9");
  // :: and ::1 hold no IPv4 address.
  for (const entry of ["::", "::1", "::/127"]) assert.equal(refusedAddresses(entry).match("0.0.0.1"), "", entry);
  // An IPv6 entry is no IPv4 entry: ::/0, all of IPv6, refuses every IPv6
  // address and no IPv4 one, and nor does an IPv6 range that holds the
  // mapped and compatible forms of every IPv4 address but is no such form
  // itself, at /96 or longer. Kept in one list, an IPv4 address was checked
  // against them as ::ffff:a.b.c.d, and every site was refused.
  for (const entry of ["::/0", "::/8", "::/64", "::/80", "::ffff:0:0/80", "::ffff:0:0/95", "::/95"]) {
    const one = refusedAddresses(entry);
    for (const address of ["8.8.8.8", "93.184.216.34", "185.137.215.163"]) assert.equal(one.match(address), "", `${entry} ${address}`);
  }
  assert.equal(refusedAddresses("::/0").match("2606:4700::1111"), "2606:4700::1111");
  assert.equal(refusedAddresses("::/80").match("2606:4700::1111"), "");
  assert.equal(refusedAddresses("::/80").match("::808:808"), "::808:808");
  for (const value of [undefined, "", " ", ",", " , ,"]) {
    const none = refusedAddresses(value);
    assert.equal(none.size, 0, String(value));
    assert.equal(none.match("10.0.0.1"), "", String(value));
  }
  // Read from the environment when no value is given.
  const before = process.env.MAKERSMCP_REFUSE_ADDRESSES;
  try {
    process.env.MAKERSMCP_REFUSE_ADDRESSES = "192.0.2.7";
    assert.equal(refusedAddresses().match("192.0.2.7"), "192.0.2.7");
    delete process.env.MAKERSMCP_REFUSE_ADDRESSES;
    assert.equal(refusedAddresses().size, 0);
  } finally {
    if (before === undefined) delete process.env.MAKERSMCP_REFUSE_ADDRESSES;
    else process.env.MAKERSMCP_REFUSE_ADDRESSES = before;
  }
});

// A Teredo address holds two IPv4 addresses, its server's and, each bit
// turned over, its client's, and NAT64's local use prefix can stand for any
// IPv4 address in a way of its network's choosing, in its last 32 bits as
// RFC 6052 puts it for a /96, in another place for a /48, or by a table of
// its own: an IPv4 entry refuses a Teredo address whose server or client it
// is, and while the setting names an IPv4 address, every address of the
// local use prefix, as easyscreenshotkit reads the setting. Both were
// opened as a site given, http://[64:ff9b:1::7f00:1]:3000/ with 127.0.0.1
// refused among them.
test("MAKERSMCP_REFUSE_ADDRESSES refuses a Teredo address whose server or client it names, and while it names an IPv4 address every address of NAT64's local use prefix", async (t) => {
  const refused = refusedAddresses("185.137.215.163,10.20.0.0/16");
  for (const [address, said] of [
    ["64:ff9b:1::b989:d7a3", "64:ff9b:1::b989:d7a3"],
    ["64:ff9b:1::185.137.215.163", "64:ff9b:1::185.137.215.163"],
    // RFC 6052's layout for a /48: 185.137 before the u octet, 215.163 after it.
    ["64:ff9b:1:b989:d7:a300::", "64:ff9b:1:b989:d7:a300::"],
    ["64:ff9b:1::a14:5", "64:ff9b:1::a14:5"],
    ["64:ff9b:1::5db8:d70e", "64:ff9b:1::5db8:d70e"],
    // A Teredo server, then a client, at 185.137.215.163 and in 10.20.0.0/16.
    ["2001:0:b989:d7a3::", "185.137.215.163"],
    ["2001:0:4136:e378:8000:63bf:4676:285c", "185.137.215.163"],
    ["2001:0:a14:5::1", "10.20.0.5"],
    ["2001:0:4136:e378:8000:63bf:f5eb:fffa", "10.20.0.5"],
    // Both on the public internet, neither of them named.
    ["2001:0:5db8:d70e::", ""],
    ["2001:0:4136:e378:8000:63bf:a247:28f1", ""],
    ["2606:4700::1111", ""],
  ]) {
    assert.equal(refused.match(address), said, address);
  }
  // With no IPv4 address named, an address of the local use prefix is
  // refused only as an entry names it, and a Teredo entry, an IPv6 range of
  // an IPv4 form shorter than /96, or than /16 for 6to4, names IPv6
  // addresses alone.
  for (const entry of ["::1", "2606:4700::/32", "2001:0:b989:d7a3::", "2001::/32", "2002::/15", "64:ff9b::/95", "64:ff9b:1::/48"]) {
    for (const address of ["185.137.215.163", "93.184.215.14", "0.0.0.1"]) assert.equal(refusedAddresses(entry).match(address), "", `${entry} ${address}`);
    assert.equal(refusedAddresses(entry).match("64:ff9b:1:abcd::7f00:1"), entry === "64:ff9b:1::/48" ? "64:ff9b:1:abcd::7f00:1" : "", entry);
  }
  // An entry in the local use prefix with the IPv4 address last refuses
  // that IPv4 address and its forms, as the other forms do.
  for (const entry of ["64:ff9b:1::185.137.215.163", "64:ff9b:1::b989:d7a3", "64:ff9b:1:fffe::b989:d7a3"]) {
    for (const address of ["185.137.215.163", "::ffff:185.137.215.163", "2002:b989:d7a3::1", "64:ff9b::b989:d7a3"]) assert.equal(refusedAddresses(entry).match(address), "185.137.215.163", `${entry} ${address}`);
  }
  // In a run, the address given at such an address is refused too.
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const local = refusedAddresses("127.0.0.1");
  for (const [given, said] of [["http://[64:ff9b:1::7f00:1]:3000/", "64:ff9b:1::7f00:1"], ["http://[2001:0:7f00:1::]:3000/", "127.0.0.1"], ["http://[2001:0:4136:e378:8000:63bf:80ff:fffe]:3000/", "127.0.0.1"], ["http://[64:ff9b::7f00:1]:3000/", "127.0.0.1"]]) {
    assert.equal(await guardFor(given, { refused: local }).judge(given), `is at ${said}, an address MAKERSMCP_REFUSE_ADDRESSES refuses`, given);
  }
});

// An entry that holds every IPv4 address in an IPv6 form, as a host copies
// a firewall's list of the IPv6 ranges it refuses whole, would refuse every
// site, with words that blamed each site's address: it stops the run as a
// value that does not parse does, saying so.
test("an entry of MAKERSMCP_REFUSE_ADDRESSES that holds every IPv4 address in an IPv6 form is refused, saying so", () => {
  const said = (entry) => `MAKERSMCP_REFUSE_ADDRESSES holds ${JSON.stringify(entry)}, a range of every IPv4 address in an IPv6 form, which would refuse every site, so nothing was read. An IPv6 form of an IPv4 address is judged by that address: give the IPv4 addresses and ranges to refuse, or leave it empty.`;
  for (const entry of ["64:ff9b::/96", "::ffff:0:0/96", "::ffff:0:0:0/96", "::/96", "2002::/16", "64:ff9b:1::/96", "64:ff9b:1:fffe::/96"]) {
    assert.throws(() => refusedAddresses(entry), { message: said(entry) }, entry);
    assert.throws(() => refusedAddresses(`185.137.215.163, ${entry}`), { message: said(entry) }, entry);
  }
  // One bit longer, it holds half of them, as written.
  assert.equal(refusedAddresses("2002::/17").match("93.184.215.14"), "93.184.215.14");
  assert.equal(refusedAddresses("2002::/17").match("185.137.215.163"), "");
});

test("a MAKERSMCP_REFUSE_ADDRESSES that does not parse is refused in words that name the setting and what in it does not parse", () => {
  for (const [value, item] of [["10.0.0.0/33", "10.0.0.0/33"], ["acme.com", "acme.com"], ["10.0.0.1;10.0.0.2", "10.0.0.1;10.0.0.2"], ["fd00::/129", "fd00::/129"], ["[::1]", "[::1]"], ["fe80::1%eth0", "fe80::1%eth0"], ["1.2.3.4/", "1.2.3.4/"], ["1.2.3.4/8/8", "1.2.3.4/8/8"], ["010.0.0.1", "010.0.0.1"], ["185.137.215.163 185.137.215.165", "185.137.215.163 185.137.215.165"], ["1.2.3.4,x", "x"]]) {
    assert.throws(() => refusedAddresses(value), (err) => err.message === `MAKERSMCP_REFUSE_ADDRESSES holds ${JSON.stringify(item)}, which is neither an IP address nor a range such as 10.0.0.0/8, so nothing was read. Give IP addresses and ranges parted by commas, or leave it empty.`, value);
  }
  // A long item is cut, and what it holds stays on one line.
  assert.throws(() => refusedAddresses(`x${"a".repeat(500)}`), (err) => err.message.startsWith(`MAKERSMCP_REFUSE_ADDRESSES holds "x${"a".repeat(59)}...", which`));
  assert.throws(() => refusedAddresses("1.2.3.4\n,x\u001b[31m"), (err) => err.message.includes('holds "x\\u001b[31m"') && !err.message.includes("\u001b"));
});

test("an address the run was not given is opened on port 80 or 443 only, and the pages on the scheme, host and port given on any", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const guard = guardFor("https://acme.com:8443/pricing");
  for (const raw of ["https://acme.com:8443/", "https://ACME.com:8443/about", "https://acme.com.:8443/x", "http://www.acme.com/", "https://www.acme.com/", "http://acme.com:443/", "https://acme.com:80/", "http://1.1.1.1/", "about:blank", "mailto:a@acme.com", "not an address"]) {
    assert.equal(await guard.judge(raw), "", raw);
  }
  for (const [raw, port] of [["http://acme.com:8443/", "8443"], ["https://www.acme.com:8443/", "8443"], ["https://acme.com:444/", "444"], ["http://1.1.1.1:8080/", "8080"], ["https://1.1.1.1:22/", "22"], ["http://acme.com:25/", "25"], ["http://[2606:4700::1111]:8080/", "8080"]]) {
    assert.equal(await guard.judge(raw), `is on port ${port}, not 80 or 443`, raw);
  }
  // A local site given is the user's own on its own port and nowhere else.
  // https on the host and port of an http address given is the same
  // program, which the browser asks over https by itself for a name that
  // takes only https (HSTS); http on those of an https address given is not.
  const local = guardFor("http://localhost:3000/");
  for (const raw of ["http://localhost:3000/assets/app.css", "http://127.0.0.1:3000/", "http://[::1]:3000/", "https://localhost:3000/", "https://127.0.0.1:3000/x", "http://127.1:3000/"]) assert.equal(await local.judge(raw), "", raw);
  for (const [raw, why] of [["http://localhost:3001/", "is on port 3001, not 80 or 443"], ["https://localhost:3001/", "is on port 3001, not 80 or 443"], ["http://localhost/", "is not on the public internet"], ["https://localhost/", "is not on the public internet"], ["http://10.0.0.5:3000/", "is on port 3000, not 80 or 443"], ["http://10.0.0.5/", "is not on the public internet"]]) {
    assert.equal(await local.judge(raw), why, raw);
  }
  assert.equal(await guardFor("https://localhost:3000/").judge("http://localhost:3000/"), "is on port 3000, not 80 or 443");
  assert.equal(await guardFor("https://acme.com:8443/").judge("http://acme.com:8443/"), "is on port 8443, not 80 or 443");
  assert.equal(await guardFor("http://acme.com:8443/").judge("https://acme.com:8443/x"), "");
  assert.equal(sameHost(new URL("http://localhost:8080/"), new URL("http://127.0.0.1:8080/")), true);
  assert.equal(sameHost(new URL("http://localhost:8080/"), new URL("http://[::1]:8080/")), true);
  assert.equal(sameHost(new URL("http://localhost:8080/"), new URL("http://127.0.0.1:8081/")), false);
  // On the port given, localhost, 127.0.0.1 and [::1] are the host given
  // where it is one of them and they reach an address of it, and a
  // connection there goes to that address alone: from 127.0.0.1, localhost
  // is reached at 127.0.0.1, and [::1], which can be another program on
  // that port, is another host; from [::1] the same the other way.
  const four = guardFor("http://127.0.0.1:4000/");
  assert.equal(await four.judge("http://localhost:4000/site.css"), "");
  assert.deepEqual(await four.route("http://localhost:4000/site.css"), { why: "", addresses: ["127.0.0.1"] });
  assert.equal(await four.judge("http://[::1]:4000/"), "is on port 4000, not 80 or 443");
  const six = guardFor("http://[::1]:4000/");
  assert.deepEqual(await six.route("http://localhost:4000/site.css"), { why: "", addresses: ["::1"] });
  assert.equal(await six.judge("http://127.0.0.1:4000/"), "is on port 4000, not 80 or 443");
  assert.equal(sameHost(new URL("http://127.0.0.1:8080/"), new URL("http://[::1]:8080/")), false);
  // No other host is the host given, though it lead to the same address and
  // port, as a program there serves many sites, each by its name: not a
  // name under localhost, as a router of this machine serves
  // traefik.localhost, nor 0.0.0.0 or ::, which a connection takes for
  // 127.0.0.1 and ::1, nor an IPv6 form of 127.0.0.1 or 0.0.0.0. Each is held
  // to the rule for an address the run was not given, on port 80 as well.
  for (const raw of ["http://app.localhost:3000/x", "http://traefik.localhost:3000/", "http://0.0.0.0:3000/", "http://[::]:3000/x", "http://0:3000/", "http://[::ffff:127.0.0.1]:3000/", "http://[::ffff:0.0.0.0]:3000/", "http://[::7f00:1]:3000/", "http://[::ffff:0:7f00:1]:3000/", "http://[2002:7f00:1::]:3000/", "http://[64:ff9b::7f00:1]:3000/"]) {
    assert.equal(await local.judge(raw), "is on port 3000, not 80 or 443", raw);
    assert.deepEqual(await local.route(raw), { why: "is on port 3000, not 80 or 443", addresses: [] }, raw);
  }
  for (const raw of ["http://app.localhost/", "http://traefik.localhost/api/secret", "http://0.0.0.0/", "http://[::]/", "http://[::ffff:127.0.0.1]/"]) {
    assert.equal(await guardFor("http://localhost/").judge(raw), "is not on the public internet", raw);
  }
  assert.equal(sameHost(new URL("http://app.localhost:8080/"), new URL("http://localhost:8080/")), false);
  assert.equal(sameHost(new URL("http://0.0.0.0:8080/"), new URL("http://127.0.0.1:8080/")), false);
  assert.equal(sameHost(new URL("http://0.0.0.0:8080/"), new URL("http://[::1]:8080/")), false);
  // A name under localhost given is a host of its own, and localhost,
  // 127.0.0.1, [::1] and the other names under localhost are not it.
  const app = guardFor("http://app1.localhost/");
  assert.equal(await app.judge("http://app1.localhost/pricing"), "");
  for (const raw of ["http://traefik.localhost/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/"]) assert.equal(await app.judge(raw), "is not on the public internet", raw);
  // The rest of 127/8 is not this machine's own name either, as another
  // program can listen on 127.0.0.2 or 127.0.0.53 on the same port.
  for (const raw of ["http://127.0.0.2:3000/other-loopback", "http://127.0.0.53:3000/", "http://[::ffff:127.0.0.2]:3000/", "http://127.255.255.254:3000/"]) {
    assert.equal(await local.judge(raw), "is on port 3000, not 80 or 443", raw);
  }
  assert.equal(await guardFor("http://localhost/").judge("http://127.0.0.2/"), "is not on the public internet");
  const other = guardFor("http://127.0.0.2:3000/");
  assert.equal(await other.judge("http://127.0.0.2:3000/x"), "");
  assert.equal(await other.judge("http://localhost:3000/"), "is on port 3000, not 80 or 443");
  assert.equal(sameHost(new URL("http://127.0.0.2:8080/"), new URL("http://localhost:8080/")), false);
});

// The cases of the host given that easybrandkit and easyscreenshotkit judge
// alike (address-cases.json): the host given is its own name, and where it
// is one of this machine's own names, localhost, 127.0.0.1 or [::1],
// localhost and the others it reaches on its port (theHostGiven), each
// connected to at an address of the host given. Nothing else is, though it
// lead to an address of the host given (notTheHostGiven): many sites are
// served at one address and port, a program there picking each by its
// name, so counted as the host given, a name under localhost had a page of
// http://localhost:3000/ load a frame, a picture and a fetch() of
// http://traefik.localhost:3000/, another site of the same program. Each
// is refused for a connection too.
test("the shared table of the host given: this machine's own names on its port where they reach an address of it, and no other host that leads to an address of it", async (t) => {
  let names = {};
  t.mock.method(dns.promises, "lookup", async (host) => {
    if (!names[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return names[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  for (const { given, opened } of CASES.theHostGiven) {
    const guard = guardFor(given);
    const at = (await guard.route(given)).addresses;
    assert.ok(at.length, given);
    for (const raw of opened) {
      assert.equal(await guard.judge(raw), "", `${given} ${raw}`);
      const { why, addresses } = await guard.route(raw);
      assert.equal(why, "", `${given} ${raw}`);
      assert.ok(addresses.length && addresses.every((address) => at.includes(address)), `${given} ${raw} ${addresses}`);
    }
  }
  for (const { given, names: table, refused } of CASES.notTheHostGiven) {
    names = table;
    const guard = guardFor(given);
    assert.equal(await guard.judge(given), "", given);
    for (const raw of refused) {
      const why = await guard.judge(raw);
      assert.match(why, /^is (on port \d+, not 80 or 443|not on the public internet|at [0-9a-f:.]+, an address not on the public internet)$/, `${given} ${raw}`);
      assert.deepEqual(await guard.route(raw), { why, addresses: [] }, `${given} ${raw}`);
    }
  }
});

// A local site whose page names its files by another of this machine's own
// names on the port given, as one given as http://0.0.0.0:4000/ whose dev
// server writes them at http://localhost:4000/, as jekyll serve --host
// 0.0.0.0 and many dev servers do, is read without them, as that name can
// be another site's (see address.js sameHost); given under the name its
// files use, it is read with them. The README's Limits and SKILL.md say
// so, and SKILL.md has an assistant offer that run.
test("a local site whose files are named by another of this machine's own names on its port is read with them when given under that name, as the README and SKILL.md say", async () => {
  for (const [given, file, under] of [
    ["http://0.0.0.0:4000/", "http://localhost:4000/assets/main.css", "http://localhost:4000/"],
    ["http://localhost:36123/", "http://0.0.0.0:36123/m/main.js", "http://0.0.0.0:36123/"],
    ["http://127.0.0.1:5173/", "http://[::1]:5173/src/app.js", "http://[::1]:5173/"],
    ["http://[::]:8080/", "http://127.0.0.1:8080/logo.png", "http://127.0.0.1:8080/"],
  ]) {
    assert.match(await guardFor(given).judge(file), /^is (on port \d+, not 80 or 443|not on the public internet)$/, `${given} ${file}`);
    assert.equal(await guardFor(under).judge(file), "", `${under} ${file}`);
  }
  const fs = require("node:fs");
  const path = require("node:path");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes("or give the address under the name its files use, when that is one of this machine's own names on that port, as `http://localhost:4000/` for a site given as `http://0.0.0.0:4000/` whose page names its files at localhost."));
  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "easybrandkit", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(skill.includes("When the note names one of this machine's own names on the port given, `localhost`, `127.0.0.1`, `[::1]`, 0.0.0.0 or `[::]`, offer the user a run with the address given under that name instead, as for a site that moves on to another of its names, and run it once they say so."));
});

test("a run that has no address of its own, as one reading a site another source named, holds every address to the rule, this machine's and those on any port included", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const none = guardFor(null);
  for (const [raw, why] of [
    ["http://localhost:3000/", "is on port 3000, not 80 or 443"],
    ["http://127.0.0.1/", "is not on the public internet"],
    ["https://acme.com:8443/", "is on port 8443, not 80 or 443"],
    ["https://acme.com/", ""],
    ["http://www.acme.com/about", ""],
  ]) {
    assert.equal(await none.judge(raw), why, raw);
  }
  // A request the kit makes itself, as for robots.txt, connects to the
  // addresses of the rule's own lookup, held to the rule, on the address
  // given too.
  assert.deepEqual(await none.addressesFor("https://acme.com/robots.txt"), ["93.184.216.34"]);
  await assert.rejects(none.addressesFor("http://localhost:3000/robots.txt"), (err) => err.code === "ENOTPUBLIC" && err.message === "http://localhost:3000/robots.txt is on port 3000, not 80 or 443");
  assert.deepEqual(await guardFor("http://localhost:3000/").addressesFor("http://localhost:3000/robots.txt"), ["::1", "127.0.0.1"]);
});

// This machine's own addresses, as its network interfaces hold them, and
// the IPv6 network of each, are not opened away from the address given,
// though their ranges are on the public internet: a machine on an IPv6
// network holds a global address of its own, and a server can hold a
// public IPv4 address, and a site that read one off the kit's connection
// had the browser load a frame, a picture or a fetch() from a service of
// this machine there, and a site that sent its visitors there had the kit
// saved as that service's. The rest of a public IPv4 range on an interface
// is other people's servers. The interfaces are read as the run goes, at
// most once a second; and an address of this machine given is the user's
// own choice, as localhost is.
test("an address this machine's network interfaces hold, a public one included, and the IPv6 network of one are not opened away from the address given", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let interfaces = SERVER;
  t.mock.method(os, "networkInterfaces", () => interfaces);
  t.mock.method(dns.promises, "lookup", async (host) => {
    const known = { "own-machine.example": ["81.2.69.160"], "own-machine6.example": ["2a02:1205:5000::1"], "own-lan6.example": ["2a02:1205:5000::77"], "own-site.example": ["93.184.215.14"] }[host];
    if (!known) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return known.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  const guard = guardFor("https://own-site.example/");
  for (const [raw, why] of [
    ["http://81.2.69.160/", "is at 81.2.69.160, an address of this machine"],
    ["http://81.2.69.160/server-status", "is at 81.2.69.160, an address of this machine"],
    ["http://[2a02:1205:5000::1]/frame", "is at 2a02:1205:5000::1, an address of this machine"],
    ["https://[2a02:1205:5000:0:5c1b:2e:9a4f:11d0]/", "is at 2a02:1205:5000:0:5c1b:2e:9a4f:11d0, an address of this machine"],
    ["http://[::ffff:81.2.69.160]/", "is at ::ffff:5102:45a0, an address of this machine"],
    ["http://[64:ff9b::81.2.69.160]/", "is at 64:ff9b::5102:45a0, an address of this machine"],
    ["http://1359103392/", "is at 81.2.69.160, an address of this machine"],
    ["http://[2a02:1205:5000::77]/api", "is at 2a02:1205:5000::77, on a network of this machine"],
    ["http://own-machine.example/robots.txt", "is at 81.2.69.160, an address of this machine"],
    ["http://own-machine6.example/", "is at 2a02:1205:5000::1, an address of this machine"],
    ["https://own-lan6.example/", "is at 2a02:1205:5000::77, on a network of this machine"],
    // Other people's servers in the public IPv4 range of the interface,
    // and another IPv6 network.
    ["http://81.2.69.161/", ""],
    ["http://[2a02:1205:5001::1]/", ""],
    ["https://own-site.example/pricing", ""],
  ]) {
    assert.equal(await guard.judge(raw), why, raw);
    // A connection to one is not made either.
    if (why) assert.deepEqual(await guard.route(raw), { why, addresses: [] }, raw);
  }
  await assert.rejects(guard.addressesFor("http://own-machine.example/robots.txt"), (err) => err.code === "ENOTPUBLIC" && err.message === "http://own-machine.example/robots.txt is at 81.2.69.160, an address of this machine");
  assert.equal(ownIp("81.2.69.160"), "machine");
  assert.equal(ownIp("[2a02:1205:5000::77]"), "network");
  assert.equal(ownIp("93.184.215.14"), "");
  // Read as the run goes: once a second has passed, an address the machine
  // no longer holds is any other.
  interfaces = LOOPBACK;
  assert.equal(await guard.judge("http://81.2.69.160/"), "is at 81.2.69.160, an address of this machine");
  t.mock.timers.tick(1_000);
  assert.equal(await guard.judge("http://81.2.69.160/"), "");
  assert.equal(await guard.judge("http://[2a02:1205:5000::77]/"), "");
  interfaces = SERVER;
  t.mock.timers.tick(1_000);
  // Given as the address, it is the user's own choice, as localhost is:
  // that host and port are opened, and no other address of the machine;
  // https on port 443 of it given on port 80 is another program, as for
  // any host.
  const given = guardFor("http://81.2.69.160:8080/");
  assert.equal(await given.judge("http://81.2.69.160:8080/"), "");
  assert.deepEqual(await given.route("http://81.2.69.160:8080/app.js"), { why: "", addresses: ["81.2.69.160"] });
  assert.equal(await given.judge("http://[2a02:1205:5000::1]/"), "is at 2a02:1205:5000::1, an address of this machine");
  assert.equal(await guardFor("http://own-machine.example/").judge("http://own-machine.example/pricing"), "");
  assert.equal(await guardFor("http://own-machine.example/").judge("https://own-machine.example/"), "is at 81.2.69.160, an address of this machine");
  // Such an address given is no site the system's proxy settings stand in
  // front of, as one of this machine's (see kit.js notThroughProxy).
  assert.equal(notPublicByForm(new URL("http://81.2.69.160:8080/")), true);
  assert.equal(notPublicByForm(new URL("http://[2a02:1205:5000::77]/")), true);
  assert.equal(notPublicByForm(new URL("http://81.2.69.161/")), false);
});

// The IPv6 network of a global address of this machine's is the prefix its
// interface gives it, held to /48 at the widest and /64 at the narrowest.
// A DHCPv6 client holds the address it gets at /128, and the network's /64
// comes from the router's advertisement as a route alone, which the kit
// does not read: with no network for such an address, the router at the
// prefix's ::1 and every other device of the user's own network counted as
// the public internet, so a page's picture, frame and fetch() reached them
// and a site that sent its visitors there had the kit saved as the
// router's, and a device of that network given by its name, which answers
// with its private IPv4 address and its global IPv6 one, was refused as a
// name whose answers mix, where on a network that gives addresses by SLAAC,
// at /64, it was read. ::1, which every machine holds at /128, is no global
// address and gives no network.
test("the IPv6 network of an address of this machine's is the prefix its interface gives it, /48 at the widest and /64 at the narrowest, so the /64 around one held at /128, as DHCPv6 gives one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 3_000_000 });
  const v6 = (address, bits) => ({ address, netmask: "", family: "IPv6", internal: false, cidr: `${address}/${bits}`, scopeid: 0 });
  // An address whose prefix Node.js could not tell, with cidr null, as for
  // a netmask that is not one, is held alone, at /128.
  let interfaces = { ...LOOPBACK, eth0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "192.168.1.20/24" }, v6("2001:470:1:2::5", 128), v6("fe80::5", 64)], tun0: [{ ...v6("2001:470:9:9::5", 0), cidr: null }] };
  t.mock.method(os, "networkInterfaces", () => interfaces);
  const names = { "router.example": ["2001:470:1:2::1"], "nas.example": ["192.168.1.50", "2001:470:1:2::50"], "site.example": ["93.184.216.34"] };
  t.mock.method(dns.promises, "lookup", async (host) => {
    if (!names[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return names[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  const site = guardFor("https://site.example/");
  for (const [raw, why] of [
    ["http://[2001:470:1:2::1]/pixel.png", "is at 2001:470:1:2::1, on a network of this machine"],
    ["http://router.example/api", "is at 2001:470:1:2::1, on a network of this machine"],
    ["https://[2001:470:1:2:ffff:ffff:ffff:fffe]/", "is at 2001:470:1:2:ffff:ffff:ffff:fffe, on a network of this machine"],
    ["http://[2001:470:1:2::5]/", "is at 2001:470:1:2::5, an address of this machine"],
    ["http://[2001:470:9:9::7]/", "is at 2001:470:9:9::7, on a network of this machine"],
    // Held at /128, its network is the /64 around it, not the /48.
    ["http://[2001:470:9:a::1]/", ""],
    // Another /64 is another network.
    ["http://[2001:470:1:3::1]/", ""],
    ["http://[2001:470:1:1:ffff:ffff:ffff:ffff]/", ""],
    // ::/64, around ::1, holds no network of this machine's.
    ["http://[::1:0:0:1]/", ""],
  ]) {
    assert.equal(await site.judge(raw), why, raw);
  }
  // A device of that network given by its name is the user's own, every
  // address of it, as on a network that gives addresses by SLAAC; away from
  // the address given it is refused by its first address that is not on
  // the public internet.
  assert.deepEqual(await guardFor("http://nas.example:5000/").route("http://nas.example:5000/"), { why: "", addresses: ["192.168.1.50", "2001:470:1:2::50"] });
  assert.equal(await site.judge("http://nas.example/"), "is at 192.168.1.50, an address not on the public internet");
  // A prefix from /48 to /64 is the network: from a /56, another address of
  // it outside any /64 of the machine's is refused, and one past the /56 is
  // not.
  interfaces = { ...LOOPBACK, eth0: [v6("2a02:1205:5000:ab00::5", 56)] };
  t.mock.timers.tick(1_000);
  assert.equal(await site.judge("http://[2a02:1205:5000:abff::9]/"), "is at 2a02:1205:5000:abff::9, on a network of this machine");
  assert.equal(await site.judge("http://[2a02:1205:5000:ac00::1]/"), "");
  // A shorter prefix gives the /48 around the address, and no more of it.
  interfaces = { ...LOOPBACK, eth0: [v6("2a02:1205:5000::5", 40)] };
  t.mock.timers.tick(1_000);
  assert.equal(await site.judge("http://[2a02:1205:5000:ffff::1]/"), "is at 2a02:1205:5000:ffff::1, on a network of this machine");
  assert.equal(await site.judge("http://[2a02:1205:5001::1]/"), "");
  // At /64, as SLAAC gives one, the /64 alone.
  interfaces = { ...LOOPBACK, eth0: [v6("2001:470:1:2::5", 64)] };
  t.mock.timers.tick(1_000);
  assert.equal(await site.judge("http://[2001:470:1:2::1]/"), "is at 2001:470:1:2::1, on a network of this machine");
  // Another network of the same site, as a router's guest network in its
  // /56, cannot be told from the public internet: the README's Limits and
  // SKILL.md say so, and that MAKERSMCP_REFUSE_ADDRESSES can name its
  // ranges, which it then refuses as the address given too.
  assert.equal(await site.judge("http://[2001:470:1:3::1]/"), "");
  const fs = require("node:fs");
  const path = require("node:path");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const limits = readme.slice(readme.indexOf("\n## Limits\n")).replace(/\s+/g, " ");
  assert.match(limits, /Nor can it tell the rest of your own network where it is at public addresses outside the networks of this machine's interfaces, [^.]*: a page can have the browser reach a device there too\. On such a network, name its ranges in `MAKERSMCP_REFUSE_ADDRESSES`, which then refuses them as the address you give too\./);
  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "easybrandkit", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /The kit takes the rest of the user's own network for the public internet where it is at public addresses outside the networks of the machine's interfaces, [^.]*\. When the user says their network is such, tell them that `MAKERSMCP_REFUSE_ADDRESSES` can name its ranges, which are then refused as the address given too\./);
  const guest = guardFor("https://site.example/", { refused: refusedAddresses("2001:470:1::/56") });
  assert.equal(await guest.judge("http://[2001:470:1:3::1]/"), "is at 2001:470:1:3::1, an address MAKERSMCP_REFUSE_ADDRESSES refuses");
  assert.equal(await guardFor("http://[2001:470:1:3::9]:3000/", { refused: refusedAddresses("2001:470:1::/56") }).judge("http://[2001:470:1:3::9]:3000/"), "is at 2001:470:1:3::9, an address MAKERSMCP_REFUSE_ADDRESSES refuses");
});

// An IPv6 address that holds an IPv4 one is judged by that IPv4 address and
// by itself. A network that gives this machine a 6to4 address (2002::/16)
// builds it from the IPv4 address of its 6to4 router, which another box
// holds: judged by that IPv4 address alone, the machine's own 6to4 address
// and every device of its 6to4 network, the router at the prefix's ::1
// among them, were taken for the public internet, so a page's pictures,
// frames and fetch() reached them.
test("an address of this machine's that holds an IPv4 address, as a 6to4 one, and its IPv6 network are this machine's, though another box holds that IPv4 address", async (t) => {
  t.mock.method(os, "networkInterfaces", () => ({
    ...LOOPBACK,
    dm0: [
      { address: "93.184.215.14", netmask: "255.255.255.255", family: "IPv4", internal: false, cidr: "93.184.215.14/32" },
      { address: "2002:5db8:d822:1::5", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2002:5db8:d822:1::5/64", scopeid: 0 },
    ],
  }));
  assert.equal(ownIp("2002:5db8:d822:1::5"), "machine");
  assert.equal(ownIp("2002:5db8:d822:1::1"), "network");
  assert.equal(ownIp("[2002:5db8:d822:1::50]"), "network");
  // The IPv4 address it holds is another box's, and another 6to4 network
  // of that address is another network.
  assert.equal(ownIp("93.184.216.34"), "");
  assert.equal(ownIp("2002:5db8:d822:2::1"), "");
  // An IPv6 form of this machine's own IPv4 address is this machine's.
  assert.equal(ownIp("2002:5db8:d70e::1"), "machine");
  assert.equal(ownIp("::ffff:93.184.215.14"), "machine");
  const site = guardFor("https://site.example/");
  for (const [raw, why] of [
    ["http://[2002:5db8:d822:1::5]/pixel.png", "is at 2002:5db8:d822:1::5, an address of this machine"],
    ["http://[2002:5db8:d822:1::1]/admin", "is at 2002:5db8:d822:1::1, on a network of this machine"],
    ["http://[2002:5db8:d70e::1]/", "is at 2002:5db8:d70e::1, an address of this machine"],
    ["http://93.184.216.34/", ""],
    ["http://[2002:5db8:d822:2::1]/", ""],
  ]) {
    assert.equal(await site.judge(raw), why, raw);
  }
});

// The machine's network interfaces are read once a second at most, however
// many addresses the run judges meanwhile, and again where the clock went
// back or the function that reads them is another, as a test puts one in
// its place.
test("this machine's network interfaces are read once a second at most, whatever the run judges meanwhile", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  t.mock.method(dns.promises, "lookup", async () => [1, 2, 3, 4].map((n) => ({ address: `93.184.216.${n}`, family: 4 })));
  let reads = 0;
  let interfaces = LOOPBACK;
  const reader = () => {
    reads++;
    return interfaces;
  };
  const real = os.networkInterfaces;
  const first = t.mock.method(os, "networkInterfaces", reader);
  const guard = guardFor(null);
  for (let n = 0; n < 50; n++) {
    assert.equal(await guard.judge(`https://four.example/${n}`), "");
    assert.equal((await guard.route(`https://four.example/${n}`)).addresses.length, 4);
  }
  assert.equal(reads, 1);
  t.mock.timers.tick(999);
  interfaces = { eth0: [{ address: "93.184.216.2", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "93.184.216.2/24" }] };
  assert.equal(await guard.judge("https://four.example/"), "");
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  assert.equal(await guard.judge("https://four.example/"), "is on a host whose name answers with an address on the public internet, 93.184.216.1, and with one of this machine's, 93.184.216.2");
  assert.equal(reads, 2);
  interfaces = {};
  t.mock.timers.setTime(4_000_000);
  assert.equal(await guard.judge("https://four.example/"), "");
  assert.equal(reads, 3);
  // The first stand-in taken back before the second is put in place, so
  // the function this test found is there again when it ends.
  first.mock.restore();
  t.mock.method(os, "networkInterfaces", () => {
    reads++;
    return { eth1: [{ address: "93.184.216.3", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "93.184.216.3/24" }] };
  });
  assert.equal(await guard.judge("https://four.example/"), "is on a host whose name answers with an address on the public internet, 93.184.216.1, and with one of this machine's, 93.184.216.3");
  assert.equal(reads, 4);
  t.mock.restoreAll();
  assert.equal(os.networkInterfaces, real);
});

// A reading of the interfaces that the system refuses, as where a Linux
// service's RestrictAddressFamilies leaves out AF_NETLINK, or where this
// process has as many files open as it may, throws, and Node.js names its
// error by its number alone. Let go, it left this machine with no address
// of its own, so each of them was opened away from the address given. The
// last reading holds; with none, why not is told, which stops a run before
// any work (see kit.js makeKit).
test("a reading of this machine's network interfaces that the system refuses keeps the last one, and with none says why", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 7_000_000 });
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  // As Node.js throws it, the error's number given as it is, with no code.
  const refusal = (errno) => Object.assign(new Error(`A system error occurred: uv_interface_addresses returned Unknown system error ${errno} (Unknown system error ${errno})`), { code: "ERR_SYSTEM_ERROR", errno, syscall: "uv_interface_addresses" });
  let errno = 0;
  let reads = 0;
  // Each stand-in is taken back before the next is put in place, so the
  // function this test found is there again when it ends: two in place at
  // once, the mock tracker puts the first back in place of the second.
  const real = os.networkInterfaces;
  const first = t.mock.method(os, "networkInterfaces", () => {
    reads++;
    if (errno) throw refusal(errno);
    return SERVER;
  });
  const guard = guardFor("https://site.example/");
  assert.equal(await guard.judge("http://81.2.69.160/"), "is at 81.2.69.160, an address of this machine");
  errno = 24;
  for (let n = 1; n <= 3; n++) {
    t.mock.timers.tick(1_000);
    assert.equal(await guard.judge("http://81.2.69.160/"), "is at 81.2.69.160, an address of this machine");
    assert.equal(await guard.judge("http://[2a02:1205:5000::77]/"), "is at 2a02:1205:5000::77, on a network of this machine");
    assert.equal(interfacesUnread(), null);
    // Tried again once a second at most, as a reading that was let be.
    assert.equal(reads, 1 + n);
  }
  // Read again once the system lets it.
  errno = 0;
  t.mock.timers.tick(1_000);
  assert.equal(interfacesUnread(), null);
  first.mock.restore();
  // With no reading before it, why not, in the system's words for its
  // number, or its message where it has none.
  for (const [error, why] of [
    [refusal(24), { code: "EMFILE", words: "too many open files (EMFILE)" }],
    [refusal(97), { code: "EAFNOSUPPORT", words: "address family not supported (EAFNOSUPPORT)" }],
    [Object.assign(new Error("A system error occurred:\nuv_interface_addresses returned nothing"), { code: "ERR_SYSTEM_ERROR" }), { code: "", words: "A system error occurred: uv_interface_addresses returned nothing" }],
    [new Error("x".repeat(300)), { code: "", words: "x".repeat(200) }],
  ]) {
    const reader = t.mock.method(os, "networkInterfaces", () => {
      throw error;
    });
    assert.deepEqual(interfacesUnread(), why);
    // Within the second, from the same reading.
    assert.deepEqual(interfacesUnread(), why);
    reader.mock.restore();
  }
  assert.equal(os.networkInterfaces, real);
});

// A name that answers both with an address on the public internet and with
// one that is not, or that is this machine's own or on one of its
// networks, is not opened wherever it is met, the address given included,
// which a run then refuses before any work (see kit.js makeKit): taken for
// the user's own, as one of its answers was, its every answer was opened,
// so a site whose name answered with its public address and with
// 127.0.0.1 had every request of the run go to a service of this machine on
// 127.0.0.1 where the system put that address first, or once the public
// address had stopped answering, and that service's page was saved as the
// site's. Away from the address given such a name is named in the same
// words, not as one off the public internet, which it is not alone. A name
// all of whose answers are inside is the user's own, as a dev name at
// 127.0.0.1 is.
test("a name that answers both on the public internet and off it, or at this machine, is refused wherever it is met, the address given included, in the same words, and one all of whose answers are inside is the user's own when given", async (t) => {
  t.mock.method(os, "networkInterfaces", () => SERVER);
  const names = {
    "mixed.example": ["93.184.216.34", "127.0.0.1"],
    "mixed6.example": ["2606:2800:220:1:248:1893:25c8:1946", "::1"],
    "first.example": ["127.0.0.1", "93.184.216.34"],
    "private.example": ["93.184.216.34", "192.168.1.1"],
    "metadata.example": ["93.184.216.34", "169.254.169.254"],
    "evil-own.example": ["93.184.216.34", "81.2.69.160"],
    "evil-lan.example": ["93.184.216.34", "2a02:1205:5000::77"],
    "evil-fake.example": ["2606:2800:220:1::99", "198.18.0.5"],
    "mixdev.example": ["127.0.0.1", "::1"],
    "site.example": ["93.184.216.34"],
  };
  t.mock.method(dns.promises, "lookup", async (host) => {
    if (!names[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return names[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  const mix = (outside, kind, inside) => `is on a host whose name answers with an address on the public internet, ${outside}, and with ${kind}, ${inside}`;
  for (const [given, why] of [
    ["http://mixed.example/", mix("93.184.216.34", "one that is not", "127.0.0.1")],
    ["http://mixed6.example/", mix("2606:2800:220:1:248:1893:25c8:1946", "one that is not", "::1")],
    ["http://first.example/", mix("93.184.216.34", "one that is not", "127.0.0.1")],
    ["https://private.example/", mix("93.184.216.34", "one that is not", "192.168.1.1")],
    ["https://metadata.example/", mix("93.184.216.34", "one that is not", "169.254.169.254")],
    ["https://evil-own.example/", mix("93.184.216.34", "one of this machine's", "81.2.69.160")],
    ["https://evil-lan.example/", mix("93.184.216.34", "one on a network of this machine", "2a02:1205:5000::77")],
    ["http://evil-fake.example/", mix("2606:2800:220:1::99", "one in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15", "198.18.0.5")],
  ]) {
    // Given, the address itself, its own pages and https on its host, and
    // every connection for them, with MAKERSMCP_REFUSE_ADDRESSES set or not.
    const { hostname } = new URL(given);
    for (const guard of [guardFor(given), guardFor(given, { refused: refusedAddresses("127.0.0.0/8,::1") })]) {
      for (const raw of [given, `http://${hostname}/api/data`, `https://${hostname}/`, `http://${hostname}./x`]) {
        assert.equal(await guard.judge(raw), why, raw);
        assert.deepEqual(await guard.route(raw), { why, addresses: [] }, raw);
      }
      await assert.rejects(guard.addressesFor(`http://${hostname}/robots.txt`), (err) => err.code === "ENOTPUBLIC" && err.message === `http://${hostname}/robots.txt ${why}`, given);
    }
    // Away from the address given, in the same words, from a public site,
    // from a site of this machine and with no address given.
    for (const other of [guardFor("https://site.example/"), guardFor("http://localhost:4000/"), guardFor(null)]) {
      assert.equal(await other.judge(`https://${hostname}/logo.png`), why, given);
      assert.deepEqual(await other.route(`https://${hostname}/logo.png`), { why, addresses: [] }, given);
    }
    // The README's Limits, SKILL.md and --help quote it in its general form.
    assert.match(why, /^is on a host whose name answers with an address on the public internet, [0-9a-f:.]+, and with one /, given);
  }
  // All its answers inside: the user's own, every answer for a connection.
  const dev = guardFor("http://mixdev.example:4000/");
  assert.equal(await dev.judge("http://mixdev.example:4000/"), "");
  assert.deepEqual(await dev.route("http://mixdev.example:4000/app.js"), { why: "", addresses: ["127.0.0.1", "::1"] });
  // And all of them public: any site.
  assert.equal(await guardFor("https://site.example/").judge("https://site.example/pricing"), "");
  // The texts say the rule once each, in that general form, with the way
  // out that works.
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const general = '"on a host whose name answers with an address on the public internet, <address>, and with one ..."';
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const limits = readme.slice(readme.indexOf("\n## Limits\n"));
  for (const [where, text] of [
    ["the README's Limits", limits.slice(0, limits.indexOf("\n## ", 2))],
    ["SKILL.md", fs.readFileSync(path.join(__dirname, "..", "skills", "easybrandkit", "SKILL.md"), "utf8")],
    ["--help", spawnSync(process.execPath, [path.join(__dirname, "..", "skills", "easybrandkit", "scripts", "easybrandkit.js"), "--help"], { encoding: "utf8" }).stdout],
  ]) {
    const flat = text.replace(/\s+/g, " ");
    assert.ok(flat.includes(general), where);
    assert.match(flat.slice(flat.indexOf(general) + general.length), /^[^.]*answers? (?:its|that) name with the address (?:you|the user) means? alone, as a line in its hosts file does\./, where);
  }
});

test("an address the run was not given is opened only on the public internet, by its form and by every address its name is found at, and never where its name is not found in time", async (t) => {
  const asked = [];
  t.mock.method(dns.promises, "lookup", async (host) => {
    asked.push(host);
    if (host === "intranet.acme.com") return [{ address: "10.0.0.5", family: 4 }, { address: "10.0.0.6", family: 4 }];
    if (host === "teredo.acme.com") return [{ address: "2001:0:7f00:1::1", family: 6 }];
    if (host === "fake.acme.com") return [{ address: "198.18.0.12", family: 4 }];
    if (host === "nat64.acme.com") return [{ address: "64:ff9b::5db8:d822", family: 6 }];
    if (host === "nat64-inside.acme.com") return [{ address: "64:ff9b::a00:5", family: 6 }];
    if (host === "gone.acme.com") throw Object.assign(new Error("getaddrinfo ENOTFOUND gone.acme.com"), { code: "ENOTFOUND" });
    if (host === "empty.acme.com") return [];
    if (host === "slow.acme.com") return new Promise(() => {});
    return [{ address: "93.184.216.34", family: 4 }];
  });
  const guard = guardFor("https://acme.com/");
  for (const [raw, why] of [
    ["http://127.0.0.1/", "is not on the public internet"],
    ["http://127.1/", "is not on the public internet"],
    ["http://2130706433/", "is not on the public internet"],
    ["http://0x7f.0.0.1/", "is not on the public internet"],
    ["http://0.0.0.0/", "is not on the public internet"],
    ["http://localhost/", "is not on the public internet"],
    ["http://LOCALHOST./", "is not on the public internet"],
    ["http://localhost../", "is not on the public internet"],
    ["http://app.localhost/", "is not on the public internet"],
    ["http://[::1]/", "is not on the public internet"],
    ["http://[::ffff:127.0.0.1]/", "is not on the public internet"],
    ["http://[::7f00:1]/", "is not on the public internet"],
    ["http://[::ffff:0:7f00:1]/", "is not on the public internet"],
    ["http://[2002:7f00:1::]/", "is not on the public internet"],
    ["http://[64:ff9b::7f00:1]/", "is not on the public internet"],
    ["http://[64:ff9b:1::7f00:1]/", "is not on the public internet"],
    ["http://[2001:0:7f00:1::1]/", "is not on the public internet"],
    ["http://[fe80::1]/", "is not on the public internet"],
    ["http://[fd00::1]/", "is not on the public internet"],
    ["http://169.254.169.254/latest/meta-data/", "is not on the public internet"],
    ["http://10.1.2.3/", "is not on the public internet"],
    ["http://192.0.2.1/", "is not on the public internet"],
    ["https://intranet.acme.com/", "is at 10.0.0.5, an address not on the public internet"],
    ["https://teredo.acme.com/", "is at 2001:0:7f00:1::1, an address not on the public internet"],
    ["https://fake.acme.com/", "is at 198.18.0.12, an address not on the public internet"],
    ["https://nat64-inside.acme.com/", "is at 64:ff9b::a00:5, an address not on the public internet"],
    ["https://gone.acme.com/", "is on a host whose name could not be looked up"],
    ["https://empty.acme.com/", "is on a host whose name could not be looked up"],
  ]) {
    assert.equal(await guard.judge(raw), why, raw);
  }
  for (const raw of ["https://www.acme.com/", "https://nat64.acme.com/", "http://[2606:4700::1111]/", "http://[::ffff:5db8:d822]/", "http://[64:ff9b::5db8:d822]/", "http://93.184.216.34/"]) assert.equal(await guard.judge(raw), "", raw);
  // Each name is asked once in a run, also when it is judged again.
  assert.equal(await guard.judge("https://intranet.acme.com/other"), "is at 10.0.0.5, an address not on the public internet");
  assert.equal(asked.filter((host) => host === "intranet.acme.com").length, 1);
  // The address given is the user's own whatever its host, as a site on
  // this machine is. Its name is looked up too, once a run, as one whose
  // answers mix is not opened even given (see the test of such names).
  const given = guardFor("http://intranet.acme.com:8080/");
  assert.equal(await given.judge("http://intranet.acme.com:8080/x"), "");
  assert.equal(await given.judge("http://intranet.acme.com:8080/y"), "");
  assert.equal(asked.filter((host) => host === "intranet.acme.com").length, 2);
  // https on port 443 of a host given on port 80 is another program, held
  // to the rule as any address the run was not given.
  assert.equal(await guardFor("http://intranet.acme.com/").judge("https://intranet.acme.com/"), "is at 10.0.0.5, an address not on the public internet");
  // A name that gives no answer in 5 s is not opened.
  const started = Date.now();
  assert.equal(await guard.judge("https://slow.acme.com/"), "is on a host whose name could not be looked up");
  assert.ok(Date.now() - started >= 4_900, `${Date.now() - started} ms`);
});

test("a name under .local or of one label that the run was not given is not on the public internet by its form and is not looked up, as the system can look it up on this machine's own networks; given, it is looked up", async (t) => {
  const asked = [];
  t.mock.method(dns.promises, "lookup", async (host) => {
    asked.push(host);
    return [{ address: host.startsWith("devbox") ? "192.168.1.20" : "93.184.216.34", family: 4 }];
  });
  const guard = guardFor("https://acme.com/");
  for (const raw of ["http://printer.local/", "https://nas.home.local/x.png", "http://PRINTER.LOCAL./", "http://printer.local../", "http://local/", "http://intranet/", "http://intranet./", "https://intranet:443/", "http://xn--bcher-kva/", "http://devbox.local/"]) {
    assert.equal(await guard.judge(raw), "is not on the public internet", raw);
    assert.deepEqual(await guard.route(raw), { why: "is not on the public internet", addresses: [] }, raw);
    await assert.rejects(guard.addressesFor(raw), (err) => err.code === "ENOTPUBLIC", raw);
  }
  assert.deepEqual(asked, [], "no such name was looked up");
  // Names that only end in local, or hold more than one label, are judged
  // by where they are found.
  for (const raw of ["https://local.acme.com/", "https://notlocal.example/x", "https://acme.locale/"]) assert.equal(await guard.judge(raw), "", raw);
  assert.deepEqual(asked, ["local.acme.com", "notlocal.example", "acme.locale"]);
  // Given, such a name is the user's own, looked up for a connection to it
  // and its own pages, and another port of it is not.
  asked.length = 0;
  for (const given of ["http://devbox.local:3000/", "http://devbox:3000/"]) {
    const own = guardFor(given);
    assert.deepEqual(await own.route(`${given}app.js`), { why: "", addresses: ["192.168.1.20"] }, given);
    assert.equal(await own.judge(given.replace(":3000", ":3001")), "is on port 3001, not 80 or 443", given);
    assert.equal(await own.judge(given.replace(":3000", "")), "is not on the public internet", given);
  }
  assert.deepEqual(asked, ["devbox.local", "devbox"]);
});

test("an address written with http: or https: that the URL parser here cannot read is not opened, as the browser can read it and go where its host leads", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const why = "is not an address easybrandkit can read";
  // Labels of broken punycode, which the browser keeps as they are written,
  // under localhost, which is this machine to it, and under names whose DNS
  // gives any address; and an IPv6 address with a wide digit. The URL parser
  // of Node.js 22.22 refuses each of them, that of Node.js 22.23 reads
  // xn--a- as a host, and that of Node.js 24 reads all but the wide digit as
  // hosts with those labels, which the kit reads as no address all the
  // same, whatever Node.js it runs on.
  const unreadable = [
    "http://xn--a.localhost:9222/json/list", "http://XN--A.localhost:9222/", "http://xn--a-.localhost:9222/", "http://a.xn--.localhost:9222/", "http://xn---.localhost:9222/",
    "https://xn--zz.localhost/", "http://xn--a.127.0.0.1.nip.io:9222/", "http://xn--a.169.254.169.254.nip.io/latest/meta-data/", "http://[::１]/",
    " HTTP://xn--a.localhost/", "ht\ttp://xn--a.localhost/", "http:xn--a.localhost:9222/", "http://xn--a.localhost..:9222/", "http://xn--a.xn--bcher-kva.example/",
  ];
  const refused = refusedAddresses("127.0.0.0/8,185.137.215.163");
  for (const guard of [guardFor("https://acme.com/"), guardFor(null), guardFor("http://localhost:9222/"), guardFor("https://acme.com/", { refused })]) {
    for (const raw of unreadable) assert.equal(await guard.judge(raw), why, JSON.stringify(raw));
    // What is not written as a web address is left to the browser's own
    // handling of it, as before.
    for (const raw of ["not an address", "mailto:a@acme.com", "about:blank", "ftp://xn--a.localhost/"]) assert.equal(await guard.judge(raw), "", raw);
  }
  // A request the kit made itself to one would connect to no address.
  await assert.rejects(guardFor("http://localhost:9222/").addressesFor("http://xn--a.localhost:9222/robots.txt"), (err) => err.code === "ENOTPUBLIC" && err.message === `http://xn--a.localhost:9222/robots.txt ${why}`);
  // A label that decodes is the name it stands for, and is judged.
  for (const raw of ["https://xn--bcher-kva.example/", "https://xn--80ak6aa92e.com/", "https://www.xn--zca.example/"]) assert.equal(await guardFor("https://acme.com/").judge(raw), "", raw);
  // Under localhost such a name is a host of its own, as any name there is,
  // and is the host given when given.
  assert.equal(await guardFor("http://localhost:9222/").judge("http://xn--bcher-kva.localhost:9222/"), "is on port 9222, not 80 or 443");
  assert.equal(await guardFor("http://xn--bcher-kva.localhost:9222/").judge("http://xn--bcher-kva.localhost:9222/json/list"), "");
});

test("an address given whose host has a label of broken punycode is no web address, whatever Node.js reads it, and one whose labels decode is read", () => {
  const { normalizeUrl } = require("../skills/easybrandkit/scripts/lib/kit");
  for (const raw of ["http://xn--a.localhost:9222/json/list", "xn--a.localhost:9222", "https://XN--ZZ.example/", "http://a.xn--.localhost/", "http://xn--a-.localhost:9222/"]) {
    assert.throws(() => normalizeUrl(raw), (err) => err.message === `Not a web address: ${raw}`, raw);
  }
  assert.equal(normalizeUrl("xn--bcher-kva.example"), "https://xn--bcher-kva.example/");
  assert.equal(normalizeUrl("http://b\u00fccher.example/"), "http://xn--bcher-kva.example/");
});

test("a host whose last dots are taken off is read again as the URL parser reads a host, so a short or other IPv4 form is the address it is, with no lookup", async (t) => {
  const asked = [];
  t.mock.method(dns.promises, "lookup", async (host) => {
    asked.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  const guard = guardFor("https://acme.com/");
  for (const raw of ["http://127.1../", "http://0x7f.1../", "http://0177.1../", "http://10.655363../", "http://192.168.1../", "http://169.254.43518../latest/meta-data/", "http://2130706433../", "http://127.0.0.1.../"]) {
    assert.equal(await guard.judge(raw), "is not on the public internet", raw);
  }
  assert.deepEqual(asked, []);
  // A name keeps its letters, its dots taken off.
  assert.equal(await guard.judge("https://www.acme.com../"), "");
  assert.deepEqual(asked, ["www.acme.com"]);
  // This machine on the port given, so written, is the address given.
  const local = guardFor("http://localhost:3000/");
  assert.equal(await local.judge("http://127.1..:3000/"), "");
  assert.equal(sameHost(new URL("http://0x7f.1..:8080/"), new URL("http://localhost:8080/")), true);
});

test("route gives the addresses a connection may go to, every address the lookup found for the host and none for one the rule refuses, the address given looked up too", async (t) => {
  const asked = [];
  t.mock.method(dns.promises, "lookup", async (host) => {
    asked.push(host);
    if (host === "intranet.acme.com") return [{ address: "10.0.0.5", family: 4 }];
    if (host === "gone.acme.com") throw Object.assign(new Error("getaddrinfo ENOTFOUND gone.acme.com"), { code: "ENOTFOUND" });
    return [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }];
  });
  const both = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  const guard = guardFor("http://intranet.acme.com:8080/");
  assert.deepEqual(await guard.route("https://www.acme.com/"), { why: "", addresses: both });
  assert.deepEqual(await guard.route("http://www.acme.com:8080/"), { why: "is on port 8080, not 80 or 443", addresses: [] });
  assert.deepEqual(await guard.route("https://intranet.acme.com/"), { why: "is at 10.0.0.5, an address not on the public internet", addresses: [] });
  assert.deepEqual(await guard.route("http://[::1]/"), { why: "is not on the public internet", addresses: [] });
  // The address given and its own pages, wherever they are, which a
  // connection has to know too.
  assert.deepEqual(await guard.route("http://intranet.acme.com:8080/x"), { why: "", addresses: ["10.0.0.5"] });
  assert.deepEqual(await guard.route("https://intranet.acme.com:8080/"), { why: "", addresses: ["10.0.0.5"] });
  assert.deepEqual(await guardFor("http://localhost:3000/").route("http://localhost:3000/"), { why: "", addresses: ["::1", "127.0.0.1"] });
  assert.deepEqual(await guardFor("http://localhost:3000/").route("http://127.1..:3000/"), { why: "", addresses: ["127.0.0.1"] });
  assert.deepEqual(await guardFor("http://[::1]:3000/").route("http://[::1]:3000/"), { why: "", addresses: ["::1"] });
  // A name not found is no refusal of the address given, but nothing to
  // connect to; it is refused where the setting names addresses, as judge
  // refuses it there.
  assert.deepEqual(await guardFor("https://gone.acme.com/").route("https://gone.acme.com/"), { why: "", addresses: [] });
  assert.deepEqual(await guardFor("https://gone.acme.com/", { refused: refusedAddresses("10.0.0.0/8") }).route("https://gone.acme.com/"), { why: "is on a host whose name could not be looked up", addresses: [] });
  // judge and route of the address given ask the name once between them;
  // judge asks none for an IP address or a name of this machine's own.
  const other = guardFor("https://other.acme.com/");
  assert.equal(await other.judge("https://other.acme.com/"), "");
  assert.deepEqual(await other.route("https://other.acme.com/x"), { why: "", addresses: both });
  assert.equal(asked.filter((host) => host === "other.acme.com").length, 1);
  const before = asked.length;
  assert.equal(await guardFor("http://93.184.216.34:8080/").judge("http://93.184.216.34:8080/"), "");
  assert.equal(await guardFor("http://app.localhost:3000/").judge("http://app.localhost:3000/"), "");
  assert.equal(asked.length, before);
  assert.deepEqual(await guard.found("www.acme.com"), both);
  assert.deepEqual(await guard.found("93.184.216.34"), ["93.184.216.34"]);
  assert.deepEqual(await guard.found("app.localhost"), ["::1", "127.0.0.1"]);
  assert.equal(asked.filter((host) => host === "www.acme.com").length, 1);
});

test("MAKERSMCP_REFUSE_ADDRESSES is refused for every address a run opens, the one given and its own pages included, by the setting's name", async (t) => {
  t.mock.method(dns.promises, "lookup", async (host) => {
    if (host === "vm.acme.com") return [{ address: "185.137.215.163", family: 4 }];
    if (host === "vm6.acme.com") return [{ address: "::ffff:185.137.215.165", family: 6 }];
    if (host === "gone.acme.com") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [{ address: "93.184.216.34", family: 4 }];
  });
  const refused = refusedAddresses("185.137.215.163,185.137.215.165,127.0.0.0/8");
  const refuses = (address) => `is at ${address}, an address MAKERSMCP_REFUSE_ADDRESSES refuses`;
  const guard = guardFor("https://vm.acme.com/", { refused });
  for (const [raw, why] of [
    ["https://vm.acme.com/", refuses("185.137.215.163")],
    ["https://vm.acme.com/pricing", refuses("185.137.215.163")],
    ["https://vm6.acme.com/", refuses("185.137.215.165")],
    ["https://185.137.215.165/", refuses("185.137.215.165")],
    ["http://[::ffff:b989:d7a5]/", refuses("185.137.215.165")],
    ["http://[2002:b989:d7a3::1]/", refuses("185.137.215.163")],
    ["https://www.acme.com/", ""],
    // An address the run was not given that is not on the public internet
    // is told as that, whatever the setting says.
    ["http://localhost/", "is not on the public internet"],
    ["http://127.0.0.1/", "is not on the public internet"],
  ]) {
    assert.equal(await guard.judge(raw), why, raw);
  }
  // Given on this machine, the user's own site is refused too when the
  // setting names this machine, and a site whose name is not found is not
  // opened, as it cannot be checked.
  assert.equal(await guardFor("http://localhost:3000/", { refused }).judge("http://localhost:3000/"), refuses("127.0.0.1"));
  assert.equal(await guardFor("https://gone.acme.com/", { refused }).judge("https://gone.acme.com/"), "is on a host whose name could not be looked up");
  // With the setting empty, the address given is not looked up to judge it.
  assert.equal(await guardFor("https://gone.acme.com/").judge("https://gone.acme.com/"), "");
});

// A connection to 0.0.0.0 reaches 127.0.0.1, and one to :: reaches ::1, so
// a setting that refuses those refuses each way of writing 0.0.0.0 and ::,
// and a name found at one of them, also as the address given. Judged as
// written, each was opened, and the program on this machine's loopback at
// the port given was read.
test("MAKERSMCP_REFUSE_ADDRESSES that refuses 127.0.0.1 or ::1 refuses 0.0.0.0 and ::, which a connection takes for them, in every form and for a name found there", async (t) => {
  const four = refusedAddresses("127.0.0.1");
  const six = refusedAddresses("::1");
  // Each IPv6 form that holds 0.0.0.0 is judged by it, as every such form is
  // judged by the IPv4 address it holds.
  for (const address of ["0.0.0.0", "::ffff:0.0.0.0", "::ffff:0:0", "[::ffff:0:0]", "::ffff:0:0:0", "2002::", "64:ff9b::"]) {
    assert.equal(four.match(address), "127.0.0.1", address);
    assert.equal(six.match(address), "", address);
  }
  for (const address of ["::", "0:0:0:0:0:0:0:0", "[::]"]) {
    assert.equal(six.match(address), "::1", address);
    assert.equal(four.match(address), "", address);
  }
  // A range that holds 127.0.0.1 does as well, and a list that names
  // 0.0.0.0 itself names it as that; any other address of 0.0.0.0/8 reaches
  // no program of this machine.
  assert.equal(refusedAddresses("127.0.0.0/8").match("0.0.0.0"), "127.0.0.1");
  assert.equal(refusedAddresses("0.0.0.0/8").match("0.0.0.0"), "0.0.0.0");
  assert.equal(four.match("0.1.2.3"), "");
  t.mock.method(dns.promises, "lookup", async (host) => {
    if (host === "zero.test") return [{ address: "0.0.0.0", family: 4 }];
    if (host === "zero6.test") return [{ address: "::", family: 6 }];
    if (host === "zeromap.test") return [{ address: "::ffff:0.0.0.0", family: 6 }];
    return [{ address: "93.184.216.34", family: 4 }];
  });
  const refused = refusedAddresses("127.0.0.1,::1");
  const refuses = (address) => `is at ${address}, an address MAKERSMCP_REFUSE_ADDRESSES refuses`;
  for (const [raw, at] of [
    ["http://0:3000/", "127.0.0.1"],
    ["http://0.0.0.0:3000/", "127.0.0.1"],
    ["http://0x0:3000/", "127.0.0.1"],
    ["http://0.0:3000/", "127.0.0.1"],
    ["http://[::ffff:0.0.0.0]:3000/", "127.0.0.1"],
    ["http://[::]:3000/", "::1"],
    ["http://[0:0:0:0:0:0:0:0]:3000/", "::1"],
    ["http://[::0.0.0.0]:3000/", "::1"],
    ["http://zero.test:3000/", "127.0.0.1"],
    ["http://zero6.test:3000/", "::1"],
    ["http://zeromap.test:3000/", "127.0.0.1"],
  ]) {
    assert.equal(await guardFor(raw, { refused }).judge(raw), refuses(at), raw);
    assert.deepEqual(await guardFor(raw, { refused }).route(raw), { why: refuses(at), addresses: [] }, raw);
  }
});

// The same, by the table shared with easyscreenshotkit (address-cases.json),
// so that a change to either kit's copy shows in the other's tests: each
// address the table lists as reaching a loopback address is refused by a
// setting that names that address, and by no setting that names the other
// or another address; written as the host of an address, it is refused as
// the address given and as one of its own pages, and a page another site
// links there is refused by the rule for such a page before the setting.
test("the addresses the shared table lists as reaching this machine's loopback are refused by MAKERSMCP_REFUSE_ADDRESSES that names that loopback address and by none that names the other, as an address and as the host of an address given or of a page", async () => {
  const otherOf = (loop) => (loop === "::1" ? "127.0.0.1" : "::1");
  for (const [loop, list] of Object.entries(CASES.reachesLoopback)) {
    for (const address of list) {
      assert.equal(refusedAddresses(loop).match(address), loop, address);
      assert.equal(refusedAddresses(otherOf(loop)).match(address), "", address);
      assert.equal(refusedAddresses("185.137.215.163").match(address), "", address);
    }
  }
  const page = guardFor("https://acme.com/", { refused: refusedAddresses("127.0.0.0/8,::1") });
  for (const [loop, hosts] of Object.entries(CASES.reachesLoopbackHosts)) {
    for (const host of hosts) {
      const given = `http://${host}:3000/`;
      for (const setting of [loop, "127.0.0.0/8,::1"]) {
        const guard = guardFor(given, { refused: refusedAddresses(setting) });
        assert.equal(await guard.judge(given), `is at ${loop}, an address MAKERSMCP_REFUSE_ADDRESSES refuses`, `${given} ${setting}`);
        assert.equal(await guard.judge(`${given}app.js`), `is at ${loop}, an address MAKERSMCP_REFUSE_ADDRESSES refuses`, `${given}app.js ${setting}`);
      }
      // A setting that names the other loopback address leaves it the
      // address given, opened as the user's own.
      assert.equal(await guardFor(given, { refused: refusedAddresses(otherOf(loop)) }).judge(given), "", given);
      assert.equal(await page.judge(given), "is on port 3000, not 80 or 443", given);
      assert.equal(await page.judge(`http://${host}/`), "is not on the public internet", host);
    }
  }
});

test("a request the kit makes itself connects only to an address the rule took, by the one lookup the rule judged, which asks the DNS once a run", async (t) => {
  // A name whose next answer would be this machine: the lookup the rule
  // judged by is the only one, so the connection never gets that answer.
  let answers = 0;
  const found = t.mock.method(dns.promises, "lookup", async (host) => (host === "rebind.acme.com" && answers++ ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]));
  const system = t.mock.method(dns, "lookup", (host, options, callback) => callback(new Error("the DNS was asked again")));
  const guard = guardFor("https://acme.com/");
  assert.equal(await guard.judge("https://rebind.acme.com/"), "");
  for (let i = 0; i < 3; i++) assert.deepEqual(await guard.addressesFor("https://rebind.acme.com/robots.txt"), ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
  assert.equal(found.mock.calls.filter((call) => call.arguments[0] === "rebind.acme.com").length, 1);
  // The address given and its own pages connect the same way.
  assert.deepEqual(await guard.addressesFor("https://acme.com/robots.txt"), ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
  assert.equal(system.mock.callCount(), 0);
  // One the rule refuses, or whose name is not found, connects nowhere.
  const refusing = guardFor("http://acme.com:8080/", { refused: refusedAddresses("93.184.216.0/24") });
  await assert.rejects(refusing.addressesFor("http://acme.com:8080/robots.txt"), (err) => err.code === "ENOTPUBLIC" && /MAKERSMCP_REFUSE_ADDRESSES refuses$/.test(err.message));
  await assert.rejects(guard.addressesFor("http://rebind.acme.com:9222/json/list"), (err) => err.code === "ENOTPUBLIC" && err.message === "http://rebind.acme.com:9222/json/list is on port 9222, not 80 or 443");
  found.mock.mockImplementation(async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND gone.acme.com"), { code: "ENOTFOUND" });
  });
  await assert.rejects(guardFor("https://gone.acme.com/").addressesFor("https://gone.acme.com/robots.txt"), (err) => err.code === "ENOTFOUND");
});
