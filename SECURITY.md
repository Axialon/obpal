# Security policy

ob.Pal turns a phone into a controller for a screen, and with ob.Pal Link and ob.Pal Desktop, for a whole Windows PC.
So its connections are held to a high standard: a phone that pairs with a screen must be the phone the person meant, and
nobody else, the room service and any relay included, may read or change what the two send each other.
[spec/SECURITY.md](spec/SECURITY.md) has the threat model, the standards each part follows and how to run your own
room service and relay. Its §11 to §13 cover updates and downloads, physical control and what an independent review
should test.

## Before you rely on it

- **Downloads.** [ob.Pal Link is on the Chrome Web Store](https://chromewebstore.google.com/detail/obpal-link/jnnpcnoilofjaffabnhecfokjjknlemg). Manual Link zips and the unsigned ob.Pal Desktop helper come from GitHub releases; Desktop never updates itself. GitHub shows a SHA-256 digest for each file, which PowerShell's `Get-FileHash` can check ([how](spec/SECURITY.md#11-updates-and-downloads)).
- **Machines.** The sims' Stop is a software hold, not an emergency stop. Real-arm and hardware paths are experimental
  and haven't been tested on hardware. Keep the machine's own emergency stop within reach.
- **Review.** The standards checklist is a self-assessment, not a certification, and no independent security assessment
  or penetration test is recorded in this repository. Outside review is welcome: §13 of the spec lists where to start.
  Findings come to the address below and follow the same terms.

## Reporting a vulnerability

Email **hello@obpal.blackboxes.net** with "Security" in the subject. Please include:

- what an attacker can do, and what they need first (on the same network, in the room, able to see the screen, …);
- the steps to reproduce it, and the versions (the site's date, or ob.Pal Link and ob.Pal Desktop versions);
- whether you'd like to be credited, and how.

Please don't open a public issue or pull request for a vulnerability before it is fixed. You'll get an answer within a
week, and a fix or a plan within 90 days, after which you're free to publish. ob.Pal has no bug bounty.

## In scope

- Pairing: the QR code, the short code and its exchange, remembered phones and the direct LAN code.
- The room service (signaling, rooms, short codes, ICE and TURN credentials) at obpal.blackboxes.net.
- The phone controller (`/p/`), the screens (the viewer, the sims, the home page) and `/embed.js`.
- The `@obpal/core` and `@obpal/host` packages.
- ob.Pal Link (the browser extension) and ob.Pal Desktop (the helper: Windows, with an unreleased macOS preview): above
  all, anything that lets something other than the paired phone, or more than the scope a person allowed, type or move
  the mouse on a PC, or that leaves input held after the phone has dropped (§2 of the spec).

## Out of scope

- Denial of service by sheer volume, and anything that needs a device or browser that is already compromised.
- Social engineering, and physical access to an unlocked device.
- Reports from automated scanners without a demonstrated impact.

## Good faith

Research in good faith is welcome: use your own devices and screens, never pair with someone else's without their
consent, and don't keep or share anyone else's data. We won't pursue anyone who does that.
