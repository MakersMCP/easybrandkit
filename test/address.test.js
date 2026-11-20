"use strict";

// The rule for the addresses a run opens (address.js): which IP addresses
// are on the public internet, the ports and hosts a run opens that it was
// not given, MAKERSMCP_REFUSE_ADDRESSES, and the lookups.

const assert = require("node:assert/strict");
const dns = require("node:dns");
const os = require("node:os");
const test = require("node:test");
const { isPublicAddress, heldIpv4, refusedAddresses, guardFor, sameHost } = require("../skills/easybrandkit/scripts/lib/address");
const CASES = require("./address-cases.json");

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
  // A local site given is the user's own on its own port and nowhere else,
  // this machine's names on that port counting as one host.
  // https on the host and port of an http address given is the same
  // program, which the browser asks over https by itself for a name that
  // takes only https (HSTS); http on those of an https address given is not.
  const local = guardFor("http://localhost:3000/");
  for (const raw of ["http://localhost:3000/assets/app.css", "http://127.0.0.1:3000/", "http://[::1]:3000/", "http://app.localhost:3000/x", "https://localhost:3000/", "https://127.0.0.1:3000/x"]) assert.equal(await local.judge(raw), "", raw);
  for (const [raw, why] of [["http://localhost:3001/", "is on port 3001, not 80 or 443"], ["https://localhost:3001/", "is on port 3001, not 80 or 443"], ["http://localhost/", "is not on the public internet"], ["https://localhost/", "is not on the public internet"], ["http://10.0.0.5:3000/", "is on port 3000, not 80 or 443"], ["http://10.0.0.5/", "is not on the public internet"]]) {
    assert.equal(await local.judge(raw), why, raw);
  }
  assert.equal(await guardFor("https://localhost:3000/").judge("http://localhost:3000/"), "is on port 3000, not 80 or 443");
  assert.equal(await guardFor("https://acme.com:8443/").judge("http://acme.com:8443/"), "is on port 8443, not 80 or 443");
  assert.equal(await guardFor("http://acme.com:8443/").judge("https://acme.com:8443/x"), "");
  // 127.0.0.1 as a URL writes it mapped into IPv6 is this machine's too; its
  // other IPv6 forms are not names of this machine, and are judged.
  assert.equal(await local.judge("http://[::ffff:127.0.0.1]:3000/"), "");
  for (const raw of ["http://[::7f00:1]:3000/", "http://[::ffff:0:7f00:1]:3000/", "http://[2002:7f00:1::]:3000/", "http://[64:ff9b::7f00:1]:3000/"]) {
    assert.equal(await local.judge(raw), "is on port 3000, not 80 or 443", raw);
  }
  assert.equal(sameHost(new URL("http://localhost:8080/"), new URL("http://127.0.0.1:8080/")), true);
  assert.equal(sameHost(new URL("http://localhost:8080/"), new URL("http://127.0.0.1:8081/")), false);
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
  // A request the kit makes itself, as for robots.txt, connects by the
  // rule's own lookup there, where one on the address given need not.
  for (const raw of ["https://acme.com/robots.txt", "http://localhost:3000/robots.txt"]) assert.equal(typeof none.lookupFor(raw), "function", raw);
  assert.equal(guardFor("https://acme.com/").lookupFor("https://acme.com/robots.txt"), undefined);
});

