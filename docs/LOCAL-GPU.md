# Local GPU testing and evaluation

Research dates: 1–2 October 2026. External links were accessed on 1 October unless noted; the pinned server flags were rechecked on 2 October. Browser repeats continued into 2 October. This investigation installed no software and downloaded no models. Browser measurements use existing repository dependencies and an existing Playwright Chromium on an RTX 4090 workstation. Model inference, training and physics runtimes were researched, not executed.

## Recommendation

The lane CLI now sets **`OBPAL_E2E_GPU=1` by default**, following the approved phone startup fix. Owner manual runs keep their existing defaults and opt in explicitly. `e2e:all` shares GPU capacity through a system TEMP semaphore, probes the actual WebGL renderer and falls back to SwiftShader when hardware is unavailable. Timing-sensitive groups take exclusive ownership. All suite browser launches use the shared options helper, preserving unrelated flags. See the scheduling rules below; the original research tables remain historical measurements.

## Shared slots and timing gates

Hardware runs share **three slots** by default; `OBPAL_E2E_GPU_SLOTS` changes that capacity. `OBPAL_E2E_GPU_WAIT_MIN` sets the shared wait before a SwiftShader fallback (default **20 minutes**). The results identify the renderer and wait fallback. Exclusive timing runs keep waiting: shared-slot pressure never converts a timing gate to software rendering. An exclusive request waits for existing holders to drain and blocks later shared admissions; requests retain their queue order. Normal completion, failed suites and handled interruption release ownership. Dead owners and reused PIDs with a mismatching process start time are reclaimed and logged; a live matching owner is never evicted. `pnpm run gpu` shows holders (lane or PID, suite and start time) and the queue.

Capacity must agree across active runs; change it when the semaphore is idle. Ownership records are created exclusively under a short coordinator mutex and atomically published with complete PID/start-time evidence. Reclaim claims remain as small token records so competing reclaimers cannot unlink a replacement mutex. Unverifiable owners fail closed. Legacy single-file owners are respected until they exit or can be proved stale; pending runs from older checkouts must finish before adopting shared scheduling across lanes.

For a bounded hardware proof, set `OBPAL_E2E_GPU=1` and `OBPAL_E2E_GPU_SMOKE=1`, then run `pnpm run e2e:all -- code` with assigned ports. Three pairing-code/QR fixtures hold shared slots while an exclusive request queues, then close their browsers and release before exclusive admission. They share one fresh local worker to stay within a lane's two ports; this does not prove three independent server deployments. The normal code suite remains unchanged when the smoke flag is absent. The outer runner delegates the smoke leases to the fixtures and retains its Desktop guard and cleanup. Distilled renderer and barrier evidence is written to `code/gpu-smoke.json`.

`scripts/lib/gpu-policy.mjs` follows the dispatchers in `scripts/e2e-sims.mjs` and `scripts/e2e-home.mjs`. A full sims run keeps its original group order and pendulum-only smoothness scope, switching ownership between contiguous shared and exclusive groups. Home remains exclusive as a full run because its pacing and audio checks are interleaved; isolated non-timing home selectors can share. Home's substring selectors are matched against timing check names, so broad selectors such as `pacing`, `viewport` and `cached obstacles` remain exclusive. Camera and shared remain exclusive as whole suites because their elapsed-time gates have no separate group selector.

| Suite or sims group | Timing-sensitive assertion or measurement | Definition |
| --- | --- | --- |
| home: warm-up | Presented/compositor startup frames and reveal timing | `e2e-warmup.mjs`, `lib/warmup.mjs` |
| home: viewport field; surface and pacing | Raw frame p95 at most 16.9 ms, including 4× CPU throttle; zero long tasks | `e2e-home-field.mjs` |
| home: contact audit; moving contact audit | A slow contact lasting more than 1,500 ms fails as stuck, measured against wall time | `e2e-home-contacts.mjs`, `e2e-home-motion.mjs` |
| home: phone knock | Application median at most 10 ms, output latency allowance +25 ms, and conditional 37 ms speaker deadline | `e2e-home.mjs` |
| sims: smoothness | Frame p95 at most 25 ms, p99 at most 50 ms, maximum gap at most 250 ms; includes warm-up and marble entrance proof | `e2e-smoothness.mjs`, `lib/smoothness-report.mjs` |
| sims: warm-up | Presented/compositor startup frames and reveal timing | `e2e-warmup.mjs`, `lib/warmup.mjs` |
| sims: physics-bench | Engine selection compares worst-fixture CPU p95 within 10% of the fastest | `e2e-physics-bench.mjs`, `src/sim/physics/decision.ts` |
| sims: humanoid-physics | Every native/narrow row must lose exactly zero clock seconds | `e2e-humanoid-physics.mjs` |
| sims: humanoid | Logic p95 below 2 ms; measured logic + render submission + GPU p95 at most 16.7 ms | `e2e-humanoid.mjs` |
| sims: humanoid-live | First runnable watchdog check within 10 ms; on-time hold at most 110 ms | `e2e-humanoid-live.mjs` |
| sims: control | Touch-to-schedule median below 35 ms, p90 below 100 ms, handler median below 15 ms | `e2e-control.mjs` |
| sims: music; p1-repairs | Same controller latency gates; eight-player frame p95 below 50 ms | `e2e-music.mjs`, `e2e-sims.mjs` |
| sims: load | Four-second delayed-mesh fallback observed between 3,500 and 6,000 ms | `e2e-load.mjs` |
| sims: marble-mobile | Entrance wall time at most 3,100 ms | `e2e-marble-mobile.mjs` |
| camera | HAND expires less than 1,500 ms after close | `e2e-camera.mjs` |
| shared | Drop/revoke propagation at most 1,000/2,000 ms; promotion/demotion at most 1,000/300 ms | `lib/share-p1.mjs`, `lib/share-p2.mjs` |

The remaining suites and isolated sims groups use shared slots. Pixel p95 in temporal checks measures intensity, not frame time. Code's pulse-start difference compares synchronized server timestamps, not elapsed browser performance. Fixed-clock simulation durations, minimum rate-limit spacing, ordinary loading/watchdog timeouts and draw/triangle/payload budgets do not require exclusive GPU ownership.
The existing `tracking` selector still executes the physics benchmark and humanoid physics prefix, so it takes exclusive ownership. `core`, `arm-live` and `control-views` are shared segments of the partitioned full run, but are not isolated `OBPAL_E2E_SIMS_ONLY` selectors: those unrecognized selectors currently enter the full suite and therefore stay exclusive.
For a separately approved local evaluation pilot, use a foreground **llama.cpp CUDA server**, **Qwen3.5-9B Q8_0 with its F16 vision projector**, and initially **keep the cloud small model for text**. Test Qwen3.5-4B Q8_0 as the later text candidate. Use deterministic image comparisons before asking the vision model to interpret changes. No local model may approve a merge, execute a suggested fix, or override a failing test.

