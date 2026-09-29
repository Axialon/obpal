# ob.Pal messaging

What ob.Pal is, in the words the site uses. The site, the link preview, llms.txt, catalogue.json, the README and ob.Pal Link's store listing carry these lines; change them together.

## Positioning

> Your phone is the controller for whatever is on a screen, alone or with friends. Scan a code: it opens in the browser. No app, no account, open source.

The essence every rewrite keeps: the phone becomes the controller for things on a screen; a scanned code opens it in the phone's browser, with no app; it's private (encrypted, no accounts) and open source.

## Hero

The eyebrow stays: **Open source · no app · no account**. Each sub-line is 12 words at most.

| | Headline | Sub-line |
|---|---|---|
| **A (on the site)** | Your phone is the controller. | Robots, drones, games, music and your computer, with friends. Scan and play. |
| B | One phone. Any controller. | Robots, drones, games, music and your computer, with friends. No app. |
| C | Every phone is a controller. | Robots, drones, games, music and your computer. Scan and play, no app. |

**Why A.** Its headline is the essence, and the hero is built on it: the marble comes to rest on its full stop. The sub-line names the whole range in six words, then friends, then the scan; the eyebrow above already says no app. B leads with the controllers (and echoes "One phone, every controller" just below it); C with everyone's phone. Either would need the hero's letter tests re-pinned.

## Proof points

- **No app:** scan the QR code or type the short code; the controller opens in the phone's browser. iPhone and Android.
- **Over 40 sims:** robot arms, drones, vehicles, a submarine, a smart home, cameras, games and science.
- **A music studio** for eight phones: drum pads, the phone as a drumstick, keys locked to a scale.
- **Together:** up to eight phones in one scene, each holding its own part.
- **The right controller:** gamepad, wheel, trackpad, pointer, air mouse, 3D hand, keyboard, drums and tone keys. A headset, clicker or Bluetooth pad can press them (a phone's volume keys never reach a browser page).
- **Any website**, said with what is tested (Chrome, Edge, Brave and Vivaldi) and a link to the limits: a gamepad for games that read the Gamepad API, a 3D mouse or keys, with ob.Pal Link. **The whole PC** with ob.Pal Desktop (Windows only, macOS coming soon), typing included.
- **Your own site:** one tag, `<obpal-remote>`.
- **The viewer:** your own 3D models, turned, pointed at and moved from the phone.
- **Private:** encrypted, and the ob.Pal service only introduces the devices. No accounts, no analytics.
- **Open source** (MIT): the code, the protocol and every controller's spec.

## Voice

1. **Concise, but the whole picture.** Name real things (robots, drones, games, music, your computer) rather than describe them. A sub-line is 12 words at most; a card's text, one sentence.
2. **Show it, then name it.** A live scene, an icon or a picture carries the idea; words label it.
3. **Plain and direct:** you, your phone; present tense; short sentences.
4. **No hype:** not revolutionary, seamless, magic, instantly, effortless, powerful, ultimate, unlock, simply or just. No exclamation marks, no emoji.
5. **Only what ships.** tests/overclaims.test.ts fails when one of these comes back:
   - VR, first-person views and watches: "coming", or left out. A sim opens on a computer, not a TV.
   - Real arms are experimental and untested on hardware: never "built for real arms". Stop is a software hold, not an emergency stop, and the arm's own stop stays within reach.
   - "Any website" and "any browser game" come with what is tested (Chrome, Edge, Brave and Vivaldi; games that read the Gamepad API) and a link to the limits in extension/README.md.
   - ob.Pal Desktop is Windows only; macOS is "coming soon".
   - The Chrome Web Store, only after Link is listed there.
   - `@obpal/core` and `@obpal/host` are on npm, so a page or README may show `npm install @obpal/host` and the import. It says only what the packages do (their READMEs), and names only paths they export: the test reads their `exports`. The embed snippet (`<script type="module" src="https://obpal.blackboxes.net/embed.js">` and `<obpal-remote>`) stays the first example, for a page with no build step.
   - The 3D position comes from the camera mode, or is estimated from the phone's own motion without it. No precision such as "in metres".
   - Offline claims only what the extension's tests cover: a phone paired once, on a network that lets devices reach each other.
   - Telemetry is off by default; feedback is opt-in only.
6. **Numbers that stay true:** "up to eight phones", "over 40 sims".
7. **Say "no app"**, not "nothing to install" (Link and Desktop are installed).
8. **One spelling for UK and US readers.** Avoid colour, centre, grey, favourite, metre, analogue, behaviour, travelling, licence and -ise or -ize verbs. Names keep theirs (the Catalogue page, catalogue.json). tests/messaging.test.ts checks every page's description.
9. **Names:** ob.Pal, ob.Pal Link, ob.Pal Desktop, the viewer, sims.
10. **Typography:** curly apostrophes and quotes in page copy and catalogue.json; straight ones in plain text and code. Never both on one page.

## The link preview

public/og.png (1200 × 630): the hero's night, eyebrow, headline, sub-line and marble, and a phone held as a gamepad in the 3D design language. `node scripts/og-image.mjs` renders it from scripts/og/ and reads the words from the hero, so run it again when they change. Every page's Open Graph and Twitter tags come from its own title and description (scripts/lib/preview.mjs, added by vite.config.ts).

## ob.Pal Link's store listing

The summary is the manifest's `description` (extension/vite.config.ts), 132 characters at most, and ships in the package. The description, the permission justifications and the reviewer's notes are in extension/store/listing.md. Every claim there must hold for the version being uploaded; it stays Windows-only until a real Mac test passes.

## The public repositories

The obpal-link README carries the same qualifiers as the site (extension/README.md has them too): websites "in your browser", games that "read the Gamepad API", PC control marked "(Windows)", the browsers that are tested, and a Limitations section. The repositories' About lines, in the same words:

- Axialon/obpal: `Your phone is the controller: robots, drones, games, music and your computer. Scan a code, no app. Open protocol.`
- Axialon/obpal-link: `Your phone as a controller for websites in your browser: a gamepad for games that read the Gamepad API, a 3D mouse or keys, and on Windows your whole PC. No phone app.`
