# ob-pal protocol v1 (draft)

An open protocol for pairing a **control device** (phone, tablet, custom hardware) with a **host** (web page, native bridge, any app) and streaming control state. 3D manipulation is the first profile, but the protocol isn't tied to it: new controls, modes and device types go in the capability and layout layers, without changing the transport.

Status: draft, implemented by `packages/core` and `packages/host`. Keywords follow RFC 2119. The controls built on these packets, their routes and profiles are in [CATALOGUE.md](CATALOGUE.md).

### Optional calibrated sim space

The existing `state{values}` / `value{id,v}` envelopes carry the optional
[control space](CONTROL-SPACE.md) profile. Hosts advertise `control.sim` (catalogue
id) and `control.scope` (`object` or `scene`); a phone can send the latter as a
value to change its own scope. `control.position` is a host-sent changing number
requesting a new neutral. Phones send the existing `recenter` after capturing it.
The Buttons action `app:recentre` is labelled **Set position**.

`control.aim` is JSON of at most 160 characters: `{aim:[x,y],tilt:[x,y],active}`,
with finite normalized coordinates in −1…1. Optional boolean `pointer` identifies
the gamepad's gyro Aim / Point independently of its physical driving stick.
Phones send at most 30 samples/second and a final inactive sample on release.
Hosts expire samples after 300 ms and clear them on mode, scope or claim change.
Aim is absolute relative to the captured orientation, not a binary STATE delta.
Unknown optional values are ignored; all binary packet layouts stay unchanged.

Music `hit` events may add both `aim:[x,y]` and `scope`. `at` is the timestamp of
the acceleration peak, translated by the existing music clock exchange. The host
validates scope, claim and target availability, then resolves this event snapshot
before scheduling sound. Legacy events without these fields keep their claimed
instrument behavior; see [MUSIC.md](MUSIC.md) for timing and voice ownership.

## 1. Roles and transport

- **Host:** creates a pairing and receives input.
- **Device:** joins a pairing and sends input.
- **Room service:** a blind signaling mailbox over WebSocket at `wss://<service>/r/<roomId>?role=host|device`. It forwards `{t:"sig", d}` from the device to the host, and from the host to the device named in `to`. It announces `{t:"peer", ev:"join"|"leave", id, role, clean?}` and greets with `{t:"welcome", id, role, host}`. On `leave`, `clean: true` means the page closed its socket (it left or reloaded) and `clean: false` that the socket was lost; a service that doesn't say counts as clean. It answers the text frame `ping` with `pong`. It also keeps the short codes' handles (§2b): `{t:"code"}` on the host's socket, and `POST /api/code` for devices.
- **Link:** one RTCPeerConnection with two pre-negotiated DataChannels:
  - `ctl`: id 0, reliable, ordered, UTF-8 JSON.
  - `st`: id 1, `ordered:false, maxRetransmits:0`, binary STATE.
