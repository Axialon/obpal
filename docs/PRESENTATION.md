# Presenting ob.Pal

A runbook for showing ob.Pal live, on https://obpal.blackboxes.net. It is written for the presenter: what to run beforehand, the order to show things in, one line to say at each step, and what to do when a step does not work. The lines stay inside what ships; the list of things not to say is at the end.

The core show is about 15 minutes. Every step after the first three can be cut without breaking the story.

## The idea in one breath

Your phone is the controller for whatever is on a screen, alone or with friends. Scan a code and it opens in the phone's browser: no app, no account, open source. Today that covers over 40 sims, a 3D viewer, websites in your browser (through ob.Pal Link) and, on Windows, the whole PC (through ob.Pal Desktop). The same phone and the same open protocol drive all of them, which is the point: one universal controller, not one app per toy.

Where it goes next, said as direction and not as a product: motion that a person records could become a model that belongs to them, a signature motion they can take from one screen to another. Nothing of that ships today; do not demo it and do not promise it.

## Run the preflight first

```
pnpm run demo:preflight
```

It takes one to two minutes and never more than five (`--budget`). It opens the live site as a visitor would, in Playwright's Chromium with software rendering, and prints one table with the time each check took. It writes screenshots and `results.json` to `artifacts/demo-preflight/<time>/` (git ignores it) and never prints a pairing link or a watch link, only the code with its digits masked.

| Part | What it proves | If a row fails |
|---|---|---|
| web | The service answers. `/link/` offers the Chrome Web Store and the manual zip, the zip downloads and matches the latest release. Desktop's page offers its Windows zip, which downloads (it is never run). | Step 6 or 7: show the page only, or skip it. |
| home | The home page loads and draws its marbles. A pairing QR and a typed code are issued. An emulated phone joins, takes each controller mode, and a drag on its trackpad moves a marble. | Steps 1 and 2: fall back to the Viewer or a sim for the first pairing. |
| viewer | The Viewer loads with a model and issues a code. A phone joins it. | Step 3: go straight to the sims. |
| turn | TURN offers a relay, and a DataChannel forced through the relay opens and echoes. | Guest or locked-down Wi-Fi may not work: have the phone hotspot ready (see the fallbacks). |
| sims | Each of three flagship sims (Humanoids, Drone, the SO-101 arm) starts, draws a frame and issues a code. On the first that does, a watch link opens as a guest and a phone joins and drives it. | Step 4 and 5: use another sim (`--sims dog,kart,pinball`), or skip the sim. |

The last lines say `READY` or `NOT READY`, and whether ob.Pal Desktop's log gained a line naming a test browser (it must say `no new sessions`).

What the preflight does not prove: your real phone (its sensors, camera, browser, battery), the venue's Wi-Fi, your display, or how fast your GPU draws. It emulates a Pixel 7 and renders in software, so its frame rates only say a scene runs. The pairing checklist below covers the rest, and the preflight is a check of the site, not a rehearsal.

Flags worth knowing:

- `--sims drone,humanoid,arm` picks the sims by name (`dog`, `kart`, `pinball`, `lamp`, `studio` are known too), or by path such as `sim/kart/`.
- `--only web,home,viewer,sims` runs some parts: `--only web` needs no browser and takes a few seconds.
- `--without-beacon` is a diagnostic. It removes Cloudflare's analytics script from the pages the test browser loads, to show what a run would find with that injection off. Use it to tell a site problem from that one.
- `--origin <url>` checks another deployment.

One warning to take seriously: the `web · Cloudflare beacon` row. Cloudflare can add its Web Analytics script to pages it serves. ob.Pal's pages block it (the browser console shows a policy error), and a sim that reads that blocked script as its own failed start shows "The scene could not be loaded". If that row warns and a sim row fails with the same cause, turn off Web Analytics' automatic setup in the Cloudflare dashboard, or deploy a sim that ignores scripts from other origins, and run the preflight again. Do not go on stage with that row warning until the sims pass.

