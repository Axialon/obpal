# ob.Pal connection security

How ob.Pal keeps the link between a phone and a screen private, authentic and quick, what that rests on, what it
doesn't do yet, and how to run all of it yourself. To report a vulnerability, see [SECURITY.md](../SECURITY.md). The
wire formats are in [PROTOCOL.md](PROTOCOL.md).

This is the state on 27 September 2026. File references point into this repository as it was then.

## 1. The connection path

```
phone (browser, /p/)               room service (Cloudflare Worker + Durable Objects)              screen (a page, or ob.Pal Link)
  │  QR link: https://<service>/p/#1.<secret>.<screen's fingerprint>    (a fragment: never sent to a server)
  │  or a typed code: 10 digits = handle (5) + secret (5)
  │── wss /r/<room> ─────────────────► Room: passes offers, answers, candidates ◄────────── wss /r/<room> ──│
  │── GET /api/ice?room= ─────────────► STUN, and TURN credentials (live rooms only) ◄────── GET /api/ice ───│
  │── POST /api/code {handle} ────────► Codes: handle → room + ticket (typed codes only)                     │
  │                                                                                                          │
  │◄═══════ WebRTC: ICE (host → server reflexive → relay), DTLS 1.2/1.3, SCTP ════════════════════════════►│
  │         ctl (reliable, ordered, JSON)   st (unordered, never retransmitted: motion)                      │
  │         binding: HMAC over both DTLS fingerprints (QR), CPace bound to them (code), or a pairing key     │
                                                                                 Link only: offscreen ──port──► service worker
                                                                                 ──native messaging──► ob.Pal Desktop ──SendInput──► the PC
```

**What the QR code carries.** `https://<service>/p/#1.<b64url(S)>.<b64url(fpH)>`:
- a 16-byte random secret `S` (`packages/core/src/pairing.ts:40`);
- the SHA-256 fingerprint of the screen's DTLS certificate (`pairing.ts:43`).

Both sit in the URL fragment, which browsers never send to a server. The controller keeps the fragment in this tab's
`sessionStorage` and takes it out of the address bar (`src/controller/main.ts:51-60`). Every page sends
`Referrer-Policy: no-referrer`.

The room id is `SHA-256("obpal-room-v1" ‖ S)`, cut to 22 characters (`pairing.ts:60`). The service learns the room,
never `S`.

**The short code** (PROTOCOL §2b) is ten digits, never starting with 0 (`packages/core/src/code.ts:14-18`):
- a 5-digit handle, which the service keeps for at most 10 minutes;
- a 5-digit secret, which never leaves the two devices.

The handle is spent as soon as it's looked up, and the screen allows one attempt per code
(`packages/host/src/remote.ts:770-795`). The two sides then run CPace's construction on X25519 over the DTLS
channel, bound to both DTLS fingerprints (`code.ts:171-267`).

**The direct LAN code** (PROTOCOL §2a) is `#2.<pairing id>.<nonce>.<ufrag>.<pwd>.<candidates>`: the screen's own ICE
credentials and host candidates, good for one attempt. It holds no secret. Only a phone that paired online before has
the pairing key that derives the matching ICE credentials and the binding MAC.

**Signaling and rooms** (`worker/index.ts`). Each room is one Durable Object, with these limits:
- at most one host and eight devices (`worker/index.ts:123-124`);
- messages up to 16 KB (`:140`);
- devices can reach only the host, and the host only the device it names (`:146-149`).

When a socket goes, the others hear `leave{clean}` (`:192-212`): either its page closed it, or the connection was
lost.

Rate limits apply per address (an IPv6 /64 counts as one address):
- 600 socket opens and 300 ICE lookups a minute (`wrangler.jsonc:16-19`, `worker/limits.ts:16`);
- the short code's own per-network limits, with proof of work under pressure (`worker/codes.ts:20-39`).

**ICE servers** (`worker/ice.ts`). STUN always. TURN credentials go only to rooms with a live host, and come from one
of two places:
- Cloudflare's TURN API;
- this service, which mints them from a shared secret for any standard TURN server (`ice.ts:66-107`).

Credentials are good for a day (`ice.ts:35`). The answer includes `expires`, so a long-lived screen fetches fresh
ones before they lapse (`packages/host/src/remote.ts:272-288`).

**The link.** One `RTCPeerConnection` carries two pre-negotiated channels (`packages/core/src/device.ts:269-270`,
`remote.ts:435-436`):
- `ctl` (id 0, reliable and ordered): buttons, typing and settings;
- `st` (id 1, `ordered: false, maxRetransmits: 0`): motion. The newest sample wins, and a stale one is dropped
  rather than queued (`device.ts:649-655`).