- The device creates the offer. ICE servers come from `GET /api/ice?room=<roomId>`: `{iceServers, turn, expires?}`, STUN plus short-lived TURN credentials when the room has a live host, and when those lapse (`expires`, epoch ms). The device SHOULD request them while its socket connects and build the offer meanwhile (gathering host candidates), so the offer and its candidates leave the moment the host is known to be present; it MUST NOT wait more than a few hundred milliseconds for TURN credentials, since on a LAN the host candidates carry the connection. An offer built before they came and not yet sent SHOULD be built again with them, and an attempt that makes no progress SHOULD start again. An offer counts as sent only once a socket took it; a device whose socket went before then sends it on its next `welcome`.
- A host SHOULD fetch the ICE servers again before `expires`: a relay drops an allocation whose credentials have lapsed.
- A host keeps a bound device whose socket was lost (`leave` with `clean: false`) while its peer connection lives, since the link doesn't run through the room service; it drops it when that connection fails too. A device likewise keeps its link while the host's socket comes back or is lost.
- **ICE restart** (RFC 8445 §9). A host whose `welcome` says `restart: true` takes a later offer on the same connection. A device whose path goes (its network changed, no `pong` for 3.5 s, or ICE says `disconnected` or `failed`) SHOULD restart ICE rather than build a new connection: it sends `{t:"sig", d:{offer, restart: true}}` (over its socket as it is now, a new one if the old was lost), and the host applies it to the connection with the same DTLS fingerprint and the same SDP session (the `o=` line's session id), with fresh ICE servers, and answers. The DTLS session, both channels and the binding stay, so input goes on the moment ICE has a path. A host with no such connection answers `{gone: true}`, and a restart that hasn't brought a path back in 6 s gives way to a new connection. Hosts that don't say `restart` (ob.Pal Link 1.5 and earlier) get a new connection instead, as before.
- Reachability: a socket that has not opened within **1.5 s** counts as unreachable. Both sides then switch to the direct path of §2a when they can, and keep retrying the room in the background.

## 2. Pairing and authentication

1. The host generates a 16-byte secret `S` and a DTLS certificate, and takes the certificate's SHA-256 fingerprint `fpH`.
2. The pairing URL is `https://<service>/p/#1.<b64url(S)>.<b64url(fpH)>`. Because it is a fragment, the secret never reaches a server.
3. `roomId = b64url(SHA-256("obpal-room-v1" ‖ S))[0..22]`.
4. The device MUST abort if the answer's `a=fingerprint:sha-256` ≠ `fpH`.
5. When `ctl` opens, the device sends `hello` with `mac = b64url(HMAC-SHA256(K, fpD ‖ fpH ‖ roomId))`, where `K = HKDF-SHA256(S, salt=roomId, info="obpal bind v1")` and `fpD` is the device's own DTLS fingerprint.
6. The host MUST ignore all input from a peer until its `mac` verifies. Then it sends `welcome`.
7. One device is active per host. A newly bound device takes over, and the previous one receives `lock{reason:"taken-over"}`.

This defeats a malicious room service, TURN operator or network attacker. None of them can see `S` or substitute either DTLS identity.

**One invite, one device (hosts MAY).** A host MAY move its invite on once a device has bound through it (by the QR code, its link, or a short code, §2b), so that a photo of the code or a replayed link binds nothing later. ob.Pal Link does (`RemoteOptions.rotateInvite` in `@obpal/host`):
- It makes a new `S`, and so a new room, link, QR code and short code, and drops the old room's short code.
- It keeps the old room for the devices that bound in it, whose pages reload with its code and whose ICE restarts (§1) come through it. There it takes offers only from the DTLS fingerprints that bound there, and answers any other offer `{t:"sig", d:{spent: true}}`.
- A device told `spent` stops, leaves the room, and asks for the code the screen shows now; it MUST NOT retry by itself.
- The kept room goes once no device may use it any more: each bound again through a newer invite, or was forgotten.

## 2a. Remembered pairings and the direct LAN code (no room service)

After one online pairing, a host and a device can find each other again on the local network with **no server at all**. Everything the device needs comes from a second kind of code on the host's screen; the host learns the device's address from the device's own ICE connectivity checks.

**Persistent identities.** A host or device that supports this keeps one DTLS certificate across sessions (browsers: `RTCPeerConnection.generateCertificate` stored in IndexedDB, renewed a week before it expires), so its fingerprint can be pinned later. Certificates expire after at most a year; a new certificate simply needs a new online pairing.

**Pairing grant.** When a device binds online (§2 step 6), a remembering host mints a 16-byte pairing id `P` (kept for that device's fingerprint across re-pairings) and a fresh 32-byte pairing key `K` and sends both in `welcome{pair:{id: b64url(P), key: b64url(K)}}`. They travel only inside the DTLS-protected channel, between two authenticated endpoints; someone who saw the QR code does not have `K`. The host stores `{P, K, fpD, name}`, the device stores `{P, K, fpH, name}`. Every online bind rotates `K`. Either side MAY forget a pairing at any time.

Both sides SHOULD keep `K` where script can use it but never read it back: `@obpal/core` imports it as a non-extractable WebCrypto HKDF key (usages `deriveBits` for the ICE credentials, `deriveKey` for the binding) and stores that key object in IndexedDB. The host sends the bytes once, in the grant, and keeps only the key; the device imports what it receives. Pairings stored as bytes by earlier versions become keys as they're read.

**The direct code.** When the host wants to be reachable without the room service (it cannot reach the service, or the person asks for it), it takes one remembered pairing and prepares a peer connection: its persistent certificate, no ICE servers, both channels, a local offer, host candidates gathered. It then publishes

`https://<service>/p/#2.<b64url(P)>.<b64url(N)>.<ufrag>.<pwd>.<cand>[,<cand>…]`

where `N` is a fresh 16-byte nonce, `ufrag`/`pwd` are the offer's real ICE credentials (ice-chars, so they never contain `.`), and each `cand` is a UDP host candidate: `m<b64url(uuid)>~<port>` for an mDNS name `<uuid>.local` (what browsers advertise), else `a<address>~<port>` for an IP literal or name. At most 4 candidates. The host sets a synthetic remote answer at once (below), so the connection is already waiting for checks when the code is scanned. The `/p/` page itself MUST be available offline on the device (it is served by a service worker after one visit), because the code is a URL the camera app opens.

**Derived ICE credentials.** Both sides compute the device's ICE credentials without exchanging them: `HKDF-SHA256(K, salt = N, info = "obpal lan ice v1")` → 24 bytes → standard base64 (the ice-char alphabet) → `ufragD` = characters 0–7, `pwdD` = characters 8–31.

**Descriptions.** Neither SDP is ever transmitted; each side rebuilds the other's:
- The device rebuilds the host's offer: one `m=application 9 UDP/DTLS/SCTP webrtc-datachannel` section, `a=ice-ufrag`/`a=ice-pwd` from the code, `a=fingerprint:sha-256 fpH` from its stored pairing, `a=setup:actpass`, `a=mid:0`, `a=sctp-port:5000`, and the code's candidates as `a=candidate` lines. It sets that as the remote description, creates an answer, **replaces the answer's `a=ice-ufrag`/`a=ice-pwd` with `ufragD`/`pwdD`** and sets it as its local description.
- The host rebuilds the device's answer: the same section with `ufragD`/`pwdD`, `a=fingerprint:sha-256 fpD` from its stored pairing, `a=setup:active`, and no candidates.

ICE then runs as usual: the device (controlled) sends checks to the host's candidates; the host (controlling) validates them with its own password, creates a **peer-reflexive** candidate for the device's address, answers, and completes its own checks with `pwdD`. DTLS pins both remembered fingerprints (a peer with any other certificate fails the handshake, whatever it knows). The device is the DTLS client.

**Binding.** When `ctl` opens the device sends `hello{…, pair: b64url(P), mac}` with `mac` computed as in §2 step 5 but keyed by `K` and with the context string `"lan:" ‖ b64url(N)` in place of `roomId` (as the HKDF salt and as the last MAC input). The host MUST reject a `hello` whose `pair` is not the pairing its code was made for, or whose `mac` does not verify.

**Freshness and single use.** A code is bound to one nonce and one prepared connection. After any bind, and after a prepared connection fails or closes, the host discards it and prepares a new code with a new nonce; an old code cannot connect to anything. The device MUST NOT retry a code by itself.

**What holds.** Only a device that completed an online pairing has `K`, so nobody can use this path without one (a phone that never paired is shown the online path). An observer of the direct code learns the host's ICE credentials and candidates, nothing more: it cannot derive `ufragD`/`pwdD`, cannot pass DTLS pinning, and cannot produce `mac`. Forgetting a pairing on either side ends the path for good.

**Browser notes.** The device side modifies its own answer's ICE credentials before `setLocalDescription` ("SDP munging"). Chromium accepts this today (verified with Chromium 152) but Google has announced its removal (field trials `WebRTC-NoSdpMangleUfrag` / `WebRTC-NoSdpMangleReject`, rolled out through Finch, dates unset). A device whose browser rejects the modification with `InvalidModificationError` MUST report that the direct path is unavailable and fall back to the online path; nothing else is affected, and the host side never modifies SDP. WebKit (iOS Safari) has no such restriction. A native host implementation is the durable answer: as an **ICE-lite** endpoint it can accept the device's *unmodified* credentials by reading them from the STUN `USERNAME` of the device's first check (the approach of libp2p WebRTC-Direct v2), which no browser host can do. Candidates on the code are usually mDNS names, so the device's network must pass multicast DNS; where it doesn't, only the online path (STUN/TURN) works.

## 2b. The short code (typed pairing)

For a device that can't scan the QR code (a TV, a headset, a phone across the room, an installed iOS web app) the host shows a short code beside it, to type on the device's start page (`https://<service>/p`).

**The code.** Ten decimal digits: a 5-digit **handle** (10000–99999) and a 5-digit **secret**. The host picks the secret (uniformly at random) and never sends it anywhere; the room service keeps the handle. Every code has the one length and starts with 1 to 9, so no code is the start of another: a device takes the tenth digit as the end of a code, never a pause. (A leading 0 is kept for a longer code, should one ever be needed.) Hosts show it as 3, 3 and 4 digits (`482 193 7056`). Devices MUST drop spaces, dashes and dots from what is typed or pasted and SHOULD read O as 0 and I or l as 1. A code is good for one room, for at most 10 minutes, and for one attempt.

**Host and service** (on the host's room socket):
- `{t:"code", op:"claim", work?}` asks for a handle. The answer is `{t:"code", code, exp}` (the handle, and when it lapses, epoch ms); `{t:"code", error:"busy"|"slow-down", retry}` (seconds to wait); or `{t:"code", error:"work", challenge, bits}`: ask again with a proof of work (below) in `work`. A room has at most one handle: a new claim replaces the last, and a refused claim leaves the last in place. A host asks again shortly before `exp` while it still shows a code.
- A host that gets no answer within 15 s asks again later: 15 s, then doubling to 5 minutes (a service that doesn't know `{t:"code"}` never answers, and hosts then show the QR code alone). A host that is refused takes its code off the screen, sends `drop`, and asks again after `retry` or its own backoff, whichever is longer.
- `{t:"code", op:"drop"}`: nothing shows the code any more. The handle also goes when the host's socket closes.
- `{t:"code", ev:"used", code, ticket, next?}`: a device looked the handle up and got `ticket`. `next` (`{code, exp}`) is the handle that replaces it, or `error` (and `retry`, or `challenge` and `bits`) stands in its place. The host adopts `next` only when `code` is the handle it shows: a notice about an older handle says nothing about what's on screen now. A handle taken off the screen still counts for its one attempt for 60 s.
- The service limits claims per host socket (10, one back every 6 s) before they reach it, and answers `busy` when it can't answer at all.

**Device and service:** `POST /api/code` with `Content-Type: application/json` and `{"code": "<handle>", "work"?: {c, x}}`. Only the device's start page on the service's own origin calls it: the service refuses any other content type (a form or another site's script can't send JSON here without CORS) and, when a browser says, any `Sec-Fetch-Site` but `same-origin` or an `Origin` other than its own. A malformed handle is answered at once as no code. Answers:
- `200 {room, ticket}`: the handle is spent as it is found;
- `404 {error:"no-code"}`, the same for a handle that is unknown, expired, spent or not a handle at all;
- `429 {error:"slow-down", retry}` with `Retry-After`;
- `429 {error:"work", challenge, bits}`: ask again with a proof of work in `work`;
- `503 {error:"busy", retry}`: the service couldn't answer.

**Limits** (token buckets; "10, one back a minute" means at most 10 at once and one more each minute). Each address counts in its networks: the address (an IPv4 address, or an IPv6 /64), an IPv6 /56, and a wide network (an IPv6 /48 or an IPv4 /24).
- Lookups that find nothing: 10 per address (one back a minute), 15 per /56 (one back every 30 s), 20 per wide network (one back every 30 s).
- Codes spent: 6 per address (one back every 100 s), 20 per wide network (one back every 30 s).
- While any of these is used up, every lookup from that address answers `slow-down`, live handles included, so no answer tells a live handle from a dead one.
- Everyone together: a budget of 120 lookups that find nothing, 10 back a minute, bigger than any one network's, so reaching it takes many. Past it pairing doesn't stop: every lookup, from anyone, brings a proof of work (the answer is `work` before the handle is looked at, so again it says nothing about the handle).
- New codes (claims and replacements): 20 per room (one back every 30 s), 60 per address (one back every 10 s) and 200 per wide network (one back every 2 s). Every attempt past the rate check spends a token, whatever comes of it.
- Live codes: 32 per address, 64 per /56 and 128 per wide network (`busy` beyond). Overall, past 18,000 a new code brings a proof of work; at 60,000 there are none to give (`busy`). The service keeps the live counts as codes come and go, so no request walks them all.

**Proof of work** (Hashcash-style, open: no third party). A challenge is `<exp>.<bits>.<nonce>.<tag>`: the time it lapses (base 36 seconds, 2 minutes after it is given), the bits asked, 12 random bytes and an HMAC-SHA256 tag (16 bytes) under a key only the service holds. A solution is a base-36 counter `x` such that `SHA-256("<challenge>:<x>")` starts with `bits` zero bits. The service takes each challenge once, unexpired and with its own tag. It asks 16 bits (about 65,000 tries: a fraction of a second on a phone), one more for each doubling of the lookups made past the budget lately (decaying by half every 30 s), at most 22; for new codes, 16 plus one for each 5,000 live codes past 18,000.

**Joining.** The device joins the returned room and offers as in §1. With no QR code it has no fingerprint to pin, so it records the one in the host's answer, `fpH` (§2 and §2b both read fingerprints strictly: see below). When `ctl` opens, a PAKE on the secret stands in for §2 step 5:
1. Device → host: `hello{proto, caps, name, code, ticket, pake}`: the handle, the lookup's ticket, and `pake = b64url(Y_D)`. No `mac`.
2. The host takes it only for a handle the service reported used, with the same ticket, within 60 s, and only once: the attempt is the code's one attempt. It answers `pake{y: b64url(Y_H), mac: b64url(c_H)}`.
3. The device checks `c_H`, then sends `pake{mac: b64url(c_D)}`. Until `c_H` checks, the device MUST ignore every host message but `pake` and `lock`: no `welcome`, `layout`, `state` or invite from a host that skipped the exchange, and it sends no input. If `c_H` is wrong, the code was wrong (or someone is in the middle): the device says so and stops.
4. The host checks `c_D`, then admits the device as in §2 step 6, and its `welcome` carries `invite`: the QR link's pairing code (`1.<b64url(S)>.<b64url(fpH)>`). From then on the device reconnects and reloads with it like a device that scanned. It MUST check that the invite's fingerprint is `fpH` and that its room id is the room it joined.

A failed exchange, or one not finished within 20 s, ends with `lock{reason:"rejected"}`; the code is spent either way. A new connection (a reconnect before the invite arrived) proves the code again.

**Reading fingerprints.** The fingerprint a side binds (here, and pins in §2) is the one DTLS checks, read strictly from the description: it MUST have exactly one media section and exactly one line starting `a=fingerprint:` (at session level or in that section), a well-formed sha-256 value; anything else, such as a second fingerprint anywhere or one hidden in another line's text, is refused. A device takes an answer only while an offer of its own waits (its first, or a later one on the same connection, such as an ICE restart's), one answer per offer, the first, and binds the answer's fingerprint only once that answer has been applied. A later answer on the same connection MUST carry exactly the fingerprint already bound (the QR code's pin, or the first answer's); any other ends the connection with `host-mismatch`. A host answers no offer whose fingerprint can't be read.

**The exchange** (CPace's construction on X25519):
- `lv(x, …)`: each field prefixed with its length in one byte, then concatenated.
- Generator: `u` = the first 32 bytes of `SHA-512(lv("obpal code v1", secret, handle, roomId))`, top bit cleared, read little-endian; `g = Elligator2(u)`, RFC 9380's `map_to_curve_elligator2` on curve25519 (Z = 2), u-coordinate only.
- Each side picks 32 random bytes `y` and sends `Y = X25519(y, g)` (RFC 7748). `K = X25519(y, Y_other)`; a side MUST abort if `Y_other` or `K` is all zeros.
- `ISK = HKDF-SHA256(ikm = K, salt = "obpal code v1", info = lv(Y_D, Y_H, fpD, fpH, roomId, handle))`, 32 bytes.
- `c_H = HMAC-SHA256(ISK, "obpal code v1 host")`, `c_D = HMAC-SHA256(ISK, "obpal code v1 device")`.

**What holds.**
- The service sees handles and rooms, never a secret. Anyone without the secret, the service or someone in the middle included, gets one guess per shown code (the generator hides the secret, and the transcript holds both DTLS fingerprints, so two separate DTLS sessions don't match), and the attempt spends the code: 1 in 100,000.
- Guessing blind. A lookup finds a live handle with chance d = N / 90,000 (N live codes), and a found handle gives one attempt at 1 in 100,000. Misses at the budget rate r = 10 a minute let through hits at r·d/(1−d), so the expected blind joins a year are r·d/(1−d)/100,000 × 31.6 million s. With 1,000 live codes (d = 1.1%): **0.59 a year**; with 100: 0.06; with 5,000: 3.1.
- Past the budget each lookup costs a proof of work of 2^16 to 2^22 hashes, so an expected blind join with 1,000 live codes costs about 9 million lookups, 6 × 10^11 hashes at 16 bits and 4 × 10^13 at 22: minutes to hours of one GPU. That buys a moment's control of one random screen, which shows who joined and can remove them; a screen that grants control of a computer should ask for the QR code or an extra confirmation instead (PLAN §4).
- Someone who can see the screen can use its code, as they could scan its QR code; the host shows who joined and can remove them.

## 3. Control messages (`ctl`, JSON)

Unknown message types and fields MUST be ignored.

### A phone with several connections

A phone MAY keep several independently authenticated links open (the controller keeps three by default, configurable
from one to four). Only its selected connection receives input. Switching MUST release held buttons, typing,
music notes and touch gestures, send neutral state, then stop all input to the previous screen before routing to
the next. A background link keeps only its signaling, ping and recovery traffic. Its layout, values, approval
notice, scene and connection statistics stay separate from every other link.

`welcome{attention:true, kind?}` advertises pause handling; `kind` is `pc`, `sim`, `viewer` or `site`, for the phone's
local list only. The device sends `attention{active:false}` when keeping this link idle, and `attention{active:true}`
when returning. A host that supports it MUST reset that participant's input stream and ignore its input messages
and binary packets while paused, while still accepting `attention`, `ping` and `bye`. It SHOULD show that phone as
paused. This carries no other screen's name, identity, state or reason for the pause. It neither grants permissions
nor changes a pairing identity or a shared-scene claim. PC Allow/Deny continues to apply on that PC.

Older hosts ignore the optional message and fields; they receive the releases and neutral state, then their normal
input watchdog goes idle. They cannot show the explicit paused label. A new host treats a phone that sends no
`attention` as active, as before. There is no protocol version change.

The phone's in-app camera accepts only canonical `/p/#1.…` or `/p/#2.…` links at its own deployment's origin, or a
complete ten-digit short code. A scan is never opened as a URL. All paths use the same fingerprint pin, HMAC or
CPace exchange and existing invite single-use rules. After successful authentication a phone MAY keep the online
invite's room, fingerprint and non-extractable HKDF key in IndexedDB, and use that key for the exact same QR HMAC
on a later connection. It keeps no short-code secret, lookup ticket or direct-code nonce. A rotated/closed host or
expired device certificate still needs its current code. Legacy remembered-PC rows migrate as metadata and keep
their existing direct-pairing keys; reconnecting them requires a current code until an online invite is remembered.

### Optional shared-sim presence (version 1)

Sim renderers can join through the same invite and authenticated `DeviceLink` as a phone. No worker or signaling change is needed. These optional JSON messages use `ctl`; the main protocol version is unchanged. Older hosts and phones ignore `sim`.

`{t:"sim", v:1, kind:"watch"|"input"|"frame", seq, data}` has a nonnegative safe-integer sequence. A renderer sends `watch` after each connection, then `input` at at most 20 Hz. The host sends complete `frame` snapshots at at most 20 Hz only to subscribed participants. Receivers discard sequences at or below the last accepted sequence; a new connection starts a fresh sequence window. Either end drops sim sends while the channel has 64 KiB buffered. Envelopes allow at most 16,000 values, nesting depth 12, arrays of 4,096 and strings of 2,048 characters; all numbers must be finite and bounded. Prototype keys are rejected.

- `watch`: `data:null`; asks for the current sim. Opening the same sim URL with `join=1` and the existing pairing fragment joins as a renderer. The fragment is removed from the address bar.
- `input`: `data:{ride,active,head,hands,grab,pad}`. `ride` is an existing device node; occupying it does not claim its controls. Poses are `{p:[x,y,z],q:[x,y,z,w]}` in scene metres, with normalized camera-style quaternions (-Z forward); at most two hands. `pad` is null or a bounded existing `PadState`, mapped from `xr-standard` to `face.gamepad`. The host derives the participant id from the connection and accepts drive only for its claimed device. Head distance from the ride is limited to 3 m, hands to 2 m from the head. No client sends object positions or release velocity.
- `frame`: host-only `data:{state,bodies,people,colors}`. `state` is the sim adapter's presentation state, excluding input filters and hardware. Bodies include stable id, kind, position, velocity, radius and current owner. `people` contains accepted head, hand and pointer poses with the host-assigned id and colour. `colors` follows the sim's unit order. Late joiners receive a complete current snapshot.

The host runs device physics and all prop contacts. A rising `grab` takes the closest free object within 1.5 m of the hand; the first accepted grab wins. Hand moves are bounded to 12 m/s plus 15 cm tolerance. Releasing uses host-measured velocity capped at 6 m/s per axis. A stale hand releases after 500 ms, stale presence disappears after 750 ms, and disconnect releases immediately without throwing. A controller going quiet clears drive after the existing 300 ms watchdog. The phone's `scene-grab` tray action toggles the same object hold and uses trackpad deltas to position it. Existing phone controls, device claims and arm approval remain in force. Arm viewing and props never enable hardware control.

The Viewer replicates catalogue models and their listed movable parts; local file bytes are not sent to other participants. Sim snapshots are live, transient state, not durable room storage.

**Device → host:**
- `hello{proto, caps{tier, sensorApi, haptics, platform}, mac, name, pair?}`: `pair` is the pairing id when connecting through a direct code (§2a)
- `hello{proto, caps, name, code, ticket, pake}`: joining by short code (§2b), with no `mac`; then `pake{mac}`, the device's confirmation
- `btn{id, ev: tap|down|up|double|long}`
- `text{s, del?}`: typing on the device's own keyboard (a `keyboard` tray control, see Layout): delete `del` characters before the caret, then type `s` (`"\n"` is Enter, `"\t"` Tab). A character is a code point, as one Backspace deletes it. At most 256 each way (a longer paste comes in pieces, in order); `del` 0 is left out; never both empty; no control characters but newline and tab. Devices diff their own text field against what they sent, so autocorrect, predictions and a swiped word arrive as a delete and a retype, and Backspace on an empty field is `del: 1`.
- `toss{v}`: the device was flicked upward, screen level, the way you'd throw a ball off a tray; `v` is how fast it went up (m/s, at most 4). Sent only to a host whose layout asks for `toss`.
- `value{id, v, add?}`: `add: true` when the user added a select option alongside the current one (see Layout)
- `mode{m, c?, p?}`: the device's mode, and what it uses in it (CATALOGUE §9.4): `c` is the catalogue controller (`face.gamepad`, `face.wii`, `face.mouse`, `face.trackpad`, `face.hand`, …; CATALOGUE §9.1) and `p` the profile it applies (CATALOGUE §3), sent on the gamepad. Devices SHOULD send `mode` again when either changes. Each is an id of a fixed shape (`c`: a kind, a dot and a name, `^[a-z]{2,12}\.[a-z0-9-]{1,32}$`; `p`: a profile id), and hosts MUST ignore a malformed one and SHOULD pass on a well-formed one they don't know. A host that gets no `c` takes the device to use the controller its mode stands for (Point is `face.mouse` under `layout.point: "mouse"`, else `face.wii`).
- `recenter`
- `claim{node}`: claim a node the host listed in `scene`; `null` releases what this device holds (CATALOGUE §5). Hosts that list no nodes ignore it.
- `ping{t0}`
- `attention{active: boolean}`: this connection is in use or paused (above).
- `bye`

**Host → device:**
- `welcome{proto, name, layout, pair?, invite?, restart?, attention?, kind?}`: `pair{id, key}` is a pairing grant (§2a) from a host that remembers this device; `invite` is the QR link's pairing code, for a device that joined by short code (§2b); `restart: true` when the host takes ICE restarts on this connection (§1; not on a direct LAN code's); `attention` and `kind` describe the optional connection hub support above.
- `pake{y, mac}`: the host's share and confirmation in the short-code exchange (§2b)
- `layout{layout}`
- `state{values}`: values the device shows, or acts on, by id. Devices know `textField` (Typing, below) and `notice`: a line the device shows over its controls until it changes or is `false`, for whatever holds its input up on the host's side (ob.Pal Link: "Waiting for approval on the PC" while the person at the PC hasn't allowed this phone yet, or its refusal). A host MAY repeat a notice as a `feedback` toast, for devices from before `notice`; a device that shows the notice skips a toast that says the same.
- `feedback{haptic?: tick|bump, toast?}`
- `pong{t0}`
- `scene{you, people, nodes?, held}`: a shared scene (CATALOGUE §5). Sent to every participant when anyone joins, leaves, claims or releases.
  - `you`: the receiving participant's id.
  - `people: [{id, name, color, lead?}]`: everyone in the scene, including the screen (`host`).
  - `nodes: [{id, name, kind, group?, parent?}]`: what can be claimed; omitted when unchanged. `parent` names the node this one is part of (a joint of a robot arm): whoever holds the parent controls this node too, so the host refuses either while someone else holds the other, and devices show such a node as held with its parent.
  - `held: {nodeId: participantId}`: who holds what.
- `lock{reason}`: `taken-over` (a one-device host gave control to another device), `host-closed`, `rejected` (binding failed), `removed` (the host removed this participant, which then MUST NOT rejoin by itself), `full` (the scene has no free place).
- `rumble{strong, weak, ms}`: vibrate the device, Gamepad API dual-rumble semantics (magnitudes 0–1, at most 5000 ms). Devices that cannot vibrate MAY show it visually.

**Layout:** `{v:1, modes:[modeId…], controllers?: [controllerId…], tray:[{id, label, type?: "button"|"toggle"|"select"|"keyboard", icon?, options?: [{value, label, group?, detail?, image?, glyph?, color?}], add?, tone?: "stop"}], utilities?: [utilityId…], profile?: string, keys?: {primary?, secondary?, next?, prev?}, buttons?: {[inputId]: target}, toss?: boolean}`. `controllers` lists the catalogue controllers the host suggests (CATALOGUE §9.2), in order: a device that knows them opens the first it can show, once, on the first `welcome`, and skips ids it doesn't know. Devices that predate controllers read `modes`, so a host that names controllers MUST also send `modes` (by default the modes the controllers stand for, in order), and SHOULD set the fields that make them on such a device: `point: "mouse"` for `face.mouse` ahead of `face.wii`, a `keyboard` tray control for `face.keyboard`, the `driving` profile for `face.wheel` ahead of `face.gamepad`. `withControllers` in `@obpal/core` does all of this, and `@obpal/host` applies it to every layout it sends. `tone: "stop"` marks a safety stop (a robot's e-stop): the device draws it in red, in words, first in the tray. `buttons` suggests what the device's physical inputs press (CATALOGUE §1 and §3): input id (`key:Enter`, `media:nexttrack`, `pad:b4`, `back`) to a control of the device's controller, a key (`key-<code>`, where the tray has a keyboard), `tray:<id>`, `app:<action>` or `none`; it outranks the controller's defaults, and a person's own bindings outrank it. `keys`, the older form, binds four actions' inputs to tray buttons: primary is Enter, Space, one headset press or a pad's A, secondary Esc, Backspace or a pad's B, next and prev the arrows, Page Up/Down, two or three headset presses or a pad's D-pad (a keyboard's volume keys count as primary and secondary; a phone's own never reach a browser page). A bound tray button sends `btn{id, ev: "tap"}` when pressed; unbound inputs keep the controller's own use, and the gamepad keeps them as A, B and the d-pad. Devices read `keys` as `buttons` (`hostButtons` in `@obpal/core`). The device renders the layout. The host alone decides what an `id` does. The reserved id `pad` carries trackpad taps. A `select` with `add: true` belongs to a host that composes scenes: devices offer a second action on each option that adds it alongside the current one, sent as `value{id, v, add: true}`. `utilities` lists the catalogue utilities the host accepts (CATALOGUE §1; absent means all) and `profile` suggests a catalogue profile for whatever the host controls right now (CATALOGUE §3); a host MAY send a new `layout` whenever either changes. `toss: true` asks the device to report upward flicks as `toss{v}` (for hosts that bounce things).

**Typing (the `keyboard` control).** A `keyboard` tray control opens the device's own keyboard (on a phone, a real text field right above the OS keyboard, focused inside the tap that opens it). Its typing goes as `text{s, del}`, and a row of keys the device's keyboard lacks as `btn{id: "key-<KeyboardEvent.code>", ev: "tap"}`: `key-Escape`, `key-Tab`, `key-ArrowLeft`, `key-ArrowUp`, `key-ArrowDown`, `key-ArrowRight`, `key-Backspace`, `key-Enter`. A host that can tell when one of its text fields has the focus sets the `state` value `textField` to `"text"`, or `"secret"` for a password field, and back to `false` when the focus leaves: devices then offer their keyboard with one tap (a "Type" prompt), and for `"secret"` type into a password field of their own, so their keyboard neither suggests nor learns. A keyboard opened from the prompt closes when `textField` clears. (ob.Pal Link sets `textField` from ob.Pal Desktop's `status.text`, §7, and only while typing there would be accepted.)

## 4. STATE packet (`st`, 76 bytes, little-endian)

| Off | Type | Field |
|---|---|---|
| 0 | u8 | `0x11`: version 1, type STATE |
| 1 | u8 | flags (see below) |
| 2 | u16 | seq; the receiver keeps only newer packets (serial arithmetic) |
| 4 | u32 | capture time, µs, device session clock |
| 8 | u8 | mode: 0 hold (1:1 match), 1 orbit (game-style gyro rotate, rate-based via aim), 2 point (Wii-style, see below), 3 tilt, 4 pad, 5 gamepad (§5), 6 track (6-DOF: POSE packets beside STATE, below) |
| 9 | u8 | grab id; increments on each clutch press |
| 10 | u8 | tier (bits 0–1: 0 touch, 1 tilt, 2 compass, 3 gyro); screen angle / 90 (bits 2–3): the controls' orientation, which is the locked one while the device locks rotation for motion control |
| 11 | u8 | active touches |
| 12 | i16×4 | qAbs, Q15: screen frame → Earth (x east, y north, z up) |
| 20 | i16×4 | qRel, Q15: rotation since grab in **view space** (x right, y up, z toward the user); identity when not clutched |
| 28 | i16×3 | gyro, mrad/s, screen frame |
| 34 | i16×3 | up vector, Q15, screen frame |
| 40 | i32×2 | aim accumulators, millidegrees: yaw (+ = left), pitch (+ = up); player-space gyro, or in point mode the pointing angle |
| 48 | i32×2 | one-finger pad accumulator, 1/16 CSS px |
| 56 | i32×2 | two-finger pan accumulator, 1/16 CSS px |
| 64 | i16 | pinch accumulator, log2(scale) × 4096, wrapping |
| 66 | i16 | twist accumulator, 0.01° (+ = clockwise), wrapping |
| 68 | i8×2 | joystick |
| 70 | i8×2 | tilt stick |
| 72 | u32 | held-button bitmask (bit 0 = clutch) |

**Flags:** bit 0 quatValid, bit 1 gyroValid, bit 2 gravValid, bit 3 duplicate, bit 4 clutch (gyro engaged; toggled on the phone), bit 5 touching, bit 6 sensor timestamp, bit 7 low power.

Accumulators only grow. Receivers difference consecutive packets with wrap-around (int32 or int16), so lost or reordered packets never cause jumps. Devices send about 60 Hz while active (the gyro on, a touch, or pointing) and 15 Hz when idle, and MUST drop rather than queue when the channel is backed up.

**Hosts apply qRel** as `object = camera · qRel · camera⁻¹ · objectAtGrab`. This makes the object follow the hand in the viewer's frame, whatever the grip.

**Point mode (Wii-style):** the aim accumulators follow where the device points, absolutely: azimuth about gravity and elevation of its pointing axis, relative to the pose at the last `recenter`. The axis is the top edge when the device is held like a remote (screen up or tipped toward the user) and the back when it is held upright, chosen at recenter; twisting about it moves nothing. Hosts sum the deltas since their own `recenter` into (yaw, pitch) and project the ray onto the screen, x = cx − tan(yaw)·K, y = cy − tan(pitch)·K, with K = (width / 2) / tan(16°) (reference). The point may leave the screen and returns when the device aims back. Devices send `recenter` when entering point mode and on their centre button, and the remote face as buttons: `wii-a` tap (select / click), `wii-b` down/up (hold to grab), `wii-plus` / `wii-minus` taps (zoom). Devices without motion sensors steer the same pointer with the one-finger pad.

**Staleness:** after 250 ms without a STATE packet, hosts MUST ease rate controls (the tilt stick) to rest instead of holding the last value.

## 5. PAD packet (`st`, 24 bytes, little-endian)

A full game controller in the W3C *standard* gamepad layout (Xbox-style), sent on the same unreliable channel while the device is in mode 5 (gamepad). The first byte tells the packet types apart.

| Off | Type | Field |
|---|---|---|
| 0 | u8 | `0x12`: version 1, type PAD |
| 1 | u8 | flags: bit 0 gyro aim is on, bit 1 tilt steering is on, bit 2 the Wii-style pointer is on (POINTER packets follow, §6) |
| 2 | u16 | seq (serial arithmetic, as STATE) |
| 4 | u32 | capture time, µs, device session clock |
| 8 | u32 | buttons, bit *i* = standard button *i*: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 View, 9 Menu, 10 L3, 11 R3, 12–15 D-pad up/down/left/right, 16 Guide |
| 12 | i16×4 | sticks LX, LY, RX, RY, Q15 in −1…1; +X right, +Y down (as the Gamepad API) |
| 20 | u8×2 | triggers LT, RT, 0…1 as /255 |
| 22 | u16 | reserved (0) |

PAD carries positions, not accumulators: each packet is the whole controller. Devices send about 60 Hz while anything is held or motion is steering, 15 Hz at rest, and immediately on a button change. A stick click (L3/R3) stays set for at least 120 ms so one lost packet cannot swallow it.

**Hand-off:** on entering gamepad mode the device keeps sending STATE (mode 5) for 250 ms, then only PAD. Hosts MUST treat a PAD packet newer than the latest STATE as mode 5 with neutral motion, so a held tilt or gyro grab from the previous mode never keeps driving the view. On leaving, the device sends a few neutral PADs; hosts drop the pad 1.5 s after the last one.

Hosts MAY expose PAD to web content as a standard `Gamepad` (`mapping: "standard"`, 17 buttons, 4 axes); `@obpal/host` ships `installGamepadShim` for this.

## 6. POINTER packet (`st`, 16 bytes, little-endian)

Where the device points, sent beside PAD while a pointing utility is on: the catalogue's `motion.point` (the Wii-style cursor) or `motion.aim` routed to the mouse (CATALOGUE §2). Devices send it at the PAD cadence, right after each PAD.

| Off | Type | Field |
|---|---|---|
| 0 | u8 | `0x14`: version 1, type POINTER |
| 1 | u8 | flags: bit 0 valid (the device has an orientation), bit 1 relative, bit 2 edge turn requested |
| 2 | u16 | seq (serial arithmetic, as STATE) |
| 4 | u32 | capture time, µs, device session clock |
| 8 | i16 | yaw, 0.01° (+ = right) |
| 10 | i16 | pitch, 0.01° (+ = up) |
| 12 | u8 | recentre generation; increments on each recentre |
| 13 | u8 | reserved (0) |
| 14 | u16 | reserved (0) |

**Absolute** (flag bit 1 clear): yaw and pitch are the pointing angles since the device's last recentre, with the Point-mode geometry of §4 (the axis is the top edge or the back, chosen at recentre; twisting about it moves nothing). A lost packet costs nothing and a recentre puts the cursor back in the middle. Hosts project them: `x = cx + tan(yaw) · K`, `y = cy − tan(pitch) · K`, `K = (width / 2) / tan(16°)`. The cursor's buttons come from PAD: A (button 0) clicks, B (button 1) holds. A PAD packet with flag bit 2 clear ends the pointer at once.

**Relative** (flag bit 1 set): the angles are an integrated turn (they only ever grow, wrapping the int16), and only their change carries meaning: hosts difference consecutive packets with wrap-around and turn the change into mouse movement (or a stick deflection), skipping the difference across a change of generation.

**Edge turn** (flag bit 2): the device asks page hosts for the Wii shooter's edge turn (CATALOGUE §4). Hosts MAY ignore it.

**Staleness:** a pointer stream ends 300 ms after its last packet; hosts MUST then drop the cursor (or the mouse) rather than hold it.

## 7. Native messaging frames (host ↔ desktop helper)

A browser-extension host that drives programs outside the browser talks to a native helper (ob.Pal Desktop, `desktop/`) over [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): the browser launches the helper and connects its stdin/stdout; each message is a native-endian `u32` byte length followed by UTF-8 JSON. The phone never sees this layer, and the helper never sees the phone: the extension maps controller state to host-side actions and sends only those, plus the text the phone's keyboard types. Unknown message types are errors, not ignored: nothing but the extension can legitimately reach the helper.

**Extension → helper:**
- `hello{v}`: protocol version (1).
- `enable{on}`: arm or disarm injection. Off at start; disarming releases everything held. ob.Pal Link arms the helper only while the PC is its target and the phone connected is one the person at the PC allowed (asked once per phone, in Link's own pages: spec/SECURITY.md §8).
- `f{k?, b?, m?, w?}`: an **action frame**, the whole desired state, never edges:
  - `k`: held keys by `KeyboardEvent.code` (`KeyW`, `Space`, `ArrowUp`, …), at most 16, each in the helper's allowlisted key table (unknown key: the frame is rejected as a whole);
  - `b`: held mouse buttons, 0 left, 1 middle, 2 right, 3 back, 4 forward;
  - `m`: relative mouse motion this frame, whole px, +y down, |v| ≤ 2000;
  - `w`: wheel this frame in 1/120 notch units, DOM convention (`[deltaX, deltaY]`, +y scrolls down), |v| ≤ 2400.
  A missing list means nothing held. The helper diffs `k` and `b` against what it holds, so a lost, dropped or refused frame can never leave a key down; the next frame repairs the state. Frames go at 60 Hz while there is input and at least every 250 ms otherwise; the helper releases everything after 500 ms without one, and accepts at most 250 per second.
- `text{s, del?}`: **typing** from the phone's keyboard into whatever has the keyboard focus: Backspace `del` times (0 when absent), then `s`, typed as characters (Unicode, so the keyboard layout doesn't matter), except that `"\n"` presses Enter and `"\t"` Tab. At most 256 characters and 256 deletions, and no other control characters (`bad-text`); at most 40 requests per second (`text-rate`). Only a helper whose `hello` says `caps.text` knows it.
- `release`: release everything now.
- `allow{path, keyboard, mouse}`: allow a program (its image path). The helper accepts only a program it has seen in the foreground in this session.
- `scope{path, keyboard, mouse}`, `forget{path}`, `pause{on}`, `resume` (after the panic hotkey), `stats`.
- `desktop{on, keyboard, mouse}`: whole-PC mode on (with that scope) or off. While it is on, every window receives input, not only allowed programs. Only a helper whose `hello` says `caps.desktop` knows it.

- `macshortcuts{ctrlToCmd}`: Mac-only persisted preference. True (default) maps logical Control keys to Command; false uses physical Control. Held input is released with the old mapping before changing it. Windows answers `unsupported`.

**Helper → extension:**
- `hello{v, version, os, hotkey, caps{keyboard, mouse, gamepad, desktop, text}}`: `hotkey` names the panic hotkey, null when it could not be registered; `desktop` is true when the helper has whole-PC mode (0.2 and later); `text` when it types `text` requests and reports text fields in `status.text` (0.3 and later on Windows; also macOS, awaiting a first Mac test).
- `platform{os:"macos", accessibility, ctrlToCmd}`: Mac-only report, sent with the initial replies and whenever either boolean changes. Accessibility is checked without prompting; false gates every input mode and hides the phone's Type prompt. Windows sends no platform message. The existing Windows hello/config/status shapes stay unchanged.
- `config{paused, desktop, programs[{path, name, keyboard, mouse, gamepad}]}`: after every change. `desktop` is whole-PC mode's scope `{keyboard, mouse, gamepad}` while it is on, else null (absent from helpers before 0.2).
- `status{enabled, panic, held, front, program, text}`: on change. `front` is the window in front now (possibly the browser), `program` the most recent foreground program that is not the browser: what "allow this program" refers to. Each is `{name, path, title, pid, elevated, browser, allowed}` where `allowed` is the scope or null. `text` is `"text"` while a text field has the keyboard focus, `"secret"` while a password field has it, else null (anything else, an elevated window, or it can't be told; absent before 0.3). It comes from the OS's accessibility layer (UI Automation on Windows, asked about 4 times a second while the helper runs; AX roles/subroles and writability on macOS, with bounded queries on a separate thread), which is asked only what kind of control has the focus, never what it holds.
- `stats{frames, injected, refused{notEnabled, paused, panic, notAllowed, elevated, noWindow, rate, invalid}}`: on request. Typing counts in `injected` and, refused, in the same counters.
- `error{code, msg}`: `bad-message`, `bad-frame`, `unknown-program`, `bad-path`, `proto`, `config-save`; for typing `bad-text`, `text-rate`, `keys-held` (a modifier is held) and `not-typed` (not enabled, paused, panic, not allowed, or the scope has no keyboard).

**Gating, in the helper, on every frame:** enabled, not panicked, not paused, a foreground window whose process is on the allowlist, at the helper's integrity level or lower (an elevated window is refused and reported), and within that program's scope: keys only with `keyboard`, buttons, motion and wheel only with `mouse`. `gamepad` is reserved for a virtual controller. Everything held is released whenever the foreground changes.

**Typing** is gated exactly like a frame and needs `keyboard` in the scope. It is refused while the helper holds Shift, Ctrl or Alt for a frame (`keys-held`), so typed text never turns into shortcuts. It holds nothing: each request is typed at once, whole characters at a time (a person's own keys may come between two characters, never inside one).

**macOS** additionally requires Accessibility permission for input in both modes. Ctrl keys map to Command by default; Alt keys to Option. Ctrl+wheel zoom becomes Command +/- key events. The per-program identity is the canonical executable path of NSWorkspace's frontmost app. The physical panic chord is Ctrl+Option+Delete (backward delete), independent of the shortcut preference.

**Whole-PC mode** replaces the program check: enabled, not panicked, not paused, and within the mode's scope, whatever window is in front, the browser included. An elevated window is not refused (Windows drops input to it by itself, and the pointer must stay free to move off it); the status reports it. The held state belongs to the PC, not a window, so it is not released when the foreground changes: pressing on a window in the background brings it to the front, and a drag that starts there must go on.

**Which gestures click (the extension's mapping, not the wire).** The Link extension turns the phone's events into held buttons, wheel and Ctrl for the PC: on the trackpad a tap clicks, a second tap double-clicks, a hold right-clicks on lifting and drags on moving, two fingers scroll (the page follows them, and a flick carries on) and a pinch zooms (Ctrl + wheel, in whole steps); on the Point face A clicks where it went down (the pointer holds still while A is down), holding A right-clicks, pressing A and aiming away drags, holding B turns aiming into scrolling, and + / − zoom a step. A click is a press held for 30 ms, then a release, so it spans frames the helper can diff.

## 8. Extending

### Music values (optional)

`face.drums` and `face.keys` are offered only by `layout.controllers`. Both use
`mode{m:4,c:"face.drums"|"face.keys"}` and the existing reliable `ctl` channel.
The default profile supplies physical-button bindings; no binary packet changes.
Older hosts ignore these unrecognised value ids.

- `value{id:"music.event",v:<JSON string>}` carries
  `{op,seq,at,uncertainty,n,v,x}`. `op` is hit/on/off/bend/air/stop/alive; `seq`
  is a nonnegative integer, `at` a capture time translated to the host monotonic
  epoch in milliseconds (0 before sync), `uncertainty` the best clock RTT/2.
  `n` is a drum index (0–12), MIDI note (24–108), or 127 for air note-off;
  `v` is velocity/air brightness 0–1; `x` is bend −1–1 (two semitones).
  Fields are required and finite, payload at most 256 characters. Drum indices
  are kick, snare, closed/open hat, low/mid/high tom, crash, ride, conga, bongo,
  cajón and djembe. Notes are scale-locked by the phone.
- `value{id:"music.sync",v:<phone monotonic epoch>}` gets a targeted
  `state{values:{"music.sync":<JSON string {at,host}>}}`. Phone time is
  performance.timeOrigin + performance.now(); the lowest-RTT midpoint sample
  estimates the offset. Wall-clock differences must not be treated as latency.
- Alive every 250 ms while a music face is visible. Hosts release after 1 s
  without music, on disconnect, mode/claim changes, and when hidden. Stop clears
  all that participant's voices. Off always releases even under rate limiting.
- The host schedules accepted attacks immediately, independently of rendering;
  it does not queue attacks while audio is locked. Claims choose the voice/station.
  A seat accepts at most 80 attacks per second and eight concurrent voices.

See [MUSIC.md](MUSIC.md) for synthesis, budgets and measurement limits.

- New device classes (wheels, pedals, knobs, custom hardware) declare `caps` and reuse the STATE fields they need. Anything else goes in new ctl messages.
- Shared scenes (CATALOGUE §5) use `scene` and `claim`. Input packets need no change: the host knows which participant each connection belongs to. A device that bridges several controllers (CATALOGUE §6) will open sub-participants with a `seat{op, seat, name, kind}` message, and their packets will carry the seat index.
- New kinds of control go into the catalogue (CATALOGUE §8) with a stable id, and reuse PAD, STATE or POINTER fields where they can; a new packet type is the last resort.
- The high nibble of byte 0 carries the packet version and the low nibble the type (`0x11` STATE, `0x12` PAD, `0x14` POINTER), so a batched v2 STATE or a native 200 Hz variant can use `0x21`. Receivers MUST ignore packet types they don't know.
- Future work: resume without rescanning over the room service (the direct code of §2a already covers the LAN), a WSS relay fallback, and a registry of controller profiles.

## POSE packet (type 5): the device in space

While 3D tracking is on (mode 6, catalogue `motion.track`), the device sends a POSE packet on the unreliable channel for each tracked frame, beside STATE (which still carries touches and the mode). The device tracks itself with its camera and motion sensors (WebXR `immersive-ar` on Android), so the position doesn't drift.

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | header 0x15 (version 1, type 5) |
| 1 | u8 | flags: b0 tracked (clear while the device has lost track of the world), b1 touching (the deadman, sampled with this pose) |
| 2 | u16 | seq |
| 4 | u32 | capture time, µs, device session clock |
| 8 | f32×3 | position, metres, in the tracking space: y up, origin where tracking began |
| 20 | i16×4 | orientation, Q15 quaternion (x, y, z, w): device → tracking space; the camera looks along −z, the top edge is +y |
| 28 | u8 | generation: a new tracking session, with a new origin |
| 29 | u8, u16 | reserved |

Hosts read it as `Frame.pose` (`@obpal/host`), stale after 250 ms. A pose is absolute within a generation. Hosts anchor a drive when the person's deadman goes down, and re-anchor when the generation changes.