## The show

Each step: what you do, one line to say, and the fallback. Say the line in your own words; keep the claim.

### 1. The home page and the marbles (1 minute)

Open https://obpal.blackboxes.net on the big screen, full screen, sound off. Move the mouse once: the page issues a real pairing code on the first sign that someone is there.

Say: "Your phone is the controller. This page is a screen waiting for one."

Fallback: if the marbles do not draw or the code does not appear, reload once. If it still fails, open `/view/` (step 3) and start there; it issues a code the same way.

### 2. Pair a real phone (2 minutes)

Hold up your phone. Scan the QR code with the phone's camera app, or open obpal.blackboxes.net on the phone, tap Scan a code, or type the ten digits at obpal.blackboxes.net/p. Allow motion when the page asks (an iPhone asks with a tap). Tilt to roll a marble, flick it up to toss. Add a second phone if someone in the room has one: the home page gives up to four phones a marble each.

Show the phone's controller bar: Trackpad and Wii remote on the home page, more modes on the Viewer and in sims. Tap the padlock with the milliseconds on the phone's top bar: it says Direct or Relayed.

Say: "No app, no account. I scanned a code and my phone is the controller."

Fallbacks:
- The camera will not scan: type the ten-digit code at obpal.blackboxes.net/p.
- The phone says it cannot reach the screen: see Wi-Fi in the fallbacks below.
- No motion (a phone without sensors, or motion refused): the trackpad steers instead. Say so; it is a normal mode, not a failure.
- The phone shows the wrong screen: open Connections on the phone, forget the screen, scan again.

### 3. The viewer (2 minutes)

Click Open the viewer. A model is on stage. From the phone: the Trackpad tab orbits, pans and zooms; Wii remote points; Gamepad is a gamepad. Open the catalogue and switch to another model.

Say: "The same phone is a pointer, a trackpad or a gamepad, depending on what the screen asks for."

Fallback: if a model is slow to load, pick another from the catalogue. If the Viewer will not pair, use the home page's pairing from step 2.

### 4. Sims (5 minutes)

Open `/sim/`. Show three, in this order. Each sim page issues its own pairing code; pair the phone again, or use the phone's Connections list.

1. **Humanoids** (`/sim/humanoid/`). Your movement, their reach: choose a seat, move with the keyboard (WASD, Q and E to turn, 1 to 6 for moves) or pair a phone and use the Body camera. Say: "Full-body practice: the robot on screen follows your movement." Fallback: camera modes ask for permission and download a model the first time (the hand model is about 20 MB, and the phone asks first on mobile data). If the camera is the problem, drive it from the keyboard and say so.
2. **Drone** (`/sim/drone/`). Take off, fly through the rings, land. Phone as Gamepad: left stick climbs and turns, tilt to fly. Say: "Same phone, now a flight controller." Fallback: the Trackpad tab flies it too (tilt to fly, drag up to climb, tap to take off).
3. **SO-101 arm** (`/sim/arm/?kind=so101`). Scan to join, then take a whole arm or one joint; Point aims at a spot, B holds. Say: "A simulated robot arm." Do not connect a real arm on stage: that path is experimental and untested on hardware, and Stop there is a software hold, not an emergency stop.

Octopus: there is no octopus sim on the site. It exists as a design plan (docs/OCTOPUS.md) and a tested motion foundation only, with no playable page. Do not show it or say it exists.

Fallback for any sim: if a sim stalls, shows a blank stage, or shows "The scene could not be loaded", do not fight it. Its Reload button is limited to once in ten minutes and is off while the scene is paired or shared. Use Back to sims and open the next one (Dog, Kart, Pinball, Lamp and Studio are all featured). The sim you skip loses nothing.

### 5. Sharing: a watch link (2 minutes)

In a sim or the Viewer, open Share. The Watch tab is first: a QR code and a link, view-only. Open it on a second device, or have someone in the room scan it. Point out the Play tab: "Anyone with this link can control. Share it only with players." Show Stop sharing and New link.