**Link and Desktop.** ob.Pal Link's offscreen document holds the screen's side of the link. For the PC target, it
turns input into action frames and typing, and the path to the PC runs like this:
1. A runtime port carries them to the service worker. Only the offscreen document may open that port
   (`extension/src/background.ts:256-261`).
2. Chrome native messaging carries them on to ob.Pal Desktop.
3. The helper serves only the extension ID it was installed for (`desktop/src/win/install.rs:23`,
   `desktop/src/main.rs:96-105`), and gates every frame (PROTOCOL §7).

## 2. Threat model

**Assets:**
- control of the screen and, with Link and Desktop, of the PC's keyboard and mouse;
- what the phone types, which can be a password typed into the PC;
- the pairing secrets: the QR secret, the code's secret, pairing keys and the DTLS private keys;
- people's network addresses and device names;
- the service's availability.

| Who | Could try | What stops them | What's left |
|---|---|---|---|
| **Someone on the network** (Wi-Fi, ISP), passive or active | Read or change the link; pass as either end | DTLS on every packet. The phone pins the screen's fingerprint from the QR, parsed strictly: one media section, one fingerprint (`pairing.ts:65-79`). The screen admits a phone only after an HMAC over both fingerprints and the room (`remote.ts:570-576`), or CPace bound to both (code) | Traffic analysis (timing, sizes); blocking the link |
| **The room service or a TURN relay** (Cloudflare, or whoever self-hosts) | Sit between two DTLS sessions (a man in the middle); read the traffic; inject input | It never sees `S`, the code's secret or a pairing key, and a man in the middle needs one of them. The phone takes one answer per offer, and a later one (an ICE restart) only with the fingerprint already bound (`device.ts:230-244`). With a typed code, nothing the screen says counts until it proves the code (`device.ts:438-440`). A relay sees only ciphertext | Addresses and timing; denial of service; with a typed code, one guess in 100,000 per code; trust in the site's origin (last row) |
| **Someone who can see the screen** | Scan the QR or type the code | Nothing: seeing the screen is what pairing means. One device controls at a time unless the screen shares the scene, and the phone that loses control is told (`remote.ts:588-598`). The screen can remove a device (`disconnect`), and a new invite locks out anyone not yet connected (`remote.ts:294-307`) | A photo of Link's popup QR works for as long as Link keeps that invite (Link item L2) |
| **A remote guesser** | Find a live code blind; flood the service; abuse TURN | One CPace attempt per code (1 in 100,000). Per-network limits and proof of work on lookups (`worker/codes.ts:20-39`). Rate limits on sockets and ICE lookups. TURN only for live rooms | A minted TURN credential relays for a day, whoever holds it; volume attacks meet Cloudflare's own protection |
| **A malicious screen** (a page that embeds ob.Pal) | Attack the phone through labels, images or toasts | The controller runs on ob.Pal's origin, never the screen's. Text from the screen is set as text or escaped, images must be `https:`, and colours are checked (`src/controller/main.ts:39-40`). The controller's policy allows scripts from its own origin only (`vite.config.ts:23-68`) | It decides what its own page does with your input, as any app does |
| **A web page in a tab Link controls** | Make the PC type; change what the helper may do | Pages reach Link only through its content scripts, which can ask only about their own tab. The `pc-*` requests that change the helper come only from Link's own pages (`extension/src/shared/messages.ts:300-324`). The helper refuses anything but its extension | None known |
| **Software on the PC** | Drive the helper | Chrome starts the helper only for the allowed extension, over stdio, and the helper checks the origin it's given (`desktop/src/main.rs:96-105`) | Local code can already inject input on its own |
| **A compromised origin or supply chain** | Serve script that reads the QR fragment or pairing keys | HSTS. A strict policy: scripts from this origin only, no inline script, no eval. No third-party scripts or fonts. The source is public. Pairing keys stay on the device | Trust in the site's origin is WebRTC's own model (RFC 8826 §4). Pairing keys are extractable bytes in IndexedDB until Link item L5 |

**Who can make the PC type or move its mouse.** All of these must hold at once:
- The device is bound to Link: it proved the QR's secret, a typed code or a remembered pairing.
- The PC target is chosen, in Link's popup or from the phone's tray. The phone's tray needs no approval on the PC
  today: that's item L1.
- Link has its optional native messaging permission, which Chrome asks the person at the PC for.
- ob.Pal Desktop is installed for this extension.
- A program is allowed in Link's options, or Whole PC is turned on there. Only Link's own pages change these.
- The helper is enabled, which Link does only while the target is PC (`extension/src/native.ts:126-129`).
- It isn't paused, and the panic key (Ctrl+Alt+Backspace, `desktop/src/win/hotkey.rs:10`) hasn't been pressed.
- The input fits that program's scope (keyboard, mouse).

