"use strict";

// Store listings and profiles: link classification, the App Store, Google
// Play and profile parsers, image header reading, and the fetch guard. No
// network: the parsers run on fixtures.

const assert = require("node:assert/strict");
const dns = require("node:dns");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const stores = require("../skills/easybrandkit/scripts/lib/stores");
const dialLib = require("../skills/easybrandkit/scripts/lib/dial");
const { setTimeLimit } = require("../skills/easybrandkit/scripts/lib/time");
const { storeAnswers, neverAnswers } = require("./store-answers");

// Each connection a request makes, kept as [host, address, port], and made
// to nothing; connected(options) has the request's own connection made, and
// resolves to the code it failed with.
function dialNowhere(t) {
  const dials = [];
  t.mock.method(dialLib.wire, "dial", (address, port, name) => {
    dials.push([name, address, port]);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error("not made here"), { code: "ECONNREFUSED" })));
    return socket;
  });
  return dials;
}
const connected = (options) => new Promise((resolve) => options.createConnection({}, (err) => resolve(err && err.code)));

test("classifies store listings and social profiles, and nothing else", () => {
  assert.deepEqual(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), {
    type: "appstore", id: "1234567890", country: "us", url: "https://apps.apple.com/us/app/id1234567890",
  });
  assert.equal(stores.classify("https://apps.apple.com/tr/app/x/id1234567890?l=tr").country, "tr");
  // A developer page keeps its kind: its id is the maker's, not an app's.
  assert.equal(stores.classify("https://apps.apple.com/us/developer/acme-inc/id1636691087").url, "https://apps.apple.com/us/developer/id1636691087");
  // The listing in its own language: ?l= on the App Store, hl= and gl= on
  // Google Play.
  assert.deepEqual(stores.classify("https://apps.apple.com/tr/app/acme/id995280265?l=tr"), {
    type: "appstore", id: "995280265", country: "tr", lang: "tr", url: "https://apps.apple.com/tr/app/id995280265?l=tr",
  });
  assert.equal(stores.appStoreLookupUrl("995280265", "tr", "tr"), "https://itunes.apple.com/lookup?id=995280265&country=tr&entity=software&lang=tr_tr");
  assert.equal(stores.appStoreLookupUrl("995280265", "us", ""), "https://itunes.apple.com/lookup?id=995280265&country=us&entity=software");
  assert.deepEqual(stores.classify("https://play.google.com/store/apps/details?id=com.acme.run&hl=tr&gl=TR"), {
    type: "googleplay", id: "com.acme.run", hl: "tr", gl: "TR", url: "https://play.google.com/store/apps/details?id=com.acme.run&hl=tr&gl=TR",
  });
  assert.deepEqual(stores.classify("https://play.google.com/store/apps/details?id=com.acme.app&hl=en"), {
    type: "googleplay", id: "com.acme.app", hl: "en", url: "https://play.google.com/store/apps/details?id=com.acme.app&hl=en",
  });
  assert.equal(stores.classify("https://www.instagram.com/acme/").type, "instagram");
  assert.equal(stores.classify("https://youtube.com/@acme").type, "youtube");
  assert.equal(stores.classify("https://x.com/acme").type, "x");
  for (const bad of ["https://acme.com/", "https://www.instagram.com/", "https://play.google.com/store/apps", "ftp://apps.apple.com/id1", "not a url"]) {
    assert.equal(stores.classify(bad), null, bad);
  }
  // Pinterest at its own hosts only: pinterest.com and its country sites,
  // and the country domains that send their visitors there, the path kept,
  // as pinterest.be, pinterest.com.pe, pinterest.com.ec and pinterest.id do,
  // and pinterest.pe, pinterest.ec, pinterest.co, pinterest.mx, pinterest.in
  // and pinterest.kr, which 0.4.2 took too: each of them, so that none is
  // left out. A host whose first label is pinterest is anyone's.
  const countries = ["at", "be", "ca", "ch", "cl", "co", "co.in", "co.kr", "co.nz", "co.uk", "com.au", "com.bo", "com.ec", "com.mx", "com.pe", "com.py", "com.uy", "com.vn", "de", "dk", "ec", "es", "fr", "hu", "id", "ie", "in", "it", "jp", "kr", "mx", "nl", "nz", "pe", "ph", "pt", "ru", "se", "th", "tw", "vn"];
  for (const own of ["https://www.pinterest.com/acme/", "https://pinterest.com/acme", "https://uk.pinterest.com/acme/", "https://pinterest.com.au/acme/", "https://pinterest.com.vn/acme/", "https://pinterest.co/acme/", ...countries.map((country) => `https://www.pinterest.${country}/acme/`)]) {
    assert.equal((stores.classify(own) || {}).type, "pinterest", own);
  }
  for (const other of ["https://pinterest.evil.example/brand", "https://www.pinterest.attacker.com/x", "https://pinterest.com.evil.example/x", "https://www.pinterest.co.evil/x", "https://a.b.pinterest.com/x"]) {
    assert.equal(stores.classify(other), null, other);
  }
});

