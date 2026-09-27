# ob.Pal Link

A Chromium (Manifest V3) extension that lets a phone paired through ob.Pal control any website:

- **Controller**: a virtual gamepad for Gamepad API games.
- **3D**: drag, pan and zoom for 3D viewers.
- **Keys**: keyboard and mouse input for keyboard games.
- **PC**: the phone as this computer's mouse and keyboard, through the ob.Pal Desktop helper: in every window (**Whole PC**), or per program with the scope you allow.

It works in Chrome, Edge, Brave, Opera, Vivaldi and Arc (Chromium 120 or later). The phone needs no app: it opens the ob.Pal controller in its browser.

## Install (unpacked)

```sh
pnpm install
pnpm run build:extension   # writes extension/dist
```

1. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Opera: `opera://extensions`
   - Vivaldi: `vivaldi://extensions`
   - Arc: `arc://extensions`
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select `extension/dist`.
4. Pin **ob.Pal Link** to the toolbar.

After a rebuild, click the reload icon on the extension's card.

## Pair and play

1. Open the game or 3D page, then click the ob.Pal Link toolbar icon.
2. Scan the QR code with the phone's camera. The ob.Pal controller opens in the phone's browser and the status changes to **Connected**.
3. Turn on **This tab**.
4. Pick what the phone drives: **Controller**, **3D**, **Keys** or **PC**. You can also switch from the phone, with the **Target** picker in its tray.

**Controlling tabs**
- One tab is controlled at a time. Turning on another tab moves control to it.
- A dot on the toolbar icon marks the controlled tab. The dot is lime while the phone is connected.

**How long the pairing lasts**
- The pairing stays up until the browser closes, or until you press × in the popup.
- To reconnect after that, scan the code again: the online one, or the direct one below.

## No internet: the direct code

After a phone has paired once, the extension and the phone remember each other. From then on they can connect over the local network with no server at all:

- When the ob.Pal service can't be reached (the popup says **Offline**, about 1.5 s after it stops answering), the popup shows a **direct code** instead of the online one, for the phone it remembers. Scan it as usual: the phone opens the controller from its own cache and connects straight to this computer over Wi-Fi.
- The chips under the code (**Online** / **Direct**) switch between the two codes by hand, for a phone on a Wi-Fi network without internet while the computer has it, or just to stay off the internet.
- Remembered phones appear under the code. Tap one to make the direct code for it; press its × to forget it. The phone can forget screens too, in its settings sheet. Forgotten means: pair online again.
- Each direct code works once. As soon as a phone has used it (or an attempt died), a new one takes its place.

What has to be true:
- The phone paired online at least once with this browser profile, on this phone's browser. That pairing is what the direct code is built on: nobody can use it without it, and it pins both certificates like the online pairing does.
- Both are on the same local network, and the network passes multicast DNS (`.local` names): most home Wi-Fi does, guest networks with client isolation don't.
- The phone's browser lets the page set its own ICE credentials. Chromium does today; Google has announced removing it ("SDP munging"), at which point Chrome on Android would show "Not in this browser" for direct codes and need the online path (iOS Safari is not affected). The native PC-control helper, which is being built separately, is the durable answer: as an ICE-lite endpoint it can accept the phone's unmodified credentials (see spec/PROTOCOL.md §2a).

The link starts with the browser, so the code is ready before the popup opens and a remembered phone can connect while the popup is closed.

## Modes

### Controller (Gamepad API)

- `navigator.getGamepads()` includes `ob.Pal Controller (STANDARD GAMEPAD …)`, which uses the standard mapping.
- `gamepadconnected` and `gamepaddisconnected` fire.
- It works both for games that poll `getGamepads()` every frame and for games that wait for the connect event.
- As with a real controller in Chrome, the pad appears on its first button press after the page has loaded. By then, a game's `gamepadconnected` listener is registered.
- Physical controllers keep their slots. The virtual pad takes the first free slot.
- `vibrationActuator.playEffect('dual-rumble', …)` vibrates the phone. Each effect is clamped to 5 s and rate-limited.
- The phone must be in its **Gamepad** mode.

The shim is `installGamepadShim()` from `@obpal/host`, bundled into the page script.

### 3D viewer

The target is the largest visible `<canvas>` or `<model-viewer>`. If there is none, it is the element under the centre of the viewport. Each event goes to the element a real mouse would hit at that point, including overlays and the inside of open shadow roots.

| Phone input | Page receives |
|---|---|
| One-finger trackpad, Point-mode gyro, right stick, tilt | left-button drag (rotate) |
| Two-finger drag, left stick | right-button drag (pan) |
| Pinch, RT (in) / LT (out) | wheel events (zoom) |

**Event sequence**
1. `pointerdown` and `mousedown` at the target's centre.
2. `pointermove` and `mousemove`, carrying `buttons` and `movementX`/`movementY`.
3. `pointerup` and `mouseup` after 120 ms without input.