The helper also caps and releases input (`desktop/src/session.rs:32-36`, gate at `:364-389`):
- at most 250 frames and 40 typing requests a second;
- everything is let go 500 ms after the last frame;
- with programs (not Whole PC), an elevated window is refused;
- typing is refused while a modifier is held (`:319`).

## 3. Standards

Status values:
- **meets**: ob.Pal meets it.
- **meets (browser)**: the browser provides it, and ob.Pal doesn't weaken it.
- **partial**: some of it is met.
- **gap**: not met yet.
- **n.a.**: doesn't apply.

### WebRTC security (RFC 8826, RFC 8827)
| Requirement | Status | Where |
|---|---|---|
| Data only over DTLS-protected transports (8827 §6.5) | meets (browser) | data channels only: `device.ts:269-270`, `remote.ts:435-436` |
| The peer's DTLS fingerprint checked against an authenticated channel | meets | QR pin at `device.ts:236-244`; strict parser at `pairing.ts:65-79`; the screen's MAC check at `remote.ts:570-576`; CPace at `code.ts:240-267`; a remembered pairing's fingerprints at `pairing.ts:270-286` |
| Consent freshness (RFC 7675) | meets (browser) | |
| Local addresses (RFC 8828): mDNS names instead of local IP addresses unless the page has camera or microphone permission | meets (browser) | The phone asks for neither. A screen that uses its camera (the glow) shows its local addresses to the paired phone and the room service |
| DTLS with ECDHE and an AEAD cipher (8827 §6.5) | meets (browser) | measured: DTLS 1.3 with TLS_AES_128_GCM_SHA256 on every run (Chromium) |
| Identity providers (8827 §7) | n.a. | replaced by the QR code, the typed code or a pairing |
| The calling site's origin is trusted (8826 §4) | meets | HTTPS only, with HSTS and a policy on every page (below) |

### ICE (RFC 8445, RFC 8838) and mDNS candidates
| Requirement | Status | Where |
|---|---|---|
| Full ICE, with direct paths before relays (candidate priorities) | meets (browser) | no `iceTransportPolicy` is ever set |
| ICE restart (8445 §9) when a path goes | meets | phone at `device.ts:531-600`; screen at `remote.ts:476-482` and `:521-557`; `welcome{restart}` at `remote.ts:617`. Hosts that don't take restarts get a new connection (PROTOCOL §1) |
| Trickle ICE both ways (8838) | meets | `device.ts:295-299`, `remote.ts:501` |
| End-of-candidates indication (8838 §13) | gap (low) | a null candidate isn't sent, so ICE concludes by its own timers |
| Gathering starts early: the offer is built while the socket connects | meets | `device.ts:170-180`, `:281-321` |
| An unsent offer is built again when TURN servers arrive, and an attempt that makes no progress starts again | meets | `device.ts:321-362` |
| mDNS host candidates (draft-ietf-mmusic-mdns-ice-candidates) | meets (browser) | the LAN code carries them (`pairing.ts:159-200`) |

### DTLS and SCTP data channels (RFC 6347, RFC 9147, RFC 8261, RFC 8831, RFC 8832, RFC 8841)
| Requirement | Status | Where |
|---|---|---|
| DTLS 1.2 (6347) | meets (browser) | |
| DTLS 1.3 (9147) | meets (browser) | used wherever both ends have it |
| Certificates: ECDSA P-256; persistent ones last at most a year and are renewed a week early | meets | `packages/core/src/store.ts:10`, `:66-76`; `remote.ts:247` |
| SCTP over DTLS (8261) | meets (browser) | |
| Reliability chosen per channel (8831): motion unordered and never retransmitted, control reliable | meets | `device.ts:269-270` |
| The newest motion wins, and nothing stale is queued | meets | `device.ts:649-655` |
| DCEP (8832) | n.a. | channels are negotiated out of band, with ids 0 and 1 (PROTOCOL §1) |
| SDP for SCTP (8841): `sctp-port`, `max-message-size` | meets | written by the browser, and by the LAN code's rebuilt descriptions (`pairing.ts:270-275`) |