test("App Store lookup: icon at 1024 px and screenshots at 1290 px wide, as PNG", () => {
  const plan = stores.appStorePlan({
    results: [{
      trackName: "Acme", sellerName: "Acme Inc.", primaryGenreName: "Business",
      averageUserRating: 4.5, userRatingCount: 12, description: "x".repeat(900),
      artworkUrl512: "https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/a/b/AppIcon.png/512x512bb.jpg",
      screenshotUrls: ["https://is1-ssl.mzstatic.com/image/thumb/Src/v4/c/d/1.png/392x696bb.jpg"],
    }],
  });
  assert.equal(plan.name, "Acme");
  assert.equal(plan.by, "Acme Inc.");
  // The whole description, up to the stores' own 4000 characters.
  assert.equal(plan.description.length, 900);
  assert.equal(stores.appStorePlan({ results: [{ trackName: "Acme", description: "x".repeat(5000) }] }).description.length, 4000);
  assert.deepEqual(plan.images, [
    { kind: "icon", url: "https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/a/b/AppIcon.png/1024x1024bb.png" },
    { kind: "screenshot", url: "https://is1-ssl.mzstatic.com/image/thumb/Src/v4/c/d/1.png/1290x2290bb.png" },
  ]);
  assert.equal(stores.appStorePlan({ results: [] }), null);
  // The developer's website, where the brand itself is read.
  assert.equal(stores.appStorePlan({ results: [{ trackName: "Acme", sellerUrl: "https://acme.com/app" }] }).site, "https://acme.com/app");
  // Looked up by a developer's id: the maker comes first, its apps after.
  const byMaker = stores.appStorePlan({ results: [{ wrapperType: "artist", artistName: "Acme Inc." }, { wrapperType: "software", trackName: "Acme" }] });
  assert.equal(byMaker.name, "Acme");
});

test("Google Play page: icon and screenshots by alt text, resized by suffix", () => {
  const html = `<html><head><meta property="og:title" content="Acme - Apps on Google Play">
    <meta name="description" content="Acme &amp; friends"></head><body>
    <img src="https://play-lh.googleusercontent.com/ICON=s48-rw" alt="Icon image">
    <a href="/store/apps/dev?id=123"><span>Acme Teknoloji A.Ş.</span></a>
    <img src="https://play-lh.googleusercontent.com/S1=w526-h296-rw" alt="Screenshot image">
    <img srcset="x" src="https://play-lh.googleusercontent.com/S1=w1052-h592-rw" alt="Screenshot image">
    <img src="https://play-lh.googleusercontent.com/S2=w526-h296-rw" alt="Screenshot image">
    <img src="https://play-lh.googleusercontent.com/AVATAR=s32" alt="Reviewer">
    <a class="Si6A0c RrSxVb" href="https://www.acme.com/help/contact" target="_blank" aria-label="Website https://www.acme.com/help/contact will open in a new window or tab."><i class="google-material-icons notranslate j25Vu" aria-hidden='true'>public</i><div class="pZ8Djf"><div class="xFVDSb">Website</div></div></a>
    </body></html>`;
  const plan = stores.playPlan(html);
  assert.equal(plan.name, "Acme");
  assert.equal(plan.by, "Acme Teknoloji A.Ş.");
  assert.equal(plan.description, "Acme & friends");
  // The developer's website: the link with the globe icon, whatever its label's language.
  assert.equal(plan.site, "https://www.acme.com/help/contact");
  assert.deepEqual(plan.images, [
    { kind: "icon", url: "https://play-lh.googleusercontent.com/ICON=s1024" },
    { kind: "screenshot", url: "https://play-lh.googleusercontent.com/S1=w1440" },
    { kind: "screenshot", url: "https://play-lh.googleusercontent.com/S2=w1440" },
  ]);
  // The listing's own text, whole and with its line breaks, over the short
  // meta description.
  const full = stores.playPlan(`${html}<div class="bARER" data-g-id="description">Learn &amp; play.<br><br>KEY FEATURES<br>• Short lessons<br>• Streaks</div>`);
  assert.equal(full.description, "Learn & play.\n\nKEY FEATURES\n• Short lessons\n• Streaks");
});

