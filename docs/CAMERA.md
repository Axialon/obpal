# Camera and hand controls

The site and phone controller use `src/ui/camera.ts`. `src/styles/camera.css` holds its presentation, separate from capture (`src/controller/scanner.ts`), QR decoding (`qr-worker.ts`), hand inference (`hand-worker.ts`) and signal processing (`hand-signal.ts`). Themes, icons, hints and glass controls come from the existing UI kit. No camera permission is requested until an opening tap.

## Entry points

This is a source audit; Safari and Android behaviour still needs the device checklist. A phone uses the existing coarse-pointer and smallest-screen-dimension-below-600 test, in either orientation. Larger tablets retain the screen role.

| Entry | Before, iOS Safari | Before, Android Chrome | Now, both phones | Desktop |
|---|---|---|---|---|
| Home right-tab phone icon | Native share sheet | Share, or copy when share is unavailable | Branded scanner | Scroll/focus the home pairing QR |
| Home primary action | Send viewer link through share | Share/copy viewer link | Scan a code; Share viewer link is secondary | Open Viewer |
| Shared right-tab phone action: Viewer, sims, catalogue, buttons, Link, privacy, support pages | Open current pairing QR or navigate to Viewer | Same | Branded scanner | Existing pairing QR or Viewer |
| Viewer/sim top-bar invite icon | Toggle pairing QR | Same | Branded scanner | Toggle pairing QR |
| Site pairing-chip phone pill, including the embed demo | Toggle pairing QR | Same | Branded scanner through the site's capture handler | Toggle pairing QR |
| Phone empty-state Scan, Settings Scan, Connections Scan another | Existing small scanner | Same | Shared branded scanner | Same controller UI |

The independent host SDK's embedded chip on third-party sites retains its existing behaviour. This site's mobile routing does not alter other hosts. The phone's Connections actions remain a screen switcher; Hand is a mode tab and Settings row only when the host advertises camera.hand. Closing restores the previous tab.

## Pairing and permissions

The scanner accepts only canonical `/p/#1.…` or `/p/#2.…` URLs at the current deployment's origin, or a complete ten-digit code. It reconstructs local destinations from validated data; no arbitrary scanned URL is opened. Short codes cross to the controller in `#code=…`, then disappear from the address bar, keeping the secret out of request logs. Pairing uses the existing HMAC/fingerprint or short-code exchange.

BarcodeDetector runs at a steady eight attempts per second where QR support works. Otherwise jsQR runs in a worker, with one pending decode. Denial, a missing/busy camera, insecure context and in-app-browser failure retain Enter a code. Torch and focus/zoom appear only where the camera advertises support. Closing or backgrounding stops tracks, pending decode and late permission results.

## Tracking and limits

MediaPipe Tasks Vision 1.0.1 and the float16 Hand Landmarker revision 1 model are self-hosted under `/models/`. Inference uses VIDEO mode in a worker, GPU first then CPU. `requestVideoFrameCallback` offers every camera frame, with a new-video-frame animation fallback on older browsers. One in-flight frame prevents an inference backlog. Capture asks for the available camera cadence up to 120 fps, starting at 640×480; resolution drops when inference cannot keep up and rises only with sustained spare capacity. This is a target, not a promise that every phone can sustain 120 fps.

Each landmark axis has a one-euro filter (minimum cutoff 1.5 Hz, beta 35, derivative cutoff 2 Hz). Gestures require two consecutive frames to engage. Grip beats pinch. Pinch and grip release early at their midpoint after three rising samples, while retaining their separate leave thresholds. A new identity, loss or a frame gap re-anchors the control. The overlay draws the filtered hand in the theme accent.

