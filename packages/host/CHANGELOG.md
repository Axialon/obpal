# Changelog

## 0.2.0

- `Frame.pose.source` says where a pose comes from: `'camera'` (the phone tracked itself), `'model'` (an estimate from the phone's own motion), `'unknown'` (a phone that doesn't say) or `'glow'` (the phone's glowing screen, followed by the host's camera with `GlowFollower`). `tracked` says the pose is usable, not that its position was measured.
- `Frame.pose.gen` is now the host's own count of origins. It moves on every new origin or source, never repeats, and neither wraps nor resets with the stream; before, it was the phone's byte, which wraps at 256.
- A POSE packet that is not newer than the last one accepted is ignored, whichever generation it names. Before, a late packet from another generation could replace a newer pose.
- Depends on `@obpal/core` 0.2.0.
- The README gives the install line.

## 0.1.0

First release: the host SDK (`Remote`, `PairingChip`, `Claims`, `GlowFollower`), the `<obpal-remote>` element (`@obpal/host/element`), the Gamepad shim (`@obpal/host/gamepad`) and the QR code (`@obpal/host/qr`).
