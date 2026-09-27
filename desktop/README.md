# ob.Pal Desktop

The native helper behind the **PC** target of the ob.Pal Link browser extension: your phone becomes this PC's mouse and keyboard, in every window (**Whole PC**) or only in the programs you allow, with the scope you choose. Windows first (x86_64), built so macOS and Linux injectors can be added.

```
phone ──WebRTC──▶ ob.Pal Link (extension) ──Chrome Native Messaging (stdio)──▶ obpal-desktop.exe ──SendInput──▶ the program in front
```

There is no other way in. The helper has **no network listener, no socket, no file it watches**: Chrome starts it, hands it two pipes, and the only peer on them is the extension named in its manifest.

## Build

```sh
cd desktop
cargo build --release          # target/release/obpal-desktop.exe (and obpal-harness.exe, see Tests)
cargo test                     # codec, key table, allowlist/scope, the session state machine, registration
cargo test -- --include-ignored  # also the Windows injection test (it creates a window and takes the foreground)
```

Rust 1.85 or later. The only Windows dependency is the `windows` crate (no C toolchain, no cgo). `build.rs` links the icon (`obpal-desktop.ico`) and the version information into `obpal-desktop.exe` as a resource file it writes itself, so no resource compiler is needed either; `node desktop/icon.mjs` redraws the icon from the site's mark (`public/favicon.svg`, `public/logo-mark.svg`) with Playwright's Chromium.

## Install (per user, no admin)

```sh
obpal-desktop.exe install      # writes net.blackboxes.obpal.json next to the exe and registers it for
                               # Chrome, Chromium, Edge, Brave and Vivaldi under HKCU (this user only)
obpal-desktop.exe status       # where it is registered, and whether the keys point at this exe
obpal-desktop.exe uninstall    # removes exactly those registry keys and the manifest
obpal-desktop.exe uninstall --purge   # and the settings (%APPDATA%\obpal)
```

A helper the browser is running checks every second that its manifest is still there; once `uninstall` has removed it, the helper lets go of everything and stops, so the folder can be deleted with the browser open. `install` refuses to run from a temporary folder (install.cmd double-clicked inside the zip), which Windows would clear later.

The release zip's `uninstall.cmd` asks, then runs `uninstall --purge`, waits for a running helper to stop, deletes the files it installed and removes the folder if nothing else is left in it (`uninstall.cmd /y` doesn't ask). `node desktop/pack.mjs` builds that zip after `cargo build --release`.

Keep the exe where you installed it from: the manifest points at that path. Moving it means `install` again.

To update in place, switch ob.Pal Link away from **PC** and close its options page if it's open (or close the browser): the extension keeps the helper running while either needs it, and Windows can't replace a running exe. Then unzip the new version over the old folder; `install` is needed again only if the folder moved.

`install --origin chrome-extension://<id>/` adds another extension ID to `allowed_origins`, for a copy of ob.Pal Link with a different ID (a Chrome Web Store build, or a fork with its own key). The built-in ID is ob.Pal Link's stable one, fixed by the public key in `extension/vite.config.ts`.

Then, in ob.Pal Link:
1. Click the **PC** chip. The browser asks once for the *nativeMessaging* permission.
2. Click **Control the whole PC** (or **Whole PC**). The phone is now the mouse and keyboard of every window, the browser included. The popup shows *Controlling this PC*.
3. Or, one program at a time: switch to the program you want to control, then come back to the popup: it names that program. Click **Allow**, with keys and/or mouse, and switch back to it.

The extension's options page turns **Whole PC** on and off, lists every allowed program with its scope, removes them, and has **Pause all**.