### TURN and STUN (RFC 8656, RFC 8489)
| Requirement | Status | Where |
|---|---|---|
| TURN over UDP, TCP and TLS on 443 | meets | Cloudflare TURN (UDP 3478 and 443, TCP 3478 and 80, TLS 5349 and 443), or `TURN_URLS`; port 53 is dropped (`worker/ice.ts:41-58`) |
| Short-lived credentials, made on the server | meets | Cloudflare's API or the TURN REST API's shared secret (`ice.ts:66-107`); a day (`:35`); `expires` in the answer (`:137`) |
| Relayed links outlive their credentials | meets | Screens fetch new credentials 10 minutes before they lapse (`remote.ts:272-288`, `packages/core/src/signal.ts:95-125`). An ICE restart takes fresh ones (`device.ts:592-600`, `remote.ts:547`) |
| Relay abuse (8656 §21) | partial | Credentials go only to live rooms, with per-address limits. A minted credential still relays for a day, whoever holds it |
| TCP allocations (RFC 6062) | n.a. | WebRTC relays UDP |
| STUN (8489) | meets (browser) | `STUN_URLS` replaces the default server |
| TURN over TLS: the server's certificate is checked | meets (browser) | |

### The pairing's cryptography
| Requirement | Status | Where |
|---|---|---|
| CPace (draft-irtf-cfrg-cpace): generator from the hashed secret and context, X25519, identity refused, ISK over the transcript, key confirmation | partial | The construction is there (`code.ts:171-267`), with both DTLS fingerprints in the transcript. But it uses its own encoding (label `obpal code v1`, length-prefixed fields, an HKDF-SHA256 ISK), not the draft's (DSI `CPace255`, zero padding, a SHA-512 ISK), so the draft's test vectors don't apply |
| A screen that skips the exchange is never listened to | meets | `device.ts:438-440` |
| X25519 (RFC 7748) | meets | WebCrypto where the platform has it: native and constant time (`code.ts:200-233`). The BigInt ladder elsewhere (`code.ts:133-160`), which isn't constant time. RFC 7748's vector and a cross-check against WebCrypto are in `tests/code.test.ts:47-67` |
| An all-zero shared secret is refused (7748 §6.1) | meets | `code.ts:220-233`, `:248`, `:254` |
| Hash to curve (RFC 9380) | partial | `map_to_curve_elligator2` for curve25519 (`code.ts:162-169`) matches RFC 9380's vectors (`tests/code.test.ts:69-85`). The field element comes from CPace-style hashing, not `hash_to_field`. It runs in BigInt, so not in constant time. What timing could leak is about one code's secret, which is used once and lapses in 10 minutes |
| HKDF (RFC 5869) and HMAC (RFC 2104) | meets | WebCrypto (`pairing.ts:106-128`, `code.ts:258-263`); MACs compared in constant time (`pairing.ts:25-30`) |
| Randomness | meets | `crypto.getRandomValues` (`pairing.ts:40-41`, `code.ts:55`, `:217`) |
| Pairing keys at rest | partial | stored as bytes in the origin's IndexedDB (`store.ts:19`); non-extractable keys are Link item L5 |

### The web platform
| Requirement | Status | Where |
|---|---|---|
| WebSocket over TLS | meets | `wss:` from an `https:` service only; `http:` is allowed only on localhost (`remote.ts:131-141`, `signal.ts:7-9`) |
| HSTS (RFC 6797) | meets | `public/_headers:10`: a year, on this host only |
| CSP Level 3 | meets | Each page's own policy comes first in its head (`vite.config.ts:23-68`): scripts and fonts from this origin only; connections to this service only (the arm sim may also reach the robot socket the person names, and the viewer the files the person opens); no inline script, no eval, no plugins, no frames. `frame-ancestors`, `object-src` and `base-uri` are in the headers (`public/_headers:13`). Each of the site's e2e suites fails on any violation (`scripts/csp-watch.mjs`), and `scripts/e2e-pages.mjs` checks every page. e2e:extension, which tests Link under Link's own policy, doesn't watch for violations |
| Trusted Types | partial | The pairing chip, its QR code and `<obpal-remote>` build no markup, and run under an enforcing policy in e2e:embed (`scripts/e2e-embed.mjs:238`). The site's own pages still fill their templates with `innerHTML`, so they don't set `require-trusted-types-for` |
| Permissions-Policy | meets | `public/_headers:11` |
| security.txt (RFC 9116) | meets | `public/.well-known/security.txt` |
| `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options`, COOP `same-origin` | meets | `public/_headers:8-14` |
| CORS | meets | `*` only on credential-free public resources: `/api/ice`, `/api/health` and the embed script (`worker/index.ts:18`, `public/_headers:21-24`). `/api/code` is same-origin only (`worker/codes.ts:115-127`) |
| No third-party scripts, styles or fonts, so no need for SRI | meets | Fonts are served from this origin (`scripts/fonts.mjs`), and e2e:pages fails on any request elsewhere (`scripts/e2e-pages.mjs:46`, `:64`). The one outside resource is an image: the controller shows thumbnails a screen's layout names, from `https:` only |