test("an address the run was not given is opened only on the public internet, by its form and by every address its name is found at, and never where its name is not found in time", async (t) => {
  const asked = [];
  t.mock.method(dns.promises, "lookup", async (host) => {
    asked.push(host);
    if (host === "intranet.acme.com") return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
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
  // this machine is, and asks no lookup.
  assert.equal(await guardFor("http://intranet.acme.com:8080/").judge("http://intranet.acme.com:8080/x"), "");
  assert.equal(asked.filter((host) => host === "intranet.acme.com").length, 1);
  // https on port 443 of a host given on port 80 is another program, held
  // to the rule as any address the run was not given.
  assert.equal(await guardFor("http://intranet.acme.com/").judge("https://intranet.acme.com/"), "is at 10.0.0.5, an address not on the public internet");
  // A name that gives no answer in 5 s is not opened.
  const started = Date.now();
  assert.equal(await guard.judge("https://slow.acme.com/"), "is on a host whose name could not be looked up");
  assert.ok(Date.now() - started >= 4_900, `${Date.now() - started} ms`);
});

test("an address written with http: or https: that the URL parser here cannot read is not opened, as the browser can read it and go where its host leads", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const why = "is not an address easybrandkit can read";
  // Labels of broken punycode, which the browser keeps as they are written,
  // under localhost, which is this machine to it, and under names whose DNS
  // gives any address; and an IPv6 address with a wide digit. Node 22.22 and
  // 22.23 read some of them differently, so each counts where this Node
  // cannot read it, xn--a on every version.
  const unreadable = [
    "http://xn--a.localhost:9222/json/list", "http://XN--A.localhost:9222/", "http://xn--a-.localhost:9222/", "http://a.xn--.localhost:9222/", "http://xn---.localhost:9222/",
    "https://xn--zz.localhost/", "http://xn--a.127.0.0.1.nip.io:9222/", "http://xn--a.169.254.169.254.nip.io/latest/meta-data/", "http://[::１]/",
    " HTTP://xn--a.localhost/", "ht\ttp://xn--a.localhost/", "http:xn--a.localhost:9222/",
  ].filter((raw) => {
    try {
      new URL(raw);
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(unreadable.includes("http://xn--a.localhost:9222/json/list") && unreadable.length >= 8, unreadable.join(" "));
  const refused = refusedAddresses("127.0.0.0/8,185.137.215.163");
  for (const guard of [guardFor("https://acme.com/"), guardFor(null), guardFor("http://localhost:9222/"), guardFor("https://acme.com/", { refused })]) {
    for (const raw of unreadable) assert.equal(await guard.judge(raw), why, JSON.stringify(raw));
    // What is not written as a web address is left to the browser's own
    // handling of it, as before.
    for (const raw of ["not an address", "mailto:a@acme.com", "about:blank", "ftp://xn--a.localhost/"]) assert.equal(await guard.judge(raw), "", raw);
  }
  // A request the kit made itself to one would connect to no address.
  const lookup = guardFor("http://localhost:9222/").lookupFor("http://xn--a.localhost:9222/robots.txt");
  const err = await new Promise((resolve) => lookup("xn--a.localhost", {}, (failed) => resolve(failed)));
  assert.equal(err.code, "ENOTPUBLIC");
  assert.equal(err.message, `xn--a.localhost ${why}`);
});

test("where the browser says it reached a page counts for an address the run was not given: a name found elsewhere by the browser is told by where it went", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const guard = guardFor("http://acme.com/");
  assert.equal(await guard.judge("http://www.acme.com/", { space: "Loopback", ip: "127.0.0.1" }), "is at 127.0.0.1, an address not on the public internet");
  assert.equal(await guard.judge("http://www.acme.com/", { space: "Local", ip: "198.18.0.11" }), "is at 198.18.0.11, an address not on the public internet");
  assert.equal(await guard.judge("http://www.acme.com/", { space: "Public", ip: "2001:0:7f00:1::1" }), "is at 2001:0:7f00:1::1, an address not on the public internet");
  assert.equal(await guard.judge("http://www.acme.com/", { space: "Public", ip: "93.184.216.34" }), "");
  assert.equal(await guard.judge("http://www.acme.com/", { space: "Public", ip: "64:ff9b::8c52:7903" }), "");
  // Through a proxy the browser says Unknown and gives the proxy's address.
  assert.equal(await guard.judge("http://www.acme.com/", { space: "Unknown", ip: "127.0.0.1" }), "");
  // The address given is the user's, wherever the browser found it.
  assert.equal(await guard.judge("http://acme.com/x", { space: "Loopback", ip: "127.0.0.1" }), "");
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
  // Where the browser says it went counts as well, for the address given too.
  const open = guardFor("https://www.acme.com/", { refused });
  assert.equal(await open.judge("https://www.acme.com/", { space: "Public", ip: "185.137.215.163" }), refuses("185.137.215.163"));
  // With the setting empty, the address given is not looked up at all.
  assert.equal(await guardFor("https://gone.acme.com/").judge("https://gone.acme.com/"), "");
});

test("a request the kit makes itself connects only to an address the rule takes, as the name is found when it connects", async (t) => {
  // This machine's own name, which the system finds on this machine or its
  // network, taken for a public one by the lookup the rule judged by.
  const host = os.hostname();
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const guard = guardFor("https://acme.com/");
  const lookup = guard.lookupFor(`http://${host}/robots.txt`);
  assert.equal(typeof lookup, "function");
  const found = await new Promise((resolve) => lookup(host, { all: true }, (err, list) => resolve(err || list)));
  const system = await new Promise((resolve) => dns.lookup(host, { all: true, verbatim: true }, (err, list) => resolve(err ? [] : list)));
  if (system.length && system.every(({ address }) => isPublicAddress(address))) return t.skip(`${host} is found on the public internet here`);
  if (!system.length) return t.skip(`${host} is not found here`);
  assert.ok(found instanceof Error && found.code === "ENOTPUBLIC", String(found));
  assert.match(found.message, /an address not on the public internet$/);
  // The pages on the host and port given connect as any program does, unless
  // the setting refuses where they are.
  assert.equal(guard.lookupFor("https://acme.com/robots.txt"), undefined);
  const refusing = guardFor(`http://${host}:8080/`, { refused: refusedAddresses(system.map(({ address }) => address).join(",")) });
  const own = await new Promise((resolve) => refusing.lookupFor(`http://${host}:8080/robots.txt`)(host, {}, (err, address) => resolve(err || address)));
  assert.ok(own instanceof Error && /MAKERSMCP_REFUSE_ADDRESSES refuses$/.test(own.message), String(own));
});