**Details**
- The `pointerId` is 1, the id of Chrome's real mouse. Page code that calls `setPointerCapture(e.pointerId)`, such as three.js OrbitControls, keeps working.
- When the virtual cursor reaches the target's edge, it lifts and re-grabs at the centre.
- Small wheel amounts are batched.

### Keys

| Phone input | Keyboard / mouse |
|---|---|
| Left stick (or tilt) | W A S D. Pressed at 0.4, released below 0.3 (hysteresis). |
| D-pad | Arrow keys |
| A / B / X / Y | Space / Escape / E / Q |
| Menu | Enter |
| LB / RB | Shift / Control |
| Right stick, Point-mode gyro, trackpad | mouse movement (`movementX`/`movementY`) |
| RT / LT | left / right mouse button (the left one also fires `click`) |

**Key events**
- Each key sends `keydown` and `keyup`, plus `keypress` for character keys.
- Events carry the correct `key`, `code`, `location` and legacy `keyCode`/`which`.
- They go to the focused element (or `body`) and bubble on to `document` and `window`, as real keys do.

**Mouse**
- Under pointer lock, only `movementX`/`movementY` matter.
- Otherwise, a small lime dot shows where the virtual mouse is.

### PC (this computer, outside the browser)

Real OS input from the phone, delivered by **ob.Pal Desktop** (`desktop/`, a small Rust helper): to every window with **Whole PC**, or to the program in front if you allowed it. Windows for now.

