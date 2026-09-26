# ob-pal protocol v1 (draft)

An open protocol for pairing a **control device** (phone, tablet, custom hardware) with a **host** (web page, native bridge, any app) and streaming control state. 3D manipulation is the first profile, but the protocol isn't tied to it: new controls, modes and device types go in the capability and layout layers, without changing the transport.

Status: draft, implemented by `packages/core` and `packages/host`. Keywords follow RFC 2119. The controls built on these packets, their routes and profiles are in [CATALOGUE.md](CATALOGUE.md).

## 1. Roles and transport

- **Host:** creates a pairing and receives input.
- **Device:** joins a pairing and sends input.
- **Room service:** a blind signaling mailbox over WebSocket at `wss://<service>/r/<roomId>?role=host|device`. It forwards `{t:"sig", d}` from the device to the host, and from the host to the device named in `to`. It announces `{t:"peer", ev:"join"|"leave", id, role}` and greets with `{t:"welcome", id, role, host}`. It answers the text frame `ping` with `pong`.
- **Link:** one RTCPeerConnection with two pre-negotiated DataChannels:
  - `ctl`: id 0, reliable, ordered, UTF-8 JSON.
  - `st`: id 1, `ordered:false, maxRetransmits:0`, binary STATE.
- The device creates the offer. ICE servers come from `GET /api/ice?room=<roomId>`: STUN, plus short-lived TURN credentials when the room has a live host. The device SHOULD request them while its socket connects and build the offer meanwhile (gathering host candidates), so the offer and its candidates leave the moment the host is known to be present; it MUST NOT wait more than a few hundred milliseconds for TURN credentials, since on a LAN the host candidates carry the connection and a later rebuild picks TURN up.
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

## 2a. Remembered pairings and the direct LAN code (no room service)

After one online pairing, a host and a device can find each other again on the local network with **no server at all**. Everything the device needs comes from a second kind of code on the host's screen; the host learns the device's address from the device's own ICE connectivity checks.

**Persistent identities.** A host or device that supports this keeps one DTLS certificate across sessions (browsers: `RTCPeerConnection.generateCertificate` stored in IndexedDB, renewed a week before it expires), so its fingerprint can be pinned later. Certificates expire after at most a year; a new certificate simply needs a new online pairing.