### OWASP ASVS 4.0.3, level 2 (the requirements that apply)
| Requirement | Status | Where |
|---|---|---|
| 1.1.2 threat model | meets | this document |
| 2.2.1, 11.1.4 anti-automation | meets | rate limits (`worker/limits.ts`); code limits and proof of work (`worker/codes.ts:20-39`) |
| 2.7.2 an out-of-band code expires within 10 minutes | meets | `code.ts:18`, `worker/codes.ts:12` |
| 2.7.3 used once | meets | spent at lookup, with one CPace attempt (`remote.ts:770-795`) |
| 2.7.6 at least 20 bits of entropy | partial | The code's secret part is 5 digits (16.6 bits). CPace allows one online guess per code, and lookups are limited per network, with proof of work under pressure |
| 4.1.1, 4.1.3 access control enforced where it can't be bypassed | meets | The screen ignores unbound devices (`remote.ts:563`, `:629`). Link's PC settings change only from its own pages. The helper has its own gates (§2) |
| 4.2.2 CSRF | meets | no cookies or credentials anywhere; `/api/code` takes same-origin JSON only |
| 5.1.3, 5.1.4 input validated against allow lists | meets | control messages (`remote.ts:559`); rooms and sizes (`worker/index.ts:17`, `:140`); native frames checked twice: in Link (`extension/src/shared/native.ts:105`), then against the helper's key table and limits (`desktop/src/protocol.rs:194`) |
| 5.3.3 output encoding | meets | the controller escapes or sets as text everything a screen sends (`src/controller/main.ts:39-40`) |
| 6.2.2 proven cryptography | partial | WebCrypto for SHA-2, HKDF, HMAC and X25519. The Elligator 2 map, and X25519 on older browsers, run in script |
| 6.2.5 no insecure algorithms | meets | HMAC-SHA1 appears only where the TURN REST API requires it |
| 6.3.1 CSPRNG | meets | `crypto.getRandomValues` throughout |
| 6.4.1 secrets kept out of the code | meets | Worker secrets (`TURN_KEY_*`, `TURN_SECRET`, `STRIPE_SECRET_KEY`); the extension's private key isn't in the repository; `scripts/open-source.mjs` scans the public snapshot for keys and tokens before it's published |
| 7.1.1, 7.1.2 no secrets or personal data in logs | meets | invocation logs are off (`wrangler.jsonc:10-12`); the service logs only two things of its own, neither with an address, a code, a secret or a room (`worker/ice.ts:129`, `worker/limits.ts:18`) |
| 7.2 security events logged | partial | by design, nothing per request; the helper keeps a small local lifecycle log, never input (`desktop/src/main.rs:203`) |
| 8.2.1 no caching of sensitive responses | meets | the API answers carry `no-store` (`worker/index.ts:18-20`) |
| 8.3.1 no sensitive data in URLs sent to servers | meets | secrets travel in the fragment only |
| 8.3.4 data inventory | meets | §7 and `/privacy/` |
| 9.1.1 TLS for all connections | meets | HTTPS, WSS, DTLS, and TURN over TLS |
| 9.1.2, 9.1.3 strong ciphers, TLS 1.2 and later only | partial | The edge's minimum TLS version is a Cloudflare zone setting (default 1.0), not something the code sets. The owner checks that it's 1.2 or above |
| 10.3.2 no code from untrusted sources | meets | the page policies; Link's own policy (`extension/vite.config.ts:63-64`) |
| 13.2.1, 13.2.5 HTTP methods and content types | meets | `/api/code` takes POST only, with a JSON content type (`worker/codes.ts:119-127`) |
| 14.4.1–14.4.7 security headers | meets | `public/_headers` |
| 14.5.3 CORS | meets | see the web platform table |

### Privacy (GDPR)
| Requirement | Status | Where |
|---|---|---|
| Data minimisation (Art. 5(1)(c)) | meets | no accounts, no analytics, no request logs of our own |
| Retention | meets | short codes last 10 minutes; rate-limit counters stay in memory for minutes; Cloudflare's edge logs follow its own policy |
| Addresses in the limits | partial | Limits key on an address or its network, in memory. But a live short code keeps its screen's raw address in storage for up to 10 minutes (`worker/codes.ts:42`), where a keyed hash would do |
| Processors named and accurate (Art. 13) | meets | `/privacy/` names Cloudflare (hosting, signaling, relays, email) and Stripe (payments), and no longer a font service |
| Privacy by default (Art. 25) | meets | fragment secrets, mDNS candidates, pairing records kept on the devices |
| Security of processing (Art. 32) | meets | DTLS end to end; relays and the room service never see content |

