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

**One code, one phone.** Once a phone pairs, the popup shows a new code (and a new short code), so a photo of the old one pairs nothing later. The phone that paired keeps its way back in through its code: a reload, or a new network, finds the same screen. Another phone that opens the old code is told it was used, and scans the one the popup shows now. Forgetting a phone ends its way back in too.

The popup's bar shows the link beside the phone's name, as the pairing chip on the site does: a lock, the path (**Direct** or **Relayed**) and the round trip. Its tooltip says the rest: encrypted end to end (with DTLS's version and cipher), and how the phone proved itself (the QR code, a typed code, or a remembered pairing).

## No internet: the direct code

After a phone has paired once, the extension and the phone remember each other. From then on they can connect over the local network with no server at all:

- When the ob.Pal service can't be reached (the popup says **Offline**, about 1.5 s after it stops answering), the popup shows a **direct code** instead of the online one, for the phone it remembers. Scan it as usual: the phone opens the controller from its own cache and connects straight to this computer over Wi-Fi.
- The chips under the code (**Online** / **Direct**) switch between the two codes by hand, for a phone on a Wi-Fi network without internet while the computer has it, or just to stay off the internet.
- Remembered phones appear under the code. Tap one to make the direct code for it; press its × to forget it. The phone can forget screens too, in its settings sheet. Forgotten means: pair online again.
- Each direct code works once. As soon as a phone has used it (or an attempt died), a new one takes its place.

What has to be true:
- The phone paired online at least once with this browser profile, on this phone's browser. That pairing is what the direct code is built on: nobody can use it without it, and it pins both certificates like the online pairing does.
- Both are on the same local network, and the network passes multicast DNS (`.local` names): most home Wi-Fi does, guest networks with client isolation don't.
- The phone's browser lets the page set its own ICE credentials. Chromium does today; Google has announced removing it ("SDP munging"), at which point Chrome on Android would show "Not in this browser" for direct codes and need the online path (iOS Safari is not affected). A native host would be the durable answer: as an ICE-lite endpoint it can accept the phone's unmodified credentials (see spec/PROTOCOL.md §2a). ob.Pal Desktop is not that host: it has no network access at all.

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
3. The first time a phone would control this PC (PC is the target, chosen here or in the phone's tray), the PC asks you: *&lt;phone&gt; wants to control this PC*, **Allow** or **Deny**. The question sits on top of the popup (a **!** on the toolbar icon says it's waiting), and comes as a notification too if you turned that on in the options page. Until you allow it, ob.Pal Desktop stays disarmed and the phone shows *Waiting for approval on the PC*. Your answer is kept for that phone, so an allowed phone never asks again.
4. Click **Control the whole PC**: the phone is now the mouse and keyboard of every window, the browser included. The popup shows *Controlling this PC*, with what each gesture does.
5. Or one program at a time: switch to the program, then back to the popup: it names the program you just left. Choose keys and/or mouse and click **Allow**, then switch back to it.

**Deny** keeps that phone off the PC and nothing else: Controller, 3D and Keys still work for it, and its own tray can't pick PC (a switch to PC it made itself goes back). The PC card then says *&lt;phone&gt; can't control this PC*, with **Allow &lt;phone&gt;** to change your mind. The options page lists every phone you answered for, each with a switch. Forgetting a phone (× under the code) takes its answer away: it's a new phone again.

On the PC, the phone works like a laptop touchpad and a mouse:

| Phone | PC |
|---|---|
| Trackpad (the Rotate tab): drag | move the pointer |
| tap · tap again | click · double-click |
| hold, then lift · hold, then move | right-click · drag |
| two fingers · pinch | scroll (a flick carries on) · zoom (Ctrl + wheel) |
| the wheel along its edge: turn it | scroll (turned fast, it spins on) |
| Point (on a PC, its face is the top of a mouse): aim | move the pointer |
| Left · Right | click · right-click where it went down (the pointer holds still while it is down); aim away to drag, or keep it down to hold it |
| its wheel: turn · tap · hold and aim | scroll · middle-click · scroll by aiming |
| + · − | zoom in · out (Ctrl + wheel) |
| Gamepad, with Whole PC | a desktop controller that types no letters: left stick the pointer, right stick scroll, A or RT click (held, it drags), X or LT right-click, left stick press middle-click, B Esc, Y Enter, D-pad arrows, LB · RB back · forward (Alt + ← · →), Menu the Start menu (Ctrl + Esc), View the last app (Alt + Tab) |
| Gamepad, one program | the Keys mapping (sticks, buttons as keys, triggers as mouse buttons) |
| **Keyboard** (tray) or **Type** | type into the field that has the focus, with the phone's own keyboard (autocorrect, predictions, swipe typing) |
| its key row: esc · tab · ← ↑ ↓ → · ⌫ · ↵ | Esc, Tab, the arrow keys, Backspace, Enter |

On the mouse face the phone's volume keys work too: up is Left, down holds the wheel.

**Typing.** When a text field has the keyboard focus on the PC (ob.Pal Desktop 0.3 or later tells), the phone shows **Type**: one tap opens its keyboard in a dock, right above the phone's own keyboard. A password field gets a password field on the phone too: nothing is suggested, learned or kept, and the dock shows dots of its own. The prompt only shows where typing would go through (Whole PC with keys, or an allowed program with keys, not paused), and the dock it opened closes when the field loses the focus. The **Keyboard** button in the phone's tray opens the same dock at any time. If typing can't get through (keys off for that window, a helper too old to type, or none connected), the phone says so.

| Popup shows | Meaning |
|---|---|
| *&lt;phone&gt; wants to control this PC* | A phone this PC hasn't answered for yet. **Allow** or **Deny**; ob.Pal Desktop stays disarmed until you allow it. |
| *&lt;phone&gt; can't control this PC* | You said no to this phone. **Allow &lt;phone&gt;** changes your mind. |
| *Allow PC control* | The permission has not been granted yet. |
| *ob.Pal Desktop isn't installed* | The browser found no helper. Install it, then Retry. |
| *Control the whole PC* | The helper can drive every window; nothing does yet. |
| *Controlling this PC* | Whole PC is on: every window receives input. *Pause* stops everything; *One program* goes back to the allowlist. |
| *Update for whole PC* | The installed helper is older than 0.2 and knows only programs. |
| *Allow &lt;program&gt;* | The program you last used is not on the list. |
| *&lt;program&gt; runs as administrator* | An elevated window; Windows would drop the input, so the helper refuses it up front (with Whole PC, the popup names it and the pointer can still move off it). |
| *Controlling &lt;program&gt;* | Input flows. *Pause* stops everything. |
| *Paused* | Nothing reaches any program until *Resume*. |
| *Stopped · Panic key* | `Ctrl+Alt+Backspace` was pressed on the PC. *Resume* continues. |

The extension's **options page** (right-click the icon → Options, or the sliders button beside the helper's version in the PC card) turns **Whole PC** on and off, lists every allowed program with its scope, removes them, and has **Pause all**. Under **Phones** it lists every phone you answered for, each a switch (may it control this PC or not), and **Notify me** turns on a notification with Allow and Deny for the next phone that asks while the popup is closed (the browser asks once for the *notifications* permission). It also shows the helper's version and panic key, and a phone's question when one is waiting (the notification opens this page).