**What the phone does on the PC**
- Trackpad (the Rotate tab): drag to move the pointer · tap to click · tap again to double-click · hold, then lift, to right-click · hold, then move, to drag · two fingers to scroll (a flick carries on) · pinch to zoom · turn the wheel along its edge to scroll (turned fast, it spins on).
- Point: on a PC its face is the top of a mouse, held like a remote. Aim to move the pointer · Left clicks and Right right-clicks where they went down (the pointer holds still while one is down) · press one and aim away to drag · the wheel between them: turn it to scroll (turned fast, it spins on), tap it to middle-click, hold it and aim to scroll · zoom out, centre the pointer and zoom in, above them. Where the phone's browser passes them on, its volume keys work too: up is Left, down holds the wheel.
- Gamepad, with Whole PC: a desktop controller that types no letters. Left stick the pointer · right stick scroll · A or RT click (held, it drags) · X or LT right-click · left stick press middle-click · B Esc · Y Enter · D-pad arrows · LB and RB back and forward (Alt + ← and →) · Menu the Start menu (Ctrl + Esc) · View the last app (Alt + Tab).
- Gamepad, one program: the Keys mapping, for games: sticks, buttons as keys, the triggers as mouse buttons.
- Keyboard: **Keyboard** in the phone's tray opens the phone's own keyboard (autocorrect, predictions, swipe typing), which types into whatever has the focus, with Esc, Tab, the arrows, Backspace and Enter on a key row. While a text field has the focus, the phone offers **Type** by itself; in a password field it types into a password field of its own, so nothing is suggested, learned or kept. Typing needs ob.Pal Desktop 0.3 or later.

## Security model

Remote-input tools have a history of remote code execution (PLAN.md §9). The helper is built so that the worst a hostile phone, network or page can do is press keys you already allowed, in a program you already allowed, while it is in front.

**Reachability**
- Reached only through Chrome Native Messaging: Chrome launches the helper and owns both pipes. The host manifest lists one `allowed_origins` entry, ob.Pal Link's extension ID; Chrome refuses other extensions, and the helper checks the origin Chrome passes on its command line as well.
- No network listener, no socket, no IPC endpoint, no auto-update.
- Runs as the user, unelevated. Registration is `HKCU` only.

**Whole PC**
- Off until you turn it on in the extension (popup or options page); remembered in the config file, like the allowlist.
- While it is on, every window in front receives input with its scope, the browser included. Nothing else changes: only table keys, relative motion, buttons and the wheel; nothing until `enable`; the panic hotkey, *Pause all* and the 500 ms watchdog still let go of everything.
- Windows keeps programs running as administrator out of reach (UIPI) whichever mode is on; the popup names the one in front. The pointer stays free to move off it.
- The held state belongs to the PC rather than a window, so switching windows doesn't release it: a press on a window in the background brings it to the front, and the drag it starts goes on.

**What can be injected**
- Only actions the *extension* mapped host-side from controller state: keys from an allowlisted table (`src/keys.rs`, named by `KeyboardEvent.code`), relative mouse motion, mouse buttons, the wheel. The phone never sends key names or sequences; it sends stick and button state, and the mapping (`extension/src/shared/keys.ts`) is fixed code. Typing, below, is the one exception.
- The key table leaves out the OS keys (Meta / Windows), the context-menu key, the lock keys, PrintScreen, Pause, Sleep and Power, and the media and browser keys.
- Frames carry the **whole desired held state**, never edges: the helper diffs against what it holds. A lost, dropped or refused frame cannot leave a key stuck; the next frame repairs it.
- Per-frame limits: at most 16 keys, 5 buttons, ±2000 px of motion, ±20 wheel notches; a frame with an unknown key is rejected as a whole. At most 250 frames/s, messages at most 64 KB.
- **Typing** (`text`): what the phone's keyboard typed, as characters (`KEYEVENTF_UNICODE`, whatever the layout), after Backspace for what it deleted; newline and tab are the Enter and Tab keys. At most 256 characters and 256 deletions per request, no other control characters, at most 40 requests/s. Gated like frames, only with the keyboard scope, and refused while a frame holds Shift, Ctrl or Alt, so text never turns into shortcuts.

