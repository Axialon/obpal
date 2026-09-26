# Chrome Web Store listing kit (ob.Pal Link)

Everything the Developer Dashboard asks for, ready to paste. Registering the developer account (one-time fee, the developer agreement) is the owner's step. After that, the submission takes about 15 minutes.

**Package:** `pnpm run pack:extension` → `extension/release/obpal-link-<version>.zip`. The 1.0.0 release is also at https://github.com/Axialon/obpal-link/releases.

**Before each submission:** `pnpm run e2e:extension` must pass.
- It needs Chromium: run `npx playwright install chromium`, or set `OBPAL_E2E_CHROMIUM`.
- `--shots=<dir>` also saves the popup and phone screenshots.

## Store listing

- **Name:** ob.Pal Link
- **Summary** (manifest `description`, 132 characters max): Your phone as a controller for any website: Gamepad API games, 3D viewers and keyboard games. Pair by QR.
- **Category:** Tools
- **Language:** English
- **Icon:** `extension/dist/icons/icon-128.png`: 96 px of art with 16 px of clear padding.
- **Screenshots:** 1280×800 or 640×400, one to five of them.
  - The popup, connected.
  - The phone's gamepad face with a Gamepad API game.
  - The phone's trackpad driving a 3D viewer.
  - Keys mode in a keyboard game.
- **Small promo tile** (440×280, optional): the mark with "Your phone controls any website".
- **Homepage:** https://obpal.blackboxes.net/link/
- **Support:** hello@obpal.blackboxes.net

**Description:**

> Turn your phone into a controller for any website. There's no app to install: scan a QR code and the controller opens in your phone's browser.
>
> • Controller: a standard gamepad for any game that uses the Gamepad API, cloud gaming included. Rumble reaches your phone.
> • 3D: drag to rotate, two fingers to pan and pinch to zoom, on any 3D viewer in the page.
> • Keys: sticks become WASD and the arrow keys, buttons become Space, Enter and more, and the right stick moves the mouse.
>
> How it works: click the ob.Pal Link icon on the page you want to control, scan the QR code with your phone and turn on "This tab". Switch between Controller, 3D and Keys from the popup or from your phone.
>
> Private by design: no accounts, no analytics, no remote code. Your phone connects to your computer directly over an encrypted WebRTC connection. The extension acts only in the tab you switch on and never reads page content or what you type.
>
> Works in Chrome, Edge, Brave, Opera, Vivaldi and Arc (Chromium 120 or later).

## Privacy practices

**Single purpose:** Let a paired phone send controller, 3D and keyboard input to the browser tab the user switches on.

**Permission justifications:**
- **offscreen:** MV3 service workers can't hold a WebRTC connection. An offscreen document (reason WEB_RTC) keeps the encrypted link to the user's phone open.
- **storage:** Remembers the mode the user chose (Controller, 3D or Keys). Until the browser closes, session storage holds the controlled tab and the link status for the popup.
- **activeTab:** When the user clicks the toolbar icon, the extension gets access to that tab only, so "This tab" works without broad host access.
- **scripting:** Injects the input bridge into the tab the user turned on. The bridge turns the phone's input into gamepad, pointer, wheel and key events in that page.
- **Host permission https://obpal.blackboxes.net/\*:** The ob.Pal service: the pairing (signaling) WebSocket and short-lived TURN relay credentials for the phone connection.
- **Optional host permission `<all_urls>`:**
  - It's requested only when the user turns on "All sites" in the popup, and it's off by default.
  - It lets control reach game iframes served from other domains, and keeps control as the page navigates.
  - The user can revoke it from the popup.
- **Optional permission nativeMessaging:**
  - It's requested only when the user first chooses the PC target in the popup, and it's off by default.
  - It lets the extension start and talk to one native host, ob.Pal Desktop (`net.blackboxes.obpal`, the user installs it), which turns the phone's controller input into keyboard and mouse input for programs the user allows one by one. The extension never runs anything else and the helper has no network access.

**Remote code:** No. All code is bundled, and extension pages use `script-src 'self'`.

**Data usage:**
- **Categories:** don't tick any of the listed data categories as collected.
  - Pairing messages pass through the signaling service in memory and aren't stored.
  - Input is sent directly between the user's own devices.
  - The extension doesn't read page content, browsing history or keystrokes.
- **Certify all three statements:** data isn't sold or transferred to third parties, isn't used for purposes unrelated to the item's single purpose, and isn't used for creditworthiness or lending.

**Privacy policy:** https://obpal.blackboxes.net/privacy/

## Notes for reviewers

> To test without a phone: click the ob.Pal Link icon on any web page and open the QR link in another browser window or device. For a phone-sized view, use DevTools device mode. The ob.Pal controller connects, and the popup shows Connected. Turn on "This tab". Then in the controller:
> - Gamepad tab with Controller mode: the page's `navigator.getGamepads()` shows "ob.Pal Controller".
> - Rotate tab with 3D mode: a trackpad drag rotates a 3D viewer (for example https://obpal.blackboxes.net/view/ or any three.js example).