test("Google Play page in another language: screenshots by their index, the title without the store's suffix", () => {
  // hl=tr, as Google Play serves a Turkish listing.
  const html = `<meta property="og:title" content="Acme: Koş, Sür, Yürü - Google Play'de Uygulamalar">
    <meta property="og:image" content="https://play-lh.googleusercontent.com/icon=s180">
    <img src="https://play-lh.googleusercontent.com/RNRn=w526-h296-rw" alt="Ekran görüntüsü resmi" itemprop="image" data-screenshot-index="0">
    <img src="https://play-lh.googleusercontent.com/M63i=w526-h296-rw" alt="Ekran görüntüsü resmi" itemprop="image" data-screenshot-index="1">
    <img src="https://play-lh.googleusercontent.com/thumb=w64" alt="Küçük resim">`;
  const plan = stores.playPlan(html);
  assert.equal(plan.name, "Acme: Koş, Sür, Yürü");
  assert.deepEqual(plan.images.map((i) => [i.kind, i.url]), [
    ["icon", "https://play-lh.googleusercontent.com/icon=s1024"],
    ["screenshot", "https://play-lh.googleusercontent.com/RNRn=w1440"],
    ["screenshot", "https://play-lh.googleusercontent.com/M63i=w1440"],
  ]);
});

test("profiles: the Open Graph picture, X avatars at 400 px, no picture behind a login", () => {
  const x = stores.profilePlan(`<meta property="og:title" content="Acme (@acme) on X">
    <meta property="og:image" content="https://pbs.twimg.com/profile_images/17/abc_200x200.jpg">`);
  assert.deepEqual(x.images, [{ kind: "profile", url: "https://pbs.twimg.com/profile_images/17/abc_400x400.jpg" }]);
  const linkedin = stores.profilePlan(`<meta property="og:title" content="Acme | LinkedIn"><meta property="og:image" content="https://media.licdn.com/a.jpg">`);
  assert.equal(linkedin.name, "Acme");
  assert.equal(stores.profilePlan("<html><title>Login • Instagram</title></html>"), null);
});

test("reads PNG, JPEG and WebP sizes and PNG transparency from the header", () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(512, 20);
  png[25] = 6;
  assert.deepEqual(stores.imageInfo(png), { ext: "png", width: 1024, height: 512, alpha: true });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38, 0x03]);
  assert.deepEqual(stores.imageInfo(jpeg), { ext: "jpg", width: 1080, height: 1920, alpha: false });
  assert.equal(stores.imageInfo(Buffer.from("<html>")), null);
});