**When it is injected**
- Nothing until the extension has sent `enable` (it does so only while the PC target is selected), and nothing while paused or after the panic key.
- Every frame is gated on the **foreground window's process** (`GetForegroundWindow` → PID → `QueryFullProcessImageNameW`, looked up every frame; only a new window costs a process query), so switching to another window stops input on the next frame: input goes only to a program on the allowlist, and only the kinds its scope allows (keyboard, mouse; a virtual gamepad needs a driver, so `gamepad` is reserved in the scope model and not offered).
- **The default is that nothing is allowed.** A program can be allowed only after the helper has seen it in the foreground in this session, so an `allow` can only name what a person just switched away from. The browser that launched the helper is never offered as a program (its popup is in front whenever you choose); Whole PC covers it. Chrome starts native hosts through `cmd.exe`, so the helper looks past that shell for the browser.
- **Elevated windows:** the helper compares the front process's integrity level with its own. A higher level (an admin window) is refused up front and reported as *runs as administrator: can't be controlled*, because UIPI would otherwise drop the input silently.

**Letting go**
- Everything held is released when the foreground changes, on `enable off`, on pause, on panic, when a program's scope changes or it is forgotten, on stdin EOF (the browser or the extension went away), and after **500 ms without frames**.
- **Panic hotkey:** `Ctrl+Alt+Backspace`, registered system-wide while the helper runs. It releases everything and stops injection until *Resume* in the extension. If another program owns that combination, the extension shows that there is no panic key.

**Text fields**
- So the phone can offer its keyboard, the status says when a text or password field has the keyboard focus (`status.text`). A thread asks UI Automation about four times a second for the focused element's control type and flags (IsPassword, its patterns, IsReadOnly), in one cached request: never a value or any text, and nothing at all of an elevated window. Text boxes, combo boxes you can type into, editable documents and a web page's editable regions count; drop-down lists, pages and everything else don't (`src/win/focus.rs`, checked against Chromium's and the Win32 controls' answers).
- A UI Automation client makes Chrome and other Chromium-based programs build their accessibility tree, which costs them memory and some CPU while they keep it. The watcher runs only while the helper serves the extension, and stops with it.

**Configuration**
- `%APPDATA%\obpal\desktop.json`: the allowlist, Whole PC and the pause flag. Written only by the helper, atomically, in response to validated messages from the extension. A damaged or hand-edited file with invalid entries is treated as empty. Nothing else is stored: no input, no titles.
- `%APPDATA%\obpal\desktop.log`: lifecycle lines (start, origin, hotkey, stop with counters). Never input.

## Protocol

Length-prefixed JSON on stdin/stdout (spec/PROTOCOL.md § Native messaging frames):

| Extension → helper | |
|---|---|
| `{"t":"hello","v":1}` | handshake |
| `{"t":"enable","on":true}` | arm / disarm (disarming releases everything) |
| `{"t":"f","k":["KeyW","ShiftLeft"],"b":[0],"m":[dx,dy],"w":[wx,wy]}` | an action frame: held keys, held buttons, motion, wheel (all optional) |
| `{"t":"text","s":"héllo\n","del":1}` | typing: Backspace `del` times, then `s` as characters (`\n` Enter, `\t` Tab) |
| `{"t":"release"}` | release everything |
| `{"t":"allow","path":…,"keyboard":true,"mouse":true}` | allow a program seen in front |
| `{"t":"desktop","on":true,"keyboard":true,"mouse":true}` | Whole PC on (every window) or off |
| `{"t":"scope",…}`, `{"t":"forget","path":…}`, `{"t":"pause","on":…}`, `{"t":"resume"}`, `{"t":"stats"}` | |

| Helper → extension | |
|---|---|
| `hello{v,version,os,hotkey,caps}` | `caps.desktop`: has Whole PC; `caps.text`: types `text` and reports text fields |
| `config{paused,desktop,programs[]}` | after every change; `desktop` is Whole PC's scope, or null |
| `status{enabled,panic,held,front,program,text}` | on change: the window in front, the last program that isn't the browser, and `text`: `"text"`, `"secret"` (a password field) or null for what has the keyboard focus |
| `stats{frames,injected,refused{…}}` | on request |
| `error{code,msg}` | typing adds `bad-text`, `text-rate`, `keys-held` and `not-typed` |

