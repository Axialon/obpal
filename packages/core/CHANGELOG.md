# Changelog

## 0.3.0

- The device link serves a deferred ICE restart when its socket returns, and ends the restart if the path recovers by itself.
- `encodeHand` and `decodeHand` add the 144-byte HAND packet `0x16`, with 21 hand landmarks, handedness, confidence, gestures, capture time and a generation byte; older hosts ignore this new packet type.
- `encodeBody` and `decodeBody` add the 276-byte BODY packet `0x17`, with 33 camera-based body landmarks, visibility, presence, capture time and a generation byte; body tracking runs on the phone, and older hosts ignore this new packet type.
- HAND and BODY each carry an independent sequence number; their existing packet layouts are unchanged.

## 0.2.0

- The README gives the install line.
- The code is the same as in 0.1.0, which already carried the pose source: `PoseSource` (`'camera' | 'model' | 'unknown'`), `PoseState.source`, and byte 29 of the POSE packet (0 unknown, 1 camera, 2 model; `encodePose` takes an optional `source`). This version is here so core and `@obpal/host` share a number.

## 0.1.0

First release: the STATE, PAD, POINTER and POSE codecs, pairing and its HMAC binding, room signaling, the direct LAN code, the control catalogue (utilities, routes, profiles and controllers) and the device-side link.
