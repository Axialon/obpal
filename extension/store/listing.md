# ob.Pal Link on the Chrome Web Store: what goes where

Every field the Developer Dashboard asks for, ready to paste. The order of the steps is in [UPLOAD.md](UPLOAD.md).
Copy each block as it is: the dashboard takes plain text, and line breaks are kept.

## Package

- **First upload** (creates the item with Link's existing ID): `%USERPROFILE%\.obpal-keys\store\obpal-link-<version>-store-first-upload.zip`, written by `pnpm run store:extension -- --with-key`. It holds `key.pem` at its root and never goes anywhere else.
- **Every later update:** `extension/release/obpal-link-<version>-store.zip`, written by `pnpm run store:extension`.
- Both have the same files, and a manifest without its `key` (the store refuses a new item whose manifest has one). The extension ID must stay `jnnpcnoilofjaffabnhecfokjjknlemg`: ob.Pal Desktop talks only to that ID.

## Store listing tab

**Name** and **summary** come from the package (the manifest's `name` and `description`, in `extension/vite.config.ts`):

- Name: `ob.Pal Link`
- Summary (128 of 132 characters):

```text
Your phone as a controller for websites: gamepad, 3D mouse or keys. Add ob.Pal Desktop for your Windows PC. No phone app needed.
```

**Description:**

```text
Your phone as a controller for websites in your browser. Scan a QR code and the controller opens in your phone's browser: no app, no account.

What your phone becomes
• Controller: a standard gamepad for browser games that read the Gamepad API, with rumble where phone and browser vibration are supported.
• 3D: drag to rotate, two fingers to pan, pinch to zoom in compatible page viewers.
• Keys: WASD on the left stick, arrow keys on the D-pad, Space, Enter and more on the buttons, the mouse on the right stick.
• Motion: turn to aim, tilt to steer, or point at the screen like a remote.
• Buttons: a headset, Bluetooth keyboard, clicker or gamepad can press the controller's buttons, and so can Back on Android.

Your whole PC, with ob.Pal Desktop for Windows
• Your phone is the mouse and keyboard, in every window or only the programs you allow: tap to click, two fingers to scroll, pinch to zoom where the app supports it.
• Type with the phone's own keyboard. It offers to when a text field has the focus, and learns nothing from password fields.
• The PC asks once before a new phone can control it: Allow or Deny, changeable in the options.
• Ctrl + Alt + Backspace stops keyboard and mouse input from the phone.
The helper is optional; Link asks to talk to it only when you choose PC. It isn't code-signed yet, so Windows may warn about it.

How it works
Pin ob.Pal Link from the Extensions menu after adding it.
1. Click the ob.Pal Link icon on the page you want to control.
2. Scan the QR code with your phone's camera.
3. Turn on "This tab" and choose Controller, 3D or Keys. PC control is set up separately, with ob.Pal Desktop.
New to it? Try in Link opens a dot demo: choose Controller, turn on "This tab" there and move the left stick.
Pair → Enable → Try keeps these steps in view. The pairing card's icon row brings its actions together. Once a phone connects, the QR code's dots become its connection seal and stay in that space. Link shows the active phone's seal; use Add phone to show a new QR, or cancel to return to its seal.
The popup shows the connection: a lock, direct or relayed, and the round trip. A phone you've paired once can also connect directly over your Wi-Fi when the internet is down, if your network lets devices reach each other.
Works in Chrome, Edge, Brave and Vivaldi (Chromium 120 or later). Other Chromium browsers may work, but aren't tested.

Private by design
• No accounts, analytics, ads or remote code.
• Phone and computer talk over encrypted WebRTC; the ob.Pal service only introduces them.
• Each QR code pairs once, so an old photo of it can't connect.
• Link and your phone show the same connection seal, three symbols, so you can compare them. The seal is a comparison aid, not certification or permission to control anything.
• Pairing keys can't be read out, on the phone or in Link.
• Input acts only in the tab you switch on, or on the PC where you allow it. Link reads page geometry and focus to deliver input; it does not collect page content or browsing history. On ob.Pal's own Desktop install page, Link tells the page only whether the helper is connected and its version.
Privacy policy: https://obpal.blackboxes.net/privacy/

Try the phone controller without the extension in ob.Pal's sims, from robot arms to a music studio for eight phones: https://obpal.blackboxes.net/sim/

Free and open source (MIT): https://github.com/Axialon/obpal
```

**Category:** Tools (owner's choice; see UPLOAD.md).

**Language:** English. The copy avoids the words that UK and US English spell differently, so either variant fits.

**Graphic assets** (all in this folder, made by `pnpm run store:art`):

| Field | File |
|---|---|
| Store icon (128×128) | `icon-128.png`: from `public/logo-mark.svg`, 96 px of art in 16 px of clear padding |
| Screenshots (1280×800, up to 5, in this order) | `screenshot-1.png` … `screenshot-5.png` |
| Small promo tile (440×280) | `tile-440x280.png` |
| Marquee promo tile (1400×560, optional) | `marquee-1400x560.png` |
| Promo video | none; leave it empty unless the dashboard marks it required |

**Additional fields:**

- Official URL: leave it empty unless the site is verified in Google Search Console under the publisher's Google account (it then shows as a verified publisher).
- Homepage URL: `https://obpal.blackboxes.net/link/`
- Support URL: `https://github.com/Axialon/obpal-link/issues`
- Mature content: No.

## Privacy practices tab

**Single purpose:**

```text
ob.Pal Link lets you use your phone as an input device for your computer. After you pair the phone by scanning a QR code, its controller, touch, motion and keyboard input becomes gamepad, pointer and key input in the browser tab you switch on, or, with the optional ob.Pal Desktop helper, mouse and keyboard input on your PC.
```

**Permission justification**, one box per permission:

`offscreen`

```text
An MV3 service worker can't hold a WebRTC connection. An offscreen document (reason WEB_RTC) holds the encrypted connection to the user's paired phone, receives its input, and passes it on to the tab the user switched on (or to ob.Pal Desktop, for the PC target). It starts with the browser so the pairing code is ready when the popup opens, and so a phone paired before can reconnect.
```

`storage`

```text
chrome.storage.local remembers what the phone drives (Controller, 3D, Keys or PC), the look the user picked for the popup and options page (a surface and an accent), and the user's Allow or Deny for each phone that asked to control the PC (the phone's pairing key or certificate fingerprint, its name, the answer and when; the newest 64). chrome.storage.session, which the browser clears when it closes, holds the controlled tab, the connection status, connection seal and pairing code shown in the popup, the connected phone (its key and name), the phone the PC is asking about and the target that phone had before it chose PC, the frames from other sites in the controlled page (how many, and the host name of one, so the popup can suggest All sites), and, for the PC target, the state ob.Pal Desktop reports for the popup and options page. Nothing in it leaves the computer.
```

`activeTab`

```text
When the user clicks the toolbar icon, the popup reads the current tab's address to show which site "This tab" will control, and turning on "This tab" injects the input scripts into that tab. activeTab limits this to the tab the user clicked on, without broad host access.
```

`scripting`

```text
Injects the extension's two bundled scripts into the tab the user turned on: an isolated-world bridge that receives the phone's input from the extension, and a main-world page script that turns it into standard web input (a Gamepad API gamepad, pointer, mouse, wheel and keyboard events, and a cursor for pointing). The page script must run in the page's world to present the gamepad through navigator.getGamepads(). With the optional All sites permission, the bridge is also registered for new frames and navigations, so control follows the page; it stays idle in every tab that isn't the controlled one.
```

Host permission `https://obpal.blackboxes.net/*`

```text
The ob.Pal service that pairs the phone with the computer: the extension opens a WebSocket to a pairing room there to exchange the WebRTC connection setup with the phone, and fetches short-lived relay (TURN) credentials for networks that block direct connections. On the top-level /link/desktop/ install guide only, a bundled content script shows the helper's existing connection status and version, and an explicit Check in Link click opens extension settings. This exposes no phone identity, pairing code, input, program list or native error to the page, and does not connect to the helper. The extension talks to no other server.
```

Optional host permission `<all_urls>`

```text
Optional and off by default: requested only when the user turns on "All sites" in the popup, and removed when they turn it off. Many web games run inside a frame from another domain; with this permission the input scripts can reach that frame, load at the start of each page, and follow the controlled tab as it navigates. The scripts act only in the tab the user switched on.
```

Optional permission `nativeMessaging`

```text
Optional and off by default: requested only when the user chooses the PC target in the popup, or turns on PC control in the options page. It lets the extension start and talk to exactly one native host, ob.Pal Desktop (net.blackboxes.obpal), a helper the user installs separately, which turns the phone's input and typing into mouse and keyboard input on the PC, in every window or only in programs the user allows. The extension sends it the phone's held keys and buttons, mouse motion, scrolling and typed text, and the user's changes to the allowed programs; the helper answers with its version and settings, the program in front, and whether a text field has the keyboard focus (never its contents). The helper has no network access.
```

Optional permission `notifications`

```text
Optional and off by default: requested only when the user turns on "Notify me" under Phones in the options page, and removed when they turn it off. The first time a paired phone asks to control the PC through ob.Pal Desktop, the extension shows one system notification with Allow and Deny buttons, so the user can answer without opening the popup. It shows no other notifications.
```

**Are you using remote code?** No.

```text
No. All of the extension's code is in the package, and its pages allow only their own scripts (script-src 'self'). The phone's controller is a web page on the phone, not code the extension runs; what the phone sends is input data (JSON and binary packets), never code.
```

**Data usage:** tick Location, Web history and User activity (leave the other six unticked), and tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Why these three: the store's user data FAQ asks for data an extension handles to be disclosed even when it's only processed on the user's device and never transmitted. Nothing reaches the developer (there are no accounts, no analytics and no logs of input), but Link does handle:

- **Location:** the computer's IP addresses, in the connection candidates it sends to the phone (below).
- **Web history:** the controlled tab's address, read in the browser only (below).
- **User activity:** the phone's input and typing, which become clicks, pointer movement, scrolling and keystrokes, and, with ob.Pal Desktop, which program is in front.

Not ticked, as judgement calls:
- Typing can include a password or a message, but Link passes keystrokes through without reading or keeping them. That's User activity, not Authentication information or Personal communications.
- Link looks for 3D canvases and frames on a page, to aim input. It never reads or sends a page's text, images or media, so it isn't Website content.

The details:
- What leaves the computer, and where it goes:
  - To pair, the extension exchanges connection setup messages with the phone through the ob.Pal service (a Cloudflare Worker): a random room identifier, the WebRTC session descriptions and the network candidates, which hold the computer's IP addresses. The service passes them to the phone in memory and doesn't store them.
  - For networks that block direct connections, it fetches short-lived relay credentials, and the connection may then run through Cloudflare's TURN relay. It stays encrypted end to end.
  - Input goes between the user's own phone and computer over that encrypted connection: the phone's name, controller state, touches, motion and typed text one way; vibration, the phone's layout and short notices the other.
- What stays on the computer: the chosen mode, the look of the popup and options page, and the session state (`chrome.storage`, with the look also cached in the pages' web storage for their first paint), the connection certificate and remembered phones (a pairing key, the phone's certificate fingerprint, its name, and when it paired; IndexedDB), and the user's Allow or Deny for each phone that asked to control the PC (the phone's pairing key or fingerprint, its name, the answer and when; `chrome.storage.local`). The controlled page's address is read only in the browser: to show it in the popup, and to suggest a control profile for known sites from a built-in list (the phone gets the profile's name, never the address).
- ob.Pal Desktop, for the PC target, runs on the same computer and gets the phone's input and typing through native messaging. It checks only whether the focused control is a text or password field, never its contents, and keeps neither input nor typed text.

**Privacy policy URL:** `https://obpal.blackboxes.net/privacy/`

## Distribution tab

- Visibility: Public.
- Distribution: all regions (owner's choice).
- No in-app purchases: the extension is free.

## Test instructions tab (notes for the reviewer)

```text
No login needed. Click the ob.Pal Link icon and scan its QR code with any phone camera (no app). No phone: open the QR link in DevTools device mode; each code pairs once. Turn on "This tab", then pick a mode:
- Controller: getGamepads() shows "ob.Pal Controller"; try it on obpal.blackboxes.net/link/try/
- 3D: drag on the phone to turn obpal.blackboxes.net/view/
- Keys: A presses Space.
PC mode needs the optional Windows helper; without it, Link says so. Source: github.com/Axialon/obpal
```

The field takes 500 characters at most.