## Layout

| Path | Contents |
|---|---|
| `src/main.rs` | CLI (`install`, `uninstall`, `status`) and the serve loop: stdin reader thread, 50 ms poll, panic flag |
| `src/protocol.rs` | codec, requests, frame and text validation, replies |
| `src/keys.rs` | the key table |
| `src/scope.rs` | the allowlist and its file |
| `src/session.rs` | the state machine: gating, diffing, typing, watchdog, rate limits, status reports; OS access behind `Injector` and `Foreground` traits |
| `src/win/` | Windows: `inject.rs` (SendInput: keys, mouse, typing), `foreground.rs` (front process, integrity level), `focus.rs` (UI Automation: does a text field have the focus), `hotkey.rs`, `process.rs` (the parent browser), `install.rs` (manifest and registry), `inject_test.rs` |
| `src/bin/harness.rs` | a test window (an EDIT control) that reports every key, character, button, motion and wheel event it receives as JSON lines, plus what its low-level keyboard hook saw (`ll`), and answers `text`, `clear`, `front` and `quit` on stdin (`--stay` keeps it open without stdin). Key events carry the injector's tag (`extra`), so a person's own typing is told apart from the helper's |
| `build.rs`, `icon.mjs`, `obpal-desktop.ico` | the exe's icon and version information, written as a resource file and linked in; the icon, and the script that draws it |

## Tests

- `cargo test`: 50+ unit tests: the codec (framing, size limits, EOF), request parsing (unknown types and fields rejected), frame and text validation, the key table (unique codes and scan codes, extended and modifier flags, forbidden keys), the allowlist (default deny, case-insensitive paths, invalid paths, persistence and damage), the session (nothing until enabled; allow only seen programs; desired-state diffing with modifier order; scope; elevated; foreground change; watchdog; pause / panic / disable / shutdown; forget; invalid frames; rate limit; status changes; stats; typing: gating, the keyboard scope, a held modifier, limits, rate; the text field in the status), the typing events (Backspace first, characters as UTF-16 units, Enter and Tab as keys, SendInput calls split between characters), and the text-field classification, also of standard Win32 controls through UI Automation (in a window that is never shown, so nothing takes the focus).
- `cargo test -- --include-ignored`: also injects `KeyW` and `ArrowLeft` into a window the test creates and asserts the `WM_KEYDOWN` / `WM_CHAR` / `WM_KEYUP` messages and the extended-key bit, and types a Backspace, `a€😀`, Enter and Tab and asserts the `WM_CHAR` code units (the emoji as its two surrogates).
- `pnpm run e2e:extension` runs the extension with a stub host; `node extension/scripts/e2e.mjs --desktop` runs it against the installed helper and this crate's `obpal-harness.exe`: keys are refused until the harness is allowed, then Space, ArrowUp and W are typed into its edit control (checked from the control's text, and tagged as the helper's by `GetMessageExtraInfo`), then refused again once it is forgotten.

## Limits and next steps

- Windows only. The session logic is platform-neutral; macOS (`CGEventPost`, Accessibility permission) and Linux (`uinput`, a udev rule, or the libei portal) need injectors and foreground lookups behind the same traits.
- No virtual gamepad: it needs a driver (ViGEmBus is archived; HIDMaestro is the user-mode candidate). The scope model already carries `gamepad`.
- The mouse is relative only (what games with raw input expect). An absolute path for desktop pointing is a later option.
- Not code-signed: SmartScreen will warn on first run until a signing identity exists. The extension ID it allows is fixed by the manifest key; a Chrome Web Store build gets its ID from the key uploaded with it (see `extension/scripts/key.mjs`).
- The pointer moves relatively, so Windows' pointer speed and *Enhance pointer precision* apply, as they do to a mouse.
