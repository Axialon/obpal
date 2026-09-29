# Device checklist

The physical checks behind the targets in [PLAN §1](../PLAN.md). Every number PLAN §1 asks for is measured here on real phones, talking to a real screen, or it stays unmeasured. Record results under `artifacts/` (git ignores it; the repository is public), in the table at the end, and hand the table to the coordinator. PLAN §1 stays open until a row is filled.

## What counts and what does not

- **Physical results only.** A phone in a hand and a screen on a desk. The harness's simulated results are listed at the end, apart, and are never copied into a physical row.
- **A round trip is not motion-to-photon.** The `ms` on the phone's connection badge is the control channel's ping and pong. `perf:connect`'s round trips are the same thing measured with both ends on one machine. Neither includes the phone's sensors, the display's refresh or the time to draw, so neither may be reported as motion-to-photon. That target needs a camera that sees both the phone and the screen (below).
- **Every result is k of n, with its conditions.** A percentage without its denominator is not a result. A session counts under the path the badge reported, not the one you meant to set up.
- **Percentiles by nearest rank.** Sort the n samples smallest first. The median is the ceil(0.5 × n)-th, p90 the ceil(0.9 × n)-th, p95 the ceil(0.95 × n)-th. Ten samples: the 5th, 9th and 10th. Write down every sample, so anyone can redo the arithmetic.
- **A failed attempt is a result.** A session that never reached control, or a resume that needed a new scan, counts in the denominator as a failure and as the slowest sample; it is never left out.

## Devices

At least one of each. More devices only add rows.

| Role | Minimum | Also, if you have them |
|---|---|---|
| iPhone | A recent iPhone on the current iOS, in Safari | The oldest iOS the plan supports (16.4); Chrome for iOS once (a WKWebView: watch for the Local Network prompt) |
| Android | A recent Android phone with a gyro, in Chrome | Samsung Internet; a phone with no gyro (touch only); the oldest supported Android (10) |
| Screen | A Windows or macOS computer running the Viewer (`/view/` on the site) in Chrome or Edge, on a 60 Hz display, wired to the router where you can | Firefox; a second screen refresh rate, noted |

Record for every session: the phone's model, OS and browser with versions; the screen's computer, browser and refresh rate; the site build you used (the deployed commit); the date; the phone's battery and whether Low Power or Data Saver was on.

## Paths

Tap the padlock with the milliseconds on the phone's top bar: it says **Direct** or **Relayed** (with UDP, TCP or TLS for a relay), and the round trip. Read it once the phone controls the screen, and file the session under what it says.

| Path | Set up | The badge should say |
|---|---|---|
| Direct | Phone and computer on the same ordinary Wi-Fi | Direct, "on your own network" |
| Relayed | Whichever of the next three gives a Relayed badge | Relayed |
| Wi-Fi that isolates devices | A guest network, or the router's AP or client isolation switched on, phone and computer both joined to it | Relayed, normally |
| Cellular | The phone on mobile data with Wi-Fi off, the computer on its own Wi-Fi | Whichever the carrier's NAT allows: Direct "over the internet", or Relayed |
| UDP blocked | A firewall or router rule that drops outbound UDP except DNS, for the computer or the network. Undo it afterwards | Relayed over TCP or TLS |

If a setup gives a badge you did not expect, keep the session under the badge and say so in the notes.

## Before every session

- The browser tab closed and the Viewer freshly loaded. For scan-to-control runs, also the phone's browser quit from the app switcher.
- The phone over 50% battery, brightness fixed, auto-lock on its longest setting (except in the lock test), notifications off (except in the call test), no other app in front.
- A second phone or camera ready to film, where the situation asks for it.

## Situations

### Branded camera and hand control

Run on both the iPhone/Safari and Android/Chrome rows above. Headless PC figures are development evidence only and do not satisfy this checklist.