### ob.Pal Link and ob.Pal Desktop
| Requirement | Status | Where |
|---|---|---|
| Native messaging only for this extension | meets | `allowed_origins` (`desktop/src/win/install.rs:23`, `:48-54`), checked again at start (`desktop/src/main.rs:96-105`) |
| Every frame gated: enabled, not paused, no panic, an allowed program or Whole PC, scope, rate, watchdog | meets | `desktop/src/session.rs:32-36`, `:364-389` |
| What the helper may do changes only from Link's own pages | meets | `extension/src/shared/messages.ts:315-323` |
| A new phone doesn't get PC control until the person at the PC agrees | gap | L1 below |
| A photo of the QR code can't pair later | gap | L2 below |
| The strict fingerprint parser, ICE restarts and TURN refresh on Link's screen side | partial | In the next Link release (L3). The phone side, served by the site, already closes the man in the middle |
| Self-hosting | meets | rebuild Link with your origin (§6) |

**Totals** (83 requirements):

| Status | Count |
|---|---|
| meets | 66 (11 of them provided by the browser) |
| partial | 11 |
| gap | 3 |
| n.a. | 3 |

Without the rows the browser provides, ob.Pal itself meets 55.

## 4. The shortest, fastest path

- **Direct first.** ICE pairs host candidates (the same network) first, then server-reflexive ones (through NAT, found
  with STUN), then relayed ones (TURN). The browser picks the best pair that works, and ob.Pal never narrows that
  choice.
- **A relay only when needed.** It runs over UDP, TCP, or TLS on 443. The service makes day-long credentials, and
  only for a room with a live screen. Production uses Cloudflare Realtime TURN. To use any standard TURN server
  instead, set `TURN_URLS` and `TURN_SECRET` (§6).
- **Motion never waits.** It goes unordered and is never retransmitted, and the newest sample wins. Buttons and
  typing are reliable and ordered.
- **A fast start:**
  - The phone asks for its ICE servers and builds its offer while its socket connects.
  - An offer built before the servers arrived is built again, as long as it hasn't gone out.
  - A screen that gets an offer before its own first servers waits for them, 1.5 s at most.
  - An attempt that makes no progress starts again.
- **Fast recovery.** The phone restarts ICE on the same connection when any of these happens:
  - its network changes (the browser says it's online again, or the connection type changes);
  - it hears no pong for 3.5 s;
  - its ICE state goes `disconnected` or `failed`.

  DTLS, both channels and the binding stay, so input resumes as soon as ICE finds a path. A lost signaling socket no
  longer drops a working link on either side.

**Measured.** Both ends ran in Chromium on one Windows PC (`scripts/perf-connect.mjs`, `pnpm run perf:connect`), so
network distance is left out and what's measured is the link itself. "Before" is the code before this review, run back
to back with the new code under the same load. The relay runs used production's Cloudflare TURN with relay-only ICE.

| | Before | After |
|---|---|---|
| Direct: phone opens the link until controls work, median (slowest), 9 phones | 151 ms (809) | 123 ms (847) |
| Direct: round trip on the control channel, median | 1.1 ms | 0.7 ms |
| Relay only: phones that connected | 8 of 9 | 9 of 9 |
| Relay only: phone opens the link until controls work, median (slowest) | 363 ms (3481) | 320 ms (877) |
| Relay only: round trip on the control channel, median | 7.6 ms | 8.4 ms |
| The phone's signaling connection cut (no close frame) | input stopped for 9.8 s, then the phone rejoined as a new participant | no gap, same participant |
| The phone's network changes (`online` event) | no ICE restart | a new ICE session in 0.53 s, with no gap in input |
| The screen's side of the link closed outright | back in 9.5 s | back in 3.2 s |

The slowest direct runs were each batch's first, cold start. Across every relay-only batch in the review, the old code
failed to connect 3 times in 21 cold starts, and the new code 0 times in 30. DTLS 1.3 with TLS_AES_128_GCM_SHA256 was
negotiated on every run.

## 5. What the connection badges say

The phone's badge (`src/controller/linkbadge.ts`) and the pairing chip's (`packages/host/src/chip.ts`) claim only
what the connection itself shows. The phone reads its connection's statistics through `linkInfo()`
(`packages/core/src/signal.ts:151`), and the chip reads each device's through `Remote.links()` (`remote.ts:818`),
which uses the same function.
- **Encrypted end to end.** A WebRTC data channel is always DTLS between the two devices. The details add the DTLS
  version and cipher when the browser reports them.
- **Verified by the QR code, the code you typed, or your pairing.** This is how the phone knew this screen:
  - the QR code: its pinned fingerprint, and the phone's proof of the QR's secret;
  - a typed code: the exchange, bound to both fingerprints;
  - a pairing: the keys both ends kept when they first paired.

  The badge shows only on a bound link, and binding takes that proof.
- **Direct or Relayed.** This is the candidate pair ICE chose. The details name a relay's transport (UDP, TCP or
  TLS) when the browser reports it.
