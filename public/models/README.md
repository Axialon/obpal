# Hand tracking assets

These files are served from ob.Pal's own origin, only when Hand camera starts.

- `hand_landmarker.task`: Google's MediaPipe Hand Landmarker, float16 model revision 1, from https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task . SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
- `vision_wasm_internal.*` and `vision_wasm_nosimd_internal.*`: unchanged WASM runtimes from `@mediapipe/tasks-vision` 1.0.1. The runtime chooses SIMD where supported; otherwise it uses the compatible build.
- `LICENSE`: upstream Apache-2.0 licence, covering MediaPipe and these distributed assets. Source and model documentation: https://github.com/google-ai-edge/mediapipe and https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker .

The JavaScript package version is pinned in the lockfile. Update the runtime copies together with that dependency. The model is not a service: no camera frames or model inputs are uploaded. Model and runtime downloads are lazy and are not included in the controller's initial offline precache.