Say: "Anyone can watch from a link; only people you invite can play. Watching never gives control."

Fallback: if the guest page does not show Watching, press New link and try again. A watch link works until you stop sharing, or until an hour passes with nobody there. If sharing fails altogether, say so and move on; the sims do not depend on it.

### 6. ob.Pal Link (2 minutes)

Link is a browser extension on the Chrome Web Store. It is tested in Chrome, Edge, Brave and Vivaldi, and it gives a page a gamepad (for games that read the Gamepad API), a 3D mouse or keys; some pages require trusted input, so say that if asked. Open `/link/try/`, the dot demo. Open Link from the toolbar (pinned), scan its QR with the phone, choose Controller, turn on This tab, and move the left stick on the phone. Pairing alone leaves input off; the turn-on is the point.

Say: "The same phone can drive a page that was never written for ob.Pal, if it reads the Gamepad API. Pairing is a separate choice from turning input on."

Fallback: if Link is not installed on the show machine, open `/link/` and show the install page, then continue without the demo. Do not install it live from the store listing on stage unless it is part of the story.

### 7. ob.Pal Desktop, only if it is safe (1 minute)

Desktop is Windows only; macOS is coming soon. It is unsigned, so Windows may show an unknown publisher or SmartScreen warning, and it is a separate permission from Link. It lets an allowed phone use the mouse and keyboard in allowed programs or the whole PC. That moves the real mouse and keyboard on the machine you are presenting from.

Safe by default: show `/link/desktop/` and say what it does and how to stop it. The default panic key is Ctrl + Alt + Backspace; it stops keyboard and mouse input from the phone. Run it live only if all of this is true: you rehearsed on this exact machine, you chose an allowed program and not Whole PC, nothing unsaved is open, and you know the panic key. Elevated Windows apps may refuse the input, which is expected.

Say: "On Windows, the same phone can reach the PC, only where you allow it, and one key stops it."

Fallback: skip the step. The story holds without it. Do not run its installer on stage.

### 8. Close (30 seconds)

Open `/trust/` or the repository. Say: "It is open source under MIT: the code, the protocol and every controller's spec. The host SDK is on npm and one `<obpal-remote>` tag puts a phone controller on your own page." Stop sharing, disconnect the phones, close the tabs.

## Fallbacks that cut across steps

| Problem | What to do |
|---|---|
| The venue Wi-Fi blocks the phone or the page | Put the phone on mobile data and keep the computer on the venue Wi-Fi: the pairing travels over the internet and the phone's padlock says Direct (over the internet) or Relayed. Or join both to your own phone's hotspot. Guest networks that isolate devices are the case TURN exists for: the padlock says Relayed. |
| No internet at all | The site is hosted, so the live demo needs it. Tether the computer to your phone's hotspot, and pair a second phone as the controller. |
| A QR will not scan | Type the ten-digit code at obpal.blackboxes.net/p, or hold the phone closer and turn the screen brightness up. |
| The phone connects, then drops | Open Connections on the phone and reconnect. If it says Disconnected, its Reconnect button returns to the same screen. |
| A page is slow or blank | Reload once. A sim's own Reload is limited; go back to Sims and open the next one. |
| The projector cuts the QR | Make the page full screen, use the typed code, or show the QR on the laptop's own display first. |
| A second presenter or phone is needed | Up to eight phones can join one scene. Keep a spare phone charged; there are no accounts to sign in to. |

## The 30-minute checklist

Tick these before the room fills. The times count back from the start.

**T-30: the machine**
- [ ] On the charger. Display sleep off, notifications off (Do Not Disturb), other apps closed, sound off or routed where you want it.
- [ ] One browser window, 100% zoom, bookmarks bar hidden, signed in to nothing you would mind showing. It is the browser where Link is installed and pinned.
- [ ] Display scaling and projector resolution set; full screen works (F11).
- [ ] You are on the network you will present on, not the office one.

