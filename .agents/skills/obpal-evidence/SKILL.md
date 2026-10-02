---
name: obpal-evidence
description: Produce comparable before-and-after visual and timing evidence for ob.Pal UI, simulation or motion changes, including contact sheets and frame strips.
---

# Evidence that a reviewer can compare

Put distilled captures, numerical measurements and logs in ignored `artifacts/<task>/before/` and `after/`. Capture the baseline before editing; record the source sha, scenario, viewport, DPR, camera/pose, device or emulation, motion preferences and tool versions alongside the evidence. Never commit captures or local paths. Test fixtures belong in a temporary folder.

Match before/after framing, lighting, controls, poses and timing. Capture desktop and phone widths when layout is affected, including open controls and long labels. A rendered model image supplements a live browser capture; it does not establish live appearance or frame rate.

Make a contact sheet with identical cell sizes and labels identifying state, viewport and revision. For motion, make a frame strip at fixed timestamps or reproducible simulation phases. Include rest, peak travel, reversal, contact and settle as relevant. Distil by default with `pnpm run distill -- <evidence dir>`; use `--keep-raw` only on request. Store raw frame dumps in TEMP with `rawRun(out)` from `scripts/lib/distill.mjs`, never directly in artifacts/. Legacy dumps belong under `raw/`, `frames/` or `*-frames/`; keep summaries at the top level. Label dropped or missing samples. The verified manifest retains frame SHA-256 hashes, counts, sizes and timestamps, first/worst/last and failure keyframes, a contact sheet and short failure clips. Raw images are deleted only after verification. Use repository proof/report scripts where their scenarios match, such as `scripts/contact-report.mjs` for contact runs.

For timing, warm up separately, state sample duration and device, retain raw frame/work timings and report sample count, median, p95 and maximum. Separate scheduling intervals from measured CPU/submission/GPU work; avoid adding overlapping measurements. Record cold/warm loading separately. Browser emulation proves layout, not physical-phone performance, camera accuracy, thermals or end-to-end motion latency.

Inspect the sheets/strips at readable scale before hand-back. Report the exact evidence directory, key files, scenario coverage and any unmeasured claims.

For deterministic classification, write `evidence-frames.json` beside the summaries: `{ "expectedCount": 3, "fps": 24, "frames": [{ "path": "scenario/0.png", "timeMs": 0, "diff": 1, "threshold": 2, "failed": false }] }`. Paths are relative to the raw TEMP root (or legacy evidence root). Record all failure frames, even if no pixel score applies. Missing counts and threshold breaches are failures; unmeasured images are unclassified. `--model` adds advisory judgement through the existing small-model wrapper, without changing the measured status. Inspect the retained proof before hand-back.