test("fetches only HTTPS on the listed hosts, and only public addresses", async () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.5", "::1", "fd00::1"]) {
    assert.equal(stores.isPublicAddress(address), false, address);
  }
  assert.equal(stores.isPublicAddress("17.253.144.10"), true);
  // An IPv4 address in IPv6 form, mapped or through NAT64 on a network with
  // IPv6 only, is as public as the IPv4 address it stands for.
  for (const address of ["::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe"]) assert.equal(stores.isPublicAddress(address), false, address);
  for (const address of ["::ffff:1153:900a", "64:ff9b::1153:900a", "64:ff9b::17.253.144.10"]) assert.equal(stores.isPublicAddress(address), true, address);
  await assert.rejects(stores.checkFetchUrl("https://acme.com/logo.png"), /host not allowed/);
  await assert.rejects(stores.checkFetchUrl("http://play.google.com/store"), /not HTTPS/);
  await assert.rejects(stores.checkFetchUrl("https://user:pw@play.google.com/"), /not a plain URL/);
  await assert.rejects(stores.checkFetchUrl("https://play.google.com:8443/"), /not a plain URL/);
});

test("a store's addresses are judged as every address the kit opens is: by the table shared with the other kits, and by MAKERSMCP_REFUSE_ADDRESSES", async (t) => {
  const cases = require("./address-cases.json");
  for (const address of cases.notPublic) assert.equal(stores.isPublicAddress(address), false, address);
  for (const address of [...cases.public, ...cases.publicInKitsOnly]) assert.equal(stores.isPublicAddress(address), true, address);
  const { guardFor, refusedAddresses } = require("../skills/easybrandkit/scripts/lib/address");
  let at = "2001:0:7f00:1::1";
  t.mock.method(dns.promises, "lookup", async () => [{ address: at, family: net.isIP(at) }]);
  await assert.rejects(stores.checkFetchUrl("https://apps.apple.com/us/app/acme/id1234567890"), (err) => err.message === "host apps.apple.com is at 2001:0:7f00:1::1, an address not on the public internet");
  // An address of this machine's own on the public internet, and one of the
  // IPv6 network of such an address, are not taken either.
  const os = require("node:os");
  t.mock.method(os, "networkInterfaces", () => ({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }], eth0: [{ address: "17.253.144.10", family: "IPv4", internal: false, cidr: "17.253.144.10/24" }, { address: "2620:149:a44::5", family: "IPv6", internal: false, cidr: "2620:149:a44::5/64" }] }));
  for (const [address, why] of [["17.253.144.10", "is at 17.253.144.10, an address of this machine"], ["2620:149:a44::10", "is at 2620:149:a44::10, on a network of this machine"]]) {
    at = address;
    await assert.rejects(stores.checkFetchUrl("https://apps.apple.com/us/app/acme/id1234567890", guardFor("https://acme.com/")), (err) => err.message === `host apps.apple.com ${why}`, address);
  }
  t.mock.restoreAll();
  t.mock.method(dns.promises, "lookup", async () => [at].flat().map((address) => ({ address, family: net.isIP(address) })));
  // A host whose name answers both with an address on the public internet
  // and with one that is not is refused in the words a page gets for it,
  // the name said in place of "is on a host whose name".
  at = ["17.253.144.10", "127.0.0.1"];
  await assert.rejects(stores.checkFetchUrl("https://apps.apple.com/us/app/acme/id1234567890", guardFor("https://acme.com/")), (err) => err.message === "host apps.apple.com answers with an address on the public internet, 17.253.144.10, and with one that is not, 127.0.0.1");
  at = ["2620:149:a44::10", "198.18.0.7"];
  await assert.rejects(stores.checkFetchUrl("https://play.google.com/store/apps/details?id=com.acme.app", guardFor(null)), (err) => err.message === "host play.google.com answers with an address on the public internet, 2620:149:a44::10, and with one in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15, 198.18.0.7");
  at = "17.253.144.10";
  const guard = guardFor("https://apps.apple.com/us/app/acme/id1234567890", { refused: refusedAddresses("17.253.144.0/24") });
  await assert.rejects(stores.checkFetchUrl("https://apps.apple.com/us/app/acme/id1234567890", guard), (err) => err.message === "host apps.apple.com is at 17.253.144.10, an address MAKERSMCP_REFUSE_ADDRESSES refuses");
  assert.equal((await stores.checkFetchUrl("https://apps.apple.com/us/app/acme/id1234567890", guardFor("https://acme.com/"))).hostname, "apps.apple.com");
  // A listing read under that rule is not asked for at all, and says why.
  const fetched = storeAnswers(t, () => ({ body: "{}" }));
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir, guard);
  assert.equal(source.ok, false);
  assert.equal(source.error, "host itunes.apple.com is at 17.253.144.10, an address MAKERSMCP_REFUSE_ADDRESSES refuses");
  assert.deepEqual(fetched, []);
});