1. On the landing page, Viewer, catalogue and a sim, tap the phone icon in the right tab and the pairing icon in the top bar where present. It must open the ob.Pal camera. The desktop counterpart must still show a QR code. Share/copy remains a separate action.
2. Scan the screen's ob.Pal QR in normal light and dim light. Check native decoding where available and worker fallback on Safari; record time to pair and ten attempts per phone. Try an unrelated URL, an altered origin/path and an incomplete code: all stay in the scanner. Test the torch and focus/zoom when the camera offers them.
3. Deny permission, remove permission in browser settings, and open the link in an in-app browser. Each fallback must lead to the same ten-digit entry. Close during the permission prompt, permit later, lock the phone, switch apps, and leave the page: the camera indicator must stop.
4. Pair to the Viewer, open Hand camera and show the other hand, first propped and then held. Hover with an open palm; hold a fist to orbit and move closer/further to zoom. Release/re-grab to ratchet. Pinch the part under the cursor; point must freeze. Try either hand, partial occlusion, hand replacement, fast movement and leaving/re-entering frame; reacquisition must not jump. The skeleton must align with the camera in portrait and landscape.
5. After a 5-second warm-up, record 30 seconds of camera fps, processed fps, sent fps, mean/p95 frame-to-send latency, inference time, delegate, resolution, dropped packets and payload bytes/s. The meter is hidden normally; a local camera-test session shows fps and mean ms. The complete numeric snapshot is on `[data-camera-metrics].dataset.measurements` for remote Web Inspector/DevTools; it contains no images or landmarks. Record whether `clock` says capture or presentation; presentation is a frame-availability proxy, not sensor exposure time. Repeat after 5 minutes and with Low Power mode, reporting any resolution adaptation and heat. Aim for processed fps matching camera fps; do not infer this from a display's refresh rate.
6. In the approved, claimed robot arm, keep Hold to move pressed and move the tracked hand. Pinch closes the gripper. Hand loss, network loss, backgrounding, release and Stop must hold both tool and gripper. Stop must require releasing the held control before motion can resume; hand visibility alone must never grant approval.
7. Inspect camera UI at 390×844 and 430×932, Lime on Carbon and from a light surface (the camera itself stays dark), enlarged text and reduced motion. Check dismissal, focus return, labels and session hints. Capture screenshots under the ignored artifacts directory. Confirm network traffic carries no images/video, all model requests stay on this origin, and only HAND/neutral STATE continues during hand control.

8. With the front camera, confirm the skeleton follows the mirrored preview and the handedness label swaps. Rotate the palm 60 degrees and check depth stability. Test both camera sides, all three live chips, the 200 ms skeleton fade, the dashed screen cursor and its 1.5 s timeout.
9. On cellular, Save-Data and unknown networks (including Safari), clear only the hand asset cache and verify the 19.5 MB confirmation precedes all model traffic. Confirm one download is reused on the next opening. Check download interruption and storage denial.
10. Hold the arm control with the hand opposite the tracked one; verify Hold and Stop remain reachable at both viewport sizes. Confirm losing the tracked hand while Hold stays pressed holds tool and gripper. Capture all four cursor states and test dock keys, editing exclusions and Stop (Space) only on the arm.

### First scan to control

Target: the median of first scan to the object moving, at most 10 s, motion prompt included.

1. Start with the phone's camera, or the in-app scanner, open on the QR code on the screen. The clock starts when you press the button that scans, and stops the first time the object moves because of the phone. On an iPhone, the tap that allows motion is part of the time.
2. Do it at least 10 times per device and path, from a cold start each time (tab closed, browser quit).
3. Time it from a film of both screens, or a stopwatch read by a second person. Note every time.

Denominator: the attempts. A session that has not reached control after 30 s is a failure (it also counts in connection success).

### Reaching control on each network

Target: at least 97% of sessions reach control, on home Wi-Fi, an isolating Wi-Fi, cellular and a UDP-blocked network.

- A session reaches control when the object moves under the phone within 30 s of the scan, with no second scan.
- Every attempt from the runs above counts, plus any other session you open on that network. Write each network's k of n and the total.
- Numbers of sessions matter more than they seem: 30 sessions with none failing shows the rate is probably above 90%, not that it is above 97%. About 100 sessions with at most 3 failing are needed to support 97%. A network with fewer than 30 sessions is "not enough to judge", and the target is judged on all four networks together.

### A 30 second lock, and resume

Target: resume at most 3 s at p90.

