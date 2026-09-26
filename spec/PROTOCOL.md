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
- The device creates the offer. ICE servers come from `GET /api/ice?room=<roomId>`: STUN, plus short-lived TURN credentials when the room has a live host.

## 2. Pairing and authentication

1. The host generates a 16-byte secret `S` and a DTLS certificate, and takes the certificate's SHA-256 fingerprint `fpH`.
2. The pairing URL is `https://<service>/p/#1.<b64url(S)>.<b64url(fpH)>`. Because it is a fragment, the secret never reaches a server.
3. `roomId = b64url(SHA-256("obpal-room-v1" ‖ S))[0..22]`.
4. The device MUST abort if the answer's `a=fingerprint:sha-256` ≠ `fpH`.
5. When `ctl` opens, the device sends `hello` with `mac = b64url(HMAC-SHA256(K, fpD ‖ fpH ‖ roomId))`, where `K = HKDF-SHA256(S, salt=roomId, info="obpal bind v1")` and `fpD` is the device's own DTLS fingerprint.
6. The host MUST ignore all input from a peer until its `mac` verifies. Then it sends `welcome`.
7. One device is active per host. A newly bound device takes over, and the previous one receives `lock{reason:"taken-over"}`.

This defeats a malicious room service, TURN operator or network attacker. None of them can see `S` or substitute either DTLS identity.

## 3. Control messages (`ctl`, JSON)

Unknown message types and fields MUST be ignored.

**Device → host:**
- `hello{proto, caps{tier, sensorApi, haptics, platform}, mac, name}`
- `btn{id, ev: tap|down|up|double|long}`
- `value{id, v, add?}`: `add: true` when the user added a select option alongside the current one (see Layout)
- `mode{m}`
- `recenter`
- `ping{t0}`
- `bye`

**Host → device:**
- `welcome{proto, name, layout}`
- `layout{layout}`
- `state{values}`
- `feedback{haptic?: tick|bump, toast?}`
- `pong{t0}`
- `lock{reason}`
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
| 10 | u8 | tier (bits 0–1: 0 touch, 1 tilt, 2 compass, 3 gyro); screen angle / 90 (bits 2–3) |
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

## 7. Extending

- New device classes (wheels, pedals, knobs, custom hardware) declare `caps` and reuse the STATE fields they need. Anything else goes in new ctl messages.
- New kinds of control go into the catalogue (CATALOGUE §5) with a stable id, and reuse PAD, STATE or POINTER fields where they can; a new packet type is the last resort.
- The high nibble of byte 0 carries the packet version and the low nibble the type (`0x11` STATE, `0x12` PAD, `0x14` POINTER), so a batched v2 STATE or a native 200 Hz variant can use `0x21`. Receivers MUST ignore packet types they don't know.
- Future work: a short-code pairing flow (commit-reveal ECDH with a SAS compared on both screens), resume without rescanning, a WSS relay fallback, and a registry of controller profiles.