test("a store's request connects only to the addresses its host was judged at, with no agent and so through no proxy the environment names, and asks the DNS nothing again", async (t) => {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const judged = [{ address: "17.253.144.10", family: 4 }, { address: "2620:149:a44::10", family: 6 }];
  const found = t.mock.method(dns.promises, "lookup", async () => judged);
  // A second lookup, as fetch makes of its own, could be given another
  // address: the system's lookup and fetch are not to be used.
  const again = t.mock.method(dns, "lookup", (host, options, callback) => callback(new Error("the DNS was asked again")));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch connects through a lookup of its own");
  });
  const lookup = { results: [{ trackName: "Acme" }] };
  const asked = storeAnswers(t, () => ({ body: JSON.stringify(lookup) }));
  const source = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir);
  assert.equal(source.ok, true, source.error);
  assert.equal(asked.length, 1);
  const { options } = asked[0];
  assert.equal(options.agent, undefined);
  assert.equal(options.lookup, undefined);
  const dials = dialNowhere(t);
  assert.equal(await connected(options), "ECONNREFUSED");
  assert.deepEqual(dials, [["itunes.apple.com", "17.253.144.10", 443], ["itunes.apple.com", "2620:149:a44::10", 443]]);
  assert.equal(found.mock.callCount(), 1);
  assert.equal(again.mock.callCount(), 0);
});

test("a store's answer is read decompressed, and refused past 15 MB once decompressed", async (t) => {
  const zlib = require("node:zlib");
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(dns.promises, "lookup", async () => [{ address: "17.253.144.10", family: 4 }]);
  const json = JSON.stringify({ results: [{ trackName: "Acme" }] });
  let body = zlib.gzipSync(json);
  let coding = "gzip";
  storeAnswers(t, () => ({ headers: { "content-encoding": coding }, body }));
  const link = stores.classify("https://apps.apple.com/us/app/acme/id1234567890");
  for (const [name, packed] of [["gzip", zlib.gzipSync(json)], ["deflate", zlib.deflateSync(json)], ["br", zlib.brotliCompressSync(Buffer.from(json))]]) {
    coding = name;
    body = packed;
    assert.equal((await stores.readSource(link, dir)).name, "Acme", name);
  }
  // 16 MB of spaces packed into a few kilobytes.
  coding = "gzip";
  body = zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024, 32));
  assert.equal((await stores.readSource(link, dir)).error, "larger than 15 MB: itunes.apple.com");
  coding = "zstd";
  body = Buffer.from("x");
  assert.equal((await stores.readSource(link, dir)).error, "answered in an encoding the kit does not read (zstd): itunes.apple.com");
});

test("a picture that does not come is skipped, a host that cannot be found is told, and a picture that cannot be written fails the run", async (t) => {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1024, 20);
  const art = "https://is1-ssl.mzstatic.com/image/thumb";
  const lookup = { results: [{ trackName: "Acme", artworkUrl512: `${art}/a/AppIcon.png/512x512bb.jpg`, screenshotUrls: [`${art}/1.png/392x696bb.jpg`, `${art}/2.png/392x696bb.jpg`] }] };
  storeAnswers(t, (url) => {
    if (url.hostname === "itunes.apple.com") return { body: JSON.stringify(lookup) };
    return url.pathname.includes("/1.png/") ? { status: 404, body: "gone" } : { body: png };
  });
  const found = t.mock.method(dns.promises, "lookup", async () => [{ address: "17.253.144.10", family: 4 }]);
  const link = stores.classify("https://apps.apple.com/us/app/acme/id1234567890");
  const source = await stores.readSource(link, dir);
  assert.equal(source.ok, true);
  assert.deepEqual(source.assets.map((asset) => asset.file), ["appstore-icon.png", "appstore-shot-01.png"]);

  const write = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", function (file, ...rest) {
    if (path.basename(String(file)) === "appstore-shot-01.png") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
    return write.call(this, file, ...rest);
  });
  await assert.rejects(stores.readSource(link, dir), (err) => err.code === "ENOSPC");
  full.mock.restore();

  found.mock.mockImplementation(async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND itunes.apple.com"), { code: "ENOTFOUND", syscall: "getaddrinfo" });
  });
  const unknown = await stores.readSource(link, dir);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "host itunes.apple.com could not be looked up");
});