## Phone startup follow-up

The follow-up reproduced arm phone DPR 3 startup at 0.540 s on the initial merged source: GPU warm-up passed 18/19. The same product source passed 19/19 with explicit SwiftShader. Arm and humanoid both passed in that software run, whose compositor sampling was much sparser; this does not establish absence of shorter flashes. The archived merged research separately reproduced both arm and humanoid under hardware rendering.

Retained full-page frames localize the reversal to the pairing seal, while the scene canvas remains stable. The initial QR assembly replaced a white loading plate with a dark flight plate and then returned to the white QR. Its newly visible flight canvas could also be measured by ResizeObserver before the first scheduled handshake phase, briefly drawing finished modules before returning to the source dots. A first-phase paint alone removed the reproduced arm event but still exposed a lamp plate reversal (18/19), so the final fix presents the SVG directly when its code arrives, without an initial assembly flight. The later conflict merge preserves master's family-coloured pending loader and white QR plate. Authenticated QR-to-seal flights remain, with their initial phase measured and painted synchronously once. Later animation frames add no layout reads. The warming class hides the canvas immediately; only a ready scene fades in. Scene readiness, deferred drawing-buffer resize and all stability tolerances remain unchanged.

The original phone follow-up used a single exclusive `obpal-e2e-gpu.lock` under system TEMP, with a one-second poll and a 180-minute wait deadline. That historical lease covered probe, builds, browsers and cleanup; a hard-killed owner required verified manual cleanup. The counted semaphore above replaces that scheduling policy. It does not supervise unrelated GPU programs. Windows D3D11 remains the measured hardware path; unsupported platforms and absent/software devices use the suite helpers' SwiftShader fallback. `OBPAL_E2E_GPU=swiftshader` forces software comparison; `0` retains original options.

Evidence is distilled under `artifacts/phone-flicker-gpu/before/` and `after/`, with per-scenario `startup-2s.jpg`, timestamp metadata, retained failure context and numerical warm-up JSON. Raw frames live in TEMP and are removed after verified distillation. Phone emulation measures compositor stability on this workstation, not physical-phone performance. One baseline phone run also exposed a missing runner evidence directory (fixed before suite launch) and an unrelated delayed-welcome timeout, retained for investigation.

