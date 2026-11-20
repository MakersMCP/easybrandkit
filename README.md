<img src=".github/assets/icon.svg" alt="" width="72" height="72">

# easybrandkit

Get a website's real logo files, colors, fonts and first screen, saved as a brand kit your coding agent can read.

```bash
npx easybrandkit@latest linear.app
```

![The brand kit easybrandkit made from linear.app](.github/assets/linear-card.jpg)

Ask a coding agent for a landing page, a launch video or a pitch deck for a product and it guesses: a blue that is almost right, a logo retyped in Inter. easybrandkit opens the real site in a headless browser, finds the logos the site itself draws, cuts each one out on the background it sits on, and writes down the colors and fonts the page actually uses. Your agent reads one Markdown file and works from facts.

Read the story behind it on my blog: [easybrandkit: A Brand Kit for Coding Agents](https://eminbudak.com/blog/easybrandkit-brand-kit-for-coding-agents/).

## Requirements

- Node.js 22 or newer.
- Google Chrome, Chromium, Edge or Brave, which opens the site and draws the card. It has been tested with Google Chrome only: 155 on Ubuntu 26.04, 157 on Ubuntu 22.04 and the ones GitHub's ubuntu-22.04, ubuntu-24.04 and ubuntu-latest runners come with. No test has run with Chromium, Edge or Brave. Chrome runs in its sandbox unless easybrandkit runs as root, where the sandbox does not start: on Linux, Google Chrome's own package sets the sandbox up, and a container has to let it start, as Docker does with `--security-opt seccomp=unconfined`. easybrandkit looks for all four on your PATH on Linux and where macOS installs them; on Windows it looks only where Chrome and Edge install themselves. Set `CHROME_PATH` to use another build, as a path or a name on your PATH. Before any work, a run starts the browser and waits for its first answer. One that cannot be started, as a folder, a link to nothing or a file this user may not run, or that ends before it answers, stops the run, and the last line names its path, what is wrong with it or how it ended and the line it printed that says why, and what to do. When that line says that the sandbox could not start or that there were too many files open, another browser would not help, and the last line says what does. A browser that printed only the lines Chrome prints on every start, such as those of its D-Bus code, has none of them quoted, unless one of them says that there were too many files open. The browser takes its pipe to easybrandkit on its file descriptors 3 and 4, so a program that `CHROME_PATH` names and that starts the browser has to hand those on. A run with one that does not stops before any work as well, and the last line says so.
- Linux, where it is tested: on Ubuntu 22.04, on Ubuntu 24.04 and on GitHub's ubuntu-latest runner, on every push and before every release. This release has also run on Ubuntu 26.04 with Node.js 22.22, and on Ubuntu 22.04 with Node.js 22.23. It is written for macOS and Windows as well, but this release has not been run on either.
- Room on the disk for the kit and the one before it, as the earlier kit stays until the new one is in place: a kit took 0.5 to 3 MB on the sites tried, an app's store pictures included. On the same sites the browser's profile took 4 to 18 MB in the temp folder while the run lasted.
- On Linux, a temp folder whose path leaves the browser room for the socket it makes there: 66 bytes at most for Google Chrome, and a few less for Chromium and Edge. A run in a longer one stops and says how much shorter `TMPDIR` has to be. The path may not have a `:` in it either (see below).
- Network access to the site and, unless you give `--no-stores`, to the store listings and social profiles it links to. Installing it needs the network, and `npx easybrandkit@latest` asks npm for the newest version each time it runs. No ffmpeg, no account, no API key and no npm dependencies.
- Pages on the public internet, on port 80 or 443, for anything past the address you give and its own pages: a page easybrandkit was not given, a redirect at each hop and a frame are opened only there, and only where its own lookup of the name works (see [Limits](#limits)).

## What you get

```
easybrandkit-linear.app/
  BRAND.md               the kit, for people and agents
  brand.json             the same, for scripts
  _brand.yml             the name, logo, colors and fonts for Quarto and Shiny
  card.png               the kit on one picture, like the one above
  logo-01.png            the header logo, on its real background
  logo-01.svg            the same logo as a vector, when the page draws it as SVG
  logo-02.png            the footer logo
  screen-01.png          the first screen at 2x, without the cookie bar
  appstore-icon.png      the app icon at 1024 px, when the site links to its app
  appstore-shot-01.png   and up to five store screenshots
  x-profile.jpg          the profile pictures of the accounts it links to
  FACTS.md               with --facts: what the site claims, each claim with its page
  facts.json             the same, for scripts
  pages/pricing.md       with --facts: the text of each page read
```

- Logos come from the header, the footer and links to the home page, as the browser paints them: SVG, image or CSS. Partner strips, customer logos, payment badges and closed menus are skipped. Each cut is at least 240 px on its short side and has no transparency, so it can go straight into an image model or a video. When the page draws a logo as SVG, inline or as an SVG file, the vector is saved next to the cut with the page's colors written into it and no background. A logo in the page body that sits on a photo is skipped: that is an event's or a campaign's lockup, not the brand's logo.
- Colors are the solid colors of the site's buttons, headings, text links, header, footer and large surfaces, plus the color the logo itself is drawn in. Tints, grey buttons and white language switches do not count.
- Fonts are the families the page uses for headings and body text.
- The words are the page title and description, its headings in reading order and what its buttons say, so copy can start from the product's own words instead of made-up claims.
- When the site links to its App Store or Google Play listing, easybrandkit saves the app icon at 1024 px and up to five screenshots. Linked X, YouTube and LinkedIn accounts give their profile pictures.
- Icons, preview images, the web manifest and social links are listed with their URLs.

| | |
| --- | --- |
| ![Notion](.github/assets/notion-card.jpg) | ![Airbnb](.github/assets/airbnb-card.jpg) |

## Use it with your agent

easybrandkit ships as an [Agent Skill](https://agentskills.io). Install it once and your agent runs it by itself when you ask for something for a product:

```bash
npx skills add MakersMCP/easybrandkit
```

That covers Claude Code, Codex, Cursor and the other agents the [`skills`](https://github.com/vercel-labs/skills) CLI supports. In Claude Code you can add it as a plugin instead:

```
/plugin marketplace add MakersMCP/easybrandkit
/plugin install easybrandkit@easybrandkit
```

In GitHub Copilot CLI, install it from the repo:

```bash
copilot plugin install MakersMCP/easybrandkit
```

Then ask as usual:

> Make a 30 second launch video for linear.app

The skill carries its own script, so it installs nothing else and needs no API key.

## Use it from the command line

```
npx easybrandkit <url> [options]

  --out <dir>      where to save (default: ./easybrandkit-<host>, the host
                   without www or a port; ./easybrandkit-appstore-<id> and
                   ./easybrandkit-googleplay-<id> for store listings)
  --facts          also read the site's own claims from its home, pricing,
                   customers, security, integrations and about pages
  --no-stores      skip app store listings and social profiles
  --json           print brand.json instead of a summary
  --timeout <s>    give up after this many seconds (default: 120, or 240
                   with --facts)
  --named-by <url> the site was named by the page at this address, as a
                   store listing names its maker's website, and not given
                   by you: it is read as a page easybrandkit chose itself
```

The address can be a website or an App Store or Google Play listing. A listing gives the app icon and screenshots, and the brand is read from the website the listing names. A social profile is not a brand's site, so easybrandkit refuses one and asks for the website.

A program that hands easybrandkit a site that another source named, as the website an App Store listing's lookup gives, passes that source's address with `--named-by`. The site is then read as a page easybrandkit chose, as the website a listing names is: only on port 80 or 443 and on the public internet (see [Limits](#limits)). One it does not open stops the run before anything is opened, and the last line says why, as in `https://acme.com:8443/, named by https://apps.apple.com/us/app/acme/id1234567890, is on port 8443, not 80 or 443, so no kit was made.` The source itself is not opened, so with `--named-by` no address counts as the one you give: one on the source's scheme, host and port is held to the same rule.

### Settings

- `CHROME_PATH` picks the browser, as a path or a name on your PATH (see [Requirements](#requirements)).
- `TMPDIR` is where the browser's throwaway profile goes while a run lasts; on Linux its path has to leave room for the browser's socket.
- `MAKERSMCP_REFUSE_ADDRESSES` is a comma list of IP addresses and CIDR ranges, such as `185.137.215.163,10.0.0.0/8,fd00::/8`, that easybrandkit refuses for every address it opens, the one you give included: the page, each hop of its redirects, a frame, a page it chose, a store listing and its pictures, and robots.txt. An IPv6 address that holds a refused IPv4 address, as `::ffff:185.137.215.163` or `2002:b989:d7a3::1` do, is refused as well, and an entry written as an IPv6 form of an IPv4 address or range, as `2002:b989:d7a3::/48` or `64:ff9b::185.137.215.163`, refuses that IPv4 address or range too. A server that runs the kit for others sets it to its own public addresses, which lead back inside its network. A run given such an address stops before anything is opened, and for a site its last line names the address and the setting, as in `https://vm.example/ is at 185.137.215.163, an address MAKERSMCP_REFUSE_ADDRESSES refuses, so no kit was made.`; a store listing whose store it refuses is told as a listing that could not be read, with the same reason. With the setting given, easybrandkit looks up the name of a site you give before it opens it, and one it cannot look up within 5 s stops the run in the same way, as `<url> is on a host whose name could not be looked up, so no kit was made.` Missing or empty, it refuses nothing more. A value that does not parse stops the run before any work, with exit code 2 as an option that does not parse does, and the last line names the setting and the part that does not parse, as in `MAKERSMCP_REFUSE_ADDRESSES holds "10.0.0.0/33", which is neither an IP address nor a range such as 10.0.0.0/8, so nothing was read. Give IP addresses and ranges parted by commas, or leave it empty.`

Run it again with the same `--out` and the new kit takes the place of the earlier one there, but only once the run has ended well. Files of your own in that folder stay, unless one has the name of a file the kit writes. While the new kit is made the earlier one stays, so the disk needs room for both. Two runs that end at the same moment with the same `--out` take turns putting their files in, so the folder holds one whole kit, the one put in last. Sites on one host, such as two ports of localhost, get the same default folder, so give each its own `--out`.

A run that fails, is refused, or is stopped with Ctrl-C or a kill leaves the folder as it was: an earlier kit stays whole, and a folder the run would have made is not made. Such a run exits with a status other than 0, and a kit you find in the folder after it is the earlier one. The line under the title of its `BRAND.md` names the address it was read from and the date, in UTC, and `capturedAt` in its `brand.json` gives the time. After two kinds of run that also exit with a status other than 0, the kit in the folder is the new one:

- A run that saved its kit but could not print its summary or `brand.json`, say to a full disk, exits with 1, and its last line says the kit was saved.
- A run stopped in the moment after it saved its kit ends by the signal, and its last line says so, as in `stopped by SIGINT, after the new kit was saved in <folder>`. With `--json`, that stop prints no error on stdout, and `brand.json` may not have been printed. A stop that comes as the process ends, once its summary is printed, leaves no such line.

So a run that printed its summary, which starts with `Saved the`, or `brand.json` with `--json`, has saved its kit, whatever its exit status.

A folder removed while a run makes its kit, by you or another program, ends the run, and its last line says what was removed.

Installed globally (`npm install -g easybrandkit`), the command is `easybrandkit`. npx keeps the copy an earlier run fetched, so `npx easybrandkit@latest` is how you get a newer version. To stop a run started with npx, press Ctrl-C or send the signal to its whole process group (`kill -- -<pgid>`). A kill sent to the npx process alone may not reach easybrandkit: where `/bin/sh` is dash, as on Debian and Ubuntu, the run goes on and puts its kit in place if it ends well.

Nothing is downloaded to run it: easybrandkit drives the browser you already have over the Chrome DevTools Protocol, with a throwaway profile (see [Requirements](#requirements)). It talks to the browser through a pipe of its own, so the browser opens no port that another program on the machine could reach. Before any page is opened, the browser is told to refuse downloads for as long as it runs, and a browser too busy to answer that ends the run. One that does not take it saves a download into the throwaway profile, which goes with the run, so nothing reaches your Downloads folder. The profile also asks the browser to preload no page, so a page's speculation rules cannot have it fetch an address ahead of the page's move there, before easybrandkit has judged it, and the browser is asked whether it took that before a page is opened. One that preloads all the same, as a Chrome policy (NetworkPredictionOptions) or a program that starts it with a profile of its own can make it do, or that cannot say, is not used: the run stops, and the last line says why and what to do. The profile also asks the browser to take no signed exchange: a page, a frame or a prefetch that answers with one would have it fetch the certificate the exchange names, from any address and port the site writes there, which easybrandkit would not judge. A browser that asks for signed exchanges all the same, as a Chrome policy (SignedHTTPExchangeEnabled) or a program that starts it with a profile of its own can make it do, is not used: the first page it would open is not asked for, the run stops, and the last line says why and what to do.

Chrome hands an address that is not a web address, such as mailto: or news:, to a program of the system without asking, so a site could start the mail program on this machine with what it wrote in the address. On every system, a page's own move to such an address, by its script, a refresh, a form or a link, is cancelled before the browser acts on it, in the page and in its frames of the same site, and the browser opens no window a page asks for without a click. A frame's first address, a frame the page makes and then sends to such an address by its script, a redirect to one, and a frame of another site that moves to one still reach the browser. On Linux the browser hands those to the desktop's portal over the session bus, or, with no session bus, to xdg-email or xdg-open, which it finds through PATH. So there easybrandkit starts it with no display and a session bus where nothing listens: DISPLAY is unset, and WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS name sockets in its throwaway profile that are never made. Left unset, either would lead a program to the desktop's own in XDG_RUNTIME_DIR. It also starts the browser with stand-ins first on its PATH for xdg-open, xdg-email, xdg-settings, x-www-browser, www-browser and sensible-browser: links in that profile to `true`, which does nothing. A `:` in the temp folder's path would part that folder from the rest of PATH, so a run in such a temp folder stops before the browser starts and says so. A browser installed as a snap or a Flatpak runs in a sandbox of its own, which can have other programs by those names. easybrandkit tells such a browser by its path and by the links on the way to it, and for it the kit's notes do not say that an address that reached it was not opened; no test has run with one. On macOS and Windows the browser asks the system instead, so there those can still reach the system's own program, the mail program for mailto:. No test has run on either. The kit's notes name the first three such addresses easybrandkit saw, a frame's redirect among them, though not one a frame of another site moves to by its script, and when the address you give redirects to one, the run fails and says so.

### If a run is killed outright

`kill -9`, `taskkill /F` or a power cut give a run no chance to clean up. It can leave:

- A folder whose name starts with `.easybrandkit-part-`, in the kit's folder, or in the folder above it when the run was making the kit's folder. On Windows, so can a run that ends while another program, such as a virus scanner, still holds a file in that folder open.
- A `.easybrandkit-swap` file in the kit's folder, when the kill came as the files moved in.
- In the temp folder, the browser's profile, in a folder whose name starts with `easybrandkit-chrome-`, and the folders the browser makes there itself, whose names start with `com.google.Chrome.` (`org.chromium.Chromium.`, `com.microsoft.Edge.` or `com.brave.Browser.` for the other browsers, with a dot in front in older versions).

The browser does not stay running. It ends within a second or so once the kit's process is gone, also when only that process was killed, as `kill -9 <pid>` does: the pipe the kit drives it through closes then.

What removes them:

- A later run that ends well removes a part folder once its process is gone and nothing in it has changed for 15 minutes, when that run puts its kit in the folder that holds the part folder or in a folder right inside that one, and this user can open it.
- The next run there takes over the `.easybrandkit-swap` file, or names it in its error when it cannot be removed.
- No later run removes what is in the temp folder. Remove those folders yourself.

Moving its files into place takes a moment. Killed in that moment, a run leaves the earlier kit's files it had moved aside in the `.earlier` of its part folder, which is in the kit's folder by then, and no run removes those. If its own `brand.json` had not come in yet, the kit's folder is left without one, with some of the new files in it or none. A later run refuses that folder and says what to do:

1. Move the files in that `.earlier` back into the kit's folder, and those in its `pages`, when it has one, into the kit's `pages`, replacing any files of the same name there, which are that run's.
2. Remove the files the refusal names as that run's. The run wrote those names down before its first move, as names the folder did not hold, so none of them is a file of the earlier kit or of yours.
3. Run again.

A folder that held no kit when that run began has no earlier files to move back. A later run refuses it and names the files that run left there: remove them and run again.

A move into place that fails and cannot be undone is rare; its error names the folder that holds the earlier kit's files.

## The site's own claims

With `--facts`, the kit also lists what the site says about itself. Each claim is quoted as the page states it, with the page it is on and the time it was read.

```bash
npx easybrandkit@latest linear.app --facts
```

- Numbers the page draws as figures, with the words under them ("135+ currencies and payment methods supported"), or states in a sentence ("Linear powers over 50,000 product teams").
- Testimonials with the person's name, role and company.
- Customers from rows of customer logos, from customer stories and from testimonials.
- Plans with their prices and terms, as the pricing page shows them.
- Integrations from the integrations page.
- Security standards the site names, such as SOC 2, ISO 27001, GDPR or HIPAA, each with the sentence that names it.
- Ratings, questions and answers, and company details from the page and its JSON-LD.

Besides the home page, easybrandkit reads up to five pages it finds in the site's menu and footer: pricing, customers, security, integrations and about. It reads them one at a time with a pause between them, and only the ones the site's robots.txt lets tools read. A page past the home page is read only while 45 s of the run's `--timeout` are left, so a short `--timeout` can leave some of them or all of them out, and `FACTS.md` names the pages it skipped. `FACTS.md` lists the claims and `facts.json` holds the same for scripts. `pages/` keeps the text of each page read, so every claim can be checked in its context. A run takes one to three minutes.

No model is involved. Rules find the claims, and a claim they cannot tie to a name, a label or a price is left out. Prices are what the page showed from where it was read, so they can differ by country.

Text from a web page can carry instructions written for AI agents. `FACTS.md` quotes the pages and `pages/` keeps their text in fenced blocks, both say that this text is data, and the skill tells your agent never to follow it.

It is made for work that has to stay true to a product: a competitor profile, a comparison page, a pitch deck, or launch copy with real numbers and real customers.

## With claude-code-video-toolkit

[claude-code-video-toolkit](https://github.com/digitalsamba/claude-code-video-toolkit) keeps each brand in `brands/<name>/`. Make a kit in the toolkit's folder, then start `/brand` and point it at the kit:

```bash
npx easybrandkit@latest stripe.com --out brand-kit
```

```
/brand New brand: Stripe. The kit is in brand-kit/, use it for the colors, the fonts and the logo.
```

`/brand` shows how it mapped the colors for you to confirm, then writes `brand.json` and the logo files. The toolkit's templates put the logo on their own backgrounds, so point `/brand` at the kit's `.svg` logo when there is one, or ask for a transparent cut of the PNG.

## With Quarto and Shiny

Every kit has a `_brand.yml` in the [brand.yml](https://posit-dev.github.io/brand-yml/) format, which Quarto and Shiny read to theme documents, websites, slides and apps. It holds the brand's name and site, its logos (each as the SVG when the page draws one, else as the PNG), the page's colors named for where it uses them, and the font families for text and headings. The `medium` logo, the one Quarto puts in a navbar, on slides and in a PDF, is the site's own header or footer logo that shows on the page's background. The button color becomes `primary`, and the page's own background and text colors become `background` and `foreground`. A family on Google Fonts gets `source: google`, so Quarto and Shiny load it from there. Any other font keeps its name as a system font and shows only where it is installed. A color or font the page doesn't show is left out, so Quarto and Shiny keep their own default for it.

Point a Quarto project at the kit in `_quarto.yml`, or a single document in its front matter:

```yaml
brand: easybrandkit-stripe.com/_brand.yml
```

A Quarto website paints its navbar in the `primary` color. For a dark logo like Stripe's, `background: light` under `website: navbar:` keeps it readable.

In Shiny for Python, `ui.Theme.from_brand("easybrandkit-stripe.com/_brand.yml")` makes the theme, and Shiny for R reads the same file through bslib. You can also copy `_brand.yml` to the root of the project or app, together with the logo files it names.

## How it works

1. Opens the home page in a headless browser on a 1600x900 desktop screen, with downloads refused and every page, redirect and frame the browser loads judged before it is asked for (see [Limits](#limits)). An address deeper in the site is read from the home page, because a blog or a help center often wears another theme. When the home page cannot be read, the address given is read instead.
2. Scrolls to the bottom and back, so lazy sections and footer logos load.
3. Reads one DOM snapshot with layout and computed styles. Logo candidates are images, outermost SVGs and elements named "logo" or "brand". They are kept only in the page header, in the page footer, inside a link to the home page, or when they are named after the brand.
4. Brings each logo to the middle of the screen, finishes its fade-in, hides whatever paints over it (a popup backdrop, the next line of text) and cuts it out with a margin of its own background. The background is read from that margin's pixels, not from the CSS. A logo drawn as SVG is also written out as a vector, with the page's styles on it and its scripts removed.
5. Hides floating overlays and takes the first screen at 2x.
6. Fetches store listings and profile pictures over HTTPS on port 443 from a fixed list of hosts, refuses addresses that are not on the public internet and those `MAKERSMCP_REFUSE_ADDRESSES` names, and connects only to the addresses it judged for the host.
7. Writes the kit into a folder of the run's own, inside the kit's folder or next to it, and moves the files into place only once the run has ended well, so a run that fails or is stopped changes nothing there. A browser that is closed or crashes on the way, or a file that cannot be written, fails the run. A card that the browser cannot draw while it runs is told in the kit's notes.

## Limits

- A site that answers with a bot check gets no kit: easybrandkit stops and says so, instead of saving the check page's colors. A login page that answers 401 or 403 is refused by its status. One served with 200 is read like any other page, so look at `card.png` before you use a kit made from one.
- An address that answers with an HTTP error (400 or above), also after a redirect, gets no kit, and neither does one that cannot be opened, that gives no answer in 30 s, or that moves on to a page that cannot be opened or to a blank page: easybrandkit stops and says which address answered what, instead of saving the error page's logo and colors.
- Those refusals are for the address you give. When the page that fails is one easybrandkit chose to read, the run goes on with what it has and the kit's notes say so. A store listing whose website answers with an error, cannot be opened or answers with a bot check keeps the app icon and screenshots from the listing, with no logos, colors, fonts, first screen or card, as a listing that names no website does. If none of the listing's pictures could be downloaded either, the run fails and says so. An address deeper in a site whose home page fails that way is read as given, so the kit's name, header and colors can differ from the home page's, and if that fails too, the error names the address you gave. A run that goes on like this has ended well, so its kit takes the place of an earlier one in the folder.
- A run that uses up its `--timeout` on such a page fails and says to give it more time, and an earlier kit stays. So does a run whose `--timeout` leaves no time to wait for a page that shows nothing yet.
- easybrandkit opens the address you give whatever its host and port, a site on this machine included, and so the pages on that address's scheme, host and port, and https on the host and port of an http address you give. The names of this machine itself, such as localhost, 127.0.0.1 and [::1], count as one host on one port, so a local site that sends its visitors from one of them to another is read. An http address is asked for over http as it is written: the browser is told not to try it over https first, as Chrome does by itself, so a site that answers on both without sending its visitors to https is read over http. A name the browser takes only over https (HSTS), as every .dev and .app name, it still asks for over https: on the port you give, and on port 443 for port 80, which is another address and is held to the rule below, so a site of this machine or of a private network by such a name is read when you give its https address. Any other address it opens, one you did not give, it opens only on port 80 or 443, and only when every address its own lookup finds for the name is on the public internet: not this machine, a private, shared or link-local network, or in IPv4 a range kept for documentation, benchmarks, multicast or later use, nor in IPv6 multicast, the documentation range 2001:db8::/32, the discard range 100::/64, a Teredo address (2001::/32), NAT64's local use prefix (64:ff9b:1::/48), a site local one or an IPv6 form of an IPv4 address that is not public. The other IPv6 ranges count as public, IPv6's newer documentation range 3fff::/20 and its benchmarking range 2001:2::/48 among them, as MakersMCP's worker counts them too. That holds for the home page of a deeper address, the website a store listing names, a site given with `--named-by`, each hop of a redirect, a page's own move, a frame or a window a page opens, a menu page with `--facts`, and robots.txt with each of its redirects. Each is judged before the browser or easybrandkit asks for it, and the browser makes no connection ahead of it. A name easybrandkit cannot look up within 5 s is not opened, and neither is an address written with http: or https: that easybrandkit cannot read itself, as one whose host has a label of broken punycode such as `xn--a`, which the browser reads and would open. A NAT64 address of a public site, as a network with IPv6 only gives, is as public as the site.
- When the address you give leads to such an address, by a redirect at any hop or by the page's own move, as its script or a refresh makes, the run fails and its last line says where it led and why, as in `https://acme.com/ led to http://127.0.0.1:9222/json/list, which is on port 9222, not 80 or 443, so no kit was made.` or `... led to http://intranet.acme.com/, which is at 10.0.0.5, an address not on the public internet, so no kit was made.` The browser shows its own error page in place of a page that moves there, so the page is not read. A page easybrandkit chose that it does not open, or that leads there, is skipped like one that fails, and the run goes on: a store listing keeps what the listing gave, the home page of a deeper address gives way to the address as given, and a menu page is named in `FACTS.md`. A site given with `--named-by` that it does not open stops the run before anything is opened, and one that leads to such an address fails the run as the address you give does. A frame or a window a page opens there is not opened: the page is read with that frame left empty, and the kit's notes name the first three such addresses and why, and count the rest, as in `https://acme.com/ tried to open http://10.0.0.5/admin, which is not on the public internet: it was not opened.` With `--facts`, a robots.txt that leads to such an address is not followed, and then no page past the home page is read. Only web pages are opened, so a link a site gives to a file on this machine is not followed.
- What a page asks for itself, its pictures, styles, scripts and the data it fetches, easybrandkit does not judge: those are left to the browser's own rules, and `MAKERSMCP_REFUSE_ADDRESSES` does not hold for them either. Google Chrome 155, as tested here, refuses a public page's pictures, scripts, data and frames on this machine by itself.
- The browser runs with HTTP/3 off, so a site's `Alt-Svc` answer cannot send its next requests to another port or host than their addresses name. The browser looks a name up again as it opens the page. Where it says which address it reached for the page it shows, as it does when it reaches the server itself, a page it got from an address the rules above refuse is not read, also when easybrandkit's own lookup found the name elsewhere; the request has reached that address all the same. That holds for the page alone: a frame is judged by easybrandkit's own lookup only, so a frame whose name the browser's own lookup finds on this machine or a private network, where easybrandkit's found it on the public internet, is opened, its request reaches that address, and what it shows can be in the first screen and the card, with no note. Through a proxy the browser does not say where a page came from, so there easybrandkit's own lookup alone decides.
- Behind a proxy in fake-ip mode, which gives every name an address in 198.18.0.0/15, or in fc00::/7 as sing-box does when its `inet6_range` is set, and on a network where this machine cannot look names up itself, no name can be told to be on the public internet, so only the address you give and its own pages are read. Then give the address the site ends on, as a page on the scheme, host and port you give is always read. Store listings and profile pictures are not read there either.
- On a busy machine the browser itself can be slow to start, to open its tab, to answer the kit's connection to that tab, to answer when the kit tells it to refuse downloads or to judge the pages it opens, or to say whether it preloads pages. The run waits for each of these as long as its `--timeout` allows, and so it does for a program `CHROME_PATH` names that takes long before it starts the browser. If that runs out, the run fails, an earlier kit stays, and the last line says what did not answer and to give the run more time. When the disk that holds the temp folder is full, the run says so within seconds instead, and what to do. A browser that answers that it does not take the kit's request to judge the pages it opens ends the run before the site is opened too, and the last line says to point `CHROME_PATH` at another browser, as the same browser would refuse it again.
- The page's headings and button labels are read while the browser tab answers, for a few seconds past `--timeout` at most. Those not read by then are left out of the kit, and its notes say so and to give the run more time.
- A page too large to read gets no kit, and the run says so. easybrandkit takes no answer from the browser over 128 MB, and the snapshot of a very large page can be bigger. With `--facts`, a menu page that large is skipped and named, and the pages after it are read.
- With `--facts`, a menu page that answers with an error is skipped, and `FACTS.md` and the summary name it with the reason. When the home page's text cannot be read, no other page is read either, and `FACTS.md` says that no page could be read and why. A deeper address read as given because its home page could not be read is filed in `FACTS.md` as the page given, its text in `pages/given.md`, and the home page is named there as not read.
- With `--facts`, rules that do not finish in their time, 30 s at most, list no claims: `FACTS.md` and the summary say so, and `facts.json` has a `claimsError` field. A page built to keep them busy costs that, and `pages/` still holds the text of each page read.
- Instagram, Facebook and TikTok serve nothing without a login, so they are not asked.
- A logo drawn into a canvas or a WebGL scene is not found.
- Colors come from what the home page shows. A main color used on one button of another page will not show up.
- `--facts` reads text as the page shows it. A claim drawn inside an image or a video, one shown only on hover or in a closed tab, a plan behind a currency or region switch, and a menu link that appears only on hover are not seen.

## License

MIT
