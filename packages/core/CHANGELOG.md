# Changelog

## 0.2.0

- The README gives the install line.
- The code is the same as in 0.1.0, which already carried the pose source: `PoseSource` (`'camera' | 'model' | 'unknown'`), `PoseState.source`, and byte 29 of the POSE packet (0 unknown, 1 camera, 2 model; `encodePose` takes an optional `source`). This version is here so core and `@obpal/host` share a number.

## 0.1.0

First release: the STATE, PAD, POINTER and POSE codecs, pairing and its HMAC binding, room signaling, the direct LAN code, the control catalogue (utilities, routes, profiles and controllers) and the device-side link.
