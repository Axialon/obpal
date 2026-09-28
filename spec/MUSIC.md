# Music studio

Wave 2 of the sims programme. The studio is eight instruments in one shared room,
with `face.drums` and `face.keys` offered only by screens that name them.

## Calibrated air stick

[CONTROL-SPACE.md](CONTROL-SPACE.md) defines the object kit arc, mallet bars,
cymbals and 75 scene surfaces, with a phone map and Lime feedback on the aimed
surface. Set position captures the phone's heading and elevation; ±35° / ±25°
spans the workspace. Hold Strike to arm, aim, then flick downward. Upward recoil
does not strike. Peak acceleration sets velocity; a quiet recovery and 100 ms
refractory period prevent repeats without dropping the next deliberate beat.

The phone snapshots aim and time at the peak, with at most 35 ms spent finding
it. `music.event` optionally carries `aim` and `scope` on hits. The screen resolves
that snapshot immediately and validates scope and occupancy. A scene strike
keeps the player's claim, polyphony budget and release ownership, while using
the struck station's voice and spatial bus. No render-frame target lookup or
audio buffering is added.

The control-space e2e uses 16 warmup and 80 measured acceleration strikes. It
reports all four percentiles for capture-to-schedule, event dispatch, detection
and emission-to-schedule. The full path includes detection; the handler gate
starts at emission, separating the sensor peak search from transport and audio.
It applies the same median <35 ms, p90 <100 ms and handler median <15 ms gates,
in addition to the independent Drums and Keys touch gates below.

## Feel and latency

Target on a local network: event to scheduled sound median below 15 ms, p95 below
35 ms; estimated event to speaker below 50 ms where the output device permits it.
These are targets, not a claim about every phone, relay or Bluetooth speaker.
The budget is roughly 1 ms input handling, 1–10 ms local DataChannel delivery,
1–3 ms synthesis scheduling, the compressor's 6 ms pre-delay, and the
browser/device's reported output delay. The 3 ms attack ramp softens clicks.

Create one AudioContext with `latencyHint: 'interactive'`, resume it from the
screen's first interaction, and schedule at currentTime. Read baseLatency and
outputLatency rather than assume a buffer size. A local haptic tick accompanies
each hit; no local click by default because two speakers would create a flam.
Live hits have no jitter buffer: extra consistency would cost immediacy. The
existing reliable ctl channel preserves note releases and chords; network loss
can therefore delay attacks. A future unreliable music stream needs an explicit
note-state recovery contract, not just dropped releases.

Music uses the existing value envelope, with bounded JSON in music.event.
music.sync exchanges phone and host monotonic epoch times. The phone uses the
lowest-RTT sample to translate capture time to host time and reports RTT/2 as
uncertainty. Do not confuse this estimate with acoustic latency. The local e2e
records real PointerEvents on emulated phones, crosses authenticated WebRTC,
and records host time immediately after scheduling, plus scheduled lead time.
Report median, p90, p95 and p99, sample count and clock uncertainty. A separate synthetic
eight-phone load measures scheduled events, frame times and Web Audio metrics.
Physical microphone/loopback measurement is still needed for speaker latency.
The touch run also records handler-entry time minus PointerEvent.timeStamp.
Subtracting each event's dispatch delay estimates the application path, including
DataChannel delivery; this is reported alongside the full event-to-schedule path.
It is not a direct measurement of touch-controller scanning or sensor hardware.

## Instrument controls

Pads attack on pointerdown. Velocity uses real pressure when distinguishable from
the Pointer Events default 0.5, then contact area, then distance from the pad's
centre and incoming pointer speed. It never waits for a harder press. Kit and
hand-drum layouts retain large targets in portrait and landscape.

Strike mode is held to arm. Gravity-free acceleration crosses a threshold, then
the first falling sample or a bounded 35 ms window identifies a peak; hysteresis
and a 100 ms refractory period reject rebound. Velocity follows the peak,
orientation selects the drum. At sparse sensor rates, detection waits for the
next sample; gesture timing is separate from the measured tap path.
Release, blur, controller changes and missing sensors disarm it. A visible pad
alternative always works without motion permission; secure grip and small
gestures are enough. Browser haptics on sensor events are best effort.

Keys are degrees of a selected scale and key, with octave shifts. A separate
hold-to-sustain pedal releases deferred note-offs when lifted. Tilt bends up to
two semitones; a held Air surface maps orientation to scale pitch and brightness.
Physical inputs use the existing Buttons layer and profile precedence. Music
reports controller ids with mode pad (4); no new binary mode is required.

The claim selects the voice. At melodic stations, drum pads play short scale
tones; at percussion stations, keys select drums. Held synth notes have a twelve-
second ceiling as a final backstop, independent of the one-second heartbeat.

## Sound and room