test("a listing's hosts are each looked up once, its pictures and its redirects judged and connected by that one answer, a run's own lookup shared", async (t) => {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1024, 20);
  const art = "https://is1-ssl.mzstatic.com/image/thumb";
  const lookup = { results: [{ trackName: "Acme", artworkUrl512: `${art}/a/AppIcon.png/512x512bb.jpg`, screenshotUrls: [`${art}/1.png/392x696bb.jpg`, `${art}/2.png/392x696bb.jpg`] }] };
  // The first screenshot is moved to the second's host, as a CDN does.
  const asked = storeAnswers(t, (url) => {
    if (url.hostname === "itunes.apple.com") return { body: JSON.stringify(lookup) };
    if (url.pathname.includes("/1.png/")) return { status: 302, headers: { location: `${art}/moved/1290x0w.png` } };
    return { body: png };
  });
  // Each name's later answers would be this machine.
  const answered = new Map();
  const found = t.mock.method(dns.promises, "lookup", async (host) => {
    answered.set(host, (answered.get(host) || 0) + 1);
    return [{ address: answered.get(host) > 1 ? "127.0.0.1" : "17.253.144.10", family: 4 }];
  });
  const { guardFor } = require("../skills/easybrandkit/scripts/lib/address");
  const guard = guardFor("https://acme.com/");
  const source = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir, guard);
  assert.equal(source.ok, true, source.error);
  assert.deepEqual(source.assets.map((asset) => asset.file), ["appstore-icon.png", "appstore-shot-01.png", "appstore-shot-02.png"]);
  assert.deepEqual([...answered], [["itunes.apple.com", 1], ["is1-ssl.mzstatic.com", 1]]);
  assert.equal(found.mock.callCount(), 2);
  const dials = dialNowhere(t);
  for (const { url, options } of asked) {
    dials.length = 0;
    assert.equal(await connected(options), "ECONNREFUSED", url);
    assert.deepEqual(dials, [[new URL(url).hostname, "17.253.144.10", 443]], url);
  }
  // A second listing read in the same run asks the DNS nothing more.
  await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir, guard);
  assert.equal(found.mock.callCount(), 2);
});

test("a store that does not answer in time is named, not told in the words of Node's timer", async (t) => {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => {
    setTimeLimit(120_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A request gets 25 s, or what the run has left but a second: here 3 s
  // at most, less on a machine slow to get there.
  setTimeLimit(4_000);
  storeAnswers(t, (url, options) => neverAnswers(options));
  t.mock.method(dns.promises, "lookup", async () => [{ address: "17.253.144.10", family: 4 }]);
  const source = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir);
  assert.equal(source.ok, false);
  assert.match(source.error, /^itunes\.apple\.com did not answer in [1-3] s$/);
});

test("what a listing says comes in without control characters, and its description keeps its lines", async (t) => {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lookup = { results: [{ trackName: "Acme\u001b[2J App", sellerName: "Acme\u0007 Inc", primaryGenreName: "Tools\u009b", description: "One\u001b[31m\nTwo" }] };
  storeAnswers(t, () => ({ body: JSON.stringify(lookup) }));
  t.mock.method(dns.promises, "lookup", async () => [{ address: "17.253.144.10", family: 4 }]);
  const source = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir);
  assert.deepEqual([source.name, source.by, source.category, source.description], ["Acme [2J App", "Acme Inc", "Tools", "One [31m\nTwo"]);
});