HAND is additive: older hosts ignore it. Its 144-byte layout and late-packet rules are in [PROTOCOL.md](../spec/PROTOCOL.md#hand-packet-type-6-a-camera-tracked-hand). Payload is 8,640 B/s at 60 fps and 17,280 B/s at 120 fps. A token bucket caps HAND at 18,000 B/s with a two-packet burst, reserving 2,000 B/s for neutral STATE/deadman within the 20 kB/s input budget; network headers and connection housekeeping are additional. Busy channels drop frames. The 21 landmarks are quantized to 0.5 mm, which is wire precision, not a claim about optical accuracy.

MediaPipe's world landmarks are hand-centred. Translation comes from image position and model palm size with a nominal 60-degree horizontal field of view, so it is a monocular relative estimate. Depth uses the smaller of the palm-width and palm-length estimates to resist rotation. Occlusion and an inaccurate field-of-view estimate still affect depth. No calibration step is required: motion is relative within each clutch. Coordinates are x right, y up, z toward the camera. Confidence carries the model's handedness score; detection/presence thresholds are separately set to 0.65 and tracking to 0.6.

Viewer: open palm moves only the seat cursor. A fist clutches the world (7 rad/m orbit with mouse drag signs, exponential depth dolly beyond a 1.5 cm band). A 45 ms one-pole smoother replaces camera-controls smoothing. Pinch grabs the part under the cursor; point freezes. Release and re-grab to ratchet. Arm: approval and a whole-arm claim remain required; Hold to move is a deadman, palm motion drives the tool, pinch closes the gripper. Stop remains visible in the camera and requires a fresh held press after resuming. Loss holds both tool and gripper. Gyro, PAD and POSE controls are released before camera HAND starts, and only the selected connection receives it.

## Proof and device review

`pnpm run e2e:camera` uses a real fake-camera Y4M QR clip and an original generated hand fixture, with a separate synthetic-landmark seam for repeatable gesture/loss cases. Generated videos, screenshots and measurements go to a temporary folder printed by the runner. Copy evidence into ignored `artifacts/camera/` for review. No test writes captures into the source tree. `tests/fixtures/camera-hand.png` is the original generated source asset, not a device capture: made with the built-in image generation tool, using an anonymous adult open palm on a gray background, five visible spread fingers, natural light, no face or identifiers. It is not evidence of a real person's hand or a real camera.

Measurements report camera, processed and sent fps separately, inference cost, mean/p95 frame-to-send latency and the timestamp source. If capture time is unavailable, presentation time is a frame-availability proxy. PC headless GPU results and generated video do not establish iPhone/Android performance or optical accuracy. Use [DEVICE-CHECKLIST.md](DEVICE-CHECKLIST.md#branded-camera-and-hand-control) for device evidence. Frames stay on the phone; only landmarks and control state leave, as described in [SECURITY.md](../spec/SECURITY.md#14-local-camera-processing).

## Reviewed camera design

Hand mode starts on the front camera and mirrors both the preview and camera-space x coordinates, with the handedness label swapped. Flip appears when the camera reports multiple video inputs. Scanner mode starts on the rear camera. Skeleton coordinates pass through the same cover transform as the video, in a DPR-aware canvas capped at 2. Loss fades for 200 ms. The screen cursor holds a dashed ring for 1.5 seconds, then hides.

Camera chrome always uses dark frost and the active family accent. The island replaces stacked mode/status/privacy copy. The lock explains local processing; its words appear once per session. Live gesture chips teach hover/orbit/grab, or tool/gripper on the arm. Hold stays opposite the tracked hand and Stop stays on its outer side. The hand hint points to the island and dismisses after at least 10 degrees of fist travel plus a pinch. Scan brackets breathe until a code is found, align to decoder corners in 180 ms and navigate after 360 ms. A rejected string is ignored for two seconds, with 600 ms of red brackets.

Cellular, Save-Data and unknown connections get a one-tap 19.5 MB download confirmation before any model traffic. Only reported Wi-Fi or Ethernet without Save-Data skips that first-use prompt. This covers Safari, where the [Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API) is unavailable. The model and selected SIMD or non-SIMD runtime are cached under a versioned key, with progress while downloading. No images enter that cache. Storage denial still permits tracking but cannot guarantee the next download is avoided.

Metrics remain available in data-measurements. The visible meter requires the explicit local camera-test switch, latched at arrival before pairing removes secrets from the URL.

## Shortcuts

The primary action is Scan on phones and Pair (P) on screens. Up to four page actions follow, then Fullscreen (F), Sound (M) where offered, and Theme (T). Viewer offers Open (O), Reset (R), Camera (C). Sims add Switch controller (K) when multiple controllers are available; the arm also offers Stop (Space). K cycles the lead phone through the host's advertised controller choices using its existing per-participant layout message. It opens pairing when no phone is present. Home and reading pages offer Viewer, Sims and Link on 1–3.

The question-mark key opens the dock and focuses its first item. Editing, modifiers, repeats and handled keystrokes are ignored. Keycaps appear only on hover-capable pointers. Desktop Pair toggles the existing chip. The home page retains its in-page pairing card and scroll/focus action.

## Round-two acceptance

The executable acceptance checks are in tests/camera-round2.test.ts and scripts/e2e-camera-design.mjs, in addition to the original camera suites. Evidence is copied from their temporary directory to ignored artifacts/camera/round2/. The browser harness holds the real scan navigation callback only for lock-on screenshots, and separately asserts its production delay is 360 ms. Hand pose evidence uses the documented landmark seam with real capture timing, filtering, HAND and WebRTC; actual-model measurements are recorded separately.

Remaining device review: comfort-band messaging during foreshortening, thumb reach around Hold with either hand, rotation-dependent optical depth, warm-device tracking cadence, and the download experience in browsers without connection information. The reviewed clutch, held deadman, front camera and dark-chrome decisions are implemented.
