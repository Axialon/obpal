# Camera tracking assets

These files are served from ob.Pal's own origin, only when the corresponding camera mode starts.

- `hand_landmarker.task`: Google's MediaPipe Hand Landmarker, float16 model revision 1, from https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task . SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
- `pose_landmarker_lite.task`: Google's MediaPipe Pose Landmarker Lite, float16 revision 1, 5,777,746 bytes, from https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task . SHA-256: `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`. Only Lite is distributed; no Full or Heavy download path exists. Model licence: [BlazePose GHUM model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf), Apache-2.0.
- `vision_wasm_internal.*` and `vision_wasm_nosimd_internal.*`: unchanged WASM runtimes from `@mediapipe/tasks-vision` 1.0.1. The runtime chooses SIMD where supported; otherwise it uses the compatible build.
- `vision-1.0.1/*.js`: byte-identical copies of the two JS loaders. Body uses versioned URLs and immutable browser caching to reopen offline without a service worker on the Viewer or sim. The unversioned Hand loader path is unchanged. Update this directory/version with the pinned runtime; never replace its contents in place.
- `LICENSE`: upstream Apache-2.0 licence, covering MediaPipe and these distributed assets. Source and model documentation: https://github.com/google-ai-edge/mediapipe and https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker .

The JavaScript package version is pinned in the lockfile. Update the runtime copies together with that dependency. The model is not a service: no camera frames or model inputs are uploaded. Model and runtime downloads are lazy and are not included in the controller's initial offline precache.

Body capture uses one person, VIDEO mode and no segmentation masks. The cold Lite + SIMD JS/WASM set totals 17,866,918 bytes (18 MB rounded); HTTP compression and shared browser cache can reduce traffic. Only static assets enter `obpal-body-vision-1.0.1-lite-1`. Body mode never loads the Hand model unless the phone's session-only Fingers toggle is enabled. The host webcam has no Fingers toggle.

Tasks Vision 1.0.1 JavaScript exposes visibility, not separate per-point presence. BODY's effective presence uses visibility, bounded by image coordinates and any explicit presence available in a result. See [BODY](../../docs/PROTOCOL.md).