- **Round trip.**
  - On the phone: the control channel's ping, from app to app, with ICE's own measurement ("the network's share") in
    the details.
  - On the chip: ICE's measurement, the slowest device's when several are connected.

They don't say a screen is trustworthy, only that it's the one the QR code or code named. A relay can't read the link,
but it still sees both devices' addresses.

## 6. Running it yourself

ob.Pal is open source, and none of its security depends on a secret in the code. The service's secrets are yours, set
as Worker secrets, and every key that matters is made on the devices.

**The room service** (a Cloudflare Worker with Durable Objects, and the site):
1. Run `pnpm install`. In `wrangler.jsonc`, set your own `name` and `routes`. If you don't take donations, remove the
   D1 database, the Stripe vars and `secrets.required`, which belong to donations.
2. Build with your origin, so each page's policy names your sockets:
   `OBPAL_PUBLIC_ORIGIN=https://your.host pnpm run build`.
3. Run `npx wrangler deploy`. The Durable Object migrations (`Room`, `Codes`) are in `wrangler.jsonc`.
   - The `ratelimits` bindings are optional: without them, the service runs unlimited and says so once in its log.
   - Their `namespace_id`s are yours to choose.
4. Point your screens at it. Screens built with `@obpal/host` take `service: 'https://your.host'` (`RemoteOptions`).
   Your deployment serves the phone controller, from the same origin as its room service.

**A relay.** Pick one of these:

- *Cloudflare Realtime TURN.* Make a TURN key (Realtime → TURN in the dashboard), then set both secrets:
  `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN`.
- *coturn.* The service mints credentials from the shared secret you set here:
  ```
  listening-port=3478
  tls-listening-port=5349
  realm=turn.example.org
  use-auth-secret
  static-auth-secret=<the same value as TURN_SECRET>
  cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
  pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
  fingerprint
  no-cli
  no-tlsv1
  no-tlsv1_1
  no-multicast-peers
  # external-ip=<public address>        (behind NAT, as on most cloud machines)
  denied-peer-ip=0.0.0.0-0.255.255.255
  denied-peer-ip=10.0.0.0-10.255.255.255
  denied-peer-ip=100.64.0.0-100.127.255.255
  denied-peer-ip=127.0.0.0-127.255.255.255
  denied-peer-ip=169.254.0.0-169.254.255.255
  denied-peer-ip=172.16.0.0-172.31.255.255
  denied-peer-ip=192.168.0.0-192.168.255.255
  denied-peer-ip=::1
  denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255
  denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
  denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
  ```
  Also deny any other network the relay can reach that the internet shouldn't. For TLS on 443 (through strict
  firewalls), give the relay an address of its own, set `tls-listening-port=443`, and list the matching
  `turns:` URL.
- *eturnal.* It works the same way (`eturnal.yml`):
  ```yaml
  eturnal:
    secret: "<the same value as TURN_SECRET>"
    realm: turn.example.org
    listen:
      - { ip: "::", port: 3478, transport: udp }
      - { ip: "::", port: 3478, transport: tcp }
      - { ip: "::", port: 5349, transport: tls }
    tls_crt_file: /etc/eturnal/tls/crt.pem
    tls_key_file: /etc/eturnal/tls/key.pem
    blacklist_peers: ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "::1", "fc00::/7", "fe80::/10"]
  ```
  eturnal's option names change between versions, so check its documentation for yours.

For coturn or eturnal, then tell the service about the relay:
1. Run `npx wrangler secret put TURN_SECRET`.
2. In `wrangler.jsonc`'s `vars`, set `TURN_URLS`:
   `"TURN_URLS": "turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp,turns:turn.example.org:5349?transport=tcp"`.
3. Optionally, set `STUN_URLS` (a var) to replace the default STUN server, if you'd rather not use Cloudflare's.

**ob.Pal Link** talks only to the service it was built for: its policy and host permissions name it. To point it at
yours:
1. Rebuild it with your origin (`extension/src/shared/constants.ts`, `extension/vite.config.ts`).
2. Make your own extension key with `node extension/scripts/key.mjs <your key file>`, and put the `key` it prints in
   `extension/vite.config.ts`.
3. Install ob.Pal Desktop for your extension's ID: `obpal-desktop install --origin chrome-extension://<your id>/`.

## 7. What is kept, and where

