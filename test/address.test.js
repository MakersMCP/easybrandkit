"use strict";

// The rule for the addresses a run opens (address.js): which IP addresses
// are on the public internet, the ports and hosts a run opens that it was
// not given, MAKERSMCP_REFUSE_ADDRESSES, and the lookups.

const assert = require("node:assert/strict");
const dns = require("node:dns");
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
  // 0.0.0.0 and ::, which a connection takes for 127.0.0.1 and ::1, are this
  // machine's own names too; the rest of 127/8 is not, as another program
  // can listen on 127.0.0.2 or 127.0.0.53 on the same port.
  for (const raw of ["http://0.0.0.0:3000/", "http://[::]:3000/x", "http://0:3000/", "http://127.1:3000/"]) assert.equal(await local.judge(raw), "", raw);
  for (const raw of ["http://127.0.0.2:3000/other-loopback", "http://127.0.0.53:3000/", "http://[::ffff:127.0.0.2]:3000/", "http://127.255.255.254:3000/"]) {
    assert.equal(await local.judge(raw), "is on port 3000, not 80 or 443", raw);
  }
  assert.equal(await guardFor("http://localhost/").judge("http://127.0.0.2/"), "is not on the public internet");
  const other = guardFor("http://127.0.0.2:3000/");
  assert.equal(await other.judge("http://127.0.0.2:3000/x"), "");
  assert.equal(await other.judge("http://localhost:3000/"), "is on port 3000, not 80 or 443");
  assert.equal(sameHost(new URL("http://127.0.0.2:8080/"), new URL("http://localhost:8080/")), false);
  assert.equal(sameHost(new URL("http://0.0.0.0:8080/"), new URL("http://[::1]:8080/")), true);
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
  assert.deepEqual(await guardFor("http://localhost:3000/").addressesFor("http://localhost:3000/robots.txt"), ["127.0.0.1", "::1"]);
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
  assert.equal(await guardFor("http://localhost:9222/").judge("http://xn--bcher-kva.localhost:9222/"), "");
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
  assert.deepEqual(await guardFor("http://localhost:3000/").route("http://localhost:3000/"), { why: "", addresses: ["127.0.0.1", "::1"] });
  assert.deepEqual(await guardFor("http://localhost:3000/").route("http://127.1..:3000/"), { why: "", addresses: ["127.0.0.1"] });
  assert.deepEqual(await guardFor("http://[::1]:3000/").route("http://[::1]:3000/"), { why: "", addresses: ["::1"] });
  // A name not found is no refusal of the address given, but nothing to
  // connect to; it is refused where the setting names addresses, as judge
  // refuses it there.
  assert.deepEqual(await guardFor("https://gone.acme.com/").route("https://gone.acme.com/"), { why: "", addresses: [] });
  assert.deepEqual(await guardFor("https://gone.acme.com/", { refused: refusedAddresses("10.0.0.0/8") }).route("https://gone.acme.com/"), { why: "is on a host whose name could not be looked up", addresses: [] });
  // judge asks no lookup for the address given, route does, once.
  assert.equal(await guardFor("https://other.acme.com/").judge("https://other.acme.com/"), "");
  assert.equal(asked.filter((host) => host === "other.acme.com").length, 0);
  assert.deepEqual(await guard.found("www.acme.com"), both);
  assert.deepEqual(await guard.found("93.184.216.34"), ["93.184.216.34"]);
  assert.deepEqual(await guard.found("app.localhost"), ["127.0.0.1", "::1"]);
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
