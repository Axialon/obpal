# Sound in the sims

Each of the 41 catalogue entries has a profile in `src/sim/audio/profiles/`. Profiles read positions and motion from logic, independent of the models. A small synchronous bus carries contact begin (normal speed and impulse), contact sustain (rolling or scraping), motor state (normalised RPM and load), and actions. Existing device notifications map into this bus; physics adds contact data where it has it. No scene invents collisions from controller input.

One lazily created AudioContext serves a sim page. The listener follows the camera passed to the shared renderer, including first-person and the XR camera. Sources use HRTF panners, metres, inverse distance attenuation, and scene-specific reference distances. The Viewer has the same listener hook. The studio retains its instrument voices, envelopes, room reverb and immediate delivery; only its seat panners change to spatial panners on the shared context.

Room, hall, yard, underwater and sky have deterministic generated stereo impulse responses. One convolver per space mixes a quiet reverberant return. Underwater also low-passes the mix. The sky has a very short, near-dry response. All buffers are original procedural synthesis: material resonances and filtered noise for impacts; periodic harmonic and noise textures for motors, rotors, servos, hydraulic pumps, rolling, scraping, water and ambience. No downloaded samples or additional asset licences.

Material pairs combine metal, rubber, tile, wood, plastic, glass and water. Impact amplitude follows bounded incident speed and impulse; water favours noise, glass and metal ring, rubber damps. Sustained voices follow simulated motion, RPM and load, with smoothed pitch and gain. Dog footfalls follow gait crossings. Actions include grab, launch, fire, dock and sonar.

The effects engine has 32 reusable spatial strips, including ambience and movement. It steals the quietest low-priority voice first, reserves higher priority for contacts, and ducks the mix with concurrency. Buffers are generated once at unlock, source strips are pooled, motion is sampled at 20 Hz, and Web Audio schedules envelopes. The rover combines motor and tyre grain in one buffer on each chassis to save a second HRTF pass. A compressor and bounded waveshaper limit the master. Contacts on the same source are coalesced within 70 ms. The studio retains its separately tested instrument budget.

The first screen gesture unlocks audio; nothing queues before unlock. The panel offers mute and reduced sound, persisted independently of reduced motion. Reduced sound lowers level and removes continuous textures. Hidden pages suspend audio and stop haptics; returning pages resume after a gesture. Page teardown releases sources and context. Haptics remain independent of audio mute.

The same addressed events send the owning phone dual-rumble messages. Contact strength controls bump duration and magnitude; motor texture is weaker and servo steps tick. A participant receives at most one effect per 100 ms and continuous textures at most once per 400 ms. Unclaimed objects make sound without buzzing somebody else. The phone's Feedback setting suppresses remote rumble and local ticks; connected gamepad actuators on that phone receive the same magnitudes and duration. Browsers without vibration retain the existing visual response.

Validation covers catalogue coverage, event mapping, impact scaling, stealing and feedback limits, then actual audio unlock, sources, camera pose, phone delivery and suppression in browser tests. Evidence uses canvas video plus the engine's post-limiter audio capture stream. CPU is measured with Chromium's WebAudio realtime metrics (render capacity), separately from main-thread update cost. Measurements record four-player load, graph counts and limitations; they are evidence for the measured machine, not a guarantee for every phone.