| What | Where | How long |
|---|---|---|
| The QR code's secret | the phone's tab (`sessionStorage`) | until the tab closes |
| Pairing keys, both devices' DTLS fingerprints, a device's name | each device's IndexedDB, and Link's | until forgotten; certificates renew yearly |
| A short code's handle, its room, the screen's address | the service's Codes object | 10 minutes at most |
| Room membership (socket ids, and the screen's address for its codes) | the room's Durable Object, with its sockets | while the sockets are open |
| Rate-limit counters (by address or network) | the service, in memory | minutes |
| Request logs | none of ours (invocation logs are off); Cloudflare's edge keeps its own, under its policy | |
| What the link carries (input, typing) | nowhere: it goes end to end between the two devices | |
| Relay metadata (addresses, ports, timing) | Cloudflare TURN, under its policy | |
| Allowed programs, the Whole PC setting, a lifecycle log (never input) | ob.Pal Desktop, in `%APPDATA%\obpal` | until removed |

## 8. The next ob.Pal Link release

Each item below is what the next Link release needs to do, with the tests that show it's done.

**L1. Ask on the PC before a new phone gets PC control.**
- *When:* a device binds while the target is PC, or switches the target to PC from its tray, and it hasn't been
  approved on this PC before.
- *What Link does:*
  - It keeps the helper disarmed, and asks in its own UI: a badge and a prompt in the popup, plus a system
    notification if the popup is closed.
  - The prompt reads `"<phone's name> wants to control this PC"`, with **Allow once**, **Always** and **Deny**.
  - Meanwhile, the phone shows "Waiting for approval on the PC".
- *Approvals:*
  - They're keyed by the pairing id, or by the DTLS fingerprint for a device without one.
  - They're kept with Link's remembered phones, and removed when that phone is forgotten.
- *No approval needed:* a page target (Controller, 3D, Keys).
- *Tests:*
  - a new phone can't arm the helper by choosing PC;
  - an approved phone can;
  - forgetting a phone takes its approval away.

**L2. Make a new invite once a phone has paired.**
- *What Link does:* after a device binds through the invite (the QR link or a short code), Link makes a new one
  (`Remote.resetInvite()`). A photo of the popup's QR code, or a replayed link, then can't pair later.
- *Devices already bound* must keep recovering: reloads, network changes and ICE restarts. Pick one of two ways:
  - Keep the old room open for them, and accept a rebind there only from a DTLS fingerprint that bound there before.
  - Hand them the new invite over the link. This adds to the protocol: the phone replaces its stored pairing, as it
    already does with a short code's invite (`device.ts:493-501`).
- *Tests:*
  - the old QR link is refused after a pairing;
  - the paired phone still recovers from a network change and from a reload.

**L3. Take the current `@obpal/host`.** It brings:
- the strict fingerprint parser and the code-exchange gating;
- ICE restarts (`welcome{restart}`);
- TURN credentials refreshed before they lapse (Link's screen side lives as long as the browser);
- handling for `leave{clean}`;
- hosts that wait for their first ICE servers;
- the connection facts (`Remote.links()`), so the popup can show the same badge as the chip.

**L4. Document self-hosting** as "rebuild Link with your origin" (§6).

**L5. Non-extractable pairing keys.**
- Store each pairing key as a non-extractable HKDF `CryptoKey` (usages `deriveBits` and `deriveKey`) in IndexedDB,
  on both the phone and Link. Turn old byte rows into keys as they're read.
- `bindMac` and `lanIceCredentials` accept either form.
- The screen sends the raw key once, in `welcome.pair`, and keeps only the imported key.
- In `extension/scripts/e2e.mjs`, change the check on the phone's record from `p.key?.length === 32` to
  `p.key instanceof CryptoKey && !p.key.extractable`. That check lives in the extension's suite, which is why this
  waits for the Link release.

## 9. Open items

- **End-of-candidates isn't signaled** (RFC 8838 §13). ICE finishes by its own timers. Low impact.
- **Trusted Types on the site's own pages** need their templates rebuilt without `innerHTML`; the chip shows how.
- **Script-side crypto isn't constant time.** The Elligator 2 map runs in script, and so does X25519 on browsers
  whose WebCrypto lacks it.
- **A live short code keeps its screen's raw address** for up to 10 minutes; a keyed hash of the network would do.
- **CPace's encoding is ob.Pal's own.** Moving to the draft's encoding would let its test vectors apply. That's a
  protocol change: a new label and version.
- **The edge's minimum TLS version** is a Cloudflare zone setting. The owner checks that it's 1.2 or above.

## 10. Dependencies

- **No new packages.** Everything uses WebCrypto and WebRTC in the browser, and the Workers runtime on the service.
- **Fonts:** Inter, JetBrains Mono and Plus Jakarta Sans are now served from this origin, under the SIL Open Font
  License 1.1. The licences are in `public/fonts/`, `scripts/fonts.mjs` fetches the fonts, and `pnpm run oss:audit`
  checks that each one is credited and has its licence beside it.
