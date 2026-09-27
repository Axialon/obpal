# A phone's physical buttons as controller buttons

**Research (2026-09-27), a live diagnostic, and a design for mapping them.** Which physical inputs a web page on a phone can hear, in which browsers, and at what cost; what only a native app can reach; and how a person binds what's left to the controller. The mapping is built after the controller contract (CATALOGUE §9, `face.*` ids), because a binding names a controller's controls.

The owner's note (2026-09-27): "also note i noticed headphone buttons utilized but no way to map physical phone buttons to the controller experience."

**How to read the marks.** Each claim was checked in the source code, the spec or the vendor's documentation on 2026-09-27:
- ✓ **verified**: read in a primary source (listed under Sources);
- ~ **inferred**: reasoned from code, or from secondary sources;
- ◌ **device check**: only a real phone can tell. The diagnostic at **/buttons/** shows it (below).

## At a glance

- **The phone's volume keys never reach a page.** Chrome, Edge and Samsung Internet (Chromium's content layer), Firefox (GeckoView) and every iOS browser (WebKit) keep them. That holds in fullscreen, as an installed app, and in a TWA ✓. Only a native app can have them.
- **Headset and earbud buttons work through Media Session,** behind an opt-in that plays a looped silent track ✓. On Android that track must be **longer than 5 s** ✓: the controller's one-second track was too short to get the presses (fixed on this branch). The cost: the person's music pauses ✓, a media card shows on the lock screen ✓, and on Android a silent page stops about a minute after the screen goes off ~ ◌.
- **Keyboards, presentation clickers and a selfie remote's Enter button work everywhere,** as ordinary key events ✓. A selfie remote's other button sends volume up, which is kept ✓.
- **Clip-on and Bluetooth pads work everywhere, through the Gamepad API** ✓. Only known pads say "standard" on Android ✓. Rumble works only on Android 12+, with pads that have two motors ✓.
- **Back can be caught on Android, once per tap** (CloseWatcher, or the history) ✓. iPhones have no Back button.
- **The Action button, Camera Control, power and side keys are never the web's** ✓.

## The matrix

"Chromium" is Chrome, Edge and Samsung Internet on Android: a tab, an installed web app (WebAPK) and a TWA use the same key path ✓ (Edge and Samsung Internet ~, by that shared path). "iOS" is Safari and every other iOS or iPadOS browser, in a tab or from the home screen ~.

| Input | Chromium on Android | Firefox on Android | iOS and iPadOS |
|---|---|---|---|
| The phone's volume keys | No ✓ | No ✓ | No ~ |
| A keyboard's or remote's volume keys | No: they become the same key codes ✓ | No ✓ | Only a keyboard's own volume keys (keyboard usage page) ~ ◌ |
| Keyboard, clicker and remote keys | Yes: keydown and keyup, with `key` and `code` ✓. Chrome may act on Esc first ◌ | Yes ~ | Yes ✓ (iOS 13 and later) |
| A selfie remote | Its Enter ("Android") button ~ ◌; its volume-up ("iOS") button: no ✓ | The same | The same |
| A keyboard's media keys | As keys first, then to the media session ✓ | ◌ | Never as keys; Media Session only ~ |
| A wired headset's button | Media Session only, after the opt-in ✓ | Media Session, only with an audible track ✓ | Media Session, after the opt-in ~ |
| Earbud buttons (Bluetooth) | Media Session, after the opt-in, with a track over 5 s ✓ | Media Session: a track of 3 s or more that is audible ✓ ◌ | Media Session, after the opt-in ✓ |
| Headset press, double, triple, hold | Play/pause, next ✓; previous only if the earbuds send it ~; hold: never ✓ | As Chromium, once it has controls ~ | Play/pause, next, previous (AirPods ✓, EarPods ~); hold: never ✓ |
| Clip-on and Bluetooth pads | Yes, once the page reads pads ✓; "standard" only for known pads ✓ | Yes, always "standard", 16 buttons ✓ | Yes, "standard" for full pads ✓; Home kept by iOS ◌ |
| Pad rumble | Android 12+, dual-rumble, two-motor pads ✓ | No ✓ | No ✓ |
| Back | Once per tap (CloseWatcher from Chrome 126, or the history) ✓ | Once per tap (CloseWatcher from Firefox 149) ✓ | No Back button; the edge swipe is a history step ◌ |
| Action button, Camera Control, power, side key | No ✓ | A camera shutter key may arrive ◌ | No ✓ |

Android WebView (a link opened inside another app) is like Chromium, with no Media Session ✓ and no pad rumble ✓.

## Volume keys

- **Chromium.** `ContentUiEventHandler.dispatchKeyEvent` sends a key to the page only if `shouldPropagateKeyEvent` allows it. The list it refuses: MENU, HOME, BACK, CALL, ENDCALL, POWER, HEADSETHOOK, CAMERA, FOCUS, VOLUME_DOWN, VOLUME_MUTE, VOLUME_UP and SYSRQ ✓. Nothing changes that: not a flag, fullscreen, the display mode or the activity ✓. The last change to the list was SYSRQ, in 2023 ✓. Android WebView goes through the same check ✓.
- **Firefox.** `GeckoEditable.shouldProcessKey` refuses MENU, BACK, FORWARD, VOLUME_UP, VOLUME_DOWN, VOLUME_MUTE, SEARCH and HEADSETHOOK, with a test that keeps it so ✓. Firefox's bug 1947131 (2025) notes that neither Chrome nor Firefox gives volume keys to web content ✓.
- **It's the browsers' choice.** Android hands volume keys to the app in front ✓, which is how a native shell can have them (Native paths).
- **iOS.** The side buttons aren't key events at all ~. WebKit maps only a keyboard's volume usages to `AudioVolumeUp` and `AudioVolumeDown` ✓. Apple's only app API for the buttons is AVCaptureEventInteraction, for camera apps, and WebKit doesn't use it ✓.
- **preventDefault can't hold what never arrives.** So "whether preventDefault stops the volume change" has no answer on a phone. Where volume keys do reach a page (a hardware keyboard on an iPad), the diagnostic's "Hold volume" test asks whether the volume still moved ◌.
- **Names.** `key` is `AudioVolumeUp`, `AudioVolumeDown` or `AudioVolumeMute` (`VolumeUp` in Firefox 48 and older) ✓. `keyCode` is 175/174/173 in Chromium and WebKit, 183/182/181 in Gecko ✓. The diagnostic and `src/controller/hardware.ts` take all of them.

**For ob.Pal.** The controller's volume-key handling runs only with such a keyboard, and in tests. Its help ("Volume keys work here") shows only once a volume key has arrived, so nobody is promised what can't happen. CATALOGUE §1 and the `layout.keys` comment in `packages/core` say some Android browsers pass volume keys; they should say none does (a proposal: those files are another lane's).

## Headset and earbud buttons (Media Session)

A page hears these only as Media Session actions, while it plays media. So the controller plays a looped silent `<audio>` track, started from a tap ✓. The rules for that track:

| Rule | Chromium (Android) | Firefox (Android) | WebKit (iOS) |
|---|---|---|---|
| Minimum length | **Over 5 s**: 5 s or less is "transient" ✓ | 3 s or more ✓ | Over 0.95 s ✓ |
| Silence | Counts for the session ✓, but a silent hidden page freezes after 1 min ✓ | Never gets controls: needs a sample over −72 dB ✓ ◌ | Doesn't matter ✓ |
| Muted element | No session ✓ | – | Never Now Playing ✓ |
| Volume 0 | Paused when hidden ✓ | – | Can't be set from script ~ |
| A MediaStream (`srcObject`) | Never controllable, yet takes full focus ✓ | Never controllable ✓ | Needs handlers or metadata ✓ |
| `loop` | Changes nothing (only the duration counts) ✓ | – | – |

**What a transient track costs on Android** ✓: Chrome asks only for ducking focus, creates no Android media session and shows no notification. The headset's presses then go to the last app that played with a media session ~, so Spotify, say, resumes. That was the controller's one-second track. It is ten seconds on this branch (commit a4db487).

**Presses.**
- **Android** ✓: the system turns a headset hook or play/pause key into play or pause after the double-tap timeout (about 300 ms). A second press within it is next track. Holding it starts the voice assistant, never the page. Android has no triple press of its own: previous comes only from earbuds that send it ~. Chrome maps play, pause, next, previous, fast-forward (`seekforward`), rewind (`seekbackward`) and seek (`seekto`, from the notification), but not stop ✓.
- **iOS** ✓: AirPods 3, 4 and Pro give play/pause, next and previous for one, two and three presses (support page updated 2026-09-14). Pressing and holding switches listening modes or calls Siri. EarPods are the same ~. WebKit maps Play, Pause, TogglePlayPause, NextTrack, PreviousTrack, the ±skips (`seekforward`, `seekbackward`) and SeekToPlaybackPosition (`seekto`) ✓.
- **Firefox** ✓: play, pause, next and previous (when the page registers them), and seek from the notification.
- **One press, either action** ✓: with `playbackState` kept at "playing", a single press arrives as `pause`, and some earbuds send play. So both are one input (`media:playpause`). No press has a release, so a headset button can tap but never hold.

**Costs** ✓:
- **The person's music pauses.** Chromium takes full audio focus for a persistent track. Safari's Playback category doesn't mix with other audio.
- **A media card appears** on the lock screen and in the notification shade. Android's shows the site's origin, our title and our artwork.
- **Android freezes a silent page.** A hidden page that isn't audible (under −72.25 dBFS, with a 30 s grace after sound) freezes after 1 minute, which pauses the element. The screen going off hides the tab ~. So headset control with the screen off lasts about a minute. A faint track, a constant level near −66 dBFS that nobody can hear, should keep the page "audible" ◌. The diagnostic has one to test.
- **iOS keeps the page running while it plays.** An `<audio>` element keeps playing on the lock screen, and Safari keeps the page's process awake until 10 s after it stops. Whether a WebRTC data channel keeps flowing ◌.
- **The system can pause the track without telling us.** Unplugging headphones pauses it with no call to our handler ✓, and so should another app taking the audio or a phone call ~. The controller must show that as off, with a tap to turn it back on.
- **Home-screen apps on iOS** have open WebKit bugs: resuming from the lock screen after a pause (243258), controls after playback ends in the background (261858), and silent audio on reopening in iOS 26 (295518). So the loop must never stop in a home-screen app ✓.
- **Where it can't work.** In-app browsers (Android WebView) have no Media Session ✓. Other iOS browsers have it; their background audio is their own ◌. Android 17 restricts background audio to apps with a visible screen or a foreground service; Chrome's media notification runs one ~.

## Keyboards, clickers and selfie remotes

- **In Chromium, every key not on its refusal list reaches the page as keydown and keyup** ✓, with `code` from the scancode and `key` from the key map: Enter, Space, Esc, the arrows, Page Up and Down, letters and F-keys. Firefox ~ and iOS ✓ (below) do the same.
- **Chrome acts on some keys first** ✓: its keyboard shortcuts see Esc, Ctrl+Page Up/Down, F6, F7, Search and Menu before the page (whether Esc then reaches the page ◌). F5 reloads only if the page didn't handle it ✓.
- **Default actions.** Space, the arrows and Page Up/Down scroll by default, and `preventDefault` on keydown stops that ~.
- **Presentation clickers** send keyboard keys: the Logitech R400 sends Page Up, Page Down, F5, Esc and period ~. The Spotlight without its software sends roughly the arrows ~ ◌.
- **Selfie remotes** (AB Shutter 3 and clones) have two buttons ~: the "iOS" one sends volume up (kept everywhere ✓), and the "Android" one sends Enter (some clones send Enter and volume up) ~ ◌. Only Enter reaches a page, and it would press a focused button unless the page stops it.
- **Media keys** on a Bluetooth keyboard reach a page on Android as keys first ✓. If the page leaves one unhandled, Chrome passes it to the media session ✓. HEADSETHOOK never reaches the page ✓. On iOS media keys never arrive as keys ✓; they go to Now Playing ~.
- **iOS with a hardware keyboard** ✓: WebKit gives the standard `key` and `code`, and `repeat` for a held key. The old quirks (no keydown without a focused field, keyCode 0, "UIKeyInputUpArrow") were fixed in iOS 13. Safari's Cmd shortcuts win ~. Full Keyboard Access may take Tab and the arrows ◌.
- **A pad-like remote** (one Android calls a gamepad) sends its keys to the Gamepad API instead of keydown while the page reads pads ✓.

## Pads (the Gamepad API)

- **Hidden until a button press** ✓: `getGamepads()` returns nothing, and `gamepadconnected` doesn't fire, until someone presses a button. HTTPS isn't required ✓, but ob.Pal is HTTPS anyway. The permissions policy `gamepad` allows every origin by default ✓, so an embed in a cross-origin iframe can read pads unless its page blocks them.
- **Chrome on Android** ✓:
  - It hands a pad's keys to the Gamepad API only while a visible page reads pads: once it calls `getGamepads()` or listens for `gamepadconnected`.
  - Until then, Chrome's own shortcuts take them: **B closes the tab**, X focuses the address bar, Y opens the menu, Start goes forward, and L1/R1 switch tabs ◌. **The controller page doesn't read pads today**, so a clip-on pad's B closes its tab (What this changes, below).
  - In WebView apps, an unhandled B falls back to the system's Back ✓ ◌.
- **Mapping on Chrome for Android** ✓:
  - `mapping` is "standard" only for pads Chrome knows: DualShock 4, DualSense, Xbox One S and Series, Switch Pro (Android 11+), Stadia, and a few by name.
  - Other pads that send Android's standard key codes arrive in the standard order anyway, with `mapping` "".
  - Razer Kishi, Backbone One (USB-C) and GameSir X2, X3 and G8 aren't in Chrome's lists, so they likely say "" ~ ◌.
  - 8BitDo pads depend on their mode ~ ◌.
  - The id reads "Name (STANDARD GAMEPAD Vendor: xxxx Product: yyyy)" ✓.
  - An unknown pad may show more than four axes from about Chrome 154 ✓.
- **Firefox on Android** ✓: `mapping` is always "standard", with 16 buttons (no Home), and there is no rumble.
- **iOS and iPadOS** ✓:
  - Every full pad (GCExtendedGamepad) is "standard": MFi pads like the Backbone and the Kishi for iPhone, plus Xbox, PlayStation and Switch Pro pads.
  - The id is the maker's name plus "Extended Gamepad", with no USB ids.
  - WebKit binds Home, Options and Menu as buttons 16, 8 and 9 and asks iOS for them, but iOS may still keep Home for Game Center or the pad's own app ◌.
  - iOS 26 lets a pad drive the system; Safari 26.1 fixed B making a page lose the pad ✓.
- **Rumble** ✓:
  - Chrome for Android: `playEffect('dual-rumble')` from Android 12 (VibratorManager), only for pads with at least two amplitude-controlled motors. There's no trigger rumble on Android, and none in WebView. It was on by default from about Chrome 119 ~.
  - Most clip-on pads have no motors ~ ◌.
  - None in Firefox, and none on iOS (WebKit's pad haptics are macOS only).
  - The fallback is the phone's own `navigator.vibrate` on Android. Chrome counts a pad's press as a user gesture while the page is visible ✓.

## Back

- **Chrome's order on Android** ✓: fullscreen first (the first Back only leaves fullscreen), then close watchers, then the tab's history, then minimising the app. Chrome looks only at the focused frame.
- **CloseWatcher** ✓ (Chrome 126, Firefox 149; Safari only in its Technology Preview):
  - A page can create one watcher freely. Watchers made without a user activation since the last one join the last group, and one Back closes a whole group.
  - Chromium's count of allowed groups starts at 1, grows with the person's activations, and drops by one after each Back, never below 1.
  - The `cancel` event can stop a close only with an activation, which that uses up.
  - So a page catches **one Back per tap**. Whether a watcher made again at once, with no tap, catches the next Back is ◌: the diagnostic's Catch Back re-arms without a tap to find out.
- **The history technique** ✓ (`pushState`, then `popstate`): Chrome's intervention (about Chrome 75 ~) makes Back skip entries a page added without a user activation. Firefox 135/136 and WebKit do the same. On Android, if every entry is skippable, Back closes the tab. The controller's sheets already use this, always from a tap, so they're safe.
- **The Navigation API** ✓ can cancel a Back only within the same page, from the top frame, with an activation, and never across documents (Chrome from about 112 ~, Firefox 147). Safari 26.2 skips the activation check (marked FIXME in WebKit), so a swipe-back might be cancellable there ◌.
- **Predictive back** ✓: pages can't opt in or out. They can detect Chrome's own preview (`hasUAVisualTransition`).
- **The risks.** In an installed app or a TWA, one Back too many closes the app ✓. On Android 16 with a single tab, Chrome gives Back to the system for its animation ✓. A page that keeps catching Back traps people.

## Buttons the web can't reach

- **Android.** Power, Home, Call and End Call, the camera and focus keys, and the headset hook never reach a page in Chromium ✓. The Samsung side (Bixby) key and "AI" keys are the system's ~. Chromium refuses a fixed list rather than allowing one, so a key an OEM passed on would arrive ~ ◌. Firefox doesn't refuse the camera keys: a shutter key (on some Xperias) may arrive as `Camera` and `CameraFocus` ◌.
- **S Pen.** Chromium reports the pen's button as the secondary ("right") button, and holding it while dragging selects text ✓. What a page sees ◌.
- **iPhone Action button** ✓: it runs a system action, a Shortcut or a native app's control (WidgetKit). A Shortcut's "Open URL" is a navigation, not a press ~.
- **Camera Control** ✓: camera apps only (AVCaptureControl, AVCaptureEventInteraction).

## Native paths, for what the web can't reach

| Path | What it gets | Effort | Store risk |
|---|---|---|---|
| **Android WebView shell** | Volume keys, pads read natively, media buttons, the page over a JS bridge | 3–5 days, plus 1–2 of store setup | Low |
| **TWA** | Nothing for buttons | 1–2 days | Low, but it doesn't help |
| **iOS: AVCaptureEventInteraction** | Volume up and down, the Action button, Camera Control (AirPods stem clicks from iOS 26), only while a camera session runs | 4–6 days | High |
| **iOS: watching `outputVolume`** | Volume presses, by resetting the volume through a hidden `MPVolumeView` | 2–3 days | High (guideline 2.5.9) |
| **iOS: App Intents and Controls** | One Action-button press runs one intent: not a stream of presses | 2–4 days, plus a native app | Low to medium |

**The Android WebView shell** ✓:
- **Volume keys.** Returning true from `Activity.dispatchKeyEvent` for KEYCODE_VOLUME_UP and DOWN (down and up) stops the volume change, since the volume only moves when the key reaches the window's default handler. The system's button chords, calls and the screen-off path come first ~.
- **The bridge.** `WebViewCompat.addWebMessageListener` (androidx.webkit) injects a JavaScript object into the origins it allows. The page posts once; the app keeps the reply proxy and pushes each press through it.
- **Media buttons.** Keys from wired and USB devices reach `dispatchKeyEvent` first while the app is in front. Earbuds follow media-session routing: the last app with a session that played locally. So the shell still needs a MediaSession and real playback ◌.
- **Pads.** The shell can read them natively (InputDevice), own the mapping (Home included), avoid B falling back to Back, and rumble through VibratorManager ~.
- **What the page loses in WebView.** Media Session and pad rumble aren't there ✓; the shell replaces both natively.
- **Play policy.** Nothing forbids keys handled inside your own app (Device and Network Abuse) ✓. A webview of your own site is allowed (the Spam policy's rule is about others' sites) ✓. Don't use an AccessibilityService for keys ✓. New personal developer accounts must run a closed test with 12 testers for 14 days ✓. Apps must target API 36 from 2026-08-31 (Wear OS: 35) ✓.

**Why a TWA can't** ✓: a TWA shows the page in the browser's own activity (a Custom Tab), so keys go to the browser, which keeps the volume keys as above. `TrustedWebActivityIntentBuilder` has no key options, only the splash screen, origins, share and file handling, the display mode, orientation and the launch handler. Its postMessage channel (Chrome 115) could carry a watch's input, but no keys.

**iOS** ✓:
- **AVCaptureEventInteraction** (iOS 17.2) delivers volume down, the Action button and Camera Control as its primary event and volume up as its secondary, only while the app is in front with the camera running. The camera indicator stays on, and Apple meant it for capture. Using the camera just to have buttons would likely fail review ~.
- **`outputVolume`** can be observed. Resetting the volume through a hidden `MPVolumeView` is undocumented, and guideline 2.5.9 rejects apps that change what the volume buttons do. Guideline 4.2 (minimum functionality) also bears on a thin wrapper.
- **The Action button** reaches apps only through App Intents, Shortcuts and iOS 18 Controls.
- **Camera Control** is for camera apps (AVCaptureControl, LockedCameraCapture).

**How this meets step 8b (the Wear OS app first)** ✓ ~:
- **One app, one listing.** A Wear OS app beside a phone app uses the same package name and, as Google recommends, the same Play listing; its APK goes up under the Wear OS form factor.
- **The phone half doubles as the shell.** It is the watch's companion (the Data Layer works only with Android phones ✓) and the controller's WebView shell. The watch's messages and the phone's volume keys, media buttons and pads all reach the controller page over the same JavaScript bridge. That's 1–2 days on top of the shell ~.
- **The phone half stays optional.** If the watch joins the room service directly (PLAN §13), it can be standalone, and people who never install the phone app keep the web controller.
- **iOS waits.** Nothing for iOS until an Apple app is on demand (§13).

## What this changed

Done on 2026-09-27, with the bindings below:
1. **The headset's track** was one second: transient in Chromium, so on Android the presses never reached the controller ✓. It is ten seconds (`src/controller/inputs.ts`), and the Buttons sheet shows "Paused" when the phone pauses it (headphones out, a call, another app's music). The faint track stays a diagnostic option until the owner's phones say whether it keeps headset control alive with the screen off on Android, and makes Firefox work ◌.
2. **Pads:** the controller reads them from the start, so in Chrome on Android a clip-on pad's B no longer closes its tab ✓ (code) ◌ (device). A pad's D-pad, which arrived as arrow keys before, now arrives as pad buttons and is bound to next and previous, so nothing changes for the person.
3. **Volume keys:** CATALOGUE §1 and the `layout.keys` comment now say that no phone browser passes them. The defaults keep them for keyboards that have them, and for a future native shell.
4. **Esc on Android** may still be Chrome's before the page's ◌: the diagnostic shows whether it arrives.

## The diagnostic: /buttons/

A standalone page (`buttons/index.html`, `src/buttons/`), live from the next deploy at https://obpal.blackboxes.net/buttons/ (locally: `pnpm dev`, then /buttons/). It reaches no screen: it only shows what arrives, large, as it arrives:
- **every key event**: `key`, `code`, `keyCode`, repeats, how long it was held, and whether it was prevented;
- **Media Session actions**, once **Headset** is on (it plays a silent track and pauses other audio), with a choice of track: 1 s (what the controller played), 10 s, or 10 s faint;
- **connected pads**: every button and axis by index and value, the mapping, and **Rumble**;
- **Back**, once **Catch Back** is on, through CloseWatcher where there is one;
- **the environment** (system, browser, and whether it's a tab, installed app, home-screen app or TWA);
- **one line to paste back**, with **Copy** and **Share**. What it saw survives a reload.

**On each phone and browser** (Chrome, Samsung Internet, Firefox, Edge; each installed from the menu too; Safari, and from the home screen on an iPhone):
1. Press the volume keys, then turn **Hold volume** off and press again, and answer whether the volume moved.
2. Press every button on a remote, clicker, selfie remote or keyboard.
3. Turn **Headset** on and press once, twice, three times, then hold. Do it with each track. Then lock the phone for two minutes and press again. Then start music in another app and come back.
4. Connect a pad, press every button, move the sticks, and try **Rumble**.
5. Turn **Catch Back** on and press Back three times without touching the screen. Then again, tapping the screen between presses.
6. Go fullscreen (on Android) and repeat 1 and 5.
7. **Copy** and paste the line back.

## Bindings: mapping physical inputs to the controller

**Status: built 2026-09-27** (PLAN step 5b.1b; CATALOGUE §1 and §3). Before, every physical input was fixed to one of four actions (primary, secondary, next, previous), and the mode decided what each did; a host could point those four at tray buttons (`layout.keys`), and nobody could see or change any of it. The design below is what was built, with these differences and additions:
- **Smart use with no setup** (the owner, 2026-09-27: "map what can be mapped and available as options or smart use based on received input"). The first input from a source each session tells what kind of device it is: arrows or Page Up and Down only are a presentation clicker; a lone Enter or volume up a selfie remote; a pad with the standard mapping a pad; media actions a headset; any other key a keyboard (`inferKind` in `packages/core/src/buttons.ts`). That kind's smart defaults for the controller in use apply at once, as a layer between the controller's defaults and the host's, and a notice says what it now does, with **Change** (the sheet, at that input). Smart defaults are saved per kind and controller the first time they're used (`obpal.buttons-smart`), so they stay as they were.
- **A one-tap bind:** an input nothing uses, from a device already recognised, offers the controller's main controls in a notice; one tap binds it.
- **Every input is an option:** the sheet lists everything a phone can hear (headset presses by count, keys, every pad button and stick direction, Back), to pick instead of pressing.
- **Keys on the screen:** where the screen takes typing (a keyboard tray control, as ob.Pal Link's PC layout has), any controller's inputs may press its key row (`key-ArrowRight` and the rest). A clicker's next and previous do by default, so a presentation on a PC moves on.
- **Back** is caught only through CloseWatcher (no history fallback), only while it's bound (or the sheet is waiting for it), and armed again only after a touch.
- **The chips** are a grid in the controller's own order, not its miniature layout.
- **The profile layer** reads the built-in profiles today, none of which binds anything; community and personal profiles reach the phone with the picker (5b.1).
- **Storage:** the person's own under `obpal.buttons.<profile id>`, as `{controller: {input: target}}`; the profile is the gamepad's in effect on the gamepad and the wheel, and `default` elsewhere.

### The idea

Each controller has default bindings. A profile can change them, and so can the person, the way a game's settings bind keys: open **Buttons**, tap a control, press the physical button. The phone resolves every physical press to one of the current controller's controls and presses it, exactly as a thumb would. Nothing new goes on the wire: the host sees A, a tray tap or a mouse click, as today (CATALOGUE §1, "Device buttons").

### Inputs

An input is anything physical the page can hear, named as the diagnostic names it (`src/buttons/inputs.ts`, unit-tested):

| Input id | What | Where it works (the matrix) |
|---|---|---|
| `key:<code>` | A key by its physical `code` (`key:Enter`, `key:PageDown`, `key:KeyB`, `key:AudioVolumeUp`). The `key` value if there's no code, else the legacy keyCode (`key:#175`) | Keyboards, clickers, remotes and a selfie remote's Enter, everywhere. The phone's own volume keys, nowhere |
| `media:<action>` | A Media Session action; play and pause are one press, `media:playpause` | Headset, earbud and Bluetooth media buttons after the headset opt-in: Android (Chromium) and iOS; Firefox with an audible track |
| `pad:b<i>`, `pad:a<i>+`, `pad:a<i>-` | A pad's button, or an axis pushed past half way, by the standard mapping's index; `pad:raw:…` when the pad's `mapping` isn't "standard" | Clip-on and Bluetooth pads, everywhere |
| `back` | Back, caught by the page | Android, once per tap |

### Controls: what an input can press

A binding's target is one of the current controller's **controls**: `ControllerSpec.controls` in the contract, the ids a physical input may press, next to the utilities it's built from. The phone knows how to press each one.

| Controller | Controls |
|---|---|
| `face.gamepad`, `face.wheel` | `a b x y lb rb lt rt view menu ls rs up down left right guide` (PAD's buttons) |
| `face.wii` | `a b minus home plus` |
| `face.mouse` | `left right middle wheel minus plus home` (`wheel` holds the wheel: aim to scroll) |
| `face.trackpad` | `grab` (the 1:1 gyro on and off), `level` |
| `face.hand` | `hold` (the pad's deadman), `recentre` |
| `face.keyboard` | `key-Escape key-Tab key-ArrowLeft key-ArrowUp key-ArrowDown key-ArrowRight key-Backspace key-Enter` (its key row) |

Besides the controller's own controls, a binding may press:
- `key-<code>`: a key on the screen, from the keyboard control's key row (Esc, Tab, the arrows, Backspace, Enter), where the screen takes typing. It taps.
- `tray:<id>`: a tray button the host sent (a robot arm's Stop, Grip or Home). It taps, as `layout.keys` does today.
- `app:<action>`: the phone's own. `app:gyro` switches the gyro, `app:recentre` recentres, `app:next` and `app:prev` pick the next or previous controller in the bar, and `app:keyboard` opens the keyboard.
- `none`: ignore the input (to take a default away).

A held input holds a control that can be held (A, B, the triggers, Left, the wheel, `hold`) and lets go when released. Tray buttons, `app:` actions and every `media:` input tap. A headset press arrives as one event with no release (on Android up to 300 ms late), so it can't hold anything.

### Defaults per controller

Today's behaviour, written down as data. It's what someone gets without ever opening the sheet.

| Controller | Vol+ | Vol− | Enter, Space | Esc, Backspace | →, PgDn | ←, PgUp | Headset press | Headset next / prev |
|---|---|---|---|---|---|---|---|---|
| `face.gamepad` | a | b | a | b | right | left | a | right / left |
| `face.wheel` | rt (throttle, held) | lt (brake, held) | a | b | right | left | a | right / left |
| `face.wii` | a | b | a | b | plus | minus | a | plus / minus |
| `face.mouse` | left | wheel | left | wheel | plus | minus | left | plus / minus |
| `face.trackpad` | grab | level | grab | level | – | – | grab | – |
| `face.hand` | hold | recentre | hold | recentre | – | – | – | – |
| `face.keyboard` | – | – | – (typing) | – | – | – | – | – |

- The volume columns matter only for a keyboard's volume keys and for a future native shell. On phones, the Enter and headset columns do the work.
- On `face.gamepad` and `face.wheel`, a pad's own buttons pass straight through (CATALOGUE §9.5, "Use a pad here"): the standard mapping is already the controller's layout. On the other controllers a pad's A, B and D-pad take the Enter, Esc and arrow rows.
- `back` is bound to nothing by default, everywhere.
- A host's suggestion outranks these defaults (`layout.keys` today, generalised below). In the robot arm sim, Vol+ grips and Vol− stops everything.

### Resolving a press

From lowest to highest, each layer lists only what it changes:
1. the controller's defaults (above, as data in `packages/core`);
2. the smart defaults of the kinds of device the phone has recognised (a clicker, a pad; "Status" above);
3. the host's suggestion: `layout.buttons?: Record<input id, target>`. `layout.keys` reads as the same thing, with `primary` standing for Enter, Space, one headset press and a pad's A, and so on;
4. the profile's `buttons` (below);
5. the person's own changes for this profile, kept on the phone. These always win.

A target the controller can't use is skipped, and so is a tray button the screen hasn't got, or a key where it doesn't take typing: the layer below stands.

A press resolves to one control, or to nothing. It never reaches the host as a raw key: the host gets the control's own message (PLAN §9: never raw key sequences).

### The Buttons sheet

A glass sheet like Settings. It opens from:
- **Settings → Buttons**, which shows a small stack of the sources that work here;
- **a long press on any control** → "Bind a button", which starts listening for that control at once;
- **the toast** that already appears the first time a physical button works ("Enter = A"), through its **Change**.

Top to bottom:
1. **The controller in miniature.** Its controls are glass chips in their real layout (the gamepad's face, the Wii remote's column, the mouse's two buttons and wheel). Each carries the badges of what's bound to it, such as `Enter` and `Play` on A: up to two, then `+1`.
2. **Press to assign.** Tap a chip and it pulses. The sheet says only "Press a button on your phone, headset, remote or pad", over the glyphs of the sources that work here. The first physical input binds to it with a tick, and the line becomes "Enter → A · Undo". Tapping anywhere else, or 10 s of nothing, cancels. While it listens, a press does nothing else, so binding never presses A on the screen.
3. **Press to find.** With no chip selected, pressing a physical button lights the chip it's bound to and names it. That's how people find out what their earbuds do.
4. **Sources.** One row of five glyphs: Keys, Volume, Headset, Pad and Back. Each is lit once it has worked on this phone, dim until then, or struck through with one short line where this browser can't have it (below).
   - Headset's switch lives here: "Turn on · plays silence and pauses your music". When the phone pauses the track (a call, another app's music, headphones unplugged), it reads "Paused · tap to turn on".
   - Back's switch: "Use Back as a button" (below).
5. **Reset**, for this controller, as an inline "Reset buttons? Reset" rather than a dialog.

**Conflicts.** An input presses one control. Binding it again moves it, and the chip it left shows "moved to B · Undo" for a moment. A control can have several inputs. Because of the layers, a reset clears only the person's own changes: the profile's and the host's bindings come back.

**Back as a button** is an opt-in with one line: "Back after a tap stays here · twice leaves". The controller re-arms it only after a touch, so two Backs in a row always leave, whatever the platform allows. That matches CloseWatcher's rule. In fullscreen, the first Back leaves fullscreen instead (Chrome's order).

**Honest, per device.** One short line, only where a source can't work, from the matrix and what this phone has shown:
- "This browser keeps the volume keys" (every phone browser);
- "No headset buttons in this browser" (no Media Session: an in-app browser);
- "Back is Android's" (iOS);
- "Connect a pad over Bluetooth or USB" (no pad yet).

A source that has worked on this phone is never struck through, whatever the table says: the phone's own evidence wins.

**Badges on the controller.** Outside the sheet, a bound control carries a small pill in its corner (`Enter` on A, `Play` on Left). Each pill is in its source's light: lime for keys, lavender for volume, sky for the headset, amber for a pad.
- Only inputs that have worked on this phone get one, so a phone never shows `Vol+`.
- They fade to half after the first use.
- They stay off a controller that's already dense (the gamepad), where the sheet is the place to look.
- A setting turns them off.

### In the profile

Proposed for the profile (CATALOGUE §3, and §9.6 "Wider profiles"). A profile already names what it tunes, and buttons are one more part of that:

```ts
interface ProfileSpec {
  // …id, name, for, on, aim, steer, point, as today
  /** The controller the profile tunes (CATALOGUE §9.1). Absent: `face.gamepad`, as for every profile today. */
  controller?: string
  /**
   * Physical inputs bound to that controller's controls, only where they differ from its defaults.
   * Keys: input ids (`key:Enter`, `media:nexttrack`, `pad:b4`, `back`).
   * Values: a control of the controller (`a`, `left`), `tray:<id>`, `app:<action>` or `none`.
   */
  buttons?: Record<string, string>
}
```

For example, a presenter profile for the air mouse, driven from a clicker and earbuds:

```json
{
  "id": "presenter",
  "name": "Presenter",
  "for": "Slides from a clicker, a keyboard or earbuds",
  "controller": "face.mouse",
  "on": ["motion.point"],
  "buttons": {
    "key:PageDown": "tray:next", "key:PageUp": "tray:prev", "key:KeyB": "tray:blank",
    "media:nexttrack": "tray:next", "media:previoustrack": "tray:prev",
    "media:playpause": "left"
  }
}
```

The profile's `aim`, `steer` and `point` are left out of the example; they don't change.

**Checks,** in `checkProfile()` and /profile.schema.json, so the builder, the build and the phone agree:
- an input id matches `^(key:(#\d{1,3}|[A-Za-z0-9]{1,32})|media:[a-z]{2,24}|pad:(raw:)?(b\d{1,2}|a\d{1,2}[+-])|back)$`;
- a value is one of the controller's `controls`, `tray:` with an id of 1 to 40 characters, `app:gyro|recentre|next|prev|keyboard`, or `none`;
- a profile has at most 32 bindings (`PROFILE_LIMITS.buttons`).

**Where they live.**
- A built-in or community profile carries `buttons` in its JSON, like its motion settings.
- The person's own changes are saved on the phone per profile, as chip options already are (§3): `obpal.buttons.<profile id>` in localStorage, the same map shape.
- "Save as mine" in the sheet, or the /catalogue/ builder's "Use on my phone" (§9.6), folds them into a profile of the person's own.
- The host never stores them and never learns which physical input was pressed.

**Reserved for later**, not in the first version: Steam Input-style activators in the id (`key:Enter~long`, `~double`), and chords.

## In the plan

**5b.1b: Buttons**, inside 5b (the controller catalogue in the phone), beside the picker (5b.1): built 2026-09-27, ahead of the picker, on the controller contract from step 3. With 5b.1 the profile layer grows to community and personal profiles, and with 5b.2 a pad's sticks join its buttons. A native Android shell, the only way to a phone's own volume keys, is noted in step 8b, beside the Wear OS app.

**What was built:**
1. **Core** (`packages/core/src/buttons.ts`): the input id grammar, `ControllerSpec.controls`, the default bindings as data, the device kinds and their smart defaults, `layout.buttons` (with `layout.keys` read as it), and `controller` and `buttons` in profiles (`checkProfile()`, /profile.schema.json, /catalogue.json).
2. **The phone's inputs** (`src/controller/inputs.ts`): one stream of input ids with down and up, from keys, the Media Session, pads and Back. `HardwareButtons` folded into it.
3. **Bindings on the phone** (`src/controller/buttons.ts`): the layers, smart use, the notices, the Buttons sheet and the badges; `src/controller/main.ts` presses what a binding names.
4. **The /catalogue/ builder:** a buttons table.
5. **Tests:** unit (`tests/bindings.test.ts`: inference, layers, defaults, profiles) and e2e:phone (a clicker and a standard pad with no setup, the one-tap bind, the sheet binding Enter to B, Reset).

## Sources

Checked 2026-09-27, on each project's main branch. Prefixes:

| Prefix | Location |
|---|---|
| CR | https://github.com/chromium/chromium/blob/main/ |
| FF | https://github.com/mozilla-firefox/firefox/blob/main/ |
| WK | https://github.com/WebKit/WebKit/blob/main/ |
| AOSP | https://github.com/aosp-mirror/platform_frameworks_base/blob/main/ (a mirror) |

**Chromium**
- Keys to the page: CR content/public/android/java/src/org/chromium/content/browser/ContentUiEventHandler.java (`dispatchKeyEvent`, `shouldPropagateKeyEvent`); CR android_webview/java/src/org/chromium/android_webview/AwContents.java; CR ui/android/view_android.cc; CR components/input/web_input_event_builders_android.cc.
- Chrome's shortcuts and media keys: CR chrome/android/java/src/org/chromium/chrome/browser/KeyboardShortcuts.java; CR chrome/android/java/src/org/chromium/chrome/browser/app/tab_activity_glue/ActivityTabWebContentsDelegateAndroid.java.
- Transient media: CR media/base/media_content_type.cc (`DurationToMediaContentType`, `kMinimumContentDurationSecs` = 5); CR third_party/blink/renderer/platform/media/web_media_player_impl.cc.
- Media sessions: CR content/browser/media/session/media_session_impl.cc (`AddPlayer`, `IsControllable`); CR content/browser/media/session/media_session_controller.cc; CR content/public/android/java/src/org/chromium/content/browser/AudioFocusDelegate.java.
- The notification: CR components/browser_ui/media/android/java/src/org/chromium/components/browser_ui/media/MediaSessionHelper.java and MediaNotificationController.java; CR third_party/blink/renderer/modules/mediasession/media_session.cc.
- Freezing silent pages: CR third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.cc; CR media/base/media_switches.cc; CR third_party/blink/renderer/core/html/media/html_media_element.cc.
- Pads: CR device/gamepad/android/java/src/org/chromium/device/gamepad/GamepadList.java, GamepadDevice.java and GamepadMappings.java; CR device/gamepad/gamepad_platform_data_fetcher_android.cc; CR device/gamepad/gamepad_id_list.cc; CR device/gamepad/gamepad_data_fetcher.cc; CR device/gamepad/public/cpp/gamepad_features.cc; CR third_party/blink/renderer/modules/gamepad/navigator_gamepad.cc; CR services/network/public/cpp/permissions_policy/permissions_policy_features.json5.
- Back and close watchers: CR third_party/blink/renderer/core/html/closewatcher/close_watcher.cc and close_watcher.h; CR docs/history_manipulation_intervention.md; CR third_party/blink/renderer/core/navigation_api/navigation_api.cc.
- Back handling in Chrome: CR components/browser_ui/widget/android/java/src/org/chromium/components/browser_ui/widget/gesture/BackPressHandler.java; CR chrome/browser/back_press/android/java/src/org/chromium/chrome/browser/back_press/CloseListenerManager.java; CR chrome/android/java/src/org/chromium/chrome/browser/customtabs/content/CustomTabActivityNavigationController.java.
- chromestatus: 4722261258928128 (CloseWatcher), 5712153302532096 (history manipulation intervention), 5204831477694464 (back-forward transitions).

**Firefox**
- FF mobile/android/geckoview/src/main/java/org/mozilla/geckoview/GeckoEditable.java (`shouldProcessKey`).
- Bug 1947131, volume keys: https://bugzilla.mozilla.org/show_bug.cgi?id=1947131
- FF mobile/android/geckoview/src/main/java/org/mozilla/gecko/AndroidGamepadManager.java; FF dom/gamepad/android/AndroidGamepad.cpp.
- FF dom/media/mediaelement/HTMLMediaElement.cpp; FF modules/libpref/init/StaticPrefList.yaml (`media.mediacontrol.eligible.media.duration.s`); FF dom/media/AudibilityMonitor.h; FF widget/NativeKeyToDOMKeyName.inc.

**WebKit**
- WK Source/WebCore/platform/ios/KeyEventIOS.mm; WK Source/WebCore/platform/ios/PlatformEventFactoryIOS.mm.
- WK Source/WebCore/html/MediaElementSession.cpp (`canShowControlsManager`, `isElementLongEnoughForMainContent`); WK Source/WebCore/html/HTMLMediaElement.cpp.
- WK Source/WebCore/platform/cocoa/RemoteCommandListenerCocoa.mm; WK Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm; WK Source/WebCore/platform/audio/ios/MediaSessionManagerIOS.mm; WK Source/WebCore/Modules/audiosession/DOMAudioSession.cpp.
- WK Source/WebCore/platform/gamepad/cocoa/GameControllerGamepad.mm; WK Source/WTF/wtf/PlatformHave.h; WK Source/WebKit/Shared/WebPreferencesDefaultValues.cpp; WK Source/WebCore/page/Navigation.cpp.
- WebKit bugs 149054, 198277, 243258, 261858, 263022 and 295518: https://bugs.webkit.org/
- Safari 26.1, gamepads: https://webkit.org/blog/17541/ (2025-11-03).
- A switch's haptic tick on iOS 18: https://webkit.org/blog/15865/

**Android**
- AOSP services/core/java/com/android/server/policy/PhoneWindowManager.java; AOSP core/java/com/android/internal/policy/PhoneWindow.java; AOSP core/java/com/android/internal/policy/PhoneFallbackEventHandler.java; AOSP data/keyboards/Generic.kl and Generic.kcm.
- AOSP media/java/android/media/session/MediaSession.java (`Callback.onMediaButtonEvent`); AOSP services/core/java/com/android/server/media/MediaSessionStack.java and MediaSessionService.java.
- AVRCP: https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/android/app/src/com/android/bluetooth/avrcp/helpers/AvrcpPassthrough.java
- The headset spec: https://source.android.com/docs/core/interaction/accessories/headset/plug-headset-spec
- Media buttons: https://developer.android.com/media/legacy/media-buttons
- Background audio in Android 17: https://developer.android.com/about/versions/17/changes/bg-audio
- Game controllers: https://developer.android.com/develop/ui/views/touch-and-input/game-controllers/controller-input
- Trusted Web Activities: https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities ; https://developer.chrome.com/docs/android/trusted-web-activity/overview ; https://developer.chrome.com/docs/android/post-message-twa
- androidx: `WebViewCompat.addWebMessageListener`, and browser/browser/src/main/java/androidx/browser/trusted/TrustedWebActivityIntentBuilder.java
- Wear OS: https://developer.android.com/training/wearables/packaging ; https://developer.android.com/training/wearables/apps/standalone-apps ; https://developer.android.com/training/wearables/data/data-layer
- Google Play policy: https://support.google.com/googleplay/android-developer/answer/9888379 (Device and Network Abuse), 9899034 (Spam), 10964491 (AccessibilityService), 14151465 (testing for new personal accounts), 11926878 (target API).

**Apple**
- AVCaptureEventInteraction: https://developer.apple.com/documentation/avkit/avcaptureeventinteraction
- Camera Control: https://developer.apple.com/documentation/avfoundation/enhancing-your-app-experience-with-the-camera-control
- `outputVolume`: https://developer.apple.com/documentation/avfaudio/avaudiosession/outputvolume
- Controls: https://developer.apple.com/documentation/widgetkit/creating-controls-to-perform-actions-across-the-system
- Audio session categories: https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback
- App Review Guidelines, 2.5.9 and 4.2: https://developer.apple.com/app-store/review/guidelines/
- AirPods controls: https://support.apple.com/en-us/102628
- A controller's Home button: https://support.apple.com/en-us/111099
- The Action button: https://support.apple.com/guide/iphone/use-and-customize-the-action-button-iphe89d61d66/ios

**Specs and compatibility data**
- Media Session: https://w3c.github.io/mediasession/
- Gamepad: https://w3c.github.io/gamepad/
- Close watchers: https://html.spec.whatwg.org/multipage/interaction.html#close-requests-and-close-watchers
- CloseWatcher explainer: https://github.com/WICG/close-watcher
- Key values: https://w3c.github.io/uievents-key/
- MDN browser-compat-data (api/CloseWatcher, Gamepad, GamepadHapticActuator, MediaSession, AudioSession, Navigation, Navigator): https://github.com/mdn/browser-compat-data

**Devices (secondary)**
- Selfie remote keys: https://dev.to/wincentbalin/key-codes-on-ab-shutter-3-2n0h
- The Logitech R400's keys: https://derickrethans.nl/logitech-r400.html