**Pairing grant.** When a device binds online (§2 step 6), a remembering host mints a 16-byte pairing id `P` (kept for that device's fingerprint across re-pairings) and a fresh 32-byte pairing key `K` and sends both in `welcome{pair:{id: b64url(P), key: b64url(K)}}`. They travel only inside the DTLS-protected channel, between two authenticated endpoints; someone who saw the QR code does not have `K`. The host stores `{P, K, fpD, name}`, the device stores `{P, K, fpH, name}`. Every online bind rotates `K`. Either side MAY forget a pairing at any time.

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

## 3. Control messages (`ctl`, JSON)

Unknown message types and fields MUST be ignored.

**Device → host:**
- `hello{proto, caps{tier, sensorApi, haptics, platform}, mac, name, pair?}`: `pair` is the pairing id when connecting through a direct code (§2a)
- `btn{id, ev: tap|down|up|double|long}`
- `value{id, v, add?}`: `add: true` when the user added a select option alongside the current one (see Layout)
- `mode{m}`
- `recenter`
- `claim{node}`: claim a node the host listed in `scene`; `null` releases what this device holds (CATALOGUE §5). Hosts that list no nodes ignore it.
- `ping{t0}`
- `bye`

**Host → device:**
- `welcome{proto, name, layout, pair?}`: `pair{id, key}` is a pairing grant (§2a) from a host that remembers this device
- `layout{layout}`
- `state{values}`
- `feedback{haptic?: tick|bump, toast?}`
- `pong{t0}`
- `scene{you, people, nodes?, held}`: a shared scene (CATALOGUE §5). Sent to every participant when anyone joins, leaves, claims or releases.
  - `you`: the receiving participant's id.
  - `people: [{id, name, color, lead?}]`: everyone in the scene, including the screen (`host`).
  - `nodes: [{id, name, kind, group?}]`: what can be claimed; omitted when unchanged.
  - `held: {nodeId: participantId}`: who holds what.
- `lock{reason}`: `taken-over` (a one-device host gave control to another device), `host-closed`, `rejected` (binding failed), `removed` (the host removed this participant, which then MUST NOT rejoin by itself), `full` (the scene has no free place).
- `rumble{strong, weak, ms}`: vibrate the device, Gamepad API dual-rumble semantics (magnitudes 0–1, at most 5000 ms). Devices that cannot vibrate MAY show it visually.

**Layout:** `{v:1, modes:[modeId…], tray:[{id, label, type?: "button"|"toggle"|"select", icon?, options?: [{value, label, group?, detail?, image?, glyph?, color?}], add?}], utilities?: [utilityId…], profile?: string}`. The device renders the layout. The host alone decides what an `id` does. The reserved id `pad` carries trackpad taps. A `select` with `add: true` belongs to a host that composes scenes: devices offer a second action on each option that adds it alongside the current one, sent as `value{id, v, add: true}`. `utilities` lists the catalogue utilities the host accepts (CATALOGUE §1; absent means all) and `profile` suggests a catalogue profile for whatever the host controls right now (CATALOGUE §3); a host MAY send a new `layout` whenever either changes.

## 4. STATE packet (`st`, 76 bytes, little-endian)

| Off | Type | Field |
|---|---|---|
| 0 | u8 | `0x11`: version 1, type STATE |
| 1 | u8 | flags (see below) |
| 2 | u16 | seq; the receiver keeps only newer packets (serial arithmetic) |
| 4 | u32 | capture time, µs, device session clock |
| 8 | u8 | mode: 0 hold (1:1 match), 1 orbit (game-style gyro rotate, rate-based via aim), 2 point (Wii-style, see below), 3 tilt, 4 pad, 5 gamepad (§5) |
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

A browser-extension host that drives programs outside the browser talks to a native helper (ob.Pal Desktop, `desktop/`) over [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): the browser launches the helper and connects its stdin/stdout; each message is a native-endian `u32` byte length followed by UTF-8 JSON. The phone never sees this layer, and the helper never sees the phone: the extension maps controller state to host-side actions and sends only those. Unknown message types are errors, not ignored: nothing but the extension can legitimately reach the helper.

**Extension → helper:**
- `hello{v}`: protocol version (1).
- `enable{on}`: arm or disarm injection. Off at start; disarming releases everything held.
- `f{k?, b?, m?, w?}`: an **action frame**, the whole desired state, never edges:
  - `k`: held keys by `KeyboardEvent.code` (`KeyW`, `Space`, `ArrowUp`, …), at most 16, each in the helper's allowlisted key table (unknown key: the frame is rejected as a whole);
  - `b`: held mouse buttons, 0 left, 1 middle, 2 right, 3 back, 4 forward;
  - `m`: relative mouse motion this frame, whole px, +y down, |v| ≤ 2000;
  - `w`: wheel this frame in 1/120 notch units, DOM convention (`[deltaX, deltaY]`, +y scrolls down), |v| ≤ 2400.
  A missing list means nothing held. The helper diffs `k` and `b` against what it holds, so a lost, dropped or refused frame can never leave a key down; the next frame repairs the state. Frames go at 60 Hz while there is input and at least every 250 ms otherwise; the helper releases everything after 500 ms without one, and accepts at most 250 per second.
- `release`: release everything now.
- `allow{path, keyboard, mouse}`: allow a program (its image path). The helper accepts only a program it has seen in the foreground in this session.
- `scope{path, keyboard, mouse}`, `forget{path}`, `pause{on}`, `resume` (after the panic hotkey), `stats`.

**Helper → extension:**
- `hello{v, version, os, hotkey, caps{keyboard, mouse, gamepad}}`: `hotkey` names the panic hotkey, null when it could not be registered.
- `config{paused, programs[{path, name, keyboard, mouse, gamepad}]}`: after every change.
- `status{enabled, panic, held, front, program}`: on change. `front` is the window in front now (possibly the browser), `program` the most recent foreground program that is not the browser: what "allow this program" refers to. Each is `{name, path, title, pid, elevated, browser, allowed}` where `allowed` is the scope or null.
- `stats{frames, injected, refused{notEnabled, paused, panic, notAllowed, elevated, noWindow, rate, invalid}}`: on request.
- `error{code, msg}`: `bad-message`, `bad-frame`, `unknown-program`, `bad-path`, `proto`, `config-save`.

**Gating, in the helper, on every frame:** enabled, not panicked, not paused, a foreground window whose process is on the allowlist, at the helper's integrity level or lower (an elevated window is refused and reported), and within that program's scope: keys only with `keyboard`, buttons, motion and wheel only with `mouse`. `gamepad` is reserved for a virtual controller. Everything held is released whenever the foreground changes.

## 8. Extending

- New device classes (wheels, pedals, knobs, custom hardware) declare `caps` and reuse the STATE fields they need. Anything else goes in new ctl messages.
- Shared scenes (CATALOGUE §5) use `scene` and `claim`. Input packets need no change: the host knows which participant each connection belongs to. A device that bridges several controllers (CATALOGUE §6) will open sub-participants with a `seat{op, seat, name, kind}` message, and their packets will carry the seat index.
- New kinds of control go into the catalogue (CATALOGUE §8) with a stable id, and reuse PAD, STATE or POINTER fields where they can; a new packet type is the last resort.
- The high nibble of byte 0 carries the packet version and the low nibble the type (`0x11` STATE, `0x12` PAD, `0x14` POINTER), so a batched v2 STATE or a native 200 Hz variant can use `0x21`. Receivers MUST ignore packet types they don't know.
- Future work: a short-code pairing flow (commit-reveal ECDH with a SAS compared on both screens), resume without rescanning over the room service (the direct code of §2a already covers the LAN), a WSS relay fallback, and a registry of controller profiles.
