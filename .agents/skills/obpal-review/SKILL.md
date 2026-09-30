---
name: obpal-review
description: Self-review an ob.Pal lane change before hand-back for accurate claims, family design, control centring, safety invariants and public-snapshot privacy.
---

# Self-review

Read the final diff against the task's base, not just the latest edit. Resolve findings inside scope; hand back dependencies or unresolved risks explicitly.

- Claims: does copy match what is implemented and measured? Label phone emulation, sampled collision proofs, inference estimates and untested physical hardware accurately. Do not turn a plan's target into a measured result.
- Design: reuse family glass, typography, spacing, icons, actions and docks from surrounding code. Check desktop/phone, reduced motion, long labels, panel-open framing and focus feedback when affected.
- Centring: inspect shared controls at both sizes. Centre labels and icons within their control, preserve balanced space around adornments, and check sliders/selects and tray items visually. Avoid unrelated global CSS fixes.
- Safety: preserve observe-only connection, fresh finite input, bounds, explicit arming, held local deadman, stop/hold, tracking-loss and background/cancellation behavior where relevant. Reconnection must not silently rearm hardware. Never run a proof against the installed helper or real actuators without separate authorization.
- Privacy: scan added source, filenames and commit text with the repository scanner rules in `scripts/lib/scan.mjs`; report findings masked. Keep secrets, account identifiers, personal details and machine paths out of tracked files. Never inspect `~/.obpal-keys`. The coordinator's merge scan is the final public-snapshot gate.
- Delivery: master merged, required checks passed, one isolated rerun at most per suspected flake, evidence paths supplied, all work committed and servers stopped. State skipped or unverified checks plainly.
