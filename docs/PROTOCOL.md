# Capture protocol additions

The base transport, authentication, STATE, POSE and HAND formats remain in [the protocol specification](../spec/PROTOCOL.md). This section specifies additive BODY v1. [HUMANOID.md](HUMANOID.md) remains the phased design plan.

## BODY packet (type 7): a camera-tracked body

BODY uses the existing unreliable, unordered `st` channel without retransmission. Hosts advertise `camera.body` before offering phone Body mode. Unknown packet types remain ignorable. No existing packet changes size or field meaning; BODY is independent of STATE, POSE and HAND.

Exactly **276 bytes**, little-endian, complete snapshots; `i=0…32` follows MediaPipe Pose landmark ordering:

| Offset | Bytes/type | Meaning |
|---|---|---|
| 0 | 1/u8 | `0x17`: version 1, type 7 |
| 1 | 1/u8 | Bit 0: torso tracked; other bits zero |
| 2 | 2/u16 | Independent BODY sequence, continuous through loss and camera reopen |
| 4 | 4/u32 | Capture microseconds relative to sender session origin, wrapping |
| 8 | 1/u8 | Tracking generation, wrapping |
| 9 | 1/u8 | Count, exactly 33 |
| 10 | 2/u16 | Reserved, zero |
| `12+8i` | 6/i16×3 | x/y/z metres ×2000 |
| `18+8i` | 1/unorm8 | Visibility ×255 |
| `19+8i` | 1/unorm8 | Effective presence ×255 |

Coordinates are hip-centred: camera-right x, up y, toward-camera z. Convert MediaPipe `[x,y,z]` once to `[x,-y,-z]`. Front preview mirroring never alters BODY or anatomical indices. Existing Hand mode keeps its own mirror convention. The origin is not an arena position or a measurement suitable for robot balance.

Quantisation has 0.5 mm steps, range −16.384…16.3835 m, and rounding error ≤0.25 mm/axis. Confidence error is ≤0.5/255. These describe encoding, not optical accuracy. Encoding rejects non-finite/out-of-range coordinates, invalid counters, short/sparse arrays and scores outside [0,1]. Decoding rejects wrong length, type, count, flags and reserved bytes. Missing/non-finite/out-of-image points have zero confidence and finite zero coordinates. Low-confidence finite coordinates can remain present; consumers must gate them.

Tasks Vision 1.0.1 JavaScript exposes visibility but not separate per-point presence. The producer uses `min(world visibility, image visibility)` and bounds effective presence by that value and any explicitly available presence. Invalid scores become zero; missing model scores never become one. See the [pinned assets](../public/models/README.md) and [Pose web API](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js).

## Admission, freshness and loss

BODY passes the same authenticated peer/attention gate as HAND. Validate sequence freshness **before** comparing generation: `((new-old)&65535)` must be 1…32767. Duplicate/old packets cannot refresh freshness, even with another generation. Retain the last sequence after expiry. Capture timestamps wrap independently and are not host wall time.

`Frame.body` is nullable: `{tracked, gen, t, receivedAt, landmarks, visibility, presence}`. `receivedAt` is host monotonic acceptance time; `t` stays on the sender capture clock. Expire at 250 ms without accepted input. An explicit untracked snapshot clears tracking immediately. Host `gen` increases on wire-generation change, acquisition, reacquisition after expiry, or first packet after reset; earlier host generations are never reused. Reset belongs to a connection/source boundary. Prior workers cannot deliver into a new local session.

Shoulders 11/12 and hips 23/24 need confidence ≥0.7 for three successive frames to acquire. Confidence <0.5, absent torso, or a >0.45 m torso-point discontinuity loses tracking and resets the one-euro filters. An inference gap ≥250 ms resets them too. Missing feet may leave the torso tracked with zero foot confidence. Retargeting and robot responses are later phases.

One inference frame is in flight; busy capture frames are dropped. Capture metadata supplies `t`, with presentation time as fallback. Discard inference ≥250 ms old before transmission. Close, hidden page, blur, page exit, ended track and worker failure release camera/worker, clear local input and send final untracked phone snapshots. Capture never restarts automatically. Wire freshness does not establish physical capture age; clock alignment and conservative age checks are required before future hardware following.

## Rate and optional fingers

| Cadence | BODY bytes/s | BODY kbit/s | With 2,000 B/s control reserve |
|---|---|---|---|
| 30 fps, default | 8,280 | 66.24 | 10,280 B/s |
| 60 fps, tracker option | 16,560 | 132.48 | 18,560 B/s |

Transport overhead is extra. A shared 18,000 B/s camera bucket has a 552-byte burst allowance. BODY30+HAND30 costs 12,600 B/s; BODY60+HAND10 costs 18,000 B/s. The channel admits at most 420 pending camera bytes, enough for one BODY+HAND capture, and drops further sends. Final untracked snapshots bypass the token bucket, still respecting connection/backpressure; expiry handles lost final packets. Phone defaults to 640×480/30 and reduces inference cadence/resolution under load.

Body sends BODY only until the off-by-default, session-only Fingers toggle loads a second landmarker after consent. BODY and optional HAND share unmirrored source/capture time. Optional `Frame.hand.t` exposes the existing timestamp. Future fusion must match source, anatomical side and ≤50 ms skew and reset on generation changes. Optional HAND carries zero legacy gesture bits; Viewer Hand actions are suppressed while BODY is present. Disabling Fingers releases HAND. Standalone Hand mode is unchanged.

## Local webcam and privacy

Viewer and sims expose an explicit Body camera action. Its `BodyInput` sink uses the same framing/gating/expiry in memory without a network sender or remote participant. No frame or landmark enters local/session storage, IndexedDB, Cache Storage, HTTP, WebSocket or WebRTC. Only versioned static Lite/runtime files may be cached. Activation is never saved; the camera control reflects the actual live track. Only **phone** capture sends landmarks to the paired screen.

Camera e2e observes HTTP requests, storage writes, socket/data-channel messages, offline local inference and worker/track cleanup. An original synthetic full-body image exercises real Lite; injected landmarks separately exercise confidence, source switching and optional HAND. PC results do not verify real phone FPS, thermals or physical camera latency.

Warm offline restart also needs the worker and JavaScript loader. The content-hashed body worker and versioned `vision-1.0.1` loaders use [immutable static-asset headers](https://developers.cloudflare.com/workers/static-assets/headers/); model/WASM bytes come from the allowlisted Cache API store. No broader service worker or script-policy exception is added. Browser eviction still requires another asset download.