1. Connected, the object moving. Press the phone's side button to lock it. Count 30 s. Unlock it.
2. The clock starts when the ob.Pal page is in front again, and stops at the first response of the object to the phone (a touch on the trackpad, or a tilt with the gyro on). Film both screens with a second phone; read the time from the frames.
3. At least 20 locks per device and path, so p90 is not just the slowest. Note whether the controls came back with no new scan; a lock that needed a scan is a failed resume.

Also note the badge before and after (Direct or Relayed) and whether a "Reconnecting" line showed.

### A call interruption

No PLAN number: what must hold is that nothing sticks and the link carries on.

1. Connected, the object moving, a button held or a drag under way. A call comes in: let it ring 5 s, answer it, talk 10 s, hang up, and go back to the browser. Repeat with a call you decline or miss.
2. Record for each: was anything left held on the screen (a stuck button, key or drag); did the controls come back with no new scan; the time from the page in front to the object responding.
3. At least 5 of each kind per device and path. On an iPhone, a banner that does not take the screen may not hide the page at all: note whether the link changed.

### 20 minutes of sustained use

No PLAN number: the link must not drop, and the phone must not get hot.

1. Use it without a break for 20 minutes: gyro (1:1 or Tilt) for a minute, the trackpad for a minute, and so on, the model on screen throughout.
2. Note the battery at the start and end (readings are whole percents, so 20 minutes is a rough guide; the plan's battery gate of 10% an hour on the oldest full-tier iPhone needs a 60 minute run), how warm the phone feels (cool, warm, hot) and any thermal warning, the number of times the link dropped or "Reconnecting" showed, the badge's round trip at the start, middle and end, and any stuck input or lag you felt.
3. One run per device and path.

## The PLAN §1 targets, one by one

| Target | Measured by | Denominator | Conditions to write down |
|---|---|---|---|
| First scan to the object moving: median at most 10 s | First scan to control, above | Attempts (at least 10 per device and path) | Device, browser, path from the badge, whether the motion prompt showed, cold start |
| Resume after a 30 s lock: p90 at most 3 s | A 30 second lock, above | Locks (at least 20 per device and path) | Device, path, whether a rescan was needed, what the badge said |
| Reaching control on home, isolated, cellular and UDP-blocked networks: at least 97% | Reaching control on each network, above | Sessions per network, and in total | The network, how it was set up, the badge's path for each session |
| Phone glass to host receive, LAN, p95 at most 35 ms | **Not measurable yet.** The in-band telemetry it names is not built (PLAN §10, week 5), and telemetry is off by default (§13.7). Leave the row empty; do not fill it from the badge or `perf:connect` | Packets, once it exists (thousands, for a p95) | LAN direct path, once it exists |
| Motion-to-photon, LAN, 60 Hz display: p50 at most 65 ms | Filmed, below | Flicks read (at least 30 per device) | Device, screen refresh rate, camera frame rate, direct path from the badge |
| Motion-to-photon, relayed via TURN: p50 at most 110 ms | Filmed, below, on a relayed path | Flicks read (at least 30 per device) | As above, and the relay's protocol from the badge |
| Drift, clutch held 60 s: under 1.5° | Below | Runs (at least 10 per device) | Device, mode, the phone at rest on a table or held in a stand |
| Unauthenticated input accepted: 0 | Below | Attempts, per kind | What each attempt was |

### Motion-to-photon, filmed

Film the phone and the screen in one shot at 240 frames a second (a second phone's slow motion). Flick the phone sharply in front of the camera with the gyro on and the model on screen. Read the frame where the phone's body starts to move and the frame where the model on screen first changes; the time is the frames between them, times 4.2 ms at 240 fps. Reading a frame is good to about a frame either way, and a 60 Hz display adds up to 16.7 ms of its own by when the next refresh comes: report what you read, and say the frame rate and the refresh rate. Do at least 30 flicks per device and path. The median (p50) is the 15th of 30.

### Drift

Lay the phone flat on a table, or hold it in a stand, and turn the gyro on in 1:1, with nothing selected on the screen (the whole model is what turns) and the model at rest. In the screen browser's console, run `const q0 = __viewer.holder.quaternion.clone()`. Leave everything alone for 60 s, then run `__viewer.holder.quaternion.angleTo(q0) * 180 / Math.PI`. The number is the drift in degrees. Ten runs per device; write the worst one as well as the median, because the target is a limit.

### Unauthenticated input

Attempts by a device that does not hold the screen's current code: a phone that opens the controller page (`/p/`) with no code; a short code typed with one digit changed; the QR code of an earlier session, after the screen has been reloaded. Each attempt: the screen's `__obpal.participants.length` stays at what it was, and the model does not move. Ten attempts of each kind. Write accepted out of attempts; anything but 0 is a security fault, not a result to average.

## Results

Copy this table to `artifacts/device-results-<date>.md` and fill it in, one row per device, path and target. Do not put results in this file.

| Date | Phone (model, OS, browser) | Screen (computer, browser, Hz) | Path (badge) | Target | n | Result | Met | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## Simulated results

These are the harness's, kept apart from the physical results above, and no row above may be filled from them. They are on one machine: the phone is an emulated browser page and the screen another, both here, so no radio, no router, no phone operating system and no real sensor is involved. What they show is that the software's recovery paths run and how quickly they do their own part, a lower bound for the software alone. They say nothing about a locked phone.

| Simulated check | Run with | What it does | Result, one Windows machine, 2026-09-29 |
|---|---|---|---|
| Resume after a 30 s lock, link kept | `pnpm run perf:connect -- --lock` | Hides and freezes the phone page for 30 s, then the time until the screen has its input again | Quiet machine, n=7: median 1 ms, p90 1 ms. Machine busy with another run, n=7: median 16 ms, p90 1624 ms |
| Resume after a 30 s lock that loses the link | `pnpm run perf:connect -- --lock-lost` | The same, with the phone's connections through the site cut and the screen closing its peer connection half way, so the phone builds a new link | Before the fix below, 60 phones (7, 7, 14 and 32 in four runs): 58 resumed, medians 445 to 475 ms, slowest 1943 ms; 2 never resumed (see below). After it, 32 phones: all resumed, median 441 ms, p90 576 ms, slowest 612 ms |
| The same, with the network coming back 1.5 s after the wake | `pnpm run perf:connect -- --lock-lost --lock-net-ms=1500` | The phone's sockets are refused for 1.5 s after it wakes, as when a radio takes a moment to return | Before the fix, n=10: median 2950 ms, p90 3299 ms. After it, n=10: median 2680 ms, p90 2811 ms. The wait for the network and the signaling socket's retry backoff (up to 1.6 s) are most of it |
| The page's own recovery, pass or fail | `tests/restart.test.ts`; `pnpm run e2e:all -- phone` | Coming back to a page restarts a lost link at once and leaves a live one alone; a restart that waited for the signaling socket goes when it is back; refused motion leaves touch only; Disconnect then Reconnect brings input back | A pass or a fail, not a measurement |

Two phones in 60 did not resume before the fix (1 of 28 and 1 of 32): after 30 s, no input at the screen, the page saying "Reconnecting…", its peer connection failed, its control channel closed and its signaling socket back. It was a real fault in `DeviceLink` (`packages/core/src/device.ts`), not load: an ICE restart that finds the signaling socket down waits for it (`restartWanted`), but it had already marked the link "reconnecting", and the socket's next welcome only served a waiting restart for a link that was up, so with the path down it was never served; a path that came back by itself in the meantime never turned the link back to connected either. Five checks in `tests/restart.test.ts` fail without the fix and pass with it. It needed the socket to be down when the restart ran, and an order of events after the wake that came up about 1 time in 30. After the fix, 32 phones in the same run all resumed.

`perf:connect` writes each lock run's median, p90 and n, with its SIMULATED label, to `artifacts/perf-connect-lock.json` and `artifacts/perf-connect-lock-lost.json`. The page is frozen with Chrome's own page freeze where it takes effect; a headless page is never hidden, which that freeze needs, so the harness holds the page at a breakpoint instead, which stops its scripts and timers as thoroughly, and plays the page's visibility change itself. Run it on a quiet machine: another run alongside it shows up in the numbers.