Web Audio references: [spatialisation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics) and the [Web Audio specification](https://www.w3.org/TR/webaudio-1.0/).


## Round 2 — acoustic design and audit (2026-09-28)

This section supersedes the round 1 buffer, mixing and voice descriptions above. The original HRTF listener, gesture unlock, addressed feedback and instrument path remain. The problem was acoustic identity: several unrelated machines were variations of one three-harmonic oscillator, and their load mainly changed a low-pass filter. A fixed 16 Hz rotor tremolo, an electronic grab beep and a high-pitched drive motor standing in for a vacuum were particularly unconvincing.

The audit rendered every profile from the round 1 baseline `bbba4f7` and the revised engine with identical telemetry. The local listening page is `artifacts/codex-audio2/index.html`; the WAVs, matched MP3s, spectra, captures, scripts and measurement JSON are ignored evidence, never repository assets. Native playback exposes the actual mix; the fixed-gain matched option removes loudness advantage. The studio comparison is an unchanged spatial reference tone, not an instrument audition.

### Reference and technique choices

These are mechanism-informed acoustic models, not measured replicas of particular products. [Maxon's gearhead reference](https://www.maxongroup.com/assets/public/caas/v1/media/168506/data/32bb5bfabd9ce7d852292f275410c997/knowledge-support-support-antriebswissen-kurz-erklaert-gear-download.pdf) identifies input-stage speed and tooth contact as important noise sources. The servo model therefore separates commutation harmonics, gear-mesh sidebands and loaded chatter. Pitch follows measured speed; load crossfades the body without making a blocked motor race. The arm hook includes real held-block mass and blocked, floor and limit states.

[NASA's rotor measurements and model](https://ntrs.nasa.gov/api/citations/20200002566/downloads/20200002566.pdf) distinguish blade-pass harmonics; [NASA's gust-interaction work](https://nas.nasa.gov/pubs/ams/2026/03-12-26.html) describes load fluctuations, sidebands and broadband changes. The chosen approximation separates blade-pass tones, commutation, slightly different rotor rates and turbulent loading. Bank and angular-rate telemetry modulate the load layer. Helicopters use a much slower pulse train; the plane has a propeller identity. Takeoff no longer plays an impact. Relative source/listener velocity gives bounded Doppler; teleports and camera cuts are rejected.

The vacuum needed a recording: [Freesound 266099](https://freesound.org/people/wjtaylor/sounds/266099/) contains the dense fan/airflow spectrum missing from round 1. It is filtered and layered with procedural body texture. Cleaning state drives suction independently of travel. This distinction also matches [iRobot's separation of cleaning-path/brush noise](https://answers.irobot.com/knowledge/32687). Robot-dog gait phase drives actuator speed and stance load; alternating recorded contacts supply the short, irregular sole strike which a two-tone resonator lacked. The dog's electric mechanism remains a servo model, not a hydraulic animal.

### Profile-by-profile critique

| Profile | Round 1 shortcoming | Round 2 choice |
| --- | --- | --- |
| arm5 | Generic low three-tone buzz; no mesh or blocked-joint sound. | Reduction gear whine and mesh sidebands; independent load chatter, grip latch and blocked/limit strain. |
| so101 | A sped-up copy of arm5, without a small actuator signature. | Brighter 265 Hz reference motor with an eightfold gear mesh; restrained trim and the same real payload/limit hooks. |
| six | Pitch alone implied scale; the industrial arm had no heavier drive body. | Lower 115 Hz motor and dense ninth-order mesh, with load-dependent body and restrained upper harmonics. |
| scara | Same servo buzz as every other arm. | 205 Hz drive, sixth-order reduction mesh; fast translation changes pitch without coupling load to speed. |
| delta | Thin pitched buzz, without rapid gear texture. | 295 Hz light mechanism, softer fifth-order mesh and short, smooth speed transitions. |
| desk | Generic whine and electronic grab beep. | Midrange 165 Hz drive, sixth-order mesh and a small recorded latch. |
| drone | 80 Hz base with fixed 16 Hz tremolo suggested a toy helicopter; no rotor interactions or banking. | 190 Hz reference blade pass with nearby rotor rates, harmonics, commutation tone, turbulent load layer, bank roughness and relative-motion Doppler. Takeoff uses spool-up, without an impact cue. |
| helicopter | Just the drone loop down-pitched; the fixed tremolo was unrelated to blades. | 28 Hz reference blade pass with a sharper pulse train and broadband loading, slower blade slap and subdued high motor tone. |
| plane | Combustion buzz lacked a propeller signature. | 105 Hz propeller harmonics, airflow and throttle-linked RPM; bank load and pass-by filtering. Gliding does not run a powered motor. |
| dog | Continuous buzz plus the same abstract impact as other collisions; little relation to stance. | Gait-phase servo RPM and stance load, two alternating recorded concrete foot contacts, pitch variation and a distinct short strong footstep haptic. |
| rover | Generic 90 Hz motor with load effectively on/off; indistinct tyre grain. | 125 Hz commutation and reduction mesh, acceleration/steering load, textured tyre grain sharing the drive panner, and recorded body contact under material resonance. |
| vacuum | A drive motor shifted up two octaves; suction was absent and movement changed its supposed fan. | Recorded suction crossfaded with procedural impeller/body texture; cleaning state controls the fan, motion controls wheel grain, and load gently varies filter and pitch. |
| tank | An engine loop and smooth generic rolling sound; no track links. | Low irregular firing harmonics, loaded engine body and a separate track-link pulse/grain layer driven by travel speed. |
| excavator | Low motor buzz called hydraulics; missing valve hiss and load response. | Pump harmonics with independently crossfaded pressure hiss and mesh energy; joint motion and payload drive it. |
| forklift | Hydraulic buzz covered both drive and lifting; load was mostly an EQ change. | Higher pump reference, pressure hiss, tyre grain and recorded wood contact for pallets. Drive/lift still share the available aggregate telemetry. |
| boat | Smooth low oscillator engine, with white-noise wake. | Irregular firing/body harmonics and lower, coloured wake noise, with speed-driven filtering and softer outdoor return. |
| submarine | Generic motor muffled by a global filter; little body or water movement. | Low drive/propulsion harmonics, separate coloured water movement, water-speed Doppler and distance filtering; sonar remains a deliberate cue. |
| kart | Simple bass oscillator engine and bright scrape. | Richer firing harmonics, loaded exhaust/body grain and a bounded tyre-scrub layer when drifting. |
| slotcars | A high copy of the rover, with conspicuous high-frequency grain. | 270 Hz brushed drive/reduction mesh, softer electrical rasp and wheel/rail grain tied to speed. |
| planetary | Generic motor and roll, despite slow geared travel and sampling. | Low geared drive, uneven travel grain and sampling/joint-load colour. This is an audible operator sonification in the depicted scene, not a claim that sound propagates through vacuum. |
| sorting | Motor loop had no conveyor identity; docking was a tone. | Low belt-drive/gear texture and recorded latch/body contacts for the mechanism. |
| claw | The same arm whine, with glassy contacts and a grab beep. | Midrange carriage servo mesh, load roughness, recorded latch and retained material resonance. |
| ptz | Disproportionately prominent servo for a small camera. | Quiet 210 Hz gearmotor with subdued mesh and a short shutter/mechanism click. |
| gimbal | A bright hobby-servo sound implied a noisy gearbox on a quiet stabiliser. | Very restrained commutation/drive tone, little mesh emphasis and quiet contact cues; the intended category trim is deliberately lower. |
| spotlights | Generic pitch-shifted servo filled the hall. | Slower, quieter pan/tilt gear drive and much shorter, quieter hall return. |
| telescope | Loud toy-servo motion under sky ambience. | Low, restrained mount drive and mesh; almost dry outdoor placement. |
| slider | Arm-servo buzz on a linear camera rail. | Belt/drive motor texture with smooth low-speed pitch and restrained carriage clicks. |
| jib | Low-pitched servo suggested a motor continuously dominating a camera crane. | Quiet slow mechanism drive, gentle mesh and subdued hall reflection. |
| smarthome | A generic motor covered fan and blind motion. | Broad fan airflow with low rotational harmonics, subdued switching contacts; the current shared telemetry still combines the small household mechanisms. |
| lamp | Switches were musical ticks, and the room always had synthetic air. | Recorded small mechanism click; no continuous motor or fabricated indoor wind. |
| painter | Bright generic scraping and electronic ticks. | Softer band-limited friction controlled by brush motion, with restrained contact cues. |
| pendulum | Swing speed drove a servo even though this mechanism is passive. | Remove the invented motor and room wind; retain quiet physical contact/action cues. |
| trebuchet | Hydraulic texture on a wooden mechanism, with a metallic launch pop. | Low wood/friction strain, recorded wood contact and a material-matched release. |
| football | Servo tone followed manually moved rods. | Friction/rod texture and recorded wood contact instead of an electrical drive identity. |
| airhockey | Bright scrape and metallic launch; excessive hall wash. | Soft sliding friction, recorded wood/body puck cue and quiet early reflections. |
| pinball | Abstract rolling noise and identical launch impact. | Higher small-ball rolling grain, recorded mechanical launch/latch and mixed material impacts. |
| marblerun | White-noise roll overwhelmed the small marble identity. | Lighter coloured rolling texture, wood release/contact and bounded top end. |
| maze | Generic rolling grain and an unrelated electronic tick. | Quiet small-ball friction/rolling, recorded wood contact and damped glass/wood resonance. |
| arena | Uniform roll and synthetic metal/rubber impacts. | Lower body rolling grain, material resonance layered with recorded body contact and softer hall return. |
| viewer | Generic servo could imply machinery for arbitrary moved objects. | Keep spatial contacts/actions and remove an invented universal motor; the camera listener is unchanged. |
| studio | Instrument quality is outside this task. | Instrument voices, timing and reverb are unchanged. The A/B file is the same short spatial reference tone on the seat panner, not a rendered instrument. |

### Mix, implementation and feedback

`models.ts` maps RPM, load and bank independently. `tuning.ts` specifies all 41 identities, frequencies and trims. Sustained mechanical voices crossfade two excitations; simple surfaces use one. Rover tyre grain shares the drive voice. Nearby mechanisms on one body share an HRTF panner at their moving centroid, refreshed once per 50 ms after joint telemetry arrives. Each voice retains its own pitch, load, filter and Doppler. Arms retain the three dominant actuator voices, with ownership taking priority and a 20% loudness margin before replacing a similarly ranked voice. Contacts and footsteps retain their own spatial positions. This makes the four-arm case affordable without reducing every arm to one oscillator.

Four-second procedural loops and the six-second suction loop have overlapped seams, independent offsets and slow rate variation. Recorded arrivals crossfade out of synthesis; no queued event suddenly replays when loading finishes. Voice starts, releases, replacements and stolen voices have gain envelopes, including a value-preserving fallback where [cancelAndHoldAtTime is unavailable](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/cancelAndHoldAtTime). Voice level and layer blend share those envelopes, avoiding redundant gain processing. The 32 voice strips remain pooled; unused panners and empty spatial groups are disconnected. Owned motors outrank background contacts, then owned contacts/actions, then unowned motion and ambience. Concurrency ducking and the final post-trim limiter protect headroom.

Nominal reference-programme targets are −26 LUFS for mechanisms, −24 for vehicles/flight, −28 for household machines, −27 for table/water sounds and −32 for passive props. Individual level trims intentionally lower small/quiet devices. Fixed profile calibration avoids an AGC pumping with every collision. Generated and recorded buffers use gated K-weighted normalisation, a bounded 12 dB boost and a −3 dBFS buffer peak ceiling. The final limiter follows the master trim. High-pass EQ removes excess rumble; each source loses high frequencies with distance. Room/hall reflections are short and quiet; outdoors is near-dry. Passive objects, indoor rooms and yards no longer acquire fabricated continuous wind; ambient beds are confined to sky and underwater spaces.

The same ownership and rate gate drives distinct dual-rumble envelopes: servo stall 65 ms with stronger low-frequency weight, hard bank 45 ms with stronger high-frequency weight, footstep 22 ms with a short strong component. Steady hover sends no continuous buzz. The existing 100 ms participant and 400 ms continuous limits, feedback preference and gamepad forwarding remain.

### Recordings, licences and download budget

Only the following six CC0 recordings are redistributed, all credited in `src/support/open-source.json` and `src/sim/audio/assets/LICENSE.md`. No manufacturer demonstration audio is copied. Contacts are mono, trimmed/faded and high-passed; suction uses seconds 5.00–11.25 of the public HQ preview, then a 250 ms seam crossfade in the loader. Opus/WebM is preferred; network or decode failure tries MP3, then keeps synthesis. Fetching begins only on unlock and only for the current profile's set. `?no-inline` keeps small recordings out of the initial JavaScript bundle.

| Shipped name | Original and source | Licence | Opus / MP3 bytes |
| --- | --- | --- | --- |
| latch | Kenney impactMetal_light_000 | CC0-1.0 | 4,881 / 4,364 |
| body | Kenney impactGeneric_light_002 | CC0-1.0 | 2,885 / 2,636 |
| foot-a | Kenney footstep_concrete_000 | CC0-1.0 | 2,123 / 2,060 |
| foot-b | Kenney footstep_concrete_002 | CC0-1.0 | 2,112 / 2,060 |
| wood | Kenney impactWood_medium_000 | CC0-1.0 | 3,688 / 4,652 |
| suction | wjtaylor vacuum_cleaner.wav, Freesound 266099 | CC0-1.0 | 61,733 / 101,036 |

Pack source: [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds). Suction source: [Freesound 266099](https://freesound.org/people/wjtaylor/sounds/266099/). Total recorded bytes across both encodings: **194,230**, well below the approximately 3 MB budget. The isolated engine's gzip increase is **5,243 bytes**, shared and cached; this is not a whole-page comparison with unrelated merged model assets. The table below gives each profile's additional lazy sample download. MP3 is fetched only on fallback; a decode failure after a complete Opus download can incur both sizes.

### Measurements and reproducibility

The ten-second 48 kHz stereo programme holds each source at its reference distance: slow RPM 0.22/load 0.2 from 0.3–2 s; fast RPM 0.82/load 0.35 from 2–4 s; the same RPM/load 0.95 from 4–6 s; low RPM 0.02/high load from 6–7 s; then a lateral 10 m/s bank/pass until 8.3 s. Actions occur at 1.5 and 8.65 s; contacts at 3.25 and 8.95 s. Dog contacts follow a repeating diagonal-pair cadence. The offline harness uses the production graphs and a simulated context clock; it substitutes only the context factory and capture destination. This measures a reproducible programme, not every possible gameplay situation. Idle/passive profiles are deliberately much quieter.

Integrated loudness and true peak below use FFmpeg `ebur128=peak=true`. The implementation's BS.1770 meter agrees within **0.06 LU** on all 82 renders. Welch spectra separately inspect slow, fast, loaded and strain windows; the listening page shows spectrograms and spectral centroids/high-frequency fractions for every profile. For example, arm5's fast-to-loaded centroid rises from about 608 to 890 Hz at the same RPM; the drone rises from 289 to 391 Hz while preserving its approximately 234 Hz blade-pass peak. The vacuum's broad recorded spectrum differs from the old sparse motor harmonics. These measurements establish acoustic changes, not a substitute for the owner's listening judgement.

| Profile | Round 1 LUFS | Round 2 LUFS | Round 2 true peak dBTP | Added samples, Opus / MP3 bytes |
| --- | ---: | ---: | ---: | ---: |
| arm5 | -26.9 | -26.6 | -15.2 | 7,766 / 7,000 |
| so101 | -28.3 | -28.6 | -14.5 | 7,766 / 7,000 |
| six | -24.8 | -25.8 | -15.4 | 7,766 / 7,000 |
| scara | -28.2 | -27.3 | -15.0 | 7,766 / 7,000 |
| delta | -28.6 | -28.6 | -14.9 | 7,766 / 7,000 |
| desk | -27.6 | -27.3 | -14.4 | 7,766 / 7,000 |
| drone | -27.3 | -25.3 | -12.2 | 7,766 / 7,000 |
| helicopter | -27.5 | -23.9 | -8.6 | 7,766 / 7,000 |
| plane | -24.8 | -24.9 | -12.2 | 7,766 / 7,000 |
| dog | -26.7 | -26.5 | -10.8 | 7,120 / 6,756 |
| rover | -24.2 | -24.0 | -12.9 | 7,766 / 7,000 |
| vacuum | -26.1 | -30.0 | -15.8 | 69,499 / 108,036 |
| tank | -51.3 | -23.7 | -13.4 | 7,766 / 7,000 |
| excavator | -25.8 | -24.3 | -11.9 | 7,766 / 7,000 |
| forklift | -24.3 | -24.8 | -12.3 | 3,688 / 4,652 |
| boat | -28.0 | -27.7 | -15.9 | 0 / 0 |
| submarine | -24.6 | -26.7 | -16.2 | 0 / 0 |
| kart | -25.6 | -25.2 | -13.0 | 7,766 / 7,000 |
| slotcars | -26.0 | -26.8 | -12.6 | 7,766 / 7,000 |
| planetary | -24.7 | -25.7 | -13.3 | 7,766 / 7,000 |
| sorting | -24.8 | -27.8 | -15.5 | 7,766 / 7,000 |
| claw | -26.7 | -27.2 | -14.7 | 7,766 / 7,000 |
| ptz | -28.5 | -30.4 | -14.6 | 7,766 / 7,000 |
| gimbal | -28.6 | -34.4 | -14.7 | 7,766 / 7,000 |
| spotlights | -26.4 | -30.4 | -15.4 | 7,766 / 7,000 |
| telescope | -25.5 | -31.7 | -15.3 | 7,766 / 7,000 |
| slider | -26.8 | -29.9 | -14.7 | 7,766 / 7,000 |
| jib | -25.2 | -31.4 | -16.3 | 7,766 / 7,000 |
| smarthome | -24.7 | -33.5 | -15.5 | 7,766 / 7,000 |
| lamp | -25.7 | -35.3 | -18.5 | 7,766 / 7,000 |
| painter | -33.0 | -28.1 | -7.3 | 0 / 0 |
| pendulum | -24.1 | -37.1 | -19.9 | 3,688 / 4,652 |
| trebuchet | -29.1 | -27.2 | -13.0 | 3,688 / 4,652 |
| football | -25.9 | -29.7 | -12.5 | 3,688 / 4,652 |
| airhockey | -31.9 | -28.1 | -6.0 | 3,688 / 4,652 |
| pinball | -27.9 | -27.0 | -6.3 | 7,766 / 7,000 |
| marblerun | -29.5 | -29.6 | -7.2 | 3,688 / 4,652 |
| maze | -32.1 | -29.5 | -7.7 | 3,688 / 4,652 |
| arena | -31.6 | -26.6 | -6.2 | 7,766 / 7,000 |
| viewer | -25.5 | -35.3 | -18.2 | 7,766 / 7,000 |
| studio | -27.7 | -27.7 | -25.7 | 0 / 0 |

The four-connected-phone rover test measured **7.81% mean audio render capacity**, with a **10.72% maximum** (ten 300 ms-spaced Chromium WebAudio samples). The round 1 baseline averaged 12.37% on the same run setup. The first layered revision averaged 16.59%; disconnecting inactive strips, removing the fabricated yard wind and sharing body spatialisation removed that regression. A separate four-arm stress test alternates real inverse-kinematic targets and grips every 900 ms. With 16 joints moving, the final mix retained 12 dominant actuator voices and measured **9.75% mean / 14.73% maximum** over twenty 500 ms-spaced samples, versus 18.32% mean before grouping. The approximate 10% target is met for these measured averages, not every transient. Main-thread update time, active voice counts and raw realtime data are retained alongside the captures. These are measurements on the test machine; the arm stress uses scripted physics targets, while the rover test uses four actual browser phone connections.

Focused tests cover identity coverage, speed/load/stall mapping, bank response, relative Doppler, distance filtering, priorities, distinct feedback, K weighting/gating/normalisation, seam continuity, lazy fetching, codec fallback and disposal during decode. Browser checks cover no context or sample requests before a gesture, actual Opus-to-MP3 fallback and legacy gain scheduling, four addressed phones/gamepads, grouped-voice priorities and cleanup, watchdog re-entry, mute/reduced sound, dog motion, vacuum recordings and all existing audio scenes. Full typecheck/Vitest and the phone, sims, catalogue and pages suites are the hand-back gates. Captures and full logs stay under ignored `artifacts/codex-audio2/` after copying the test runner's temporary outputs.

Final validation against merged master 78c0273 passed all four TypeScript configurations, 1,344 Vitest cases (12 skipped), phone 19/19, sims 52/52 (including 11 audio checks), catalogue 126/126 and pages 15/15. The desktop guard reported 19 test-browser lines before and after, with no new sessions. Proof-of-work timing failures and one studio latency-tail failure passed on unchanged-code reruns; the failed logs and repeated load readings are retained with the evidence.

Remaining limits: no torque/current sensors exist for most devices, so acceleration, payload, joint motion and gait are explicit load proxies. Household and forklift aggregate telemetry still combines some mechanisms. Recorded foot contacts are processed human sole strikes used as robot sole foley; the vacuum recording is not a particular robot's fan. Browser haptics are verified through the phone/gamepad transport and emulated actuators; physical phone motors vary. The owner should judge the acoustic identity using the matched and native A/B controls.