A later button proof captured `net::ERR_NO_BUFFER_SPACE` fetching a script chunk before controls or WebGL started. [Chromium defines that error as unavailable socket buffer space](https://chromium.googlesource.com/chromium/src/+/master/net/base/net_error_list.h). Post-run socket and memory counts did not establish persistent exhaustion. The full selected run later captured the same error fetching a chunk for Slot cars; its isolated first-load rerun captured it for Drone. GPU button proofs now close their browser between viewport batches and before node strips; GPU first-load proofs use a fresh browser for each independent case. Each job retains its lease throughout, and every assertion and loading deadline remains. Software and manual runs preserve their original browser reuse. This contains browser lifetime without retrying failed assertions; the Windows error's underlying cause remains unproven.

The delayed-welcome investigation found that an ICE rebuild can shift peer creation indices. The harness now tracks the peer that delivered the second screen's welcome instead of closing index 1. Contact proofs dismiss their moving hint through its button handler and retain failure geometry; the merged master supplied the marble contact fix. Earlier failures, including startup/network diagnostics, remain alongside the successful proofs.

### Completed GPU proofs

The product and all five requested GPU groups have three passing runs on the merged product. The two earlier phone, home, warm-up and smoothness entries use `5b2debd`; later entries use `4263049`, with identical startup product files. All three bounded button runs use `4263049`. The later GPU-only browser-reuse guard preserves the same hardware behavior. `final-proof.json` records exact revisions and timing scopes.

| Group | GPU checks, each run | GPU minutes, three runs | Archived CPU minutes, three runs |
| --- | --- | --- | --- |
| phone | 189/189 | 18.39 / 18.39 / 18.33 | Not measured |
| warm-up | 19/19 | 3.10 / 3.11 / 3.11 | 4.3 / 4.1 / 4.0 |
| smoothness | 13/13 | 17.75 / 17.67 / 17.74 | 26.3 / 26.3 / 26.7 |
| buttons | 138/138 | 11.62 / 11.46 / 11.53 | 30.0 / 30.0 / 29.5 |
| home | 36/36 | 6.42 / 6.45 / 6.39 | 9.4 / 9.4 / 9.5 |

Standalone wall times include probe, build, worker, browser and cleanup. The third phone and home times come from their phase in the full selected run, excluding its shared probe. Historical CPU smoothness and button runs failed or timed out, and home had 32 checks then, 36 now. Sources and other workstation activity differ, so these are operational comparisons, not controlled speedup measurements.

The three GPU warm-ups cover 54 scene/viewport starts, with no detected clears, setup pops or broad alternations and one WebGL context per start. Arm and humanoid both pass at phone DPR 3. Explicit SwiftShader warm-up also passes 19/19. Smoothness records no startup failures across 42 entries per run; its two enforced fixtures have p95 RAF intervals of 17.6–18.0 ms. The existing report-only Drone geometry failure and other coverage gaps remain; 13/13 is not complete physics/visibility certification for all 42 entries.

The final merged master is `1c4d0ee`; a second merge used the AGENTS conflict exception for four conflicting files. The full selected GPU run at `4263049` executed all twelve suites in 99.11 minutes: phone 189/189, home 36/36, code 19/19, embed 19/19, shared 32/32, extension 29/29, camera 20/20, catalogue 133/134, contact 41/41, orientation 146/146, pages 137/137 and sims 503/505. It was not a single green run. Catalogue's landscape sheet drag and the slow-asset progress check pass on their single isolated reruns: catalogue 134/134 and graphics recovery 26/26. The first-load group reproduced the network error on its isolated rerun (34/35), then passed 35/35 in three GPU runs after the browser-lifetime change, and 35/35 again after scoping that change to GPU. These later proofs cover both failed sims assertions without weakening gates. No brief scope override was used; the full runner budget was 90 minutes per suite.

The final `pnpm run check` at `9ca9e6b` passes all four typecheck configurations and 3,392 tests, with 14 skipped (3,406 total). Suite selection remains code, embed, home, phone, sims, shared, extension, camera, catalogue, contact, orientation and pages. Every guarded browser job reports **19 test-browser lines before, 19 after; no new sessions**. Distilled results are in `after/bounded-final/`, `after/isolated-final/`, `after/post-bound/` and `after/final-scope/`; the top-level comparison is `startup-before-after.jpg` with sample timestamps. Scoped GPU capture utility proofs cover arm desktop DPR 1 and phone DPR 3 with preserved aspect ratios, zero flicker events and closed assigned ports.

An extra SwiftShader first-load diagnostic with a cold browser per case passed 32/35: Drone fallback initialization was still pending, its entrance had only two sampled frames, and its late-input entrance scale had not settled. Restoring the original software browser reuse passed 33/35: both Drone entrance cases still had only two frames after mesh arrival (the unchanged gate requires at least three). These software timing failures remain recorded; the required software warm-up passes. Physical phones and a physically GPU-less machine remain unmeasured. Renderer/fallback selection, lease contention, timeout, cancellation and idempotent release have scoped tests; no driver, registry, power or owner browser settings changed.

## Renderer and repeated measurements

The probe used `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL` in a headless page, closing each browser immediately. The installed full Playwright Chromium reported version `152.0.7977.8`; the pinned dependency wanted a newer browser, so the repository resolver selected the existing earlier Playwright installation. No browser was launched with `--version`.

| Launch | Observed WebGL renderer |
| --- | --- |
| Chromium default; sims groups have no ANGLE override | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Home main-launch default: `--use-angle=swiftshader --enable-unsafe-swiftshader` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` |
| Experimental `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` | Same RTX 4090 D3D11 renderer |

The CPU comparison explicitly forces SwiftShader for every measured launch; it is **not the current sims default**, nor the mixed default of the entire home suite. These labels identify WebGL rendering, not every Chromium compositor or encoding path. The GPU comparison replaces home’s software flags and applies the same D3D11 flags to all measured browser launches, including emulated phone contexts and warm-up browsers. Playwright's existing headless setting sufficed; a second `--headless=new` flag was unnecessary.

| Group | CPU wall, minutes (runs 1 / 2 / 3) | GPU wall, minutes (runs 1 / 2 / 3) | CPU p95, ms | GPU p95, ms | Completed passing runs CPU / GPU | Total device peak, MiB CPU / GPU |
| --- | --- | --- | --- | --- | --- | --- |
| smoothness | 26.3 / 26.3 / 26.7 | 19.5 / 18.9 / 19.1 | pendulum: 88.0 / 67.3 / 95.1; marblerun: 285.8 / 228.1 / 235.3 | pendulum: 17.3 / 17.3 / 17.3; marblerun: 17.3 / 17.5 / 17.3 | 0/3 / 3/3 | 5966 / 6043 |
| warm-up | 4.3 / 4.1 / 4.0 | 3.5 / 3.3 / 3.2 | 286.9 / 250.0 / 229.5 | 16.8 / 16.8 / 16.8 | 3/3 / 3/3 | 6073 / 5670 |
| buttons | 30.0 / 30.0 / 29.5 | 10.9 / 10.2 / 10.1 | 713.1 / 319.6 / 549.1 | 16.8 / 16.8 / 16.8 | 0/3 / 3/3 | 6929 / 7448 |
| home | 9.4 / 9.4 / 9.5 | 8.2 / 8.3 / 8.2 | 53.3 / 57.3 / 57.4 | 16.8 / 16.8 / 16.8 | 3/3 / 3/3 | 5320 / 5404 |

Smoothness p95 is the existing full rest/orbit/rest gate; other p95 columns are diagnostic document RAF samples, with the limitations below. Memory is the maximum sampled total device usage, including unrelated work. A completed passing run means all assertions passed without timeout. All retained measurement invocations reported **no new sessions**.

| Mode / group | Assertion outcomes, runs 1 / 2 / 3 |
| --- | --- |
| cpu / smoothness | 3/13 / 3/13 / 3/13 |
| cpu / warm-up | 19/19 / 19/19 / 19/19 |
| cpu / buttons | timeout (89 pass, 33 fail observed) / timeout (99 pass, 30 fail observed) / 113/138 |
| cpu / home | 32/32 / 32/32 / 32/32 |
| gpu / smoothness | 13/13 / 13/13 / 13/13 |
| gpu / warm-up | 19/19 / 19/19 / 19/19 |
| gpu / buttons | 138/138 / 138/138 / 138/138 |
| gpu / home | 32/32 / 32/32 / 32/32 |

| Smoothness probe | Total samples, runs 1 / 2 / 3 | Motion-only samples | Median interval, ms | Maximum interval, ms |
| --- | --- | --- | --- | --- |
| cpu / pendulum | 155 / 206 / 197 | 127 / 171 / 163 | 79.6 / 60.9 / 62.1 | 196.5 / 193.7 / 149.0 |
| cpu / marblerun | 46 / 56 / 55 | 38 / 46 / 45 | 264.1 / 218.7 / 222.5 | 297.2 / 237.0 / 241.3 |
| gpu / pendulum | 723 / 722 / 722 | 601 / 601 / 600 | 16.7 / 16.7 / 16.7 | 23.4 / 31.2 / 24.5 |
| gpu / marblerun | 722 / 722 / 722 | 601 / 600 / 601 | 16.7 / 16.7 / 16.7 | 23.6 / 18.2 / 21.0 |

| Full 42-entry smoothness report | Pass / fail / incomplete, runs 1 / 2 / 3 |
| --- | --- |
| cpu | 0 / 40 / 2; 0 / 40 / 2; 0 / 40 / 2 |
| gpu | 2 / 1 / 39; 2 / 3 / 37; 2 / 3 / 37 |

Full report statuses are broader than enforced assertions; incomplete means missing required evidence, not acceptance. Report-only GPU findings by repetition:

- Run 1: drone: part visibility, draw submission or geometry identity changed.
- Run 2: football: warm-up: 1 flicker events; alternation at 0.313s | drone: part visibility, draw submission or geometry identity changed | spotlights: warm-up: 1 flicker events; alternation at 0.678s.
- Run 3: rover: warm-up: 1 flicker events; alternation at 0.795s | drone: warm-up: 1 flicker events; alternation at 0.773s; part visibility, draw submission or geometry identity changed | smarthome: warm-up: 1 flicker events; alternation at 0.307s.

These report-only findings are a limit on visual stability claims even when the enforced 13 checks pass. They are retained for investigation; this lane does not relax gates or fix unrelated scenes.

For regular viewport button audits visited in all three repetitions (excluding unvisited timeout cases and other audit types):

- cpu: 32 of 120 common audits changed pass/fail outcome.
- gpu: 0 of 129 common audits changed pass/fail outcome.

This is observed consistency over three runs, not a statistical flake-rate estimate. Shared load and early dependency provenance limit causal attribution; the ink audits alone do not establish matched-pixel alignment quality.


Method: sequential guarded `pnpm run e2e:all` invocations on stand-in 5181 and worker 5194, three runs per mode/group, alternating mode order between repetitions. Each invocation includes its Vite build, fresh worker startup and any assigned-port wait; wall time is not just rendering time. The first valid CPU smoothness invocation waited for preflight ports, as its runner log records. Other workstation CPU/GPU activity was not held fixed; alternating order does not make this a controlled hardware benchmark. Smoothness traverses all 42 catalogue entries with its existing separate startup capture, then 90 settling RAFs, one second at rest, ten seconds of motion and one second at rest again, at 960 × 640 and DPR 1. The existing JSON retains raw frame intervals, sample counts, median derivable from samples, p95, maximum and verdicts. These are RAF scheduling/submission intervals, not GPU execution timings.

Worktree source: `42fe67ec36ba4af20e85ee9bcc882ce5ba1b1429`; corrected home-checker source: `bf210ee5837c27710b81a523126d91f9a745ed24`. Earlier invocations reused the parent checkout's host-package link; its chip gained a seal-rail `part` attribute during this investigation, and its later sharing update caused the excluded build failure. Those early builds were not hermetically pinned dependency snapshots, so the table is diagnostic evidence rather than a source-controlled visual-regression benchmark. From GPU warm-up repetition 2 onward, worktree-local core/host links isolate the package source as well. An external watchdog polls device memory every five seconds and terminates only the owned measurement process tree if total usage exceeds 16 GiB, monitoring fails, or the seven-hour measurement deadline expires. That overall deadline was extended once from six hours to allow the matched home repeats after the checker correction; each suite retains its 30-minute runner limit. Browsers and fresh workers close between invocations; there is no model or training load.

The original home checker completed 32/32 on CPU in 637.79 seconds and 32/32 on GPU in 902.845 seconds. Investigation found that its settling predicate could never accept perfectly stationary samples 120 or 130 ms apart: dropping every sample older than 0.45 seconds could leave a span below the required 0.4 seconds forever. The corrected checker includes the nearest sample before the window, preserving the minimum duration, minimum driven time and strict 0.3 px tolerance. Ten unit cases cover cadence, duration and motion at the boundary. Both home modes were restarted with that same checker for the repeated comparison; the original completed baselines and interrupted next smoothness start remain in `preflight-home-cadence/`. This corrects test sampling, not application physics or rendering defaults.

Known coverage gap: the humanoid page exposes `__humanoid` under its own test modes; the family smoothness runner requests `test=vr` and waits for `__presence.experience`. Those two humanoid entries cannot supply this probe's motion measurements. This is a source-confirmed harness mismatch, not a graphics-device verdict. Other report-only scenes can also be incomplete because their physics/skin coverage is not implemented. Only the enforced pendulum, marble-run and associated control checks contribute assertion totals; preserve the whole report alongside them.

The existing smoothness gate's p95 covers the full 12-second rest/orbit/rest sequence. The summary also retains the motion-only p95 and count separately; total samples are not motion-only samples. A runner timeout leaves unvisited scenarios unmeasured, with only observed check counts and context-closure RAF samples available.

Warm-up and other groups additionally have a minimal research RAF sampler in each context, limited to 12,000 intervals per document. These include loading, idle and test interactions and must not be compared to smoothness's orbit as if they measured the same work. Context closure records the renderer and samples for pages still open; navigation replaces the document's buffer. Warm-up uses the suite's desktop DPR 1/2 and phone DPR 3 profiles; buttons uses its existing three viewport sizes; home uses its existing desktop and emulated-phone scenarios. Three runs reveal observed consistency, not a statistical guarantee against flakes.

Visual inspection of the retained GPU desktop and phone marble captures confirms drawn boards and controls, but the portrait phone header's seal overlaps some title text. The software run's retained phone failure capture also shows that overlap; these captures are different test states, so they are not a registered pixel comparison. Passing ink-centering, naming and motion checks does not establish complete visual quality; include such occlusions in the maintainer-labelled vision pilot.

`nvidia-smi` samples total device memory and utilization every two seconds. Windows shared-device usage includes the owner’s work, desktop and other lanes; differences are not attributable browser allocations. The initial device observation was 3,481 MiB and 53% utilization. Browser memory has no enforceable per-process WebGL cap here. Run one GPU suite/job at a time across all lanes, including suites that select hardware automatically with the opt-in unset, with no model/training job alongside it; stop the task’s process tree if the owner needs the GPU or total memory approaches the agreed reserve. The assigned ports serialize this lane, not other lanes. The coordinator must schedule that exclusive window or provide a shared lease; the environment flag is not itself a cross-lane lock.

Evidence is ignored under `artifacts/gpu-local/`: `renderers.json`, `before/` (forced CPU), `after/` (GPU), runner/suite logs, `pages.jsonl`, two-second `gpu.json` samples and `runs.jsonl`. Preflight directories retain environment failures excluded from timing statistics. Existing dependencies were linked locally and a local Vite cache directory created; no dependency install was required. A parent workspace package change broke the second GPU warm-up build before tests; local core/host links were then isolated to this worktree and that excluded invocation retained in `preflight-package-links/`. Tests retain their temporary fixtures outside the repository.

## Original e2e opt-in (research stage)

This section records the original research-stage implementation. The lane default, all-suite wrapping, fallback and lock described in Phone startup follow-up supersede these limitations.

The shared `e2eBrowserOptions` helper changes launch arguments only when `OBPAL_E2E_GPU=1`. It wraps the main home/sims launches and the smoothness, warm-up and button group browsers. It removes conflicting ANGLE/software flags, preserves unrelated arguments and appends the measured D3D11 flags. Other suites and separately launching sims modules retain their existing options. With the variable unset or any value other than `1`, the original options object is returned unchanged. Unsupported operating systems reject this Windows-specific opt-in before a suite starts.

The actual helper, without the measurement preload, confirmed RTX 4090 rendering for the opt-in and unchanged SwiftShader rendering for home's default. A small font-metric fixture produced identical measurements in both modes; it does not explain the full button-audit variation. Renderer evidence is in `opt-in-renderers.json`.

After the coordinator schedules an exclusive GPU window, use the lane's assigned ports:

```powershell
$env:OBPAL_E2E_PORT='5181'
$env:OBPAL_E2E_WORKER_PORT='5194'
$env:OBPAL_E2E_GPU='1'
$env:OBPAL_E2E_SIMS_ONLY='smoothness' # alternatively warm-up or buttons
pnpm run e2e:all -- sims
$env:OBPAL_E2E_SIMS_ONLY=$null
pnpm run e2e:all -- home
$env:OBPAL_E2E_GPU=$null # restore the existing defaults
```

The runner announces the opt-in in its log. Scheduling one GPU job across all lanes remains necessary even when the flag is unset, since Chromium can select the GPU automatically. This flag does not implement memory admission or a cross-lane lease. Keep it off by default pending the owner's decision.

## Validation and hand-back scope

Master `f8140b34971a34aa8fdb7d40724149c6f2c5f78b` was merged once. The two launcher conflicts were resolved by preserving upstream evidence handling and new group dispatch while wrapping the affected launches. The lockfile did not change; existing Chrome type definitions were linked locally for the extension typecheck, without installing dependencies. `pnpm run check` passed all four TypeScript configurations and 3,341 Vitest tests, with 14 skipped (221 test files passed, one skipped).

The merged evidence runner gives each suite a new child directory. Its first smoothness invocation failed before assertions because that parent directory did not exist; the smoothness launcher now creates it before making its capture directory. The excluded setup log is retained in `preflight-merged-evidence-root/`. This fix changes evidence setup, not acceptance thresholds.

Final warm-up on the merged source passed 17/19, then 17/19 on its single isolated same-environment rerun. Both failed arm and humanoid at phone DPR 3 with one startup alternation each. Their events are from full-page compositor samples, with no canvas flicker event. Arm alternation affected 7.39% of the downsampled screen at 0.427 seconds; humanoid affected 3.91% at 0.472 seconds in the rerun. A separate current-default diagnostic, without the opt-in, passed 18/19 and also failed humanoid phone startup. That default already selects the GPU on this workstation. These observations limit attribution to the new flags; they do not prove the cause or excuse the failures. No thresholds were weakened, and no further retries were used. Retained logs/JSON are in `final/warm-up-first/`, `final/warm-up/` and `default-warmup/`. The baseline three-run table above remains separate from this newer merged source.

| Final check on code `03d2a2f` | Result |
| --- | --- |
| TypeScript | 4/4 configurations passed |
| Vitest | 3,341/3,355 passed; 14 skipped |
| Sims smoothness, full family traversal | 13/13 enforced assertions passed; broader findings retained |
| Sims warm-up | 17/19, then 17/19 on the single rerun; unresolved |
| Sims buttons | 137/138, then 138/138 on the single rerun |
| Home | 36/36 passed; includes four upstream viewport-field checks absent from the 32-check measurement baseline |
| Desktop guard | 19 test-browser lines before and after; **no new sessions** on every invocation |

The first final button run timed out waiting for page readiness at forklift 844 × 390, rather than failing an ink measurement. It passed on the group's one isolated rerun; both logs are retained in `final/buttons-first/` and `final/buttons/`. No further retries were used. Final validation uses the real launcher helper without the research sampler/forcing preload, with sequential GPU jobs and external memory/deadline watchdogs. `check.log` and `final/` retain the results; the default-launch warm-up diagnostic is additional investigation, not a substitute pass. Required validation is **not all green**: the phone startup failures need a separate application/harness investigation before routine GPU adoption. Model quality/latency, CUDA image metrics and later physics/training remain unmeasured.

The new suite selector conservatively recommends all suites because the shared browser helper is imported widely. This brief explicitly requests the measured smoothness, warm-up and button groups plus home, so final browser validation uses those four groups with the real opt-in and no research preload. Other suites' launch options are unchanged, and their full runs are outside this brief's validation scope.

The labelled `contact-proof/labelled-contact-sheet.png` shows diagnostic CPU/GPU phone captures and GPU desktop board views at equal cell sizes, with source viewport/revision labels. The distiller verified hashes and retained keyframes; classification remains **unclassified**, since these are different test states with no supplied image threshold. It removed only its temporary copies after verification; original measurement captures remain available. No model advisory was requested.

## Runtimes on Windows and 24 GB VRAM

Memory means weights **plus** context/KV or recurrent state, vision activations, work buffers and concurrent requests. A 24 GB card does not provide 24 GB of free inference memory. The throughput assessment below is an architectural recommendation; no matched runtime benchmark was executed here.

| Runtime and licence | Windows and API | Resource use and throughput tradeoff |
| --- | --- | --- |
| llama.cpp, MIT | Native Windows x64 CUDA binaries; OpenAI-compatible chat completions, images and JSON schema | Explicit model/projector files, context, batch and parallelism. Good fit for one bounded job; foreground shutdown releases resources. Quantized decoding suits this workload. |
| Ollama, MIT | Native Windows with NVIDIA; subset of OpenAI API including vision | Easy model management; resident-model count, context and parallelism affect memory. Default Windows app runs in background; prefer standalone CLI and job-owned `serve`, explicit unload. No reason to expect the same model to be faster solely because of the wrapper. |
| LM Studio, proprietary app terms; free personal/work use | Windows x64/ARM64; OpenAI-compatible server | Convenient model/GPU controls and memory estimates. Idle TTL/auto-evict exist, but stop the job-owned server and unload explicitly. llama.cpp-backed speed is configuration-dependent. |
| vLLM, Apache-2.0 | Linux; Windows through WSL2 or unofficial forks; OpenAI server | Continuous batching benefits many requests. Default large memory reservation conflicts with polite sharing; lower `--gpu-memory-utilization`, context and sequence limits. WSL/CUDA/PyTorch maintenance is excessive for occasional digests. |
| ONNX Runtime, MIT; DirectML redistributable has separate terms | Native Windows CUDA/DirectML/WinML; library, no universal built-in OpenAI server | Good for a pinned classifier or metric graph. Must export a supported model and implement preprocessing/server/schema handling. CUDA requires matched CUDA/cuDNN dependencies; DirectML is in sustained engineering and Microsoft recommends WinML for new Windows projects. Throughput depends on graph/operator support. |
| SGLang, Apache-2.0 | Linux CUDA stack, generally WSL2 on this workstation; OpenAI server | Strong batching/prefix reuse; more dependencies and model-specific kernels. A possible later throughput study, with explicit memory fraction and concurrency, rather than the first pilot. |

Sources: [llama.cpp licence](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE), [multimodal server](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md), [server configuration](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [Ollama licence](https://github.com/ollama/ollama/blob/main/LICENSE), [Windows/standalone CLI](https://docs.ollama.com/windows), [OpenAI subset](https://docs.ollama.com/api/openai-compatibility), [Ollama memory/unload controls](https://docs.ollama.com/faq), [LM Studio work use](https://lmstudio.ai/blog/free-for-work), [app terms](https://lmstudio.ai/app-terms), [server](https://lmstudio.ai/docs/developer), [load settings](https://lmstudio.ai/docs/cli/local-models/load), [TTL](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), [vLLM platform requirements](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/), [vLLM licence](https://github.com/vllm-project/vllm/blob/main/LICENSE), [ONNX licence](https://github.com/microsoft/onnxruntime/blob/main/LICENSE), [DirectML limits](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html), [CUDA/DirectML GenAI install](https://onnxruntime.ai/docs/genai/howto/install.html), [SGLang](https://github.com/sgl-project/sglang).

## Models and quality

Published full-precision/harness scores are not a validation of quantized local image judging. The proposed bounded pilot disables thinking and caps output; its quality can differ further from publisher benchmark settings. OCR, chart reasoning and pointing benchmarks measure different tasks; none establishes reliable aesthetic judgement, pixel-perfect alignment, contrast compliance or ob.Pal regression classification. Scores from different harnesses or metric definitions must not be ranked directly.

| Candidate | Licence; release family | Q4 / Q8 weights and estimated short-context working VRAM | Relevant published evidence |
| --- | --- | --- | --- |
| Qwen3.5-9B | Apache-2.0; March 2026 small family | GGUF 5.68 / 9.53 GB, plus 0.918 GB projector; plan roughly 8–11 / 12–15 GB working memory | OCRBench 89.2, ScreenSpot Pro 65.2, CharXiv RQ 73.0. Recommended vision pilot. |
| Qwen3.5-4B | Apache-2.0; 2026 | GGUF 2.74 / 4.48 GB; text-only roughly 4–6 / 6–8 GB; optional vision projector 0.672 GB | IFEval 89.8; OCRBench 85.0, ScreenSpot Pro 60.3. Later text pilot; no demonstrated digest fidelity here. |
| Qwen3.8-27B; Qwen3.6-27B predecessor | Apache-2.0; August / April 2026 | Estimated weights roughly 16–18 / 28–30 GB plus projector; Q4 working roughly 19–23+ GB | 3.8 reports OSWorld-Verified 84.3, OmniDocBench 1.5 91.1, CharXiv RQ 83.7 without computer interaction. Too little shared-GPU headroom. |
| Gemma 4 E2B / E4B / 12B | Apache-2.0; 2026 | Publisher Q4/SFP8 estimates: 2.9/5.7, 4.5/8.9, 6.7/13.4 GB; add roughly 2–4 GB working space | 12B: MMMU-Pro 69.1%; OmniDocBench edit distance 0.164 (lower better). E4B: 52.6%; 0.181. Viable alternatives; effective parameter names understate total stored weights. |
| Gemma 4 26B-A4B / 31B | Apache-2.0; 2026 | Publisher Q4/SFP8 14.4/28.8 and 17.5/34.9 GB, before working allocations | 26B/31B have stronger published multimodal scores but are poor shared-device choices. Active MoE parameters do not determine stored VRAM. |
| Phi-4-reasoning-vision-15B | MIT; March 2026 | Estimated 8–10 / 16–18 GB weights, working roughly 11–15 / 19–23 GB | Publisher: ChartQA 83.3, OCRBench 76.0, ScreenSpot-v2 88.2. Verify runtime conversion; recommended upstream BF16 alone exceeds this card. No matched local latency result. |
| GLM-OCR 0.9B | MIT; 2026 model/report; full layout pipeline adds Apache-2.0 components | Parameter-only Q4/Q8 floors 0.45/0.9 GB; encoder precision, conversion and buffers add memory. Plan 2–4 GB for a small recognition job, unmeasured | Publisher reports OmniDocBench 1.5 94.62 for its document pipeline. OCR specialist with restricted prompts, not a general UI judge. |
| Ministral 3, 3B / 8B / 14B | Apache-2.0; December 2025 weights, January 2026 report | Approximate Q4/Q8 weight floors 2/3.5, 5/9, 8/15 GB plus projector/buffers | Vision and structured output; useful smaller alternative. No comparable UI-judgement evidence found in this investigation. |
| SmolLM3-3B; Phi-4-mini-instruct 3.8B | Apache-2.0 / MIT; 2025 baselines | Approximate Q4/Q8 2/3.5 and 2.5/4.2 GB; add context/workspace | Small text baselines; lower cost does not prove failure taxonomy or exact-log preservation. |

Memory ranges are planning estimates, not measured allocations; decimal download GB differ from GiB in VRAM tools. GGUF Q4_K_M mixes precisions and is larger than parameter count × half a byte. Gemma publisher SFP8 is not identical to GGUF Q8_0. Bound images and context instead of using advertised 256K–1M maximums.

Model sources: [Qwen3.5-9B benchmarks](https://huggingface.co/Qwen/Qwen3.5-9B), [4B card](https://huggingface.co/Qwen/Qwen3.5-4B), [9B GGUF files](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/tree/main), [4B GGUF files](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/main), [Qwen3.8 release history](https://github.com/QwenLM/Qwen3.8), [27B card and benchmark caveats](https://huggingface.co/Qwen/Qwen3.8-27B), [Gemma memory table](https://ai.google.dev/gemma/docs/core), [Gemma 4 card](https://huggingface.co/google/gemma-4-12B-it), [Phi vision card](https://huggingface.co/microsoft/Phi-4-reasoning-vision-15B), [Ministral report](https://arxiv.org/abs/2601.08584), [SmolLM3](https://huggingface.co/HuggingFaceTB/SmolLM3-3B-Base), [Phi mini report](https://arxiv.org/abs/2503.01743).

A [primary community RTX 4090 measurement](https://gist.github.com/smarvr/287292d82726449ea624a4c8e25c24d9) reports Qwen3.5 Q4_K_M text generation at about 159 tokens/s for 4B and 115 tokens/s for 9B with a short 232-token input; warm follow-ups were about 186 and 147 tokens/s. It is a useful order-of-magnitude reference, not a controlled runtime comparison: build/OS details are insufficient and the author flags offload concerns. Image encoding/prefill, longer prompts, Q8, thermal conditions and GPU sharing change latency. Do not extrapolate those numbers to screenshot judgement. No reliable matched Windows 4090 throughput comparison of all six runtimes was found.

[GLM-OCR's model card](https://huggingface.co/zai-org/GLM-OCR) and [pipeline repository](https://github.com/zai-org/GLM-OCR) were accessed on 2 October 2026. The publisher reports 1.86 PDF pages/s and 0.67 images/s for single-concurrency document export, without enough matched Windows 4090 detail to use those as a workstation prediction. Its complete benchmark pipeline includes PP-DocLayout-V3; do not attribute the pipeline score to bare cropped-label recognition. It could be assessed later for tiny-text extraction, but this report requests no installation of it. DOM text/bounds remain cheaper where the page is available.

## Deterministic image comparisons

Start with existing CPU image tooling for single screenshots. Registration, matching viewport/DPR/camera/pose/time, masks for declared dynamic regions and colour-space normalization matter more than GPU speed. Compute exact pixel differences and a spatial heatmap; use SSIM for structural changes and perceptual hashes for duplicate/contact-sheet selection. A hash cannot prove unchanged small text; SSIM cannot decide whether a change is intentional. DOM bounding boxes and computed contrast measurements give stronger evidence of alignment and accessibility than an image-model opinion.

For large batches, CUDA **CuPy** arrays plus cuCIM's SSIM can amortize transfers; CuPy is MIT, cuCIM Apache-2.0. cuCIM is principally a Linux/RAPIDS route, so validate a supported WSL environment instead of assuming its Windows wheel exists. Native Windows CuPy plus a separately validated SSIM implementation is another option. **LPIPS** uses learned network features; evaluation with fixed weights can be repeatable but is not a weight-free deterministic metric or a tiny-text oracle. Its BSD-2-Clause implementation/PyTorch/backbone weights require separate package and weight approval. Set deterministic kernels and record versions/tolerance; CUDA floating-point reductions need not be bit-identical across releases. No metric library or LPIPS weights were installed.

Sources: [SSIM API and data-range cautions](https://scikit-image.org/docs/stable/api/skimage.metrics.html), [CuPy installation](https://docs.cupy.dev/en/stable/install.html), [CuPy licence](https://github.com/cupy/cupy/blob/main/LICENSE), [cuCIM API](https://docs.nvidia.com/cucim/latest/api/index.html), [cuCIM licence](https://github.com/rapidsai/cucim/blob/main/LICENSE), [LPIPS implementation/licence](https://github.com/richzhang/PerceptualSimilarity), [LPIPS paper](https://arxiv.org/abs/1801.03924). NVENC accelerates video encoding, not SSIM or visual judgement; the existing ffmpeg encoder can later make evidence videos with explicit resolution, duration and rate limits, without installing a model.

## Exact approval requests and pilot recipe

These are owner approval requests, **not actions performed**. Download only the named files, retain upstream licence notices and check published hashes. Source cards/file metadata were viewed; model binaries were not fetched. Reserve roughly 15 GB disk for the first pilot including extraction/scratch; more for a second model. A read-only check on 2 October found a roughly 2 TB NVMe worktree volume with 209 GB free, enough for that pilot. Availability can change before approval.

| Request | Exact source | Published download size | Licence |
| --- | --- | --- | --- |
| llama.cpp b11146 Windows x64 CUDA 12.4 binaries, the build linked by v0.5.0 | [llama-b11146-bin-win-cuda-12.4-x64.zip](https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-win-cuda-12.4-x64.zip) | 242 MB | MIT; bundled dependencies retain their notices |
| Matching CUDA runtime DLL archive | [cudart-llama-bin-win-cuda-12.4-x64.zip](https://github.com/ggml-org/llama.cpp/releases/download/b11146/cudart-llama-bin-win-cuda-12.4-x64.zip) | 373 MB | NVIDIA CUDA Toolkit redistributable terms, not MIT |
| Qwen3.5-9B Q8_0, quantization revision `3885219` | [Qwen3.5-9B-Q8_0.gguf file metadata](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/blob/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q8_0.gguf) | 9.53 GB | Apache-2.0 |
| Same revision's F16 vision projector | [mmproj-F16.gguf metadata](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/blob/3885219b6810b007914f3a7950a8d1b469d598a5/mmproj-F16.gguf) | 918 MB | Apache-2.0 |
| Optional later text pilot, not needed for first approval: Qwen3.5-4B Q8_0, revision `e87f176` | [Qwen3.5-4B-Q8_0.gguf metadata](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/blob/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q8_0.gguf) | 4.48 GB; no projector for text | Apache-2.0 |

[Release asset sizes/hashes](https://github.com/ggml-org/llama.cpp/releases/expanded_assets/b11146), [stable release mapping](https://github.com/ggml-org/llama.cpp/releases/tag/v0.5.0), [CUDA redistribution terms](https://docs.nvidia.com/cuda/eula/index.html). Use CUDA 12.4 rather than assuming the newest CUDA 13.4 build is compatible with the workstation's driver.

After approval, extract both binary archives into one owner-selected tools directory, preserving relative DLL locations. Place the exact model/projector files in a separate owner-selected model directory. No installer, service, PATH change, account login or startup task is necessary. In a foreground PowerShell session from that tools directory, with a coordinator-assigned free model port supplied in `OBPAL_LOCAL_MODEL_PORT`:

```powershell
# Paths are relative placeholders for the separately approved model directory.
./llama-server.exe -m ./models/Qwen3.5-9B-Q8_0.gguf `
  --mmproj ./models/mmproj-F16.gguf --alias obpal-vision `
  --host 127.0.0.1 --port $env:OBPAL_LOCAL_MODEL_PORT `
  -ngl 99 -c 8192 -np 1 -n 512 -b 256 -ub 128 -t 8 -tb 8 `
  --threads-http 1 --timeout 30 `
  --offline --no-webui --no-agent `
  --reasoning off `
  --sleep-idle-seconds 30
```

This foreground command is a manual smoke-test recipe, not the proposed job supervisor. Stop it with Ctrl+C after the approved request and confirm its process has exited. Use the supervisor described below before connecting routine lane jobs. The [pinned server options](https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/README.md) were rechecked on 2 October 2026; keep built-in tools/MCP disabled and use a clean environment without inherited server configuration.

Do not reuse this lane's worker/stand-in ports while testing. Run one job at a time, at most two images or four equally sized contact-sheet cells per request, with crops for tiny text, at most 512 output tokens and a 30-second request deadline. Admission requires free VRAM of at least the expected job peak plus a 6 GiB owner reserve: the first Q8 pilot's 14 GiB process budget therefore requires at least 20 GiB free. If that window is unavailable, retain the cloud/deterministic fallback rather than evicting the owner's work. These are pilot admission/watchdog rules, not a llama.cpp hard allocator cap. If Windows cannot report per-process memory, watch total free memory and stop the owned server if the reserve is breached. A job supervisor must terminate its process tree on timeout/cancel/completion, wait for exit, release its cross-lane GPU lease and verify memory returns near the pre-job baseline. Idle sleep is an extra safeguard, not completion cleanup. Do not change clocks, drivers or power limits.

For the pilot, cap overview images at a 1,600-pixel long edge, retain native-resolution crops for text and preserve originals for metrics. Preflight the model's image-token count plus prompt/output allowance against the 8,192-token context; reject oversized requests before inference. Record all resizing and crop coordinates. Resized overviews cannot establish one-pixel alignment or original-pixel contrast.

Before adoption, make a private, versioned evaluation set of at least 50 labelled UI before/after pairs and 50 real redacted failure/digest examples. Include tiny labels, deliberate one-pixel shifts, known contrast defects, harmless antialias changes and missing evidence. Measure cold load, image prefill/TTFT, warm generation, peak memory, schema compliance, exact-field preservation and false negatives against deterministic checks and maintainer labels. Repeat each prompt three times. Keep Q8 initially for quality; evaluate Q4 only against the same set. Require perfect preservation of immutable digest fields and no missed critical labelled defects before treating local output as more than advisory. Published model benchmarks do not replace this acceptance.

## One adapter and fallback

The current shared seam is `scripts/lib/decision-model.mjs`: `classify` accepts an injected `runner`, validates JSON against a schema and caller-specific grounding rules, then falls back to the deterministic extract. `lane digest` and `triage` share it and currently name `gpt-6-luna`. Preserve those checks. This lane specifies the adapter contract; it does not change those tools or the tooling-tune distiller.

Have the text adapter return the existing runner shape: `{ output, usage, model, failed }`, with `output` containing JSON text. Digest and triage supply their existing schemas and acceptance functions through `classify`'s injected runner. The tooling-tune distiller uses the same seam for an advisory note while preserving its deterministic status; an image advisory would be a separate bounded `evaluate` call after metrics, with no power to convert a deterministic failure into a pass.

Propose `evaluate({ task, prompt, schema, images, timeoutMs, signal })` with `task` selecting digest, triage or visual-diff. The approved opt-in adapter makes `POST /v1/chat/completions` to a configured loopback origin using native Node `fetch`; text messages use the 4B alias, image messages use the 9B alias and bounded `data:image/png;base64` inputs. Set `chat_template_kwargs: { enable_thinking: false }`, `max_tokens: 512` and `stream: false` in the JSON body; use `response_format` JSON schema when supported, then perform the existing independent schema and grounding validation. The [pinned b11146 server API](https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/README.md) documents these template controls. Record provider/model revision, quantization, prompt hash, duration, token counts, metric findings and fallback reason; include no secrets or raw private screenshots in tracked output.

The first pilot starts only the vision server and leaves text on the existing cloud runner. If the later text pilot passes, start the 4B server with its own alias for a text job, after the vision process has exited; do not keep both models resident. One adapter routes requests, while the job supervisor and cross-lane lease bound model residency and concurrency.

The adapter owns no execution tools. Preserve branch/SHA, test totals, failure lines, category enums, evidence paths and rerun commands; unknown/missing evidence must remain unknown. For visual output require named regions, observed changes and uncertainty; contrast/alignment numbers come from deterministic measurements. Apply redaction before either provider, reject remote URLs/redirects for the local endpoint and bound input/output sizes.

When the GPU lease is busy, memory is low, the runtime is absent, a request expires, or output is invalid, use the existing cloud runner **only under the existing cloud-input policy**. A 30-second total deadline must cover local plus cloud attempts: reserve time for the cloud call rather than granting each another full deadline. With a local-only privacy setting or unavailable cloud, return the existing deterministic text extract, or image metrics plus `needs-human-review`; do not invent a vision verdict. Never pull a missing model, start a background service or queue unlimited requests automatically. Text remains cloud by default until the local pilot passes; the distiller can use the same proposed seam without a separate provider stack.

The current Codex digest runner is a text interface, not an implemented image-provider adapter. Visual fallback requires an approved image-capable cloud route and permission to send those redacted images; otherwise metrics plus human review is the automatic fallback. Sanitized metric descriptions alone do not establish visual understanding.

## Later physics and training work: assessment only

| Work | Fit and prerequisites | Estimated engineering effort, excluding approval/downloads |
| --- | --- | --- |
| N1 Newton reference motion | RTX 4090 compute capability 8.9 and driver 596.36 exceed Newton 1.3.0's CC 5.0/driver 545 floor. Python 3.10 minimum, 3.11+ recommended; Warp bundles CUDA runtime. Upstream supports Windows, but the parked brief selects dedicated Linux x86-64: this Windows setup does not meet that selected OS profile until a Linux/WSL plan is separately accepted. F0-R acceptance and F1 body/joint map still required. | 3–5 days for a pinned environment plus pendulum/arm fixture and repeatability exporter; another 1–2 weeks for mapped gait/contact comparisons, solver diagnosis and browser gates. |
| N2 Isaac Sim / ROS 2 bridge | Isaac Sim 6.0 lists Windows 11, 32 GB RAM, RTX 4080/16 GB VRAM as numerical floors, with Windows driver 581.42 listed as tested. This workstation exceeds those hardware floors; 64 GB RAM matches its good profile. The measured roughly 2 TB NVMe volume has 209 GB free, clearing the 50 GB SSD storage floor; budget additional assets and datasets before approval. Its good storage profile lists 500 GB. Driver compatibility, compatible ROS distribution/bridge setup and complex-scene fit remain unverified. Prefer a separately pinned Linux environment for ROS; Linux container support does not establish WSL GUI/sensor suitability. | 1–2 weeks for a fake bridge, one arm and one base with topic/frame/QoS mapping; 2–4 more weeks for full humanoid joint mapping, wall-time leases/holds, pause/disconnect fault injection and reproducible evidence. |
| Motion Club local ACT/diffusion pilot | A single 24 GB 4090 is sufficient for a modest image-policy pilot. LeRobot guidance estimates ACT 2–6 GB and diffusion 8–14 GB at batch 8 with AdamW; not a workstation measurement. Current install docs require Python >=3.12/PyTorch >=2.10; confirm TorchCodec/ffmpeg compatibility instead of assuming existing ffmpeg 6 suffices. Use cleared, local datasets and simulation/offline replay first. | 3–5 days for dataset/coordinate/time validation and ACT baseline; 1–2 weeks for held-out episodes, seed repeats, diffusion comparison and a bounded simulation evaluation. Training wall time is unmeasured and depends on data/batch/steps. |

Sources: [parked N1/N2 contracts](SIMS-PROGRAMME.md), [NVIDIA compute capabilities](https://developer.nvidia.com/cuda/gpus), [Newton 1.3.0 requirements](https://newton-physics.github.io/newton/1.3.0/guide/installation.html), [Isaac requirements](https://docs.isaacsim.omniverse.nvidia.com/6.0.0/installation/requirements.html) (rechecked 2 October 2026), [LeRobot hardware guidance](https://huggingface.co/docs/lerobot/main/hardware_guide), [current install requirements](https://huggingface.co/docs/lerobot/installation). Effort ranges are planning judgement, not upstream promises. No Newton, Isaac, ROS, LeRobot, training, asset import, hardware control or model inference was run. Each needs a new pinned brief, licence/size approval for its dependencies/assets and an exclusive owner-approved GPU window.

N1 additionally needs cleared numeric body descriptions, fixed seeds/ticks, coordinate and unit maps, predeclared tolerances and exported contact/energy trajectories. A second simulator supplies an independent reference, not biological or hardware truth. N2 needs a simulation-only ROS domain and allowlist, named joint/frame maps, compatible QoS, fresh measured state and bounded input, exclusive ownership, wall-time leases, deadman release and acknowledged hold. Pause, stale state, disconnect and replay must disarm without reconnect auto-resume. The Motion Club pilot needs cleared timestamped episodes, calibrated action/observation coordinates, held-out tasks and seed repeats; start with offline or simulated evaluation.