1. Install the helper: download it from the [install guide](https://obpal.blackboxes.net/link/#desktop) and run `install.cmd`, or build it and run `obpal-desktop.exe install` (per user, no admin; see [desktop/README.md](../desktop/README.md)).
2. Click **PC** in the popup. The browser asks once for the *nativeMessaging* permission.
3. Click **Control the whole PC**: the phone is now the mouse and keyboard of every window, the browser included. The popup shows *Controlling this PC*, with what each gesture does.
4. Or one program at a time: switch to the program, then back to the popup: it names the program you just left. Choose keys and/or mouse and click **Allow**, then switch back to it.

On the PC, the phone works like a laptop touchpad and a Wii remote:

| Phone | PC |
|---|---|
| Trackpad (Rotate, Tilt): drag | move the pointer |
| tap · tap again | click · double-click |
| hold, then lift · hold, then move | right-click · drag |
| two fingers · pinch | scroll (a flick carries on) · zoom (Ctrl + wheel) |
| Point: aim | move the pointer |
| A · hold A · press A and aim away | click where A went down (the pointer holds still while A is down) · right-click · drag |
| hold B and aim · + / − | scroll · zoom |
| Gamepad | the Keys mapping (sticks, buttons as keys, triggers as mouse buttons) |

| Popup shows | Meaning |
|---|---|
| *Allow PC control* | The permission has not been granted yet. |
| *ob.Pal Desktop isn't installed* | The browser found no helper. Install it, then Retry. |
| *Control the whole PC* | The helper can drive every window; nothing does yet. |
| *Controlling this PC* | Whole PC is on: every window receives input. *Pause* stops everything; *One program* goes back to the allowlist. |
| *Update for whole PC* | The installed helper is older than 0.2 and knows only programs. |
| *Allow &lt;program&gt;* | The program you last used is not on the list. |
| *&lt;program&gt; runs as administrator* | An elevated window; Windows would drop the input, so the helper refuses it up front (with Whole PC, the popup names it and the pointer can still move off it). |
| *Controlling &lt;program&gt;* | Input flows. *Pause* stops everything. |
| *Stopped · Panic key* | `Ctrl+Alt+Backspace` was pressed on the PC. *Resume* continues. |

The extension's **options page** (right-click the icon → Options, or the ⚙ in the PC card) turns **Whole PC** on and off, lists every allowed program with its scope, removes them, and has **Pause all**.

What goes over to the helper is the whole held state each frame (which keys and buttons are down) plus this frame's mouse motion and wheel, never key names from the phone and never edges: a lost frame cannot leave a key stuck, and the helper injects only keys from its own allowlisted table, only into an allowed program while it is in front (or, with Whole PC, into whatever is in front). Everything is released when the phone disconnects, the target changes or the helper loses the browser, and, one program at a time, when the window changes. Clicks and gestures are turned into held buttons, wheel and Ctrl in `src/shared/pcgestures.ts`; a click is a press held for 30 ms, then a release, so it spans frames the helper can diff.

### Changing the mappings

The mappings are typed config objects:
- Key bindings, thresholds and mouse speed: `DEFAULT_KEYS` in `src/shared/keys.ts`. To make another key bindable, add a row to the `KEYS` table there.
- 3D gains, rates and the pan style (`'right'` or `'shift'` drag): `DEFAULT_VIEWER` in `src/shared/viewer.ts`.

### Motion: Aim, Steer and Point (the control catalogue)

In the phone's Gamepad mode the Motion chips follow the [control catalogue](../spec/CATALOGUE.md): **Aim** (gyro turn rate), **Steer** (tilt angle) and **Point** (a Wii-style pointer). Hold a chip for its options (route, sensitivity, deadzone jump, invert Y); the profile pill picks a profile (Default, Flight, Driving, Shooter, Pointer). The extension suggests a profile per site from `src/shared/sites.ts` (tesana.com and play.tesana.ai suggest Flight); the phone applies it unless you chose one yourself.

| Utility | Page receives |
|---|---|
| Aim → right stick (Default, Flight) | right-stick values that clear the game's deadzone with a small turn |
| Aim → mouse (Shooter) | `movementX`/`movementY` under pointer lock; the right stick otherwise |
| Steer → fly (Flight) | tilt = right-stick X, tip forward/back = right-stick Y, like a yoke |
| Steer → wheel (Default, Driving) | tilt = left-stick X |
| Point | a lime cursor where the phone points; A clicks (`pointerdown`, `mousedown`, `up`, `click`) and holding B drags, through frames and open shadow roots; under pointer lock the pointer becomes relative mouse movement and no cursor is drawn; with the edge turn on, the right stick deflects toward the edge the cursor is near |

While A or B click at the cursor they are not also gamepad buttons.

### Pages with frames

The controller is visible in every bridged frame, as a real one would be. Keys go only to the focused frame. 3D input goes to the frame with the largest canvas.

## Permissions

| Permission | Why |
|---|---|
| `offscreen` | An MV3 service worker can't hold a WebRTC connection, so an offscreen document (reason `WEB_RTC`) keeps the link to the phone. |
| `storage` | Remembers the chosen mode. Session storage, cleared when the browser closes, holds the controlled tab and link status for the popup. (Remembered phones and the link's own certificate live in the offscreen document's IndexedDB, not in `chrome.storage`.) |
| `activeTab` | Clicking the toolbar icon grants access to the current tab only (its address for the popup, and script injection), so **This tab** needs no broad host access. |
| `scripting` | Injects the bridge (isolated world) and the page script (main world) into the controlled tab. |
| `https://obpal.blackboxes.net/*` | Signaling and TURN credentials for the phone link. |
| `<all_urls>` (optional, **All sites**) | Requested only when you turn it on. It reaches game iframes served from other domains, and keeps control across navigation and newly added frames. |
| `nativeMessaging` (optional, **PC**) | Requested when you first choose the PC target. It lets the extension start and talk to ob.Pal Desktop (`net.blackboxes.obpal`), and nothing else. |

Scripts run only in the tab you enabled:
- While **All sites** is on and a tab is controlled, a small bridge loads at page start in other tabs too, but it stays idle there.
- The popup's toggle revokes the permission again. So does the site access setting on the extension's details page.

The extension has no analytics and loads no remote code:
- Extension pages use `script-src 'self'`.
- Their network access is limited to the ob.Pal service.

## Limitations

**Browser limits**
- **Synthetic events are untrusted** (`isTrusted` is false).
  - Sites that check it ignore them: some games, anti-cheat, many login and payment forms.
  - Browser default actions don't run: arrow keys don't scroll, keys don't type into inputs, and right-click opens no menu.
- **Pointer lock and fullscreen can't be triggered.** Both need a real user gesture. Click the game yourself to lock the pointer; mouse-look then uses `movementX`/`movementY`.

**Frames and pages**
- **Cross-origin iframes need All sites.** Most itch.io games and many embeds run in one. Without the permission, only frames from the tab's own origin are reached.
- **Some pages can't be controlled**: browser pages such as `chrome://`, extension stores, and other extensions' pages. `file://` pages work only after you turn on "Allow access to file URLs".

**Games**
- **Cloud gaming in the browser works through Controller mode.** Xbox Cloud Gaming, GeForce NOW and similar services read the Gamepad API, which has no `isTrusted`.
- A game that saved a reference to `navigator.getGamepads` before the page script arrived won't see the pad. Reload with control on: with All sites, the bridge loads at page start.

**Everything else**
- If the browser window isn't focused, keys go to the top frame.
- Canvases inside closed shadow roots can't be found. For those pages, the element under the viewport centre is used.
- One phone and one controlled tab at a time.

## How it works

```
phone (ob.Pal controller PWA)
   │ WebRTC DataChannels (signaling via obpal.blackboxes.net, or none at all with a direct code)
   ▼
offscreen.html: @obpal/host Remote; samples remote.pad + remote.consume() as packets arrive and at 60 Hz
   │ runtime port per frame (compact frames; the pad goes to every frame, keys/3D to one elected frame)
   ▼
bridge.js (isolated world, every permitted frame of the controlled tab)
   │ window.postMessage, channel "obpal-link/v1" + session id, same window and origin only
   ▼
page.js (main world): getGamepads shim, pointer/wheel synthesis, key/mouse synthesis

PC target instead:
offscreen.html: Keys mapping → the held state ──port──▶ background.js ──connectNative──▶ obpal-desktop.exe ──SendInput──▶ the allowed program in front
```

**Service worker (`background.js`)**
- Creates the offscreen document, at browser start and whenever it is needed.
- Injects the bridge when you enable a tab. Each bridge then asks the worker for the page script in its own frame.
- Stores the mode and the controlled tab.
- For the PC target, holds the native messaging port to the helper (`src/native.ts`), arms it only while PC is the target, and mirrors what the helper reports into session storage for the popup and options page.

**Connecting fast**
- The phone requests ICE servers and opens its signaling socket at the same time, and builds its offer (gathering host candidates) while the socket connects, so the offer leaves the moment the host is seen. It never waits more than 250 ms for TURN credentials: on a LAN the host candidates carry the connection.
- The link samples the phone the moment a packet lands (plus a 60 Hz clock for heartbeats), instead of on the next clock tick.
- The phone's page keeps its fonts from blocking the app, and after one visit loads from its service worker cache.

**Validation**
- Every hop validates what it receives (`src/shared/messages.ts`).
- The service worker also checks who sent each request: pages may only ask about their own tab.

## Development

| Command | What it does |
|---|---|
| `pnpm run build:extension` | Runs the Vite build (see below). |
| `pnpm run typecheck` | Includes `extension/tsconfig.json`. |
| `pnpm test` | `tests/extension.test.ts` covers key mapping and hysteresis, the 3D drag and wheel synthesis, message validation and frame routing; `tests/lan.test.ts` the direct code, derived credentials and the controller's service worker routing; `tests/native.test.ts` the PC frames, helper message validation and the popup's PC states; `tests/pcgestures.test.ts` the PC clicks, holds, drags, scrolling, flicks and zoom. |
| `pnpm run e2e:extension` | Builds the site and the extension, then runs `scripts/e2e.mjs`: the extension in one Chromium, an emulated phone in another, online through the real service, then offline through a direct code (see below). Needs Playwright's Chromium, or `OBPAL_E2E_CHROMIUM=<path to chrome.exe>`. The PC target runs against a stub helper (`e2e/native-stub.mjs`); `node extension/scripts/e2e.mjs --desktop` uses the installed ob.Pal Desktop and its harness window instead. |
| `pnpm run bench:extension` | `scripts/bench.mjs`: time to connected, time to first input, press-to-page latency and data channel RTT over several pairings, with the phone's timeline. |
| `node extension/scripts/icons.mjs [outDir]` | Renders the 16/32/48/128 px icons from `public/favicon.svg` with sharp. |
| `node extension/scripts/key.mjs` | Prints the manifest `key` and the extension ID for the private key outside the repository (creates one if missing). |

The end-to-end test and the bench run the phone against this checkout's controller build: `e2e/local.mjs` is a stand-in for `obpal.blackboxes.net` on `https://127.0.0.1:5176` (self-signed certificate in `e2e/tls`, the phone browser runs with `--ignore-certificate-errors`) that serves `dist/client` and proxies the room service (`/r/*`, `/api/*`) to production. For the offline case it refuses the service, the phone context goes offline, and the extension's browser is relaunched with the service's hostname unresolvable, so the phone's page can only come from its service worker cache and the connection can only be the direct one.

The build does the following:
- Builds the popup, the options page, the offscreen document and the service worker as ES modules.
- Builds the two content scripts as self-contained IIFEs.
- Writes `manifest.json` (with the public `key` that fixes the extension ID) and renders the PNG icons.
- Fails unless the manifest is MV3 and every file it references exists.

| Path | Contents |
|---|---|
| `src/background.ts` | Service worker: routing, per-tab enablement, injection, badge, warm start, the helper port |
| `src/native.ts` | The native messaging bridge to ob.Pal Desktop (service worker side) |
| `src/offscreen.ts` | Phone link (remembered phones, direct code) and the sampler (`src/ticker.ts` is its worker clock); PC frames |
| `src/popup/` | Popup UI: codes, remembered phones, controls (uses `src/ui/icons.ts` and `src/styles/base.css` from the app) |
| `src/options/` | Options page: Whole PC and the PC allowlist |
| `e2e/` | Test page, the local stand-in service (it makes a throwaway test certificate on first run), the stub helper |
| `src/content/bridge.ts` | Isolated-world bridge |
| `src/content/page.ts` | Main-world page script |
| `src/shared/` | Pure logic: constants, messages and validation, routing, key mapping, 3D synthesis, the helper protocol (`native.ts`) |