Both pages wear the ob.Pal look, with the family's surfaces and colours as the phone's settings offer them: the palette button in the popup, or **Look** on the options page. A choice applies at once, on both pages, and is kept in `chrome.storage`. The family's own keys in the pages' `localStorage` are its cache: the options page's first script puts the last look on before anything is drawn, so a light surface never opens dark. (The popup needs no such script: Chrome shows it only once it has loaded.)

From the keyboard, the targets, the codes and the look's pickers are radio groups: Tab reaches the chosen one, the arrow keys move and choose, and Home and End go to the first and the last.

What goes over to the helper is the whole held state each frame (which keys and buttons are down) plus this frame's mouse motion and wheel, never key names from the phone and never edges: a lost frame cannot leave a key stuck, and the helper injects only keys from its own allowlisted table, only into an allowed program while it is in front (or, with Whole PC, into whatever is in front). Everything is released when the phone disconnects, the target changes or the helper loses the browser, and, one program at a time, when the window changes. Clicks and gestures are turned into held buttons, wheel and Ctrl in `src/shared/pcgestures.ts`; a click is a press held for 30 ms, then a release, so it spans frames the helper can diff. The key row's taps are held and released the same way, and only from its own eight keys. Typing goes to the helper as text requests (delete n, then type), on the same port as the frames and in order with the key taps: each right after a frame that holds no modifier (the helper refuses text under one and doesn't retry), at most 20 a second after a burst of 5 (the helper takes 40), and what has to wait merges into one request wherever that types the same.

### Changing the mappings

The mappings are typed config objects:
- Key bindings, thresholds and mouse speed: `DEFAULT_KEYS` in `src/shared/keys.ts`, and `DESKTOP_KEYS` there for the whole PC. To make another key bindable, add a row to the `KEYS` table there.
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
| `storage` | Remembers the chosen mode, the look, and your answer for each phone that wanted the PC. Session storage, cleared when the browser closes, holds the controlled tab and link status for the popup. (Remembered phones and the link's own certificate live in the offscreen document's IndexedDB, not in `chrome.storage`; each pairing key there is a non-extractable key, which the extension can use but no script can read back.) |
| `activeTab` | Clicking the toolbar icon grants access to the current tab only (its address for the popup, and script injection), so **This tab** needs no broad host access. |
| `scripting` | Injects the bridge (isolated world) and the page script (main world) into the controlled tab. |
| `https://obpal.blackboxes.net/*` | Signaling and TURN credentials for the phone link. |
| `<all_urls>` (optional, **All sites**) | Requested only when you turn it on. It reaches game iframes served from other domains, and keeps control across navigation and newly added frames. |
| `nativeMessaging` (optional, **PC**) | Requested when you first choose the PC target. It lets the extension start and talk to ob.Pal Desktop (`net.blackboxes.obpal`), and nothing else. |
| `notifications` (optional, **Notify me**) | Requested when you turn on **Notify me** in the options page. When a phone asks to control this PC while the popup is closed, a notification asks you, with Allow and Deny. Nothing else is ever shown. |

Scripts run only in the tab you enabled:
- While **All sites** is on and a tab is controlled, a small bridge loads at page start in other tabs too, but it stays idle there.
- The popup's toggle revokes the permission again. So does the site access setting on the extension's details page.

The extension has no analytics and loads no remote code:
- Extension pages use `script-src 'self'`.
- Their network access is limited to the ob.Pal service.

## Running your own service

Link talks only to the service it was built for: its host permission, its pages' policy and its code name that one origin. To point it at a service of your own (spec/SECURITY.md §6):

1. Build it with your origin: `OBPAL_PUBLIC_ORIGIN=https://your.host pnpm run build:extension`, the same variable the site's build takes.
2. Give it an ID of its own: `node extension/scripts/key.mjs <your key file>` prints a manifest `key`; put it in `extension/vite.config.ts` (`EXTENSION_KEY`). Keep the private key out of the repository.
3. Install ob.Pal Desktop for that ID: `obpal-desktop install --origin chrome-extension://<your id>/`.

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
offscreen.html: the Keys (or desktop) mapping and the PC gestures → the held state, and the phone's typing ──port──▶ background.js ──connectNative──▶ obpal-desktop.exe ──SendInput──▶ the window in front
offscreen.html ◀── text-field ── background.js ◀── status.text (a text field has the focus) ── obpal-desktop.exe
   └─▶ the phone: textField, and its Type prompt
```

**Service worker (`background.js`)**
- Creates the offscreen document, at browser start and whenever it is needed.
- Injects the bridge when you enable a tab. Each bridge then asks the worker for the page script in its own frame.
- Stores the mode and the controlled tab.
- For the PC target, holds the native messaging port to the helper (`src/native.ts`), arms it only while PC is the target, the phone connected is one you allowed (`src/shared/access.ts`: the link says who is connected, by the pairing it proved; your answers live in `chrome.storage.local`), and the link has the gamepad mapping for what the helper's config says (the desktop controller for the whole PC, the game keys for one program). It mirrors what the helper reports into session storage for the popup and options page. A restarted worker picks the helper's config back up from there, and a restarted link document gets the whole config, whole PC included. It tells the link when a text field in front would take typing (the phone's Type prompt), and when typing didn't get through. It asks about a new phone (the popup's prompt, the **!** badge, the notification) and takes the answer only from Link's own pages.

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
| `pnpm test` | `tests/extension.test.ts` covers key mapping and hysteresis (and the whole PC's desktop mapping), the 3D drag and wheel synthesis, message validation and frame routing; `tests/lan.test.ts` the direct code, derived credentials and the controller's service worker routing; `tests/native.test.ts` the PC frames, typing requests, helper message validation, the popup's PC states and when the phone offers Type; `tests/pcgestures.test.ts` the PC clicks, holds, drags, scrolling, flicks and zoom, the mouse face, and the key row's taps and typing (order, modifiers, pacing, merging); `tests/typing.test.ts` the phone's keyboard diff; `tests/link-pages.test.ts` the stored look and its first-paint cache, and the radio groups' keys; `tests/access.test.ts` which phones may control the PC (answers, when to ask, the messages that carry them); `tests/invite.test.ts` the invite moving on once a phone pairs (the old link refused to others, the phone that paired back through its room); `tests/lan.test.ts` also the non-extractable pairing keys. |
| `pnpm run e2e:extension` | Builds the site and the extension, then runs `scripts/e2e.mjs`: the extension in one Chromium, an emulated phone in another, online through the real service, then offline through a direct code (see below). It also proves the security items of spec/SECURITY.md §8: the invite moving on (a second phone with the old link is refused), the PC's question (a new phone can't arm the helper; Deny, Allow, remembered, forgotten), and non-extractable keys on both sides. `OBPAL_E2E_SHOTS=<dir>` saves screenshots, the prompt's in both surfaces among them. Needs Playwright's Chromium, or `OBPAL_E2E_CHROMIUM=<path to chrome.exe>`. The PC target runs against a stub helper (`e2e/native-stub.mjs`), and the run can't reach an installed ob.Pal Desktop: the test copy has no manifest key (the helper refuses its ID) and names only the stub's host (the run won't launch otherwise), and it fails if the helper's own log shows a session from the test browser. `node extension/scripts/e2e.mjs --desktop` is the one run meant to reach the installed ob.Pal Desktop: it injects real input into its harness window. |
| `pnpm run bench:extension` | `scripts/bench.mjs`: time to connected, time to first input, press-to-page latency and data channel RTT over several pairings, with the phone's timeline. |
| `pnpm run store:extension` | Builds, then `scripts/store.mjs` writes the Chrome Web Store zip, `release/obpal-link-<version>-store.zip`: the release's files with a manifest without its `key`, read back and checked (every file one the extension uses, the manifest parses, no key). With `-- --with-key [<pem>]` (default `~/.obpal-keys/extension-key.pem`) it also writes the item's first-upload zip, with the private key as `key.pem` so the store keeps Link's ID: only next to the key, in `<key folder>/store/`, never inside a git working tree, and only when the key gives the ID ob.Pal Desktop allows. |
| `pnpm run store:art` | Builds the site and the extension, then `store/src/render.mjs` renders the store's images into `store/`: the promo tiles, the icon, and five 1280 × 800 screenshots made of real renders (the popup, the options page, and the phone paired through the real service). It runs a copy of the extension without its key and with the native host renamed, so no ob.Pal Desktop is started. Needs Chromium, as the end-to-end test does. |
| `node extension/scripts/icons.mjs [outDir]` | Renders the 16/32/48/128 px icons from `public/favicon.svg` with sharp. |
| `node extension/scripts/key.mjs` | Prints the manifest `key` and the extension ID for the private key outside the repository (creates one if missing). |

The end-to-end test and the bench run the phone against this checkout's controller build: `e2e/local.mjs` is a stand-in for `obpal.blackboxes.net` on `https://127.0.0.1:5176` (self-signed certificate in `e2e/tls`, the phone browser runs with `--ignore-certificate-errors`) that serves `dist/client` and proxies the room service (`/r/*`, `/api/*`) to production. For the offline case it refuses the service, the phone context goes offline, and the extension's browser is relaunched with the service's hostname unresolvable, so the phone's page can only come from its service worker cache and the connection can only be the direct one.

The build does the following:
- Builds the popup, the options page, the offscreen document and the service worker as ES modules.
- Builds the two content scripts, and the options page's first-paint script (`first-paint.js`, a plain script in its `<head>`: MV3 allows no inline one), as self-contained IIFEs.
- Writes `manifest.json` (with the public `key` that fixes the extension ID), renders the PNG icons, and puts the fonts' licences beside them (`assets/OFL-*.txt`).
- Fails unless the manifest is MV3 and every file it references exists.

| Path | Contents |
|---|---|
| `src/background.ts` | Service worker: routing, per-tab enablement, injection, badge, warm start, the helper port |
| `src/native.ts` | The native messaging bridge to ob.Pal Desktop (service worker side) |
| `src/offscreen.ts` | Phone link (remembered phones, direct code) and the sampler (`src/ticker.ts` is its worker clock); PC frames |
| `src/popup/` | Popup UI: the link's status and badge, codes, remembered phones, a phone's question for the PC, controls, the PC card and its gestures |
| `src/options/` | Options page: Whole PC, Pause all, the PC allowlist, the phones and their answers, the notification switch, the look |
| `src/ui/` | What both pages share: the look (surface and colour, applied live, stored, and cached for the first paint), the radio groups' keys, the cards and controls, the light on the cards, the logo, a phone's question for the PC (`ask.ts`). Tokens and icons come from the app (`src/family`, `src/styles/base.css`, `src/ui/icons.ts`) |
| `src/fonts/` | Inter and Plus Jakarta Sans (SIL Open Font License 1.1, whose text ships with them), bundled so the pages load nothing from the network |
| `e2e/` | Test page, the local stand-in service (it makes a throwaway test certificate on first run), the stub helper |
| `store/` | The Chrome Web Store listing: every field to paste (`listing.md`), the upload steps (`UPLOAD.md`), the images, and their sources (`store/src/`) |
| `src/content/bridge.ts` | Isolated-world bridge |
| `src/content/page.ts` | Main-world page script |
| `src/shared/` | Pure logic: constants, messages and validation, routing, key mapping, 3D synthesis, the helper protocol (`native.ts`), which phones may control the PC (`access.ts`) |
