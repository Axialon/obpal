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
- Summary (129 of 132 characters):

```text
Use your phone as a controller for websites: games, 3D viewers and more. Add ob.Pal Desktop to control your whole PC. Pair by QR.
```

**Description:**

```text
Your phone controls any website. ob.Pal Link turns it into a gamepad for browser games, a 3D mouse for model viewers and a keyboard for keyboard games. Scan a QR code to pair: the controller opens in your phone's browser, so there's no app to install.

What your phone becomes
• Controller: a standard gamepad for any game that uses the Gamepad API, cloud gaming included. Rumble reaches your phone.
• 3D: drag to rotate, two fingers to pan and pinch to zoom, on any 3D viewer in the page.
• Keys: sticks become WASD and the arrow keys, buttons become Space, Enter and the rest, and the right stick moves the mouse.
• Motion: aim by turning the phone, steer by tilting it, or point it at the screen like a remote, with a cursor where it points.

Your whole PC, with ob.Pal Desktop
Add the free ob.Pal Desktop helper for Windows, and your phone becomes this computer's mouse and keyboard: in every window, or only in the programs you allow. Tap to click, hold to right-click, two fingers to scroll, pinch to zoom.
• Type with your phone's own keyboard, autocorrect and predictions included. When a text field on the PC has the focus, the phone offers to type by itself. In a password field, nothing is suggested, learned or kept.
• Ctrl + Alt + Backspace on the PC stops everything at once.
The helper is optional: the extension works on websites without it, and asks for permission to talk to it only when you choose PC.

How it works
1. Click the ob.Pal Link icon on the page you want to control.
2. Scan the QR code with your phone's camera.
3. Turn on "This tab". Switch between Controller, 3D, Keys and PC in the popup or on your phone.
A phone you've paired once connects straight over your Wi-Fi when the internet is down.
The popup and the options page wear ob.Pal's look: pick one of six surfaces and eight accent shades, and both pages follow.

Private by design
• No accounts, no analytics, no ads and no remote code.
• Your phone and your computer talk over an encrypted WebRTC connection. The ob.Pal service only introduces them to each other, and doesn't keep what they send.
• The extension acts only in the tab you switch on, or with ob.Pal Desktop in the programs you allow. It doesn't read page content, your browsing history or what you type on the computer.
Privacy policy: https://obpal.blackboxes.net/privacy/

Free and open source (MIT): https://github.com/Axialon/obpal
```

**Category:** Tools (owner's choice; see UPLOAD.md).

**Language:** English. The copy avoids the words that UK and US English spell differently, so either variant fits.

**Graphic assets** (all in this folder, made by `pnpm run store:art`):

| Field | File |
|---|---|
| Store icon (128×128) | `icon-128.png`: the package's own icon, 96 px of art in 16 px of clear padding |
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
chrome.storage.local remembers two settings: what the phone drives (Controller, 3D, Keys or PC), and the look the user picked for the popup and options page (a surface and an accent). chrome.storage.session, which the browser clears when it closes, holds the controlled tab, the connection status and pairing code shown in the popup, the frames from other sites in the controlled page (how many, and the host name of one, so the popup can suggest All sites), and, for the PC target, the state ob.Pal Desktop reports for the popup and options page. Nothing in it leaves the computer.
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
The ob.Pal service that pairs the phone with the computer: the extension opens a WebSocket to a pairing room there to exchange the WebRTC connection setup with the phone, and fetches short-lived relay (TURN) credentials for networks that block direct connections. The extension talks to no other server.
```

Optional host permission `<all_urls>`

```text
Optional and off by default: requested only when the user turns on "All sites" in the popup, and removed when they turn it off. Many web games run inside a frame from another domain; with this permission the input scripts can reach that frame, load at the start of each page, and follow the controlled tab as it navigates. The scripts act only in the tab the user switched on.
```

Optional permission `nativeMessaging`

```text
Optional and off by default: requested only when the user chooses the PC target in the popup, or turns on PC control in the options page. It lets the extension start and talk to exactly one native host, ob.Pal Desktop (net.blackboxes.obpal), a helper the user installs separately, which turns the phone's input and typing into mouse and keyboard input on the PC, in every window or only in programs the user allows. The extension sends it the phone's held keys and buttons, mouse motion, scrolling and typed text, and the user's changes to the allowed programs; the helper answers with its version and settings, the program in front, and whether a text field has the keyboard focus (never its contents). The helper has no network access.
```

**Are you using remote code?** No.

```text
No. All of the extension's code is in the package, and its pages allow only their own scripts (script-src 'self'). The phone's controller is a web page on the phone, not code the extension runs; what the phone sends is input data (JSON and binary packets), never code.
```

**Data usage:** tick none of the data types, and tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Why none (and one judgement call, in UPLOAD.md):

- Nothing reaches the developer. There are no accounts, no analytics and no logs of input.
- What leaves the computer, and where it goes:
  - To pair, the extension exchanges connection setup messages with the phone through the ob.Pal service (a Cloudflare Worker): a random room identifier, the WebRTC session descriptions and the network candidates, which hold the computer's IP addresses. The service passes them to the phone in memory and doesn't store them.
  - For networks that block direct connections, it fetches short-lived relay credentials, and the connection may then run through Cloudflare's TURN relay. It stays encrypted end to end.
  - Input goes between the user's own phone and computer over that encrypted connection: the phone's name, controller state, touches, motion and typed text one way; vibration, the phone's layout and short notices the other.
- What stays on the computer: the chosen mode, the look of the popup and options page, and the session state (`chrome.storage`, with the look also cached in the pages' web storage for their first paint), the connection certificate and remembered phones (a pairing key, the phone's certificate fingerprint, its name, and when it paired; IndexedDB). The controlled page's address is read only in the browser: to show it in the popup, and to suggest a control profile for known sites from a built-in list (the phone gets the profile's name, never the address).
- ob.Pal Desktop, for the PC target, runs on the same computer and gets the phone's input and typing through native messaging. It checks only whether the focused control is a text or password field, never its contents, and keeps neither input nor typed text.

**Privacy policy URL:** `https://obpal.blackboxes.net/privacy/`

## Distribution tab

- Visibility: Public.
- Distribution: all regions (owner's choice).
- No in-app purchases: the extension is free.

## Test instructions tab (notes for the reviewer)

```text
No account or login is needed.

Click the ob.Pal Link icon on any web page and scan the QR code with any phone's camera; the phone needs no app. Without a phone, open the link the QR code holds (any QR reader decodes it from a screenshot of the popup) in another browser window, in DevTools device mode. The ob.Pal controller opens and connects, and the popup shows the device as connected. Then turn on "This tab" in the popup.
- Controller: pick Controller in the popup and Gamepad on the phone. The page's navigator.getGamepads() shows "ob.Pal Controller", and a button tap on the phone presses it.
- 3D: pick 3D in the popup and Rotate on the phone. A drag on the phone's trackpad rotates a 3D viewer, for example https://obpal.blackboxes.net/view/
- Keys: pick Keys. A on the phone presses Space, and the D-pad presses the arrow keys.

The PC target needs the optional ob.Pal Desktop helper for Windows (https://obpal.blackboxes.net/link/, free, open source). Without it, choosing PC asks for the native messaging permission and then says that ob.Pal Desktop isn't installed; everything else works without it.

Source code: https://github.com/Axialon/obpal (the extension is in extension/). The package is built without minifying, so the code in it reads like the TypeScript in the repository.
```
