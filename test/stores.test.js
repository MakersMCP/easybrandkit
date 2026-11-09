"use strict";

// Store listings and profiles: link classification, the App Store, Google
// Play and profile parsers, image header reading, and the fetch guard. No
// network: the parsers run on fixtures.

const assert = require("node:assert/strict");
const dns = require("node:dns");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const stores = require("../skills/easybrandkit/scripts/lib/stores");

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
  await assert.rejects(stores.checkFetchUrl("https://acme.com/logo.png"), /host not allowed/);
  await assert.rejects(stores.checkFetchUrl("http://play.google.com/store"), /not HTTPS/);
  await assert.rejects(stores.checkFetchUrl("https://user:pw@play.google.com/"), /not a plain URL/);
  await assert.rejects(stores.checkFetchUrl("https://play.google.com:8443/"), /not a plain URL/);
});

test("a picture that does not come is skipped, a host that cannot be found is told, and a picture that cannot be written fails the run", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1024, 20);
  const art = "https://is1-ssl.mzstatic.com/image/thumb";
  const lookup = { results: [{ trackName: "Acme", artworkUrl512: `${art}/a/AppIcon.png/512x512bb.jpg`, screenshotUrls: [`${art}/1.png/392x696bb.jpg`, `${art}/2.png/392x696bb.jpg`] }] };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.hostname === "itunes.apple.com") return new Response(JSON.stringify(lookup));
    return url.pathname.includes("/1.png/") ? new Response("gone", { status: 404 }) : new Response(png);
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
  assert.match(unknown.error, /ENOTFOUND/);
});

test("what a listing says comes in without control characters, and its description keeps its lines", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lookup = { results: [{ trackName: "Acme\u001b[2J App", sellerName: "Acme\u0007 Inc", primaryGenreName: "Tools\u009b", description: "One\u001b[31m\nTwo" }] };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(lookup)));
  t.mock.method(dns.promises, "lookup", async () => [{ address: "17.253.144.10", family: 4 }]);
  const source = await stores.readSource(stores.classify("https://apps.apple.com/us/app/acme/id1234567890"), dir);
  assert.deepEqual([source.name, source.by, source.category, source.description], ["Acme [2J App", "Acme Inc", "Tools", "One [31m\nTwo"]);
});
