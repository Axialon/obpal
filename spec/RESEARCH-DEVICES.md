# Devices beyond the phone: TVs, headsets, AR glasses and watches

**A quick feasibility scan (2026-09-27), not the deep research.** It places each family of devices on the roadmap (PLAN §10, step 8b) with its likely route and risk. The deep research happens when development reaches it. Recheck everything marked *unverified* then, and anything a vendor may have changed since.

The owner's ask (2026-09-27): "also note for research integration with various TV and VR, AR systems with watches as control devices on top of existing, with various controller profiles to function seamlessly."

ob.Pal has two roles, and every device here takes one or both:
- A **host** shows the scene and takes control (PROTOCOL §1).
- A **controller** is what a person uses (CATALOGUE §9). It is either a face on a phone, or a device of its own, joined directly or bridged through a phone (CATALOGUE §6).

## At a glance

| Family | As a host | As a controller | First route | Risk |
|---|---|---|---|---|
| Meta Quest | Yes: its browser runs the Viewer | Yes: controllers and hands through WebXR | The Viewer in Quest Browser; `bridge.xr` | Low |
| Android XR (Galaxy XR) | Yes: Chrome with WebXR | Yes: controllers and hands | As Quest | Low |
| Pico | Yes (VR) | Yes: the registry has its controllers | As Quest, once tested | Medium |
| Apple Vision Pro | VR only | Hands as gaze and pinch. PS VR2 controllers only as gamepads, without pose | The Viewer in Safari; `bridge.xr` with pointers | Medium |
| AR glasses | Mostly a display for a phone or PC, which stays the host | Android XR wired glasses: hands. Ray-Ban Display: Neural Band gestures (preview) | Nothing to build for display glasses | Medium to high |
| Samsung TVs (Tizen) | Web app. WebRTC on 2026 sets, partial on 2025 sets | – | A Tizen web app | Medium |
| Google TV, Chromecast | A Cast receiver page if it gets DataChannels, else a native app | – | Prototype a receiver | Medium |
| LG TVs (webOS) | Web app over the WSS relay (WebRTC is for LG's partners) | – | After the relay | Medium |
| Fire TV | Fire OS: a native app. Vega OS: a web app, WebRTC unknown | – | Wait | Medium to high |
| Apple TV | A native tvOS app only | – | Only with a native Apple app | High |
| Roku | No | – | – | High |
| TVs as control systems | – | – | A bridge that speaks the TV's LAN remote | Low to medium |
| Wear OS, Galaxy Watch | – | A native watch app: direct, or to the phone's page over Bluetooth | A Wear OS app | Medium |
| Apple Watch | – | Only beside a native iPhone app | Only with a native iPhone app | High |

## What this changes in the plan

1. **Headsets and watches need the short code.** A phone can't scan a code shown inside a headset, a headset can't scan the code on a screen to join as a controller, and a watch can't scan at all. The short code with approval (PLAN §4) is specced but not built. It comes first in step 8b, or earlier if headsets matter sooner. TVs show the QR code like any screen.
2. **The WSS relay is what reaches most TVs.** LG keeps WebRTC for its partners. Samsung added it in 2025 (partially) and 2026. Vega OS doesn't mention it. The relay through the room service (PLAN §7a, v1) makes a TV a host whatever its WebRTC.
3. **Watches mean a native app.** No watch has a browser that can open the controller page. Wear OS (Pixel Watch, Galaxy Watch) needs only a watch app. An Apple Watch also needs a native iPhone app, which ob.Pal doesn't have. That is an owner decision (PLAN §13).
4. **Headset controllers and hands are ready on Quest and Android XR.** `bridge.xr` (CATALOGUE §6) can be built as soon as there's a headset to test on.
5. **Profiles come from the standards.** Pads use the Gamepad API's standard layout, headset controllers the WebXR Input Profiles registry's ids, and raw HID pads SDL's mapping format. ob.Pal adds only its routes (CATALOGUE §2) on top.
6. **DataChannels are expected on these devices, but nobody documents them.** The Chromium browsers (Quest, Pico, Android XR, Tizen) and WebKit (Vision Pro) have WebRTC. Test on each device; the relay covers the rest.

## Headsets

| Device | Host | Controller | Notes | Risk |
|---|---|---|---|---|
| Meta Quest (Quest Browser) | `immersive-vr`, and `immersive-ar` (passthrough) | Two Touch controllers (the `xr-standard` gamepad, grip and aim poses), or tracked hands (25 joints) | Chromium 146 (April 2026). Hands are on by default. Plane and mesh detection, hit test and anchors. WebGPU since v32; WebGPU inside WebXR is still experimental (August 2026). | Low |
| Samsung Galaxy XR (Chrome on Android XR) | `immersive-vr` and `immersive-ar`, hit test, anchors, depth, light estimation | Hand input and the Gamepads module; the registry has a `samsung-galaxyxr` profile | Google's page (updated 2026-08-31) covers headsets and wired XR glasses. *Unverified:* whether WebXR is on by default, and WebGPU. | Low |
| Pico (Pico Browser) | `immersive-vr` | The registry has `pico-4`, `pico-4u` and `pico-neo3` | Pico's web docs are thin. *Unverified:* `immersive-ar`, hand input, WebGPU. | Medium |
| Apple Vision Pro (Safari, visionOS 26) | `immersive-vr`, on by default; WebGPU in WebXR since Safari 26.2. No `immersive-ar`: developers report its flag does nothing in visionOS 26.5. | Hands as `transient-pointer` (gaze and pinch; the input source exists only during a pinch), and hand joints after a permission prompt. PS VR2 Sense controllers work in native apps, but developers report Safari shows them only in `navigator.getGamepads()`, not as XR input sources, so they have no pose. | The registry has no Apple or Sony profile. | Medium |

**Route.**
- **As a host:** the Viewer, or any `@obpal/host` page, runs in the headset's browser, and phones join by the short code.
- **As a controller:** `bridge.xr` runs a WebXR session in the headset's browser, joins the screen's scene by the short code too, and sends each hand as its own participant (CATALOGUE §6). The pose goes as POSE; the trigger, grip, stick and buttons as PAD.
- **On Vision Pro,** a hand is a pointer only while it pinches.

## AR glasses

| Device | Host | Controller | Notes | Risk |
|---|---|---|---|---|
| XREAL One and Air, VITURE | By proxy: a USB-C display for the phone or PC that hosts | Nothing reaches the web | Nothing to build. *Unverified.* | Low |
| XREAL Project Aura (Android XR, wired, with a compute puck) | Likely: Google documents Chrome's WebXR for wired XR glasses, and XREAL has shown a WebXR demo | Hands through WebXR. *Unverified:* whether the puck's trackpad reaches the web | Due in fall 2026; not shipped as of 2026-09-20 (secondary source) | Medium |
| Android XR display and AI glasses | No | No: their touchpad and voice go through native Jetpack XR only | Google lists no web support for them | High |
| Meta Ray-Ban Display with the Neural Band | No 3D scene: Web Apps are 2D pages on the glasses | Partly. A Web App gets the Neural Band's fixed gestures (swipes, an index pinch to enter, a middle pinch to cancel, presses) and the glasses' motion: a D-pad, A, B and 3DoF, no custom gestures. | Meta's Wearables Device Access Toolkit is a developer preview. Display access opened on 2026-05-14, for up to 100 testers, with no public publishing. *Unverified:* network APIs in Web Apps. | High |
| Snap Spectacles (Snap OS 2.0) | Possible: its browser has WebXR, `immersive-ar` only | Hands only; Snap says gamepads aren't practical there | Developer kits now; consumer Specs are due in 2026. *Unverified:* WebRTC. Snap documents WebSockets only for Lenses. | Medium to high |

**Route.** Display glasses need nothing: the phone or PC they're plugged into is the host. Android XR wired glasses follow the headsets once they ship. The Neural Band would make a small controller (`pad`: a D-pad, A and B), but only through Meta's preview.

## TVs

| Platform | Host | Notes | Risk |
|---|---|---|---|
| Samsung (Tizen web app) | Chromium M120 on 2025 sets and M130 on 2026 sets. Samsung's table: WebRTC yes on Tizen 10 (2026), partial on Tizen 9 (2025), none before. WebSocket and WebGL on every year. | It doesn't say what "partial" covers, so test DataChannels on a 2025 set. The relay covers older sets. | Medium |
| Google TV, Chromecast (Cast Web Receiver) | A custom receiver is a web page we host, launched from a Cast sender | Google documents WebRTC in receivers only for its own one-way camera streams. A third party reports custom-receiver WebRTC working on some devices only. *Unverified:* DataChannels, WebSockets, idle timeouts, and launching from an iPhone (it needs a Cast sender). | Medium |
| Google TV, Android TV (app) | A native Android TV app (a WebView, or native WebRTC) | TV store review | Medium |
| LG (webOS web app) | Chromium 87 to 132 across webOS 22 to 26 | LG's developer support says WebRTC is only for contracted partner apps (2026-01-07). So the relay, unless LG partners. *Unverified:* WebSocket and WebGL (expected from Chromium). | Medium |
| Fire TV (Fire OS) | A native Android app | Amazon says Vega OS will power all its future streaming players | Medium |
| Fire TV (Vega OS) | A hosted web app in Vega WebView (Chrome 130 user agent, WebGL2, WASM, no WebGPU) | Linux, not Android; first shipped in October 2025 on a stick with 1 GB of RAM. *Unverified:* WebRTC and WebSocket, which Amazon's docs don't mention. | High |
| Apple TV (tvOS) | A native tvOS app only: tvOS has no WebKit or web views, and TVMLKit is deprecated in tvOS 18 | WebRTC would need a self-built library | High |
| Roku | None practical: BrightScript apps, with no web runtime and no WebRTC | – | High |

**TVs as control systems.** ob.Pal can also drive a TV's own menus through its LAN remote, with no app on the TV. That makes a candidate `system.tv` (CATALOGUE §7): the phone's face becomes the TV's remote. A page on a public origin can't open raw TLS sockets or freely call addresses on the LAN, so the bridge belongs in ob.Pal Desktop, which already keeps its own rules for what it may drive.

| TV | LAN remote | Pairing | Status |
|---|---|---|---|
| Roku | External Control Protocol: HTTP on port 8060 | None. But since the December 2024 firmware, the default "Control by mobile apps" setting is Limited, which refuses commands until the owner changes it. | Official |
| Samsung | WebSocket on 8001, or TLS on 8002 (the `samsung.remote.control` channel) | "Allow" on the TV once, then a stored token | Reverse-engineered |
| LG | SSAP over WebSocket: TLS on 3001 on 2023 and later firmware (3000 is the old port) | "Allow" on the TV once, then a stored client key | Reverse-engineered |
| Google TV, Android TV | Android TV Remote v2 over TLS, found by mDNS | Once: a code shown on the TV (port 6467), then the session on 6466 | Reverse-engineered |
| Fire TV (Fire OS) | ADB over the network | The owner turns on ADB debugging | A developer setting |
| Apple TV | Companion and MRP, as pyatv uses them | A PIN | Proprietary; Apple can break it |

## Watches

No watch has a browser that can open the controller page, so a watch needs a native app. It can connect in two ways:
- **Directly,** as a device of its own (CATALOGUE §9.5). The watch app joins the room service and connects like a phone, then groups with its person's phone.
- **Through the phone's page, over Bluetooth.** The watch app advertises a small BLE service, and the controller page connects to it with Web Bluetooth. Only Chrome on Android has Web Bluetooth; no Safari does.

| Watch | Route | Notes | Risk |
|---|---|---|---|
| Wear OS (Pixel Watch and others) | A standalone watch app, directly over WebSocket (through the phone's Bluetooth proxy when paired, else Wi-Fi or LTE), or over BLE to the phone's page on Android | HTTP, TCP and UDP are allowed. Asking for Wi-Fi isn't instant, since the radio may be off. There are no web views on the watch, so the face is native (Compose). Standalone apps are allowed. The Data Layer reaches only a native phone app, so it can't help a web page. A community demo runs a GATT server on a watch. Inputs: the rotating crown or bezel, touch, haptics and the motion sensors. *Unverified:* latency through the Bluetooth proxy, and WebRTC on the watch (possible with native libraries, not needed). | Medium |
| Samsung Galaxy Watch (Watch4 and later) | The same app | Wear OS since the Watch4. The bezel gives rotary events with a haptic click. Samsung's Health Sensor SDK needs a Samsung partnership to ship, so the app uses the standard sensors. Tizen watches no longer take new apps, and their store content ended on 2025-09-30. | Medium |
| Apple Watch (watchOS) | A native iPhone app with WatchConnectivity. Nothing reaches a web page on the iPhone. | Apple's TN3135: every app gets HTTP through URLSession, but WebSockets and raw connections only while streaming audio, during a CallKit call, or to the same app on an Apple TV (DeviceDiscoveryUI). So nothing real-time reaches the room service. Inputs: Double Tap (one primary action, watchOS 11), the Digital Crown, and motion at up to 100 Hz live. | High |

**What a watch is for.** A second device on the wrist:
- its motion as a strike (the music room's drums);
- a flick or a double tap as A;
- the crown as a wheel or a slider;
- haptics for feedback.

It joins as part of its person, beside the phone (CATALOGUE §9.5).

## Phones relaying physical controllers (`bridge.gamepad`)

The phone's own browser already sees Bluetooth and USB pads through the Gamepad API: Chrome, Samsung Internet and Firefox on Android, and Safari on iOS and iPadOS (from 10.1). So a paired pad can join through the phone with no install, either as the phone's own gamepad or as a seat of its own (CATALOGUE §9.5).
- **Mapping.** Known pads (Xbox, DualSense, DualShock 4, Switch Pro) report the standard mapping in current browsers. A single Joy-Con and some 8BitDo modes may report none; that varies per device and is *unverified*. The bridge then keys the pad on `Gamepad.id` and offers a remap.
- **iOS pairing.** Xbox and DualShock 4 pads pair in Bluetooth settings, and some 8BitDo pads in Accessibility settings (webrcade's tests).
- **Rumble.** `vibrationActuator` works in Chrome (68+) and desktop Safari (16.4+), not in Firefox or on iOS.
- **No motion.** The Gamepad API carries no gyro; only Firefox has an experimental pose. A Joy-Con's or DualSense's gyro needs WebHID, which only desktop Chromium has, so `bridge.joycon` stays a PC bridge.

## Controller profiles: what to reuse

| Standard | What it gives | What ob.Pal takes | License |
|---|---|---|---|
| Gamepad API standard mapping (W3C) | Buttons 0–3 are the face buttons (bottom, right, left, top), 4–5 the bumpers, 6–7 the triggers, 8–9 View and Menu, 10–11 the stick presses, 12–15 the D-pad and 16 Guide. Axes 0–1 are the left stick and 2–3 the right. `mapping` is "standard" only when the browser knows the pad; otherwise the indices are raw. | The pad's canonical layout. PAD's button bits already follow it (`packages/core/src/pad.ts`), and every pad profile maps into it. | A W3C spec, free to implement |
| WebXR Input Profiles registry | A profile per controller: a vendor-prefixed id with fallbacks down to `generic-*`, layouts per hand, and typed components (trigger, squeeze, thumbstick, touchpad, button) mapped onto the `xr-standard` gamepad. Assets add visual responses and a glTF model per hand. 61 profiles from 13 vendors (assets 1.0.20); none from Apple or Sony. | The ids and fallback chain as `bridge.xr`'s controller ids, and the models to draw each hand's controller on the host | Code: the W3C Software and Document License. Assets: MIT, with the makers' trademarks excluded. Both fit MIT if the notices are kept. |
| SDL_GameControllerDB | One line per pad: its GUID and name, then semantic names mapped to raw indices (`a:b0,leftx:a0,dpup:h0.1,platform:Windows`) | The line format and the names, for pads read raw over WebHID or in ob.Pal Desktop. Browser indices differ from SDL's, and browsers don't expose SDL's GUID. | zlib |
| SDL3 gamepad names | Buttons named by position (south, east, west, north), with each maker's printed label as a separate layer. Confirm is usually south and cancel east, reversed in some regions. | Position names as the canonical button names, labels per profile, and confirm and cancel as a setting | zlib |
| Steam Input | Action sets and layers; digital and analog actions; gyro as a mouse or a joystick; mode shifts; activators (long, double and chorded presses); shared community configurations. There's no open spec, only the Steamworks docs and a VDF file. | Ideas only: a host mapping is an action set, a layer is a mode shift, an activator is a route option, and people share mappings (CATALOGUE §9.6) | Proprietary |
| OpenXR | The app declares actions and suggests bindings per interaction profile; the runtime picks the profile | The split between actions (catalogue controls) and bindings (profiles and mappings) | Khronos |
| Apple GameController | Profile classes by capability: micro (the Siri Remote) inside extended (a full pad) inside maker-specific (DualSense) | Capability tiers for pad profiles, so a smaller controller degrades gracefully | Proprietary |

## Order within step 8b

1. **The short code** (PLAN §4). It unblocks headsets as hosts, and watches.
2. **Headsets.** The Viewer as a host in Quest Browser and on Galaxy XR. Then `bridge.xr` on Quest, then Android XR, then Vision Pro's pointers. Test DataChannels on each device.
3. **A TV host.** A Tizen web app on a 2025 and a 2026 set, and a Cast receiver prototype. The WSS relay covers LG and older sets.
4. **A Wear OS app** for Pixel and Galaxy watches: direct first, then the Bluetooth link to Chrome on Android. Measure its latency against the phone's.
5. **`system.tv`** from ob.Pal Desktop, starting with Roku's official ECP.
6. **Apple Watch and Apple TV,** only with a native Apple app (PLAN §13).

## Sources

Checked 2026-09-27. Dates are the page's own where it shows one.

**TVs**
- Samsung, web engine specifications: https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html (Chromium per year; WebRTC "Yes" on Tizen 10, "Yes (partially)" on Tizen 9, "No" before; WebSocket and WebGL every year; re-read 2026-09-27)
- LG, web API and web engine: https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine (Chromium per webOS version)
- LG developer forum, WebRTC on webOS TV: https://forum.webostv.developer.lge.com/t/inquiry-regarding-webrtc-support-on-webos-tv/28059 (partner apps only; 2026-01-07)
- Google Cast, Web Receiver: https://developers.google.com/cast/docs/web_receiver/basic (a custom receiver is a web app you host)
- Google Home, CameraStream: https://developers.home.google.com/cloud-to-cloud/traits/camerastream (WebRTC in Cast for Google's own one-way camera streams)
- classic-chromecast-caster: https://github.com/RikvdReijen/classic-chromecast-caster (custom-receiver WebRTC on some devices only; third party)
- androidtv-remote: https://github.com/louis49/androidtv-remote (Android TV Remote v2, reverse-engineered: ports, on-screen code, mDNS)
- samsung-tv-ws-api: https://github.com/xchwarze/samsung-tv-ws-api (Samsung's remote on 8001 and 8002)
- aiowebostv: https://github.com/home-assistant-libs/aiowebostv (LG SSAP on 3001, client-key pairing)
- Roku, External Control Protocol: https://developer.roku.com/dev/docs/external-control-api (official; HTTP on 8060)
- Home Assistant issue 36240: https://github.com/home-assistant/home-assistant.io/issues/36240 (Roku's December 2024 firmware defaults to Limited)
- Home Assistant, Android TV: https://www.home-assistant.io/integrations/androidtv/ (Fire TV through ADB)
- Amazon, Vega WebView and WebGL: https://developer.amazon.com/docs/vega/0.21/webview-webgl-best-practices (WebGL2 and WASM, no WebGPU, Chrome user agent)
- Amazon, Vega web apps: https://developer.amazon.com/docs/vega/0.24/develop-your-app-with-webview.html (hosted web apps; no mention of WebRTC or WebSocket; 2026-09-15)
- AFTVnews: https://www.aftvnews.com/amazon-announces-fire-tv-stick-4k-select-the-first-non-android-based-fire-tv-running-vega-os/ (the first Vega OS device)
- Amazon Appstore Developers on X: https://x.com/AmazonAppDev/status/1973093688973860960 (Vega OS for all future players)
- pyatv, supported features: https://pyatv.dev/documentation/supported_features/ (Apple TV's Companion and MRP, PIN pairing)
- WWDC24, tvOS: https://developer.apple.com/videos/play/wwdc2024/10207/ (TVMLKit deprecated in tvOS 18)

**Headsets and glasses**
- Android XR, WebXR: https://developer.android.com/develop/xr/web (Chrome's WebXR modules on headsets and wired glasses; 2026-08-31)
- Android XR, devices: https://developer.android.com/develop/xr/devices (WebXR listed only for headsets and wired XR glasses; 2026-05-19)
- WebKit, WWDC24: https://webkit.org/blog/15443/news-from-wwdc24-webkit-in-safari-18-beta/ (visionOS WebXR: `immersive-vr`, transient pointers, hands behind a prompt)
- WebKit, Safari 26.2: https://webkit.org/blog/17640/webkit-features-for-safari-26-2/ (WebGPU in WebXR; 2025-12-12)
- Apple Developer Forums, thread 790351: https://developer.apple.com/forums/thread/790351 (PS VR2 controllers only as gamepads in Safari; 2025)
- Apple Developer Forums, WebXR tag: https://developer.apple.com/forums/tags/webxr (the AR-module flag has no effect in visionOS 26.5; 2026-09)
- Meta, Quest Browser release notes: https://developers.meta.com/horizon/release-notes/web/ (Chromium 146, 2026-04-21; WebGPU and XR items to v150.1, 2026-08-28)
- Meta, WebXR mixed reality: https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/ (passthrough AR, planes, meshes, hit test, anchors)
- Meta, building for display glasses: https://developers.meta.com/blog/build-for-display-glasses/ (native SDKs and Web Apps; Neural Band; up to 100 testers; 2026-05-14)
- Meta, Web Apps for glasses: https://wearables.developer.meta.com/docs/develop/webapps (Web Apps run on the glasses from a public HTTPS URL)
- UploadVR: https://www.uploadvr.com/meta-ray-ban-display-amazing-hud-apps/ (the Neural Band's fixed gesture set; secondary)
- TechCrunch: https://techcrunch.com/2025/09/15/snap-unveils-snap-os-2-0-with-native-browser-webxr-support-and-more/ (Snap OS 2.0's browser and WebXR; 2025-09-15)
- Snap, Spectacles WebXR: https://developers.snap.com/spectacles/about-spectacles-features/webxr (`immersive-ar`, hands first, emulated hit test, gamepads impractical)
- Snap, WebSocket API: https://developers.snap.com/spectacles/about-spectacles-features/apis/web-socket (documented for Lenses)
- XREAL, Aura: https://www.xreal.com/us/blog/aura-25-tas-release-en (Android XR; a WebXR demo)
- VR AR Wiki, Xreal Aura: https://vrarwiki.com/wiki/Xreal_Aura (due fall 2026, not shipped as of 2026-09-20; secondary)

**Watches**
- Apple TN3135: https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos (watchOS networking rules and their exceptions)
- Wear OS, network access: https://developer.android.com/training/wearables/data/network-access (Bluetooth proxy or Wi-Fi and LTE, standalone apps, no web views; 2026-09-22)
- Wear OS, rotary input: https://developer.android.com/training/wearables/compose/rotary-input (the crown and the bezel)
- GalaxyWatchBridge: https://github.com/FelipeTamm123/GalaxyWatchBridge (a watch as a GATT server; community demo)
- Can I use, Web Bluetooth: https://caniuse.com/web-bluetooth (Chromium on Android; no Safari)
- WWDC24, watchOS: https://developer.apple.com/videos/play/wwdc2024/10205/ (the Double Tap API)
- WWDC Notes, Core Motion: https://wwdcnotes.com/documentation/wwdc23-10179-whats-new-in-core-motion/ (motion at up to 100 Hz live, batched faster)
- Samsung Health Sensor SDK: https://developer.samsung.com/health/sensor/overview.html (raw sensors on Watch4 and later; shipping needs a partnership)
- Samsung, Tizen watch notice: https://developer.samsung.com/galaxy-watch-tizen/notice.html (no new or updated Tizen watch apps)
- Android Authority: https://www.androidauthority.com/samsung-tizen-os-support-ending-3592909/ (Tizen watch store content ended 2025-09-30)

**Pads and profiles**
- MDN compatibility data, Navigator: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json (`getGamepads` in Chrome, Samsung Internet and Firefox on Android, and Safari on iOS from 10.1)
- MDN compatibility data, Gamepad: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Gamepad.json (`vibrationActuator` in Chrome 68 and Safari 16.4, not Firefox or iOS; pose only in Firefox)
- webrcade, iOS gamepads: https://docs.webrcade.com/platforms/ios/gamepads/ (pads that work in Safari on iOS, and how they pair)
- W3C Gamepad: https://w3c.github.io/gamepad/ (the standard layout, when `mapping` is "standard", `xr-standard`, rumble)
- WebXR Input Profiles: https://github.com/immersive-web/webxr-input-profiles (registry and asset schemas; licenses)
- WebXR Input Profiles, profile list: https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets/dist/profiles/profilesList.json (61 profiles, 13 vendors; assets 1.0.20)
- SDL_GameControllerDB: https://github.com/mdqinc/SDL_GameControllerDB (the line format; zlib)
- SDL3 gamepad buttons: https://wiki.libsdl.org/SDL3/SDL_GamepadButton (position names and printed labels)
- Steamworks, in-game actions file: https://partner.steamgames.com/doc/features/steam_controller/iga_file (action sets, layers, action types)
- OpenXR, suggested bindings: https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrSuggestInteractionProfileBindings.html (the app suggests, the runtime picks)
- Apple GameController, GCMicroGamepad: https://developer.apple.com/documentation/gamecontroller/gcmicrogamepad (with GCExtendedGamepad and GCDualSenseGamepad: profiles by capability)