All audio is generated here: sine-sweep/click kick, noise/tone snare, filtered
noise and metallic FM cymbals, damped modes for hand drums and mallets, a warm
detuned subtractive polysynth, and a decaying modal piano. No samples or downloads.
Voices have bounded duration and polyphony. Eight seat buses feed conservative
gain, a compressor, generated short stereo reverb and a bounded final limiter.
The meter reads the final output. Default volume is low; the screen can mute.

Two simultaneous players keep independent voices, colour and envelopes, including
when they strike the same kind of drum. Claims remain exclusive per station;
changing claim, disconnecting or hiding the screen releases the affected voices.
A heartbeat watchdog prevents a suspended phone leaving a sustained note behind.

Visual thesis: warm timber and dark acoustic panels, porcelain drum heads, brass
cymbals and restrained player-coloured light on a small rehearsal stage.
Content: instruments fill the closer play view, with the complete room one tap
away in Overview; instrument seats, one clear audio-start action and a meter. Motion: damped head flex, cymbal wobble and fast light attacks
with smooth decay. Reduced motion keeps colour feedback without deformation.
Use the shared kit and batch static geometry; target <=250k triangles and <=150
draw calls. STYLE-3D.md is absent both at intake and in the master merged for
hand-back; the existing shared kit supplies the family materials and lighting.
Metronome and looper are deferred to keep live playing focused.

## Sources

- [W3C Web Audio](https://www.w3.org/TR/webaudio/): interactive latency hint,
  currentTime scheduling, baseLatency/outputLatency and audio graph semantics.
- [W3C Pointer Events](https://www.w3.org/TR/pointerevents/): contact geometry,
  pointer capture, and the default pressure value on hardware without pressure.
- [W3C WebRTC](https://www.w3.org/TR/webrtc/): ordered delivery, reliability and
  bufferedAmount. The studio deliberately keeps the existing transport contract.

## Local latency regression check

The sims suite uses Playwright's supplied Chromium, a fresh local worker and
eight separate emulated phone contexts. This is local WebRTC on one machine,
not a Wi-Fi or physical-phone benchmark. The executable reads the assigned ports
and browser from the environment. Run `pnpm run e2e:all -- sims catalogue`;
`scripts/e2e-music.mjs` supplies the studio coverage within the sims suite.

After the initial clock exchange, 32 alternating drum/key touches warm both
actual paths, including input dispatch, JIT and voice allocation. Wait for their
host samples before clearing the measurement buffers. Then measure 160 more
touches, 80 per controller, and wait for every host sample. This avoids counting
cold starts or mistaking an in-flight final message for a missing attack.
No outliers are discarded, no passing window is selected, and no automatic
retry can replace a failing measurement.

Each controller must independently meet all three regression limits:

| Statistic | Strict upper bound |
| --- | ---: |
| Event-to-scheduled-sound median | 35 ms |
| Event-to-scheduled-sound p90 | 100 ms |
| Handler-to-scheduled-sound median | 15 ms |

The per-controller limits prevent a fast drum path from masking slower keys, or
vice versa. The handler median subtracts each matched PointerEvent's dispatch
delay; it still includes DataChannel transit, synthesis work and scheduled lead
time. This tighter bound detects a persistent buffer even when a browser happens
to dispatch touches immediately. The full-path p90 bounds sustained slow delivery
while tolerating occasional scheduler stalls from other jobs. These CI limits
are distinct from the aspirational feel targets above: they do not promise that
a heavily loaded machine always plays responsively.

Always report median, p90, p95 and p99 for the full path, browser dispatch and
handler path, both overall and per controller where applicable. Percentiles use
the sorted sample at `floor(count * quantile)`, capped at the last entry. Also
report sample counts and p95 clock uncertainty. A tail such as the coordinator's
147 ms p95 stays visible without becoming a failure by itself. Missing samples,
nonfinite timings or sustained delay still fail.

To validate sensitivity, temporarily add `0.03` seconds to the `at` value in
`StudioSound.finish`, rebuild and run `node scripts/e2e-music.mjs`. This delays
actual source starts and their reported scheduled time, rather than merely
adding a number to the measured result. The 30 ms offset must fail the handler
median gate. Remove it, rebuild, and require the ordinary suites to pass. The
shipping audio path remains immediate and contains no test-delay switch.

Measurements, screenshots and the generated viewer go to a unique OS temporary
folder, whose path the runner prints. Only an explicit `OBPAL_EVIDENCE` opts into
`artifacts/codex-music/`; neither destination is committed. The viewer includes
the play view and Overview at desktop, portrait and landscape sizes. The test
checks that Overview contains the room and Reset view restores the close view.

The separate simultaneous jam records every scheduled attack, frame timings,
geometry budgets and playbackStats underruns. CDP WebAudio renderCapacity times
100 reports audio-thread render cost as a share of its realtime budget, as
[Chromium's Web Audio panel does](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/web_audio/WebAudioView.ts).
It is not whole-process CPU. baseLatency and outputLatency remain separately
reported; neither scheduling measurements nor headless underrun counters prove
physical speaker latency or continuity. The compressor's graph pre-delay must
also be included in any speaker estimate.