**T-25: run the preflight**
- [ ] `pnpm run demo:preflight` from a checkout with dependencies installed (`pnpm install --frozen-lockfile`).
- [ ] It says `READY`, the Cloudflare beacon row does not warn, and the guard line says `no new sessions`. If anything fails, read its row in the table above and decide which step to cut now, not on stage.
- [ ] Optional: `pnpm run check:live` for the wider post-deploy check (every page at two widths, headers, the pairing-code rules).

**T-20: warm the pages**
- [ ] Open each page you will show once, so its files are cached: `/`, `/view/`, `/sim/humanoid/`, `/sim/drone/`, `/sim/arm/?kind=so101`, `/link/try/`, `/link/desktop/`.
- [ ] If you will show a camera mode, open it once on the phone now so its model is already downloaded.
- [ ] Close the tabs again, except the home page. Each open sim holds a room until its tab closes.

**T-15: the real phone**
- [ ] Charged over 50%, brightness fixed, auto-lock on its longest setting, notifications off, no other app in front.
- [ ] Pair it to the home page. Tilt to roll a marble, flick to toss. Tap the padlock and note Direct or Relayed.
- [ ] Allow motion when asked. On a phone without sensors, check the trackpad steers.
- [ ] Open the Viewer on the phone's pairing: Trackpad, Wii remote and Gamepad all respond.
- [ ] Disconnect it, so you start the show from a fresh QR.

**T-10: Link and sharing**
- [ ] Link is pinned and opens. Pair, choose Controller, turn on This tab on `/link/try/`, move the stick, then turn the tab off again.
- [ ] Open a sim, press Share, open the watch link on a second device and see Watching. Then Stop sharing.
- [ ] Desktop: do not install, start or test it. Open `/link/desktop/` and leave it at that unless you rehearsed the live path (step 7).

**T-5: the backups**
- [ ] Your phone's hotspot is on and the laptop knows its name and password.
- [ ] A second phone is charged and has the site's address open.
- [ ] You know the next sim to open if one stalls (Dog, Kart, Pinball, Lamp, Studio), and which steps you will cut if you run out of time (7, 6, 5).
- [ ] This page is open on your own screen, not the audience's.

**T-0**
- [ ] The home page is full screen, the pointer is out of the way, the first line is ready.

## Say, and do not say

Say what ships:
- Your phone is the controller for whatever is on a screen, alone or with friends. Scan a code, it opens in the browser. No app, no account, open source.
- Over 40 sims. Up to eight phones in one scene. iPhone and Android.
- Encrypted between the devices, and the ob.Pal service only introduces them. No accounts, no analytics. The Trust page shows how to check the source and compare the connection seal on both screens; the seal is a comparison aid, not proof that a build is legitimate.
- Link is on the Chrome Web Store; tested in Chrome, Edge, Brave and Vivaldi; a gamepad for games that read the Gamepad API, a 3D mouse or keys. Desktop is Windows only and optional.

Do not say:
- That it works on any website or any game. It works where a page reads the Gamepad API (or takes mouse and keys), in the browsers named above, and the limits are in the Link README.
- That a real arm is supported. An arm you connect is experimental and untested on hardware; Stop is a software hold, not an emergency stop.
- That there is a macOS build (it is coming soon), a TV mode, an octopus sim, or a signature-motion product.
- That a phone's volume keys work as controls. Browsers never give them to a page.
- A latency number. The milliseconds on the padlock are a round trip on the control channel, not motion to photon, and nothing in this runbook has measured the second.
- That something is instant, seamless, effortless or magic. Show it and let it speak.

## After the show

- [ ] Stop sharing in every sim you shared, and press Disconnect everyone in the Viewer.
- [ ] Close the tabs. Rooms are ephemeral and end when their pages close.
- [ ] Tell the maintainer what failed on stage, and at which step. The preflight's `results.json` from the day is the first thing to attach.
